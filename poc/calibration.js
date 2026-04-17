import { toBlendshapeMap } from "./hud.js";

const STORAGE_KEY = "smile_poc_baseline_v1";
const CFG = {
  countdownMs: 2000,
  sampleMs: 4000,
};

const POSE_MARGIN_DEG = 6;
const BBOX_IOU_MARGIN = 0.05;
const BLINK_THRESHOLD_FLOOR = 0.5;

export const CALIB_DISPLAY = {
  idle: { action: "", subtext: "", record: false },
  calib_countdown: { action: "Calibrating · get ready", subtext: "sit still, relaxed face", record: false },
  calib_sample: { action: "Hold still", subtext: "measuring your resting baseline", record: true },
  calib_done: { action: "Calibrated", subtext: "thresholds set from your baseline", record: false },
};

export const CALIB_DURATIONS_MS = {
  calib_countdown: CFG.countdownMs,
  calib_sample: CFG.sampleMs,
};

function poseFromMatrix(d) {
  if (!d || d.length < 12) return { yaw: 0, pitch: 0, roll: 0 };
  const mat = (r, c) => d[r + 4 * c];
  const deg = (x) => (x * 180) / Math.PI;
  return {
    yaw: deg(Math.atan2(mat(0, 2), mat(2, 2))),
    pitch: deg(Math.asin(Math.max(-1, Math.min(1, -mat(1, 2))))),
    roll: deg(Math.atan2(mat(1, 0), mat(1, 1))),
  };
}

function bbox(landmarks) {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const p of landmarks) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  return { xMin, yMin, xMax, yMax };
}

function bboxIoU(a, b) {
  const ixMin = Math.max(a.xMin, b.xMin);
  const iyMin = Math.max(a.yMin, b.yMin);
  const ixMax = Math.min(a.xMax, b.xMax);
  const iyMax = Math.min(a.yMax, b.yMax);
  const iw = Math.max(0, ixMax - ixMin);
  const ih = Math.max(0, iyMax - iyMin);
  const inter = iw * ih;
  const aa = (a.xMax - a.xMin) * (a.yMax - a.yMin);
  const bb = (b.xMax - b.xMin) * (b.yMax - b.yMin);
  const union = aa + bb - inter;
  return union > 0 ? inter / union : 0;
}

export function loadBaseline() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveBaseline(baseline) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline)); } catch { /* ignore */ }
}

export function clearBaseline() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function createCalibrationController({ onPhaseChange, onDone }) {
  let phase = "idle";
  let phaseStartedAt = 0;
  let samples = [];
  let latestT = 0;

  function setPhase(next, t) {
    phase = next;
    phaseStartedAt = t;
    if (onPhaseChange) onPhaseChange(next);
  }

  function start() {
    samples = [];
    const t = performance.now();
    latestT = t;
    setPhase("calib_countdown", t);
  }

  function feed(t, result) {
    latestT = t;
    if (phase === "idle" || phase === "calib_done") return;

    if (phase === "calib_countdown") {
      if (t - phaseStartedAt >= CFG.countdownMs) setPhase("calib_sample", t);
      return;
    }

    if (phase === "calib_sample") {
      const landmarks = result.faceLandmarks?.[0];
      if (landmarks) {
        const blendshapes = toBlendshapeMap(result.faceBlendshapes?.[0]?.categories);
        const matrix = result.facialTransformationMatrixes?.[0]?.data;
        samples.push({
          pose: poseFromMatrix(matrix),
          blink: ((blendshapes.eyeBlinkLeft ?? 0) + (blendshapes.eyeBlinkRight ?? 0)) / 2,
          smile: ((blendshapes.mouthSmileLeft ?? 0) + (blendshapes.mouthSmileRight ?? 0)) / 2,
          bbox: bbox(landmarks),
        });
      }
      if (t - phaseStartedAt >= CFG.sampleMs) {
        const baseline = summarize(samples);
        saveBaseline(baseline);
        setPhase("calib_done", t);
        if (onDone) onDone(baseline);
      }
    }
  }

  function getDisplay() {
    const display = CALIB_DISPLAY[phase] ?? CALIB_DISPLAY.idle;
    const duration = CALIB_DURATIONS_MS[phase];
    const elapsed = latestT - phaseStartedAt;
    let action = display.action;
    let progress = null;
    if (phase === "calib_countdown") {
      const remaining = Math.max(0, CFG.countdownMs - elapsed);
      action = `Calibrating · ${Math.ceil(remaining / 1000)}`;
      progress = Math.min(1, elapsed / CFG.countdownMs);
    } else if (duration != null) {
      progress = Math.min(1, elapsed / duration);
    }
    return { phase, action, subtext: display.subtext, progress };
  }

  function getPhase() { return phase; }

  return { start, feed, getPhase, getDisplay };
}

function range(values) {
  if (!values.length) return 0;
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  return max - min;
}

function maxBy(values) {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

function mean(values) {
  if (!values.length) return 0;
  let s = 0; for (const v of values) s += v; return s / values.length;
}

function summarize(samples) {
  if (!samples.length) return null;
  const yawRange = range(samples.map((s) => s.pose.yaw));
  const pitchRange = range(samples.map((s) => s.pose.pitch));
  const rollRange = range(samples.map((s) => s.pose.roll));
  const blinkMax = maxBy(samples.map((s) => s.blink));
  const blinkMean = mean(samples.map((s) => s.blink));
  const smileMean = mean(samples.map((s) => s.smile));

  const baselineBBox = samples[0].bbox;
  let minIoU = 1;
  for (const s of samples) {
    const iou = bboxIoU(baselineBBox, s.bbox);
    if (iou < minIoU) minIoU = iou;
  }

  const poseMax = Math.max(yawRange, pitchRange, rollRange);
  return {
    at: new Date().toISOString(),
    samples: samples.length,
    rawRanges: { yaw: yawRange, pitch: pitchRange, roll: rollRange },
    restingBlink: { mean: blinkMean, max: blinkMax },
    restingSmile: smileMean,
    restingBBoxMinIoU: minIoU,
    limits: {
      poseRangeDeg: Math.max(10, poseMax + POSE_MARGIN_DEG),
      bboxIouMin: Math.max(0.7, Math.min(0.95, minIoU - BBOX_IOU_MARGIN)),
      blinkThreshold: Math.max(BLINK_THRESHOLD_FLOOR, blinkMax + 0.15),
    },
  };
}
