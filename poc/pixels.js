import {
  LEFT_CHEEK_APEX,
  RIGHT_CHEEK_APEX,
  LEFT_NASOLABIAL,
  RIGHT_NASOLABIAL,
  LEFT_INFRAORBITAL,
  RIGHT_INFRAORBITAL,
  FOREHEAD_REF,
} from "./rois.js";

export const PIXEL_ROIS = [
  { key: "cheek_left", indices: LEFT_CHEEK_APEX },
  { key: "cheek_right", indices: RIGHT_CHEEK_APEX },
  { key: "nasolabial_left", indices: LEFT_NASOLABIAL },
  { key: "nasolabial_right", indices: RIGHT_NASOLABIAL },
  { key: "infraorbital_left", indices: LEFT_INFRAORBITAL },
  { key: "infraorbital_right", indices: RIGHT_INFRAORBITAL },
  { key: "forehead", indices: FOREHEAD_REF },
];

export function srgbToLab(r, g, b) {
  const rn = sToLin(r / 255), gn = sToLin(g / 255), bn = sToLin(b / 255);
  const X = rn * 0.4124564 + gn * 0.3575761 + bn * 0.1804375;
  const Y = rn * 0.2126729 + gn * 0.7151522 + bn * 0.0721750;
  const Z = rn * 0.0193339 + gn * 0.1191920 + bn * 0.9503041;
  const xr = X / 0.95047, yr = Y / 1.0, zr = Z / 1.08883;
  const fx = f(xr), fy = f(yr), fz = f(zr);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function sToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function f(t) { return t > 216 / 24389 ? Math.cbrt(t) : (t * 24389 / 27 + 16) / 116; }

function pointInPolygon(x, y, polyX, polyY) {
  let inside = false;
  const n = polyX.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polyX[i], yi = polyY[i];
    const xj = polyX[j], yj = polyY[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonBBox(polyX, polyY) {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (let i = 0; i < polyX.length; i++) {
    if (polyX[i] < xMin) xMin = polyX[i];
    if (polyX[i] > xMax) xMax = polyX[i];
    if (polyY[i] < yMin) yMin = polyY[i];
    if (polyY[i] > yMax) yMax = polyY[i];
  }
  return { xMin: Math.floor(xMin), yMin: Math.floor(yMin), xMax: Math.ceil(xMax), yMax: Math.ceil(yMax) };
}

function sampleOneROI(imgData, W, H, polyX, polyY) {
  const bb = polygonBBox(polyX, polyY);
  const x0 = Math.max(0, bb.xMin - 1);
  const y0 = Math.max(0, bb.yMin - 1);
  const x1 = Math.min(W - 1, bb.xMax + 1);
  const y1 = Math.min(H - 1, bb.yMax + 1);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw <= 2 || bh <= 2) return { meanL: 0, edgeDensity: 0, n: 0 };

  const lBuf = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y + y0) * W + (x + x0)) * 4;
      const { L } = srgbToLab(imgData[i], imgData[i + 1], imgData[i + 2]);
      lBuf[y * bw + x] = L;
    }
  }

  let Lsum = 0, Lcount = 0, Esum = 0, Ecount = 0;
  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      const gx = x + x0, gy = y + y0;
      if (!pointInPolygon(gx, gy, polyX, polyY)) continue;
      const l = lBuf[y * bw + x];
      Lsum += l; Lcount++;
      const sx =
        -lBuf[(y - 1) * bw + (x - 1)] + lBuf[(y - 1) * bw + (x + 1)]
        - 2 * lBuf[y * bw + (x - 1)] + 2 * lBuf[y * bw + (x + 1)]
        - lBuf[(y + 1) * bw + (x - 1)] + lBuf[(y + 1) * bw + (x + 1)];
      const sy =
        -lBuf[(y - 1) * bw + (x - 1)] - 2 * lBuf[(y - 1) * bw + x] - lBuf[(y - 1) * bw + (x + 1)]
        + lBuf[(y + 1) * bw + (x - 1)] + 2 * lBuf[(y + 1) * bw + x] + lBuf[(y + 1) * bw + (x + 1)];
      Esum += Math.abs(sx) + Math.abs(sy);
      Ecount++;
    }
  }

  return {
    meanL: Lcount ? Lsum / Lcount : 0,
    edgeDensity: Ecount ? Esum / Ecount : 0,
    n: Lcount,
  };
}

export function sampleAllROIs(video, landmarks, videoW, videoH, scratchCanvas, scratchCtx) {
  if (!video || !landmarks) return null;
  if (!videoW || !videoH) return null;
  scratchCanvas.width = videoW;
  scratchCanvas.height = videoH;
  scratchCtx.drawImage(video, 0, 0, videoW, videoH);
  const imgData = scratchCtx.getImageData(0, 0, videoW, videoH).data;

  const out = {};
  for (const roi of PIXEL_ROIS) {
    const polyX = new Array(roi.indices.length);
    const polyY = new Array(roi.indices.length);
    for (let i = 0; i < roi.indices.length; i++) {
      const lm = landmarks[roi.indices[i]];
      polyX[i] = lm.x * videoW;
      polyY[i] = lm.y * videoH;
    }
    out[roi.key] = sampleOneROI(imgData, videoW, videoH, polyX, polyY);
  }
  return out;
}

export function createScratch() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return { canvas, ctx };
}

export function grabVideoFrameJpeg(video, canvas, ctx, quality = 0.9) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

export function diffSnapshots(neutral, peak) {
  if (!neutral || !peak) return null;
  const out = {};
  for (const roi of PIXEL_ROIS) {
    const n = neutral[roi.key];
    const p = peak[roi.key];
    if (!n || !p) continue;
    out[roi.key] = {
      dMeanL: p.meanL - n.meanL,
      dEdgeDensity: p.edgeDensity - n.edgeDensity,
      neutralN: n.n,
      peakN: p.n,
    };
  }
  return out;
}
