import {
  LEFT_CHEEK_APEX,
  RIGHT_CHEEK_APEX,
  LEFT_NASOLABIAL,
  RIGHT_NASOLABIAL,
  LEFT_INFRAORBITAL,
  RIGHT_INFRAORBITAL,
  FOREHEAD_REF,
} from "./rois.js";

export const ROI_GROUPS = [
  { key: "cheek",        label: "cheeks",        color: "#ff3b3b", kind: "polygon",  sets: [LEFT_CHEEK_APEX, RIGHT_CHEEK_APEX] },
  { key: "nasolabial",   label: "nasolabial",    color: "#ffcc00", kind: "polyline", sets: [LEFT_NASOLABIAL, RIGHT_NASOLABIAL] },
  { key: "infraorbital", label: "infraorbital",  color: "#00c3ff", kind: "polygon",  sets: [LEFT_INFRAORBITAL, RIGHT_INFRAORBITAL] },
  { key: "forehead",     label: "forehead ref",  color: "#9ef28f", kind: "polygon",  sets: [FOREHEAD_REF] },
  { key: "eyes",         label: "eye aperture",  color: "#c78bff", kind: "segments", sets: [[[159, 145]], [[386, 374]]] },
];

export const toggleState = Object.fromEntries(ROI_GROUPS.map((g) => [g.key, true]));

function toPx(lm, w, h) {
  return { x: lm.x * w, y: lm.y * h };
}

function drawPolygon(ctx, landmarks, indices, color, w, h) {
  if (!indices.length) return;
  ctx.beginPath();
  const first = toPx(landmarks[indices[0]], w, h);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < indices.length; i++) {
    const p = toPx(landmarks[indices[i]], w, h);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = color + "22";
  ctx.fill();
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

function drawPhaseBanner(ctx, display, w, h) {
  if (!display || display.phase === "idle") return;
  const { action, subtext, progress, phase } = display;
  const dpr = devicePixelRatio || 1;
  const pad = Math.round(14 * dpr);
  const actionPx = Math.round(30 * dpr);
  const subtextPx = Math.round(14 * dpr);
  const boxW = Math.round(Math.min(w * 0.7, 620 * dpr));
  const boxH = actionPx + subtextPx + pad * 3 + (progress != null ? 10 * dpr : 0);
  const boxX = (w - boxW) / 2;
  const boxY = pad;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  roundRect(ctx, boxX, boxY, boxW, boxH, 8 * dpr);
  ctx.fill();

  ctx.translate(w / 2, 0);
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
    const barH = 4 * dpr;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(ctx, barX, barY, barW, barH, barH / 2);
    ctx.fill();
    ctx.fillStyle = "#7ad1ff";
    roundRect(ctx, barX, barY, Math.max(2 * dpr, barW * progress), barH, barH / 2);
    ctx.fill();
  }
  ctx.restore();
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
        if (group.kind === "polygon")  drawPolygon(ctx, landmarks, set, group.color, w, h);
        if (group.kind === "polyline") drawPolyline(ctx, landmarks, set, group.color, w, h);
        if (group.kind === "segments") drawSegments(ctx, landmarks, set, group.color, w, h);
      }
    }
    drawAnnotations(ctx, landmarks, snap, w, h);
  }
  drawPhaseBanner(ctx, display, w, h);
}
