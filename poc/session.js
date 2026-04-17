import { flattenVectorKeys, getPath } from "./repeatability.js";

export function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function medianOfArray(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function computeMedianVectors(trials) {
  const pool = trials.filter((t) => t.smile);
  if (!pool.length) return null;
  const keys = flattenVectorKeys(pool[0].smile);
  const result = {};
  for (const k of keys) {
    const values = pool
      .map((t) => getPath(t.smile, k))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    setPath(result, k, values.length ? medianOfArray(values) : null);
  }
  return result;
}

export async function fetchBaseline(person) {
  const res = await fetch(`/baseline?person=${encodeURIComponent(person)}`);
  if (!res.ok) return null;
  return await res.json();
}

export function computeZScores(medianVectors, baselineData) {
  if (!baselineData || !baselineData.baseline) return null;
  const flat = {};
  flattenPaths(medianVectors, "", flat);
  const z = {};
  for (const [path, stats] of Object.entries(baselineData.baseline)) {
    const val = flat[path];
    if (!Number.isFinite(val) || !Number.isFinite(stats.sigma) || stats.sigma < 1e-9 || stats.n < 3) {
      z[path] = { value: val ?? null, personalMedian: stats.median, personalSigma: stats.sigma, z: null, n: stats.n };
      continue;
    }
    z[path] = {
      value: val,
      personalMedian: stats.median,
      personalSigma: stats.sigma,
      z: (val - stats.median) / stats.sigma,
      n: stats.n,
    };
  }
  return z;
}

function flattenPaths(obj, prefix, out) {
  if (obj == null) return;
  if (typeof obj === "number") { out[prefix] = obj; return; }
  if (typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    flattenPaths(obj[k], prefix ? `${prefix}.${k}` : k, out);
  }
}

export async function postSession({ sessionId, person, trials, trialsPassed, vectors, quality, baseline, images }) {
  const res = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, person, trials, trialsPassed, vectors, quality, baseline, images }),
  });
  if (!res.ok) throw new Error(`session save failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function fetchSessions(person) {
  const res = await fetch(`/sessions?person=${encodeURIComponent(person)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions || [];
}

export async function deleteSession(id, person) {
  const res = await fetch(`/session/${encodeURIComponent(id)}?person=${encodeURIComponent(person)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
  return await res.json();
}

function zIndicator(zVal) {
  if (zVal == null || !Number.isFinite(zVal)) return { icon: "—", color: "#888" };
  const az = Math.abs(zVal);
  if (az < 1) return { icon: "●", color: "#9ef28f" };
  if (az < 2) return { icon: "▲", color: "#ffcc66" };
  return { icon: "▲▲", color: "#ff6a6a" };
}

function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 10) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

export function renderSessionCard(container, { medianVectors, zScores, trials, passedTrials, baselineData }) {
  if (!medianVectors) { container.innerHTML = "<div>no vectors</div>"; return; }
  const flat = {};
  flattenPaths(medianVectors, "", flat);
  const keys = Object.keys(flat).sort();
  const sessionCount = baselineData?.sessionCount ?? 0;

  const rows = keys.map((k) => {
    const val = flat[k];
    const zEntry = zScores?.[k];
    const zVal = zEntry?.z;
    const ind = zIndicator(zVal);
    const zStr = zVal != null && Number.isFinite(zVal) ? (zVal >= 0 ? "+" : "") + zVal.toFixed(2) : "—";
    return `<div style="display:grid;grid-template-columns:1fr 64px 56px 24px;gap:4px;padding:2px 0;font-size:11px;align-items:center">
      <span style="opacity:0.8">${k}</span>
      <span style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(val)}</span>
      <span style="text-align:right;font-variant-numeric:tabular-nums;color:${ind.color}">z ${zStr}</span>
      <span style="text-align:center;color:${ind.color}">${ind.icon}</span>
    </div>`;
  }).join("");

  container.innerHTML = `
    <div style="margin-bottom:6px">Trials: ${passedTrials.length}/${trials.length} passed quality gate</div>
    <div>${rows}</div>
    <div style="margin-top:8px;opacity:0.6;font-size:11px">
      <span style="color:#9ef28f">●</span> normal &nbsp;
      <span style="color:#ffcc66">▲</span> notable |z|&gt;1 &nbsp;
      <span style="color:#ff6a6a">▲▲</span> unusual |z|&gt;2
    </div>
    <div style="margin-top:4px;opacity:0.6;font-size:11px">
      Baseline: ${sessionCount} session${sessionCount !== 1 ? "s" : ""} accumulated
      ${sessionCount < 3 ? " (z-scores need ≥3 sessions)" : ""}
    </div>`;
}

export function renderSessionHistory(container, sessions, { onDelete } = {}) {
  if (!sessions.length) {
    container.innerHTML = "<div style='opacity:0.5'>no sessions yet</div>";
    return;
  }
  const rows = sessions.map((s) => {
    const flat = {};
    flattenPaths(s.vectors, "", flat);
    const sym = flat["cheekLift.symmetry"];
    const stiff = flat["stiffness"];
    const dt = s.created_at.replace("T", " ").slice(0, 16);
    return `<details style="border-bottom:1px solid #1a1a22;padding:4px 0" data-session-id="${s.id}" data-person="${s.person}">
      <summary style="cursor:pointer;font-size:11px;display:flex;align-items:center;gap:8px">
        <span>${dt}</span>
        <span>${s.trials_passed}/${s.trials}</span>
        <span>sym ${sym != null ? sym.toFixed(3) : "—"}</span>
        <span>stf ${stiff != null ? stiff.toFixed(1) : "—"}</span>
        <span class="del-zone" style="margin-left:auto" data-id="${s.id}" data-person="${s.person}">
          <button class="btn-del" style="font-size:10px;padding:1px 5px;opacity:0.5">🗑</button>
        </span>
      </summary>
      <div style="font-size:10px;padding:4px 0;opacity:0.8">${renderMiniVectors(flat, s.baseline)}</div>
    </details>`;
  }).join("");
  container.innerHTML = `<div style="margin-bottom:6px;opacity:0.7">${sessions.length} session${sessions.length !== 1 ? "s" : ""}</div>${rows}`;

  container.querySelectorAll(".btn-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const zone = btn.closest(".del-zone");
      const id = zone.dataset.id;
      const person = zone.dataset.person;
      zone.innerHTML = `<span style="font-size:10px">sure? <a href="#" class="confirm-yes" style="color:#ff6a6a">yes</a> / <a href="#" class="confirm-no" style="color:#9ef28f">cancel</a></span>`;
      zone.querySelector(".confirm-yes").addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          await deleteSession(id, person);
          const row = container.querySelector(`[data-session-id="${id}"]`);
          if (row) row.remove();
          if (onDelete) onDelete(id, person);
        } catch (err) {
          zone.innerHTML = `<span style="font-size:10px;color:#ff6a6a">failed</span>`;
        }
      });
      zone.querySelector(".confirm-no").addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        zone.innerHTML = `<button class="btn-del" style="font-size:10px;padding:1px 5px;opacity:0.5">🗑</button>`;
        zone.querySelector(".btn-del").addEventListener("click", btn._handler);
      });
    });
  });
}

function rollingBaseline(values) {
  const medians = [];
  const bands = [];
  for (let i = 0; i < values.length; i++) {
    const window = values.slice(0, i + 1);
    const med = medianOfArray(window);
    const deviations = window.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = medianOfArray(deviations) * 1.4826;
    medians.push(med);
    bands.push({ upper: med + mad, lower: med - mad });
  }
  return { medians, bands };
}

const SMILE_VECTOR_PREFIXES = [
  "eyeApertureDelta.left",
  "eyeApertureDelta.right",
  "cheekLift.left",
  "cheekLift.right",
  "cheekLift.symmetry",
  "nasolabialResponse.",
  "movementSymmetry",
  "stiffness",
  "rebound.reboundMs",
  "shadowRedistribution.",
  "foldVisibility.",
];

function isSmileVector(key) {
  return SMILE_VECTOR_PREFIXES.some((p) => key === p || key.startsWith(p));
}

export function renderTrendCharts(container, sessions) {
  if (sessions.length < 2) {
    container.innerHTML = "<div style='opacity:0.5'>need ≥2 sessions for trends</div>";
    return;
  }
  const sorted = sessions.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  const allFlat = sorted.map((s) => {
    const f = {};
    flattenPaths(s.vectors, "", f);
    return f;
  });
  const dates = sorted.map((s) => s.created_at.replace("T", " ").slice(5, 16));
  const keys = Object.keys(allFlat[0] || {}).filter(isSmileVector).sort();

  const charts = keys.map((k) => {
    const values = allFlat.map((f) => f[k]).filter(Number.isFinite);
    if (values.length < 2) return "";
    const rawValues = allFlat.map((f) => f[k]);
    const rb = rollingBaseline(values);
    return trendSvg(k, rawValues, dates, rb);
  });
  const legend = `<div style="font-size:12px;margin-bottom:12px;opacity:0.7;line-height:1.6">
    <strong>z-score</strong> = how far today's value is from your personal baseline, in units of your typical variation.<br>
    <span style="color:#9ef28f">● |z| &lt; 1 = normal</span> &nbsp;
    <span style="color:#ffcc66">▲ 1–2 = notable change</span> &nbsp;
    <span style="color:#ff6a6a">▲▲ &gt; 2 = unusual — investigate</span>
  </div>`;
  container.innerHTML = `${legend}<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">${charts.join("")}</div>`;
}

function trendSvg(label, rawValues, dates, rb) {
  const w = 360, h = 100, pad = 10, topPad = 20;
  const values = rawValues.filter(Number.isFinite);
  if (values.length < 2) return "";
  const allVals = [...values, ...rb.bands.map((b) => b.upper), ...rb.bands.map((b) => b.lower)];
  const mn = Math.min(...allVals), mx = Math.max(...allVals);
  const span = (mx - mn) || 1e-6;
  const y = (v) => topPad + (h - topPad - pad) - ((v - mn) / span) * (h - topPad - pad);
  const n = rawValues.length;
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(1, n - 1);

  let validIdx = 0;
  const bandPath = [];
  const medianPath = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(rawValues[i])) continue;
    bandPath.push({ x: x(i), upper: y(rb.bands[validIdx].upper), lower: y(rb.bands[validIdx].lower) });
    medianPath.push({ x: x(i), y: y(rb.medians[validIdx]) });
    validIdx++;
  }

  const bandD = bandPath.length
    ? `M ${bandPath.map((p) => `${p.x} ${p.upper}`).join(" L ")} L ${bandPath.slice().reverse().map((p) => `${p.x} ${p.lower}`).join(" L ")} Z`
    : "";
  const medD = medianPath.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");

  const dots = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(rawValues[i])) continue;
    dots.push(`<circle cx="${x(i)}" cy="${y(rawValues[i])}" r="2.5" fill="#7ad1ff"/>`);
  }

  const lastVal = values[values.length - 1];
  const lastMed = rb.medians[rb.medians.length - 1];
  const lastSig = rb.bands[rb.bands.length - 1].upper - lastMed;
  const zVal = lastSig > 1e-9 ? (lastVal - lastMed) / lastSig : null;
  const zStr = zVal != null ? `z=${zVal >= 0 ? "+" : ""}${zVal.toFixed(1)}` : "";
  const zCol = zVal == null ? "#888" : Math.abs(zVal) < 1 ? "#9ef28f" : Math.abs(zVal) < 2 ? "#ffcc66" : "#ff6a6a";

  const xLabels = [];
  const step = Math.max(1, Math.floor(n / 4));
  for (let i = 0; i < n; i += step) {
    xLabels.push(`<text x="${x(i)}" y="${h - 1}" fill="#666" font-size="9" text-anchor="middle">${dates[i] || ""}</text>`);
  }

  const zLabel = zVal == null ? "" : Math.abs(zVal) < 1 ? "normal" : Math.abs(zVal) < 2 ? "notable" : "unusual";

  return `<figure style="margin:0">
    <figcaption style="font-size:13px;display:flex;justify-content:space-between;padding:0 2px 4px">
      <span style="opacity:0.9;font-weight:500">${label}</span>
      <span style="color:${zCol}">${zStr}${zLabel ? ` · ${zLabel}` : ""}</span>
    </figcaption>
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;background:#0a0a0c;border:1px solid #1a1a22">
      ${bandD ? `<path d="${bandD}" fill="rgba(95,255,91,0.10)"/>` : ""}
      <path d="${medD}" fill="none" stroke="#5fff5b" stroke-width="1" stroke-dasharray="3,2"/>
      ${dots.join("")}
      ${xLabels.join("")}
    </svg>
    <div style="font-size:11px;opacity:0.5;padding:2px 2px 0;display:flex;justify-content:space-between">
      <span>— rolling median &nbsp; ░ ±1σ band</span>
      <span>latest: ${fmtNum(lastVal)}</span>
    </div>
  </figure>`;
}

function renderMiniVectors(flat, baselineSnapshot) {
  const keys = Object.keys(flat).sort();
  return keys.map((k) => {
    const val = flat[k];
    const zEntry = baselineSnapshot?.[k];
    const zVal = zEntry?.z;
    const ind = zIndicator(zVal);
    const zStr = zVal != null && Number.isFinite(zVal) ? `z=${zVal >= 0 ? "+" : ""}${zVal.toFixed(1)}` : "";
    return `<div style="display:flex;justify-content:space-between;padding:1px 0">
      <span>${k}</span>
      <span style="font-variant-numeric:tabular-nums">${fmtNum(val)} <span style="color:${ind.color}">${zStr}</span></span>
    </div>`;
  }).join("");
}
