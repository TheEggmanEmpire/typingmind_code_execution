// Options page: edits the trusted hosts (chrome.storage.local).
const DEFAULT_TRUSTED = ["typingmind.com", "*.typingmind.com"];
const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(["trustedHosts"]);
  $("hosts").value = (Array.isArray(s.trustedHosts) && s.trustedHosts.length ? s.trustedHosts : DEFAULT_TRUSTED).join("\n");
}
$("save").onclick = async () => {
  const hosts = $("hosts").value.split(/\s+/).map((h) => h.trim()).filter(Boolean);
  await chrome.storage.local.set({ trustedHosts: hosts.length ? hosts : DEFAULT_TRUSTED });
  $("saved").textContent = "Saved"; setTimeout(() => ($("saved").textContent = ""), 1500);
};
load();
