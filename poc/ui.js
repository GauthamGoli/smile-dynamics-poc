const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const logPre = document.getElementById("log-pre");

export function setStatus(text) {
  statusEl.textContent = text;
}

export function showError(text) {
  errorEl.style.display = "block";
  errorEl.textContent = text;
  log(`ERROR: ${text}`);
}

export function log(text) {
  const stamp = new Date().toISOString().slice(11, 23);
  logPre.textContent = `[${stamp}] ${text}\n` + logPre.textContent;
}
