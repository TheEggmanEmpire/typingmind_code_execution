// Credentials stay in trusted extension contexts and are never displayed.
const DEFAULT_TRUSTED = ["typingmind.com", "*.typingmind.com"];
const $ = (id) => document.getElementById(id);
function normalizeServerUrl(value) {
  const u = new URL(String(value).trim());
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) throw new Error("Use the server URL only, without a path, login or query.");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("Use HTTPS; HTTP is allowed only on localhost or 127.0.0.1.");
  return u.origin;
}
function hosts(value) { return String(value).split(/[\s,;]+/).map(h => h.trim()).filter(Boolean); }
async function load() {
  const s = await chrome.storage.local.get(null);
  $("hosts").value = (Array.isArray(s.trustedHosts) && s.trustedHosts.length ? s.trustedHosts : DEFAULT_TRUSTED).join("\n");
  for (const k of ["remoteAllow", "remoteBlock", "remoteChatHosts"]) $(k).value = (s[k] || []).join("\n");
  for (const k of ["remoteEnabled", "remoteConfirmRisky", "remoteScripts"]) $(k).checked = s[k] !== false;
  $("serverUrl").value = s.remoteLink?.url || "";
  $("deviceName").value = s.remoteName || "Chrome on this computer";
  $("unlink").disabled = !s.remoteLink;
  await status();
}
async function status() {
  const { remoteStatus: s = {} } = await chrome.storage.session.get("remoteStatus");
  $("connection").textContent = s.connected ? "Connected to " + s.host + " as " + s.user + " since " + new Date(s.since).toLocaleString() : "Disconnected" + (s.host ? " from " + s.host : "");
  $("lastError").textContent = s.lastError ? "Last error: " + s.lastError : "";
}
async function save() {
  const s = { trustedHosts: hosts($("hosts").value), remoteName: $("deviceName").value.trim() || "Chrome" };
  if (!s.trustedHosts.length) s.trustedHosts = DEFAULT_TRUSTED;
  for (const k of ["remoteAllow", "remoteBlock", "remoteChatHosts"]) s[k] = hosts($(k).value);
  for (const k of ["remoteEnabled", "remoteConfirmRisky", "remoteScripts"]) s[k] = $(k).checked;
  await chrome.storage.local.set(s);
}
async function pair() {
  const entered = $("serverUrl").value.trim();
  const split = entered.indexOf("#");
  const url = normalizeServerUrl(split < 0 ? entered : entered.slice(0, split));
  const code = ($("pairCode").value.trim() || (split < 0 ? "" : entered.slice(split + 1))).toUpperCase().replace(/[-\s]/g, "");
  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) throw new Error("Enter the 10-character pairing code from the browser tool.");
  const { remoteLink } = await chrome.storage.local.get("remoteLink");
  if (remoteLink) throw new Error("Unlink the current device before pairing another server.");
  await save();
  const r = await fetch(url + "/bridge/pair", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: $("deviceName").value.trim() || "Chrome", version: chrome.runtime.getManifest().version }), signal: AbortSignal.timeout(15_000) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Pairing failed (HTTP " + r.status + ").");
  if (typeof data.deviceId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.token || "") || typeof data.user !== "string") throw new Error("The server returned an invalid pairing response.");
  await chrome.storage.local.set({ remoteLink: { url, deviceId: data.deviceId, token: data.token, user: data.user }, remoteEnabled: true, remoteAuthRejected: false });
  $("pairCode").value = ""; $("serverUrl").value = url; $("remoteEnabled").checked = true; $("unlink").disabled = false;
  $("pairResult").textContent = "Paired. Connecting…";
}
async function unlink() {
  const { remoteLink: link } = await chrome.storage.local.get("remoteLink");
  let error = "";
  // Stop accepting new requests while the revocation fetch is in flight.
  await chrome.storage.local.set({ remoteEnabled: false });
  if (link) {
    try {
      const url = normalizeServerUrl(link.url);
      const r = await fetch(url + "/bridge/unpair", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: link.deviceId, token: link.token }), signal: AbortSignal.timeout(10_000) });
      if (!r.ok && r.status !== 401) throw new Error();
    } catch { error = " The server could not confirm revocation. Revoke browser devices in the MCP client when it is reachable."; }
  }
  await chrome.storage.local.remove(["remoteLink", "remoteAuthRejected"]);
  $("remoteEnabled").checked = false; $("unlink").disabled = true;
  $("pairResult").textContent = "Local link removed." + error;
}
if (typeof document !== "undefined") {
  $("save").onclick = async () => {
    try { await save(); $("saved").textContent = "Saved"; setTimeout(() => $("saved").textContent = "", 1500); }
    catch { $("saved").textContent = "Could not save settings."; }
  };
  $("remoteEnabled").onchange = () => chrome.storage.local.set({ remoteEnabled: $("remoteEnabled").checked });
  $("pair").onclick = async () => {
    $("pair").disabled = true;
    try { await pair(); } catch (e) { $("pairResult").textContent = e.message || "Could not pair."; }
    finally { $("pair").disabled = false; }
  };
  $("unlink").onclick = () => unlink().catch(() => { $("pairResult").textContent = "Could not remove local link."; });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.remoteStatus) void status(); });
  void load().catch(() => { $("connection").textContent = "Could not load extension settings."; });
}
