import {
  LEFT_NASOLABIAL,
  RIGHT_NASOLABIAL,
} from "./rois.js";
import { gate } from "./quality.js";

const LANDMARK_IOD_L = 33;
const LANDMARK_IOD_R = 263;
const LANDMARK_EYE_L_UPPER = 159;
const LANDMARK_EYE_L_LOWER = 145;
const LANDMARK_EYE_R_UPPER = 386;
const LANDMARK_EYE_R_LOWER = 374;
const LANDMARK_CHEEK_L = 205;
const LANDMARK_CHEEK_R = 425;

const MOVEMENT_SYMMETRY_LEFT = [205, 207, 187, 147, 61, 91, 57, 212];
const MOVEMENT_SYMMETRY_RIGHT = [425, 427, 411, 376, 291, 321, 287, 432];

function iod(landmarks) {
  const a = landmarks[LANDMARK_IOD_L];
  const b = landmarks[LANDMARK_IOD_R];
  return Math.hypot(a.x - b.x, a.y - b.y) || 1e-6;
}

export function normalize(landmarks) {
  const scale = iod(landmarks);
  const out = new Array(landmarks.length);
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    out[i] = { x: p.x / scale, y: p.y / scale, z: p.z / scale };
  }
  return out;
}

export function medianLandmarks(frames) {
  if (!frames.length) return null;
  const n = frames[0].landmarks.length;
  const out = new Array(n);
  const xs = new Float32Array(frames.length);
  const ys = new Float32Array(frames.length);
  const zs = new Float32Array(frames.length);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < frames.length; k++) {
      const p = frames[k].landmarks[i];
      xs[k] = p.x; ys[k] = p.y; zs[k] = p.z;
    }
    out[i] = { x: median(xs), y: median(ys), z: median(zs) };
  }
  return out;
}

function median(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function framesInPhase(capture, phase) {
  return capture.frames.filter((f) => f.phase === phase);
}

function peakFrame(capture) {
  const candidates = framesInPhase(capture, "smile");
  if (!candidates.length) return null;
  let best = candidates[0];
  for (const f of candidates) if (f.smile > best.smile) best = f;
  return best;
}

function yGap(lms, a, b, scale) {
  return Math.abs(lms[a].y - lms[b].y) / scale;
}

export function eyeApertureDelta(neutral, peak) {
  const sN = iod(neutral), sP = iod(peak);
  const L_n = yGap(neutral, LANDMARK_EYE_L_UPPER, LANDMARK_EYE_L_LOWER, sN);
  const L_p = yGap(peak,    LANDMARK_EYE_L_UPPER, LANDMARK_EYE_L_LOWER, sP);
  const R_n = yGap(neutral, LANDMARK_EYE_R_UPPER, LANDMARK_EYE_R_LOWER, sN);
  const R_p = yGap(peak,    LANDMARK_EYE_R_UPPER, LANDMARK_EYE_R_LOWER, sP);
  const dL = L_p - L_n;
  const dR = R_p - R_n;
  return { left: dL, right: dR, asymmetry: Math.abs(dL - dR) };
}

export function cheekLift(neutral, peak) {
  const sN = iod(neutral), sP = iod(peak);
  const yLN = neutral[LANDMARK_CHEEK_L].y / sN;
  const yRN = neutral[LANDMARK_CHEEK_R].y / sN;
  const yLP = peak[LANDMARK_CHEEK_L].y / sP;
  const yRP = peak[LANDMARK_CHEEK_R].y / sP;
  const left = yLN - yLP;
  const right = yRN - yRP;
  const mean = (left + right) / 2;
  const denom = Math.max(Math.abs(mean), 1e-6);
  const symmetry = 1 - Math.abs(left - right) / denom;
  return { left, right, symmetry };
}

function polylineLength(lms, indices, scale) {
  let s = 0;
  for (let i = 1; i < indices.length; i++) {
    const a = lms[indices[i - 1]], b = lms[indices[i]];
    s += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return s / scale;
}

function polylineTurningSum(lms, indices) {
  let sum = 0;
  for (let i = 1; i < indices.length - 1; i++) {
    const a = lms[indices[i - 1]], b = lms[indices[i]], c = lms[indices[i + 1]];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1e-9;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / mag));
    sum += Math.acos(cos);
  }
  return sum;
}

