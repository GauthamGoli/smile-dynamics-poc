const WINDOW = 5;
const RING_SIZE = 1800;
const DISPLAY_SAMPLES = 150;

const rings = new Map();
let firstFullLogged = false;

function push(key, raw) {
  let r = rings.get(key);
  if (!r) {
    r = { buf: new Float32Array(RING_SIZE), i: 0, n: 0 };
    r.buf.fill(NaN);
    rings.set(key, r);
  }
  r.buf[r.i] = Number.isFinite(raw) ? raw : NaN;
  r.i = (r.i + 1) % RING_SIZE;
  if (r.n < RING_SIZE) r.n++;
  if (!firstFullLogged && r.n === RING_SIZE) {
    firstFullLogged = true;
    console.log(`hud ring full for "${key}" (${RING_SIZE} samples). rings available on window.__rings for inspection.`);
  }
  return r;
}

export function runningStats(ring) {
  const len = ring.n;
  if (len === 0) return { count: 0, min: NaN, max: NaN, mean: NaN, sigma: NaN };
  const start = len < RING_SIZE ? 0 : ring.i;
  let mn = Infinity, mx = -Infinity, sum = 0, count = 0;
  for (let k = 0; k < len; k++) {
    const v = ring.buf[(start + k) % RING_SIZE];
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
    count++;
  }
  if (count === 0) return { count: 0, min: NaN, max: NaN, mean: NaN, sigma: NaN };
  const mean = sum / count;
  let ss = 0;
  for (let k = 0; k < len; k++) {
    const v = ring.buf[(start + k) % RING_SIZE];
    if (!Number.isFinite(v)) continue;
    ss += (v - mean) * (v - mean);
  }
  const sigma = count > 1 ? Math.sqrt(ss / (count - 1)) : 0;
  return { count, min: mn, max: mx, mean, sigma };
}

export function getRings() { return rings; }

function ensureCanvasSized(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const targetW = Math.max(1, Math.round(rect.width * dpr));
  const targetH = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
}

function drawSpark(canvas, ring, stats, color, minSpan) {
  ensureCanvasSized(canvas);
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (ring.n < 2 || !Number.isFinite(stats.mean)) return;

  const displayLen = Math.min(ring.n, DISPLAY_SAMPLES);
  const displayStart = (ring.i - displayLen + RING_SIZE) % RING_SIZE;
  const pad = Math.max(2, Math.round(1 * (window.devicePixelRatio || 1)));

  const observedSpan = stats.max - stats.min;
  const floor = Number.isFinite(minSpan) && minSpan > 0 ? minSpan : Math.max(1e-6, Math.abs(stats.mean) * 0.01);
  const span = Math.max(observedSpan, floor);
  const mid = (stats.max + stats.min) / 2;
  const yMin = mid - span / 2;
  const y = (v) => h - pad - ((v - yMin) / span) * (h - 2 * pad);
  const x = (k) => pad + (k * (w - 2 * pad)) / Math.max(1, displayLen - 1);

  if (Number.isFinite(stats.sigma) && stats.sigma > 0) {
    ctx.fillStyle = "rgba(95,255,91,0.12)";
    const yTop = y(stats.mean + stats.sigma);
    const yBot = y(stats.mean - stats.sigma);
    ctx.fillRect(0, yTop, w, Math.max(1, yBot - yTop));
  }

  const meanY = y(stats.mean);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, meanY);
  ctx.lineTo(w, meanY);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.round(1 * (window.devicePixelRatio || 1)));
  ctx.beginPath();
  let started = false;
  for (let k = 0; k < displayLen; k++) {
    const v = ring.buf[(displayStart + k) % RING_SIZE];
    if (!Number.isFinite(v)) { started = false; continue; }
    const px = x(k), py = y(v);
    if (!started) { ctx.moveTo(px, py); started = true; } else { ctx.lineTo(px, py); }
  }
  ctx.stroke();
}

class Smoother {
  constructor(window = WINDOW) { this.w = window; this.buf = []; }
  push(v) {
    if (!Number.isFinite(v)) return this.mean();
    this.buf.push(v);
    if (this.buf.length > this.w) this.buf.shift();
    return this.mean();
  }
  mean() {
    if (!this.buf.length) return 0;
    let s = 0;
    for (const v of this.buf) s += v;
    return s / this.buf.length;
  }
}

const smoothers = new Map();
function smooth(key, v) {
  let s = smoothers.get(key);
  if (!s) { s = new Smoother(); smoothers.set(key, s); }
  return s.push(v);
}

export function toBlendshapeMap(categories) {
  const m = {};
  if (!categories) return m;
  for (const c of categories) m[c.categoryName] = c.score;
  return m;
}

// MediaPipe's facial transformation matrix is a flat 16-float array in
// column-major order: index = row + 4*col.
function mat(d, r, c) { return d[r + 4 * c]; }

export function poseFromMatrix(d) {
  if (!d || d.length < 12) return { yaw: 0, pitch: 0, roll: 0 };
  const r02 = mat(d, 0, 2);
  const r12 = mat(d, 1, 2);
  const r22 = mat(d, 2, 2);
  const r10 = mat(d, 1, 0);
  const r11 = mat(d, 1, 1);
  const yaw = Math.atan2(r02, r22);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)));
  const roll = Math.atan2(r10, r11);
  const deg = (x) => (x * 180) / Math.PI;
  return { yaw: deg(yaw), pitch: deg(pitch), roll: deg(roll) };
}

