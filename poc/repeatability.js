export function flattenVectorKeys(obj, prefix = "", out = []) {
  if (obj == null) return out;
  if (typeof obj === "number") { out.push(prefix); return out; }
  if (typeof obj !== "object") return out;
  for (const k of Object.keys(obj)) {
    flattenVectorKeys(obj[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

export function getPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function mean(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stdev(arr, m) {
  if (arr.length < 2) return NaN;
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / (arr.length - 1));
}

export function summarize(runs) {
  const ok = runs.filter((r) => r.quality && r.quality.flags && r.quality.flags.length === 0);
  const pool = ok.length ? ok : runs;
  if (!pool.length) return { stats: {}, ok_count: 0, total: runs.length, keys: [] };
  const keys = flattenVectorKeys(pool[0].smile).sort();
  const stats = {};
  for (const k of keys) {
    const xs = [];
    for (const r of pool) {
      const v = getPath(r.smile, k);
      if (Number.isFinite(v)) xs.push(v);
    }
    if (!xs.length) { stats[k] = { n: 0 }; continue; }
    const m = mean(xs);
    const sd = stdev(xs, m);
    const cv = Number.isFinite(sd) && Math.abs(m) > 1e-9 ? sd / Math.abs(m) : null;
    stats[k] = { n: xs.length, mean: m, std: sd, cv, values: xs };
  }
  return { stats, ok_count: ok.length, total: runs.length, keys };
}

export async function runRepeatability({ n, restMs, runSingleCapture, showRest, hideRest, onProgress }) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    onProgress?.({ phase: "starting", i, n });
    const vectors = await runSingleCapture();
    runs.push(vectors);
    onProgress?.({ phase: "captured", i, n, vectors });
    if (i < n - 1) {
      const endAt = performance.now() + restMs;
      while (performance.now() < endAt) {
        const remaining = Math.max(0, endAt - performance.now());
        showRest({
          action: `Rest · ${Math.ceil(remaining / 1000)}`,
          subtext: `next capture ${i + 2} of ${n}`,
          progress: 1 - remaining / restMs,
        });
        await sleep(100);
      }
      hideRest();
    }
  }
  return { runs, summary: summarize(runs) };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cvColor(cv) {
  if (cv == null || !Number.isFinite(cv)) return "#888";
  if (cv < 0.1) return "#9ef28f";
  if (cv < 0.25) return "#ffcc66";
  return "#ff6a6a";
}

export function renderSummaryTable(container, summary) {
  const keys = summary.keys;
  const rows = keys.map((k) => {
    const s = summary.stats[k];
    if (!s || s.n === 0) return `<tr><td>${k}</td><td colspan="4" style="color:#888">no data</td></tr>`;
    const cvStr = s.cv == null || !Number.isFinite(s.cv) ? "—" : s.cv.toFixed(3);
    const color = cvColor(s.cv);
    return `<tr>
      <td>${k}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${Number.isFinite(s.mean) ? s.mean.toFixed(4) : "—"}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${Number.isFinite(s.std) ? s.std.toFixed(4) : "—"}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;color:${color}">${cvStr}</td>
      <td style="text-align:right">${s.n}</td>
    </tr>`;
  }).join("");
  container.innerHTML = `
    <div style="margin-bottom:6px">${summary.ok_count} / ${summary.total} runs passed quality gate</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="border-bottom:1px solid #333;text-align:left">
          <th>vector</th><th style="text-align:right">mean</th><th style="text-align:right">std</th><th style="text-align:right">cv</th><th style="text-align:right">n</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function renderProgressionPlots(container, summary) {
  const keys = summary.keys;
  const parts = keys.map((k) => {
    const s = summary.stats[k];
    if (!s || !s.values || s.values.length < 2) return "";
    return progressionSvg(k, s);
  });
  container.innerHTML = parts.join("");
}

function progressionSvg(label, stats) {
  const values = stats.values;
  const w = 300, h = 70, pad = 8;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(1, values.length - 1);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const d = values.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const meanY = y(stats.mean);
  const color = cvColor(stats.cv);
  const cvStr = stats.cv == null || !Number.isFinite(stats.cv) ? "—" : stats.cv.toFixed(3);
  return `<figure style="margin:0 0 8px">
    <figcaption style="font-size:11px;opacity:0.8;display:flex;justify-content:space-between">
      <span>${label}</span>
      <span style="color:${color}">cv=${cvStr}  n=${values.length}  μ=${stats.mean.toFixed(4)}  σ=${Number.isFinite(stats.std) ? stats.std.toFixed(4) : "—"}</span>
    </figcaption>
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;background:#0a0a0c;border:1px solid #222">
      <line x1="${pad}" y1="${meanY}" x2="${w - pad}" y2="${meanY}" stroke="#444" stroke-dasharray="3,3"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>
      ${values.map((_, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(values[i]).toFixed(1)}" r="2" fill="${color}"/>`).join("")}
    </svg>
  </figure>`;
}

export function buildReportHtml({ runs, summary, baseline }) {
  const tableDiv = { innerHTML: "" };
  const plotsDiv = { innerHTML: "" };
  renderSummaryTable(tableDiv, summary);
  renderProgressionPlots(plotsDiv, summary);
  const ts = new Date().toISOString();
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Smile POC repeatability report ${ts}</title>
<style>
  body{background:#0b0b0d;color:#e6e6e6;font-family:ui-monospace,Menlo,monospace;font-size:13px;margin:20px;max-width:1000px}
  h1,h2{font-weight:500}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{padding:4px 6px}
  th{border-bottom:1px solid #333;text-align:left}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
  @media (max-width: 800px){.two-col{grid-template-columns:1fr}}
</style></head>
<body>
  <h1>Smile-dynamics repeatability — ${ts}</h1>
  <p>${summary.ok_count} / ${summary.total} captures passed quality gate.
     Baseline pose≤${baseline?.limits?.poseRangeDeg?.toFixed(1) ?? "—"}°,
     bboxIoU≥${baseline?.limits?.bboxIouMin?.toFixed(3) ?? "—"},
     blinkThr=${baseline?.limits?.blinkThreshold?.toFixed(2) ?? "—"}.</p>
  <h2>Summary table</h2>
  ${tableDiv.innerHTML}
  <h2>Per-vector progression (capture 1 → N)</h2>
  <div class="two-col">${plotsDiv.innerHTML}</div>
</body></html>`;
}