export function nasolabialResponse(neutral, peak) {
  const sN = iod(neutral), sP = iod(peak);
  const dLenL = polylineLength(peak, LEFT_NASOLABIAL, sP) - polylineLength(neutral, LEFT_NASOLABIAL, sN);
  const dLenR = polylineLength(peak, RIGHT_NASOLABIAL, sP) - polylineLength(neutral, RIGHT_NASOLABIAL, sN);
  const dCurvL = polylineTurningSum(peak, LEFT_NASOLABIAL) - polylineTurningSum(neutral, LEFT_NASOLABIAL);
  const dCurvR = polylineTurningSum(peak, RIGHT_NASOLABIAL) - polylineTurningSum(neutral, RIGHT_NASOLABIAL);
  return {
    left: { dLength: dLenL, dCurvature: dCurvL },
    right: { dLength: dLenR, dCurvature: dCurvR },
  };
}

export function stiffnessAndSymmetry(neutral, peakFrameObj) {
  const peak = peakFrameObj.landmarks;
  const sN = iod(neutral), sP = iod(peak);
  let sumL = 0, sumR = 0;
  for (let i = 0; i < MOVEMENT_SYMMETRY_LEFT.length; i++) {
    const iL = MOVEMENT_SYMMETRY_LEFT[i], iR = MOVEMENT_SYMMETRY_RIGHT[i];
    const dL = Math.hypot(
      peak[iL].x / sP - neutral[iL].x / sN,
      peak[iL].y / sP - neutral[iL].y / sN,
    );
    const dR = Math.hypot(
      peak[iR].x / sP - neutral[iR].x / sN,
      peak[iR].y / sP - neutral[iR].y / sN,
    );
    sumL += dL; sumR += dR;
  }
  const symmetryDenom = Math.max((sumL + sumR) / 2, 1e-6);
  const movementSymmetry = 1 - Math.abs(sumL - sumR) / symmetryDenom;

  const dyL = Math.abs(neutral[LANDMARK_CHEEK_L].y / sN - peak[LANDMARK_CHEEK_L].y / sP);
  const dyR = Math.abs(neutral[LANDMARK_CHEEK_R].y / sN - peak[LANDMARK_CHEEK_R].y / sP);
  const maxCheek = Math.max(dyL, dyR, 1e-4);
  const smilePeak = ((peakFrameObj.blendshapes.mouthSmileLeft ?? 0) + (peakFrameObj.blendshapes.mouthSmileRight ?? 0)) / 2;
  const stiffness = smilePeak / maxCheek;

  return { stiffness, movementSymmetry, smilePeak, cheekDisplacementLeft: dyL, cheekDisplacementRight: dyR };
}

export function rebound(capture, peakFrameObj) {
  const releaseFrames = [...framesInPhase(capture, "release"), ...framesInPhase(capture, "relax")];
  if (!releaseFrames.length) return { reboundMs: null, overshoot: null };
  const threshold = 0.15;
  let reboundMs = null;
  for (const f of releaseFrames) {
    if (f.smile < threshold) { reboundMs = f.t - peakFrameObj.t; break; }
  }
  const neutralRef = framesInPhase(capture, "neutral");
  if (!neutralRef.length) return { reboundMs, overshoot: null };
  const neutralMedian = medianLandmarks(neutralRef);
  const sN = iod(neutralMedian);
  const baselineY = (neutralMedian[LANDMARK_CHEEK_L].y / sN + neutralMedian[LANDMARK_CHEEK_R].y / sN) / 2;
  let maxOvershoot = 0;
  for (const f of releaseFrames) {
    const sF = iod(f.landmarks);
    const y = (f.landmarks[LANDMARK_CHEEK_L].y / sF + f.landmarks[LANDMARK_CHEEK_R].y / sF) / 2;
    const delta = y - baselineY;
    if (delta > Math.abs(maxOvershoot)) maxOvershoot = delta;
  }
  return { reboundMs, overshoot: maxOvershoot };
}