function iod(landmarks) {
  const a = landmarks[33], b = landmarks[263];
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function yDist(landmarks, i, j) {
  return Math.abs(landmarks[i].y - landmarks[j].y);
}

export function geometricReadouts(landmarks) {
  if (!landmarks) return null;
  const scale = iod(landmarks) || 1e-6;
  const cheekL_y = landmarks[205].y / scale;
  const cheekR_y = landmarks[425].y / scale;
  const eyeL_open = yDist(landmarks, 159, 145) / scale;
  const eyeR_open = yDist(landmarks, 386, 374) / scale;
  return { cheekL_y, cheekR_y, eyeL_open, eyeR_open };
}

function fmtSmall(v) {
  const a = Math.abs(v);
  if (a >= 10) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

const MIN_SPAN_B = 0.1;
const MIN_SPAN_P = 5.0;
const MIN_SPAN_G = 0.02;

const ROWS = [
  { key: "mouthSmileLeft",  label: "smile L",    src: "b", fmt: fmtSmall, minSpan: MIN_SPAN_B },
  { key: "mouthSmileRight", label: "smile R",    src: "b", fmt: fmtSmall, minSpan: MIN_SPAN_B },
  { key: "eyeBlinkLeft",    label: "blink L",    src: "b", fmt: fmtSmall, minSpan: MIN_SPAN_B },
  { key: "eyeBlinkRight",   label: "blink R",    src: "b", fmt: fmtSmall, minSpan: MIN_SPAN_B },
  { key: "eyeSquintLeft",   label: "squint L",   src: "b", fmt: fmtSmall, minSpan: MIN_SPAN_B },
  { key: "eyeSquintRight",  label: "squint R",   src: "b", fmt: fmtSmall, minSpan: MIN_SPAN_B },
  { key: "yaw",             label: "yaw (deg)",  src: "p", fmt: (v) => v.toFixed(1), minSpan: MIN_SPAN_P },
  { key: "pitch",           label: "pitch (deg)",src: "p", fmt: (v) => v.toFixed(1), minSpan: MIN_SPAN_P },
  { key: "roll",            label: "roll (deg)", src: "p", fmt: (v) => v.toFixed(1), minSpan: MIN_SPAN_P },
  { key: "cheekL_y",        label: "cheek L y",  src: "g", fmt: fmtSmall, minSpan: MIN_SPAN_G },
  { key: "cheekR_y",        label: "cheek R y",  src: "g", fmt: fmtSmall, minSpan: MIN_SPAN_G },
  { key: "eyeL_open",       label: "eye L open", src: "g", fmt: fmtSmall, minSpan: MIN_SPAN_G },
  { key: "eyeR_open",       label: "eye R open", src: "g", fmt: fmtSmall, minSpan: MIN_SPAN_G },
];

export function ensureRows(host) {
  if (host.dataset.built === "1") return;
  for (const r of ROWS) {
    const el = document.createElement("div");
    el.className = "hud-row-dyn";
    el.innerHTML =
      `<span class="hud-label">${r.label}</span>` +
      `<canvas class="hud-spark" id="spark-${r.key}" width="160" height="28"></canvas>` +
      `<span class="hud-val" id="hud-${r.key}">—</span>` +
      `<span class="hud-cv" id="cv-${r.key}"></span>`;
    host.appendChild(el);
  }
  host.dataset.built = "1";
}

const domCache = new Map();

function cachedCells(key) {
  let c = domCache.get(key);
  if (!c) {
    c = {
      val: document.getElementById(`hud-${key}`),
      spark: document.getElementById(`spark-${key}`),
      cv: document.getElementById(`cv-${key}`),
    };
    domCache.set(key, c);
  }
  return c;
}

export function update(host, { blendshapes, pose, geom }) {
  ensureRows(host);
  const sources = { b: blendshapes || {}, p: pose || {}, g: geom || {} };
  const snap = {};
  for (const r of ROWS) {
    const raw = sources[r.src][r.key];
    const ring = push(r.key, raw);
    const v = smooth(r.key, raw);
    snap[r.key] = v;
    const cells = cachedCells(r.key);
    if (cells.val) {
      if (!Number.isFinite(v)) cells.val.textContent = "—";
      else cells.val.textContent = r.fmt ? r.fmt(v) : v.toFixed(3);
    }
    if (cells.spark) {
      const stats = runningStats(ring);
      const cv = Math.abs(stats.mean) > 1e-6 && stats.count > 10 ? (stats.sigma / Math.abs(stats.mean)) : null;
      const cvColor = cv == null ? "#888" : cv < 0.1 ? "#9ef28f" : cv < 0.25 ? "#ffcc66" : "#ff6a6a";
      drawSpark(cells.spark, ring, stats, cvColor, r.minSpan);
      if (cells.cv) {
        cells.cv.textContent = cv != null && Number.isFinite(cv) ? cv.toFixed(2) : "—";
        cells.cv.style.color = cvColor;
      }
    }
  }
  return snap;
}
