// Code Runner Browser Bridge - page agent.
//
// Injected by the service worker into the ISOLATED world of the target tab's top
// frame (chrome.scripting), so page scripts cannot see or tamper with it and the
// page's Content-Security-Policy does not apply. It builds the numbered snapshot
// of interactive elements that browser_act works with, and performs the DOM side
// of the actions (focus, scroll, dropdowns, reading the page as Markdown). Real
// mouse and keyboard input is sent by the service worker over the DevTools
// protocol, using the coordinates this agent reports.
//
// The snapshot approach (index every visible interactive element, act by index)
// follows nanobrowser / browser-use (Apache-2.0); this is an independent, compact
// implementation.

(() => {
  if (window.__crbAgent && window.__crbAgent.version === 3) return;

  const MAX_TEXT = 90;
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "DETAILS", "OPTION", "LABEL"]);
  const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "listbox"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "META", "LINK", "IFRAME"]);
  const RISKY = /\b(buy|purchase|pay|payment|checkout|check out|place (your )?order|order now|delete|remove|destroy|erase|wipe|send|transfer|withdraw|donate|confirm|unsubscribe|subscribe|publish|post|submit|sign out|log ?out|deactivate|close account|cancel (my )?(subscription|order|account|plan))\b/i;

  let map = [];          // index -> element, from the last snapshot
  let stamp = 0;         // bumps with every snapshot

  const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

  function visible(el) {
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function isInteractive(el) {
    const tag = el.tagName;
    if (tag === "INPUT" && el.type === "hidden") return false;
    if (tag === "A") return el.hasAttribute("href");
    if (tag === "LABEL") return false;   // its control is indexed instead
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("jsaction")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0 && tag !== "BODY" && tag !== "HTML") return true;
    try { if (getComputedStyle(el).cursor === "pointer" && !(el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer")) return true; } catch (e) {}
    return false;
  }

  // Frame offsets, so coordinates of elements in same-origin iframes are top-level.
  // A frame's content starts inside its border and padding; a frame scaled by a
  // CSS transform cannot be mapped reliably, so it is reported as such.
  function frameOffset(el) {
    let x = 0, y = 0, scaled = false, w = el.ownerDocument.defaultView;
    while (w && w !== window && w.frameElement) {
      const f = w.frameElement, r = f.getBoundingClientRect();
      let pl = 0, pt = 0;
      try { const cs = f.ownerDocument.defaultView.getComputedStyle(f); pl = parseFloat(cs.paddingLeft) || 0; pt = parseFloat(cs.paddingTop) || 0; } catch (e) {}
      if (f.offsetWidth && Math.abs(r.width / f.offsetWidth - 1) > 0.01) scaled = true;
      x += r.left + f.clientLeft + pl; y += r.top + f.clientTop + pt; w = w.parent;
    }
    return { x, y, scaled };
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect(), o = frameOffset(el);
    return { x: r.left + o.x, y: r.top + o.y, w: r.width, h: r.height };
  }

  function inScope(el, scope) {
    if (scope === "page") return true;
    const r = rectOf(el), vh = window.innerHeight, vw = window.innerWidth;
    return r.y + r.h > -vh * 0.25 && r.y < vh * 1.25 && r.x + r.w > 0 && r.x < vw;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = [];
    const add = (k, v) => { if (v != null && String(v).trim() !== "") attrs.push(k + '="' + clip(v, 60).replace(/"/g, "'") + '"'); };
    const role = el.getAttribute("role");
    if (tag === "input") { add("type", el.type); add("name", el.name); add("placeholder", el.placeholder);
      if (el.type === "checkbox" || el.type === "radio") attrs.push(el.checked ? "checked" : "unchecked");
      else if (el.type !== "password") add("value", el.value); else if (el.value) attrs.push('value="••••"'); }
    else if (tag === "textarea") { add("name", el.name); add("placeholder", el.placeholder); add("value", el.value); }
    else if (tag === "select") { add("name", el.name); const o = el.selectedOptions && el.selectedOptions[0]; add("selected", o && o.textContent); }
    else if (tag === "a") { const h = el.getAttribute("href") || ""; add("href", h.startsWith("javascript:") ? "javascript:" : h.length > 80 ? h.slice(0, 77) + "..." : h); }
    if (role) add("role", role);
    add("aria-label", el.getAttribute("aria-label"));
    if (!attrs.some((a) => a.startsWith("aria-label")) && el.title) add("title", el.title);
    if (el.disabled) attrs.push("disabled");
    if (el.isContentEditable && tag !== "input" && tag !== "textarea") attrs.push("contenteditable");
    let text = "";
    if (!["input", "textarea", "select"].includes(tag)) text = clip(el.innerText || el.textContent || (el.querySelector && el.querySelector("img[alt]") ? el.querySelector("img[alt]").alt : ""), MAX_TEXT);
    if (tag === "input" && ["submit", "button", "reset"].includes(el.type) && !text) text = clip(el.value, MAX_TEXT);
    return "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">" + text + (text || !["input", "select"].includes(tag) ? "</" + tag + ">" : "");
  }

  function* walk(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === 1) {
        if (node.hasAttribute("data-crb-hl")) continue;
        if (SKIP_TAGS.has(node.tagName)) {
          if (node.tagName === "IFRAME") { try { const d = node.contentDocument; if (d && d.body) { yield { frame: node }; stack.push(d.body); } } catch (e) {} }
          continue;
        }
        yield { el: node };
        const kids = [];
        if (node.shadowRoot) kids.push(...node.shadowRoot.childNodes);
        kids.push(...node.childNodes);
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      } else if (node.nodeType === 3) {
        yield { text: node };
      } else if (node.nodeType === 11) {
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
      }
    }
  }

  // The snapshot: numbered interactive elements, with the visible text between
  // them for context, in document order.
  function snapshot(opts) {
    opts = opts || {};
    const scope = opts.scope === "page" ? "page" : "viewport";
    const maxChars = Math.min(Math.max(Number(opts.maxChars) || 14000, 2000), 60000);
    map = []; stamp++;
    const lines = [];
    let used = 0, truncated = false;
    const insideIndexed = new WeakSet();
    const push = (line) => { if (truncated) return; if (used + line.length > maxChars) { truncated = true; return; } lines.push(line); used += line.length + 1; };
    let pendingText = "";
    const flushText = () => { const t = clip(pendingText, 200); pendingText = ""; if (t.length > 1) push(t); };

    for (const item of walk(document.body || document.documentElement)) {
      if (truncated) break;
      if (item.el && item.el.hasAttribute && item.el.hasAttribute("data-crb-hl")) continue;
      if (item.frame) { flushText(); push("--- iframe ---"); continue; }
      if (item.text) {
        const p = item.text.parentElement;
        if (!p || insideIndexed.has(p)) continue;
        const t = item.text.textContent;
        if (!t || !t.trim()) continue;
        if (!visible(p) || !inScope(p, scope)) continue;
        pendingText += " " + t;
        continue;
      }
      const el = item.el;
      if (el.parentElement && insideIndexed.has(el.parentElement)) { insideIndexed.add(el); continue; }
      if (!isInteractive(el) || !visible(el) || !inScope(el, scope)) continue;
      flushText();
      const i = map.length + 1;
      map.push(el);
      insideIndexed.add(el);
      push("[" + i + "]" + describe(el));
    }
    flushText();
    const se = document.scrollingElement || document.documentElement;
    return {
      stamp, count: map.length, truncated, scope,
      url: location.href, title: document.title,
      scroll: { y: Math.round(se.scrollTop), above: Math.round(se.scrollTop), below: Math.max(0, Math.round(se.scrollHeight - se.scrollTop - window.innerHeight)), viewport: window.innerHeight },
      text: lines.join("\n")
    };
  }

  function el(index) {
    const e = map[Number(index) - 1];
    if (!e) throw new Error("no element [" + index + "] in the last snapshot (" + map.length + " elements). Take a fresh snapshot with browser_state.");
    if (!e.isConnected) throw new Error("element [" + index + "] is no longer on the page (it changed). Take a fresh snapshot with browser_state.");
    return e;
  }

  function riskyReason(e) {
    const texts = [e.innerText, e.value, e.getAttribute("aria-label"), e.title, e.id, e.name, e.getAttribute("data-testid")];
    const form = e.form || (e.closest && e.closest("form"));
    if (form) texts.push(form.getAttribute("action"), form.id, form.getAttribute("name"));
    const hay = texts.filter(Boolean).join(" ");
    const m = RISKY.exec(hay);
    if (m) return 'it looks like it would "' + m[0].toLowerCase() + '"';
    if (form && (e.type === "submit" || (e.tagName === "BUTTON" && (!e.type || e.type === "submit"))) && form.querySelector("input[type=password], input[autocomplete^='cc-'], input[name*='card' i]"))
      return "it submits a form with a password or payment field";
    return null;
  }

  // Scroll the element into view and report its centre (top-level CSS pixels),
  // plus whether something else covers that point.
  function point(index, opts) {
    const e = el(index);
    const risky = opts && opts.checkRisk ? riskyReason(e) : null;
    e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = rectOf(e);
    const x = r.x + r.w / 2, y = r.y + r.h / 2;
    let covered = false;
    try {
      const doc = e.ownerDocument, o = frameOffset(e);
      const hit = doc.elementFromPoint(x - o.x, y - o.y);
      covered = !(hit && (hit === e || e.contains(hit) || hit.contains(e) || (hit.closest && hit.closest("label") && hit.closest("label").control === e)));
      if (o.scaled) covered = true;   // a transformed frame: click the element directly
    } catch (e2) {}
    return { x, y, covered, risky, tag: e.tagName.toLowerCase(), type: e.type || null, desc: describe(e) };
  }

  function clickDirect(index) { const e = el(index); e.click(); return true; }

  // Focus a field and select its content (fill) or move to its end (append).
  function focusField(index, mode) {
    const e = el(index);
    const tag = e.tagName;
    if (tag === "SELECT") throw new Error("element [" + index + "] is a dropdown: use the select action");
    if (tag === "INPUT" && ["checkbox", "radio", "submit", "button", "file", "image", "reset"].includes(e.type)) throw new Error("element [" + index + "] is a " + e.type + " input: use click" + (e.type === "file" ? " (file uploads are not supported)" : ""));
    e.scrollIntoView({ block: "center", behavior: "instant" });
    e.focus();
    const editable = tag === "INPUT" || tag === "TEXTAREA";
    if (editable) {
      try { const n = e.value.length; if (mode === "append") e.setSelectionRange(n, n); else e.setSelectionRange(0, n); } catch (x) { if (mode !== "append") e.select(); }
    } else if (e.isContentEditable) {
      const range = e.ownerDocument.createRange(); range.selectNodeContents(e); if (mode === "append") range.collapse(false);
      const sel = e.ownerDocument.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } else throw new Error("element [" + index + "] is not a text field");
    return { risky: null, hadText: editable ? e.value.length > 0 : (e.textContent || "").length > 0, form: !!(e.form || e.closest("form")) };
  }

  function fieldValue(index) { const e = el(index); return e.value != null ? e.value : e.textContent; }

  // Checked just before Enter is pressed in a field: would it submit something risky?
  function focused() {
    let e = document.activeElement;
    try { while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; } catch (x) {}
    try { while (e && (e.tagName === "IFRAME" || e.tagName === "FRAME") && e.contentDocument) e = e.contentDocument.activeElement; } catch (x) {}
    return e;
  }
  // Would Enter / Space on this element (or the focused one) do something risky?
  // The control itself counts (a "Delete" button), and so does the form it submits.
  function enterRisk(index) {
    const e = index ? el(index) : focused();
    if (!e || e === document.body) return null;
    const own = riskyReason(e);
    if (own) return own;
    const form = e.form || (e.closest && e.closest("form"));
    if (!form) return null;
    const submit = form.querySelector("button[type=submit], input[type=submit], button:not([type])");
    return (submit && riskyReason(submit)) || riskyReason(form.querySelector("input,textarea") || e);
  }

  function options(index) {
    const e = el(index);
    if (e.tagName !== "SELECT") throw new Error("element [" + index + "] is not a dropdown (<select>); open custom dropdowns with click, then click the option");
    return [...e.options].map((o, i) => ({ i, text: clip(o.textContent, 120), value: o.value, selected: o.selected, disabled: o.disabled }));
  }

  function select(index, wanted) {
    const e = el(index);
    if (e.tagName !== "SELECT") throw new Error("element [" + index + "] is not a dropdown (<select>)");
    const w = String(wanted).trim(), lw = w.toLowerCase();
    const opts = [...e.options];
    const o = opts.find((x) => x.textContent.trim() === w) || opts.find((x) => x.value === w) ||
      opts.find((x) => x.textContent.trim().toLowerCase() === lw) || opts.find((x) => x.textContent.toLowerCase().includes(lw));
    if (!o) throw new Error('no option "' + w + '" in [' + index + ']. Options: ' + opts.map((x) => clip(x.textContent, 40)).slice(0, 30).join(" | "));
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(e, o.value);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return clip(o.textContent, 80);
  }

  function scroll(opts) {
    const target = opts.index ? el(opts.index) : (document.scrollingElement || document.documentElement);
    const vh = opts.index ? target.clientHeight : window.innerHeight;
    const max = target.scrollHeight - (opts.index ? target.clientHeight : window.innerHeight);
    const to = String(opts.to || "down").toLowerCase();
    if (to === "text") {
      const needle = String(opts.text || "").toLowerCase();
      if (!needle) throw new Error("scroll to text needs `text`");
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.textContent.toLowerCase().includes(needle) && n.parentElement && visible(n.parentElement)) {
          n.parentElement.scrollIntoView({ block: "center", behavior: "instant" });
          return "scrolled to \"" + clip(n.textContent, 60) + "\"";
        }
      }
      throw new Error('text "' + opts.text + '" was not found on the page');
    }
    let y = target.scrollTop;
    if (to === "top") y = 0;
    else if (to === "bottom") y = max;
    else if (to === "percent") y = max * Math.min(Math.max(Number(opts.percent) || 0, 0), 100) / 100;
    else if (to === "up") y -= vh * 0.9;
    else y += vh * 0.9;
    target.scrollTo({ top: Math.max(0, Math.min(max, y)), behavior: "instant" });
    return "scrolled " + to + " (" + Math.round(target.scrollTop) + " of " + Math.max(0, Math.round(max)) + " px)";
  }

  // ---- the page as Markdown ------------------------------------------------------
  function read(opts) {
    opts = opts || {};
    const maxChars = Math.min(Math.max(Number(opts.maxChars) || 20000, 1000), 200000);
    let root = null;
    if (opts.selector) { root = document.querySelector(opts.selector); if (!root) throw new Error("no element matches " + opts.selector); }
    if (!root) {
      const cands = [...document.querySelectorAll("main, article, [role=main]")].filter((e) => visible(e) && (e.innerText || "").length > 200);
      root = cands.sort((a, b) => b.innerText.length - a.innerText.length)[0] || document.body;
    }
    const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
    const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|BUTTON|SELECT|INPUT|TEXTAREA)$/;
    const NOISE = /^(NAV|FOOTER|ASIDE)$/;
    const out = [];
    const INLINE = /^(A|SPAN|STRONG|B|EM|I|CODE|LABEL|SMALL|MARK|ABBR|TIME|IMG|SUP|SUB|U|S|Q|CITE)$/;
    const inline = (node) => {
      let s = "";
      for (const c of node.childNodes) {
        if (c.nodeType === 3) s += c.textContent.replace(/\s+/g, " ");
        else if (c.nodeType === 1) {
          if (SKIP.test(c.tagName)) continue;
          if (c.tagName === "BR") s += "\n";
          else if (c.tagName === "A" && c.getAttribute("href") && !c.getAttribute("href").startsWith("javascript:")) { const t = inline(c).trim(); s += t ? "[" + t + "](" + abs(c.getAttribute("href")) + ")" : ""; }
          else if (c.tagName === "IMG") { if (c.alt) s += "![" + clip(c.alt, 80) + "]"; }
          else if (/^(STRONG|B)$/.test(c.tagName)) { const t = inline(c).trim(); if (t) s += "**" + t + "**"; }
          else if (/^(EM|I)$/.test(c.tagName)) { const t = inline(c).trim(); if (t) s += "*" + t + "*"; }
          else if (c.tagName === "CODE") s += "`" + c.textContent + "`";
          else s += inline(c);
        }
      }
      return s;
    };
    const block = (node, depth) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { const t = c.textContent.replace(/\s+/g, " ").trim(); if (t) out.push(t); continue; }
        if (c.nodeType !== 1 || SKIP.test(c.tagName) || (c.hasAttribute && c.hasAttribute("data-crb-hl"))) continue;
        if (root === document.body && NOISE.test(c.tagName)) continue;
        if (typeof c.checkVisibility === "function" && !c.checkVisibility()) continue;
        const tag = c.tagName;
        if (INLINE.test(tag)) { const t = inline({ childNodes: [c] }).trim(); if (t) out.push(t); }
        else if (/^H[1-6]$/.test(tag)) { const t = inline(c).trim(); if (t) out.push("\n" + "#".repeat(Number(tag[1])) + " " + t + "\n"); }
        else if (tag === "P") { const t = inline(c).trim(); if (t) out.push(t + "\n"); }
        else if (tag === "UL" || tag === "OL") {
          let n = 0;
          for (const li of c.children) if (li.tagName === "LI") { n++; const t = inline(li).trim(); if (t) out.push("  ".repeat(depth) + (tag === "OL" ? n + ". " : "- ") + t); }
          out.push("");
        }
        else if (tag === "PRE") out.push("```\n" + c.textContent.replace(/\s+$/, "") + "\n```\n");
        else if (tag === "BLOCKQUOTE") out.push("> " + inline(c).trim().replace(/\n/g, "\n> ") + "\n");
        else if (tag === "TABLE") {
          const rows = [...c.querySelectorAll("tr")].slice(0, 200).map((tr) => [...tr.children].map((td) => inline(td).trim().replace(/\|/g, "\\|").replace(/\n/g, " ")));
          if (rows.length) {
            const w = Math.max(...rows.map((r) => r.length));
            const pad = (r) => r.concat(Array(w - r.length).fill(""));
            out.push("| " + pad(rows[0]).join(" | ") + " |", "|" + " --- |".repeat(w), ...rows.slice(1).map((r) => "| " + pad(r).join(" | ") + " |"), "");
          }
        }
        else if (tag === "HR") out.push("\n---\n");
        else block(c, depth);
        if (out.join("\n").length > maxChars * 1.2) return;
      }
    };
    // The root itself counts (a selector may point straight at a table or list).
    block(root === document.body ? root : { childNodes: [root] }, 0);
    let md = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const truncated = md.length > maxChars;
    if (truncated) md = md.slice(0, maxChars);
    return { url: location.href, title: document.title, markdown: md, truncated, length: md.length };
  }

  // Numbered boxes over the indexed elements, nanobrowser style: "page" anchors
  // them to the document (they scroll with it, shown on the live page until the
  // next snapshot); the default pins them to the viewport for a screenshot.
  function highlight(on, anchor) {
    document.querySelectorAll("[data-crb-hl]").forEach((n) => n.remove());
    if (!on) return 0;
    const page = anchor === "page";
    const dx = page ? window.scrollX : 0, dy = page ? window.scrollY : 0;
    const box = document.createElement("div");
    box.setAttribute("data-crb-hl", "");
    box.style.cssText = (page ? "position:absolute;left:0;top:0;width:0;height:0;" : "position:fixed;inset:0;") + "pointer-events:none;z-index:2147483647";
    const colors = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080", "#9a6324", "#800000"];
    map.forEach((e, i) => {
      if (!e.isConnected || !visible(e)) return;
      const r = rectOf(e);
      if (!page && (r.y + r.h < 0 || r.y > window.innerHeight)) return;
      const c = colors[i % colors.length];
      const d = document.createElement("div");
      d.style.cssText = "position:" + (page ? "absolute" : "fixed") + ";left:" + (r.x + dx) + "px;top:" + (r.y + dy) + "px;width:" + r.w + "px;height:" + r.h + "px;border:2px solid " + c + ";background:" + c + "14;box-sizing:border-box";
      const l = document.createElement("span");
      l.textContent = String(i + 1);
      // The tag sits just above the box's corner (inside it at the very top of the page).
      l.style.cssText = "position:absolute;" + (r.y > 16 ? "top:-15px" : "top:0") + ";right:-2px;background:" + c + ";color:#fff;font:bold 11px/14px sans-serif;padding:0 3px;border-radius:2px;white-space:nowrap";
      d.appendChild(l);
      box.appendChild(d);
    });
    document.documentElement.appendChild(box);
    return map.length;
  }

  window.__crbAgent = { version: 3, snapshot, point, clickDirect, focusField, fieldValue, enterRisk, options, select, scroll, read, highlight,
    hasSnapshot: () => map.length > 0, stamp: () => stamp };
})();
