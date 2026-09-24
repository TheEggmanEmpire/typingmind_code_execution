// Options page: shows the pairing key and edits the trusted hosts (chrome.storage.local).
const DEFAULT_TRUSTED = ["typingmind.com", "*.typingmind.com"];
const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(["pairingKey", "trustedHosts"]);
  if (!s.pairingKey) {
    // The service worker creates the key on first use; ask it.
    await chrome.runtime.sendMessage({ type: "crb", request: { op: "ping" } }).catch(() => {});
    Object.assign(s, await chrome.storage.local.get(["pairingKey"]));
  }
  $("key").value = s.pairingKey || "(open this page again in a moment)";
  $("hosts").value = (Array.isArray(s.trustedHosts) && s.trustedHosts.length ? s.trustedHosts : DEFAULT_TRUSTED).join("\n");
}

$("copy").onclick = async () => { await navigator.clipboard.writeText($("key").value); $("copy").textContent = "Copied"; setTimeout(() => ($("copy").textContent = "Copy"), 1500); };
$("regen").onclick = async () => {
  if (!confirm("Create a new key? The plugin stops working until you paste the new key into its settings.")) return;
  const b = new Uint8Array(18); crypto.getRandomValues(b);
  const key = "crb-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  await chrome.storage.local.set({ pairingKey: key });
  $("key").value = key;
};
$("save").onclick = async () => {
  const hosts = $("hosts").value.split(/\s+/).map((h) => h.trim()).filter(Boolean);
  await chrome.storage.local.set({ trustedHosts: hosts.length ? hosts : DEFAULT_TRUSTED });
  $("saved").textContent = "Saved"; setTimeout(() => ($("saved").textContent = ""), 1500);
};
load();
