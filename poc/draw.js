import {
  LEFT_NASOLABIAL,
  RIGHT_NASOLABIAL,
} from "./rois.js";
import { PHASE_DISPLAY } from "./capture.js";

export const ROI_GROUPS = [
  { key: "cheek",        label: "cheeks",        color: "#ff3b3b", kind: "points",   sets: [[205], [425]] },
  { key: "nasolabial",   label: "nasolabial",    color: "#ffcc00", kind: "polyline", sets: [LEFT_NASOLABIAL, RIGHT_NASOLABIAL] },
  { key: "forehead",     label: "forehead ref",  color: "#9ef28f", kind: "points",   sets: [[10]] },
  { key: "eyes",         label: "eye aperture",  color: "#c78bff", kind: "segments", sets: [[[159, 145]], [[386, 374]]] },
];

export const toggleState = Object.fromEntries(ROI_GROUPS.map((g) => [g.key, true]));

function toPx(lm, w, h) {
  return { x: lm.x * w, y: lm.y * h };
}

function drawPolyline(ctx, landmarks, indices, color, w, h) {
  if (indices.length < 2) return;
  ctx.beginPath();
  const first = toPx(landmarks[indices[0]], w, h);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < indices.length; i++) {
    const p = toPx(landmarks[indices[i]], w, h);
    ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawPoints(ctx, landmarks, indices, color, w, h) {
  const dpr = devicePixelRatio || 1;
  const r = 3 * dpr;
  ctx.fillStyle = color;
  for (const i of indices) {
    const p = toPx(landmarks[i], w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  for (const i of indices) {
    const p = toPx(landmarks[i], w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawSegments(ctx, landmarks, pairs, color, w, h) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const [a, b] of pairs) {
    const pa = toPx(landmarks[a], w, h);
    const pb = toPx(landmarks[b], w, h);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  const seen = new Set();
  const indices = [];
  for (const [a, b] of pairs) {
    if (!seen.has(a)) { seen.add(a); indices.push(a); }
    if (!seen.has(b)) { seen.add(b); indices.push(b); }
  }
  drawPoints(ctx, landmarks, indices, color, w, h);
}

function drawLabel(ctx, landmarks, index, text, color, w, h, dxPx = 8, dyPx = -6) {
  const p = toPx(landmarks[index], w, h);
  ctx.save();
  ctx.translate(p.x + dxPx, p.y + dyPx);
  ctx.scale(-1, 1);
  const pad = 3;
  const font = `${Math.round(12 * (devicePixelRatio || 1))}px ui-monospace, Menlo, monospace`;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const metrics = ctx.measureText(text);
  const tw = metrics.width;
  const th = Math.round(13 * (devicePixelRatio || 1));
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(-pad, -th, tw + pad * 2, th + pad);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, -2);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export const annotateState = { on: true };

function drawAnnotations(ctx, landmarks, snap, w, h) {
  if (!annotateState.on || !snap) return;
  const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
  drawLabel(ctx, landmarks, 205, `chk L y ${f(snap.cheekL_y)}`, "#ff3b3b", w, h, -10, 18);
  drawLabel(ctx, landmarks, 425, `chk R y ${f(snap.cheekR_y)}`, "#ff3b3b", w, h, 10, 18);
  drawLabel(ctx, landmarks, 159, `eye L ${f(snap.eyeL_open)}`, "#c78bff", w, h, -10, -6);
  drawLabel(ctx, landmarks, 386, `eye R ${f(snap.eyeR_open)}`, "#c78bff", w, h, 10, -6);
  drawLabel(ctx, landmarks, 61,  `smile L ${f(snap.mouthSmileLeft)}`, "#7ad1ff", w, h, -10, 6);
  drawLabel(ctx, landmarks, 291, `smile R ${f(snap.mouthSmileRight)}`, "#7ad1ff", w, h, 10, 6);
  drawLabel(ctx, landmarks, 10,
    `yaw ${Number.isFinite(snap.yaw) ? snap.yaw.toFixed(0) : "—"}  pit ${Number.isFinite(snap.pitch) ? snap.pitch.toFixed(0) : "—"}  rol ${Number.isFinite(snap.roll) ? snap.roll.toFixed(0) : "—"}`,
    "#9ef28f", w, h, 0, -10);
}

const MIN_SUBTEXT_CSS_PX = 11;
let minBoxWCache = { dpr: 0, value: 0 };

function computeMinBoxW(ctx, dpr, pad) {
  if (minBoxWCache.dpr === dpr && minBoxWCache.value > 0) return minBoxWCache.value;
  const prevFont = ctx.font;
  ctx.font = `${MIN_SUBTEXT_CSS_PX * dpr}px ui-monospace, Menlo, monospace`;
  let widest = 0;
  for (const d of Object.values(PHASE_DISPLAY)) {
    const tw = ctx.measureText(d.subtext).width;
    if (tw > widest) widest = tw;
  }
  ctx.font = prevFont;
  const value = widest + pad * 2;
  minBoxWCache = { dpr, value };
  return value;
}

let smoothedAnchor = null;
function smoothAnchor(next, alpha = 0.2) {
  if (!smoothedAnchor) {
    smoothedAnchor = { cx: next.cx, cy: next.cy, boxW: next.boxW };
    return smoothedAnchor;
  }
  smoothedAnchor.cx   = smoothedAnchor.cx   * (1 - alpha) + next.cx   * alpha;
  smoothedAnchor.cy   = smoothedAnchor.cy   * (1 - alpha) + next.cy   * alpha;
  smoothedAnchor.boxW = smoothedAnchor.boxW * (1 - alpha) + next.boxW * alpha;
  return smoothedAnchor;
}

function anchorOverEyes(landmarks, w, h, ctx, dpr, pad) {
  const L = landmarks[33], R = landmarks[263];
  const UL = landmarks[159], UR = landmarks[386];
  const cx = ((L.x + R.x) / 2) * w;
  const cy = ((UL.y + UR.y) / 2) * h;
  const eyeSpanPx = Math.abs(R.x - L.x) * w;
  const minBoxW = computeMinBoxW(ctx, dpr, pad);
  const boxW = Math.max(minBoxW, Math.min(w * 0.9, eyeSpanPx * 2.2));
  return { cx, cy, boxW };
}

function drawPhaseBanner(ctx, display, w, h, landmarks) {
  if (!display || display.phase === "idle") {
    smoothedAnchor = null;
    return;
  }
  const dpr = devicePixelRatio || 1;
  const pad = Math.round(14 * dpr);
  const { action, subtext, progress, phase } = display;

  let cx, cy, boxW, overEyes;
  if (landmarks) {
    const smooth = smoothAnchor(anchorOverEyes(landmarks, w, h, ctx, dpr, pad));
    cx = smooth.cx; cy = smooth.cy; boxW = smooth.boxW;
    overEyes = true;
  } else {
    smoothedAnchor = null;
    const minBoxW = computeMinBoxW(ctx, dpr, pad);
    boxW = Math.max(minBoxW, Math.min(w * 0.7, 620 * dpr));
    cx = w / 2; cy = 0;
    overEyes = false;
  }

  const actionPx = Math.max(18 * dpr, Math.min(30 * dpr, boxW * 0.11));
  const subtextPx = Math.max(11 * dpr, Math.min(14 * dpr, boxW * 0.055));
  const boxH = actionPx + subtextPx + pad * 3 + (progress != null ? 10 * dpr : 0);

  const rawBoxX = cx - boxW / 2;
  const rawBoxY = overEyes ? (cy - boxH / 2) : pad;
  const boxX = Math.max(0, Math.min(w - boxW, rawBoxX));
  const boxY = Math.max(0, Math.min(h - boxH, rawBoxY));
  const effectiveCx = boxX + boxW / 2;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  roundRect(ctx, boxX, boxY, boxW, boxH, 8 * dpr);
  ctx.fill();

  ctx.translate(effectiveCx, 0);
  ctx.scale(-1, 1);

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let actionColor;
  if (phase === "smile") {
    actionColor = "#ffd76a";
  } else if (phase === "release" || phase === "relax") {
    actionColor = "#9ef28f";
  } else {
    actionColor = "#ffffff";
  }
  ctx.fillStyle = actionColor;
  ctx.font = `${actionPx}px ui-monospace, Menlo, monospace`;
  ctx.fillText(action, 0, boxY + pad);

  ctx.fillStyle = "#cfcfcf";
  ctx.font = `${subtextPx}px ui-monospace, Menlo, monospace`;
  ctx.fillText(subtext, 0, boxY + pad + actionPx + pad / 2);

  ctx.restore();

  if (progress != null) {
    const barX = boxX + pad;
    const barW = boxW - pad * 2;
    const barY = boxY + boxH - pad;
    const barH = 3 * dpr;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(ctx, barX, barY, barW, barH, barH / 2);
    ctx.fill();
    ctx.fillStyle = "#7ad1ff";
    roundRect(ctx, barX, barY, Math.max(2 * dpr, barW * progress), barH, barH / 2);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function render(landmarks, ctx, w, h, snap, display) {
  ctx.clearRect(0, 0, w, h);
  if (landmarks) {
    for (const group of ROI_GROUPS) {
      if (!toggleState[group.key]) continue;
      for (const set of group.sets) {
        if (group.kind === "polyline") drawPolyline(ctx, landmarks, set, group.color, w, h);
        if (group.kind === "points")   drawPoints(ctx, landmarks, set, group.color, w, h);
        if (group.kind === "segments") drawSegments(ctx, landmarks, set, group.color, w, h);
      }
    }
    drawAnnotations(ctx, landmarks, snap, w, h);
  }
  drawPhaseBanner(ctx, display, w, h, landmarks);
}