export function eyeSquintCrossCheck(neutralFrames, peakFrameObj) {
  if (!neutralFrames.length) return null;
  let sumL = 0, sumR = 0;
  for (const f of neutralFrames) {
    sumL += f.blendshapes.eyeSquintLeft ?? 0;
    sumR += f.blendshapes.eyeSquintRight ?? 0;
  }
  const baseL = sumL / neutralFrames.length;
  const baseR = sumR / neutralFrames.length;
  return {
    squintDeltaLeft: (peakFrameObj.blendshapes.eyeSquintLeft ?? 0) - baseL,
    squintDeltaRight: (peakFrameObj.blendshapes.eyeSquintRight ?? 0) - baseR,
  };
}

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

function poseStats(frames) {
  if (!frames.length) return { yaw: 0, pitch: 0, roll: 0 };
  let yMin = Infinity, yMax = -Infinity, pMin = Infinity, pMax = -Infinity, rMin = Infinity, rMax = -Infinity;
  for (const f of frames) {
    const { yaw, pitch, roll } = poseFromMatrix(f.transform);
    if (yaw < yMin) yMin = yaw; if (yaw > yMax) yMax = yaw;
    if (pitch < pMin) pMin = pitch; if (pitch > pMax) pMax = pitch;
    if (roll < rMin) rMin = roll; if (roll > rMax) rMax = roll;
  }
  return { yawRange: yMax - yMin, pitchRange: pMax - pMin, rollRange: rMax - rMin };
}

export function extract(capture, baseline = null) {
  const neutralFrames = framesInPhase(capture, "neutral");
  const smileFrames = framesInPhase(capture, "smile");
  const releaseFrames = framesInPhase(capture, "release");
  const relaxFrames = framesInPhase(capture, "relax");
  const peak = peakFrame(capture);

  const quality = gate(capture, baseline);

  if (!neutralFrames.length || !peak) {
    return {
      error: "missing phases",
      neutralFrames: neutralFrames.length,
      hasPeak: !!peak,
      quality,
    };
  }

  const neutralMedian = medianLandmarks(neutralFrames);
  const plateauMedian = smileFrames.length ? medianLandmarks(smileFrames) : peak.landmarks;

  const eye = eyeApertureDelta(neutralMedian, plateauMedian);
  const cheek = cheekLift(neutralMedian, plateauMedian);
  const nasolabial = nasolabialResponse(neutralMedian, plateauMedian);
  const stiff = stiffnessAndSymmetry(neutralMedian, peak);
  const reb = rebound(capture, peak);
  const squint = eyeSquintCrossCheck(neutralFrames, peak);
  const pose = poseStats(capture.frames);

  return {
    schema: "smile_v0.1",
    quality,
    normalization: {
      iodNeutral: iod(neutralMedian),
      iodPeak: iod(plateauMedian),
      frames: {
        neutral: neutralFrames.length,
        smile: smileFrames.length,
        release: releaseFrames.length,
        relax: relaxFrames.length,
        total: capture.frames.length,
      },
      poseRangesDeg: pose,
    },
    smile: {
      eyeApertureDelta: eye,
      cheekLift: cheek,
      nasolabialResponse: nasolabial,
      movementSymmetry: stiff.movementSymmetry,
      stiffness: stiff.stiffness,
      smilePeak: stiff.smilePeak,
      cheekDisplacement: { left: stiff.cheekDisplacementLeft, right: stiff.cheekDisplacementRight },
      rebound: reb,
      eyeSquintCrossCheck: squint,
      shadowRedistribution: shadowRedistributionFromPixelDiff(capture.pixelDiff),
      foldVisibility: foldVisibilityFromPixelDiff(capture.pixelDiff),
    },
  };
}

function shadowRedistributionFromPixelDiff(diff) {
  if (!diff) return null;
  const out = {};
  for (const key of Object.keys(diff)) {
    out[key] = { dMeanL: diff[key].dMeanL };
  }
  return out;
}

function foldVisibilityFromPixelDiff(diff) {
  if (!diff) return null;
  const out = {};
  for (const key of Object.keys(diff)) {
    out[key] = { dEdgeDensity: diff[key].dEdgeDensity };
  }
  return out;
}
