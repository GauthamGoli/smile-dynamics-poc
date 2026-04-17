const DEFAULT_LIMITS = {
  poseRangeDeg: 15,
  bboxIouMin: 0.88,
  blinkFracMax: 0.25,
  blinkThreshold: 0.6,
  smilePeakFloor: 0.35,
  smileHoldDropFrac: 0.3,
  poseDriftDeg: 8,
  missingFaceFrac: 0.05,
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

function poseRanges(frames) {
  let yMin = Infinity, yMax = -Infinity, pMin = Infinity, pMax = -Infinity, rMin = Infinity, rMax = -Infinity;
  for (const f of frames) {
    const { yaw, pitch, roll } = poseFromMatrix(f.transform);
    if (yaw < yMin) yMin = yaw; if (yaw > yMax) yMax = yaw;
    if (pitch < pMin) pMin = pitch; if (pitch > pMax) pMax = pitch;
    if (roll < rMin) rMin = roll; if (roll > rMax) rMax = roll;
  }
  return {
    yaw: yMax - yMin,
    pitch: pMax - pMin,
    roll: rMax - rMin,
  };
}

function faceBBox(landmarks) {
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

function minBBoxIoUWithin(frames) {
  if (frames.length < 2) return 1;
  const bboxes = frames.map((f) => faceBBox(f.landmarks));
  const baseline = bboxes[0];
  let min = 1;
  for (let i = 1; i < bboxes.length; i++) {
    const iou = bboxIoU(baseline, bboxes[i]);
    if (iou < min) min = iou;
  }
  return min;
}

function worstPerPhaseIoU(capture) {
  const perPhase = {};
  let worst = 1;
  for (const phase of ["neutral", "smile", "release", "relax"]) {
    const frames = byPhase(capture, phase);
    if (frames.length < 2) continue;
    const iou = minBBoxIoUWithin(frames);
    perPhase[phase] = iou;
    if (iou < worst) worst = iou;
  }
  return { worst, perPhase };
}

function blinkFraction(frames, threshold) {
  if (!frames.length) return 0;
  let n = 0;
  for (const f of frames) {
    const l = f.blendshapes.eyeBlinkLeft ?? 0;
    const r = f.blendshapes.eyeBlinkRight ?? 0;
    if ((l + r) / 2 > threshold) n++;
  }
  return n / frames.length;
}

function byPhase(capture, phase) {
  return capture.frames.filter((f) => f.phase === phase);
}

function meanPose(frames) {
  if (!frames.length) return { yaw: 0, pitch: 0, roll: 0 };
  let y = 0, p = 0, r = 0;
  for (const f of frames) {
    const pose = poseFromMatrix(f.transform);
    y += pose.yaw; p += pose.pitch; r += pose.roll;
  }
  return { yaw: y / frames.length, pitch: p / frames.length, roll: r / frames.length };
}

export function gate(capture, baseline = null) {
  const limits = { ...DEFAULT_LIMITS };
  if (baseline?.limits) {
    if (Number.isFinite(baseline.limits.poseRangeDeg)) limits.poseRangeDeg = baseline.limits.poseRangeDeg;
    if (Number.isFinite(baseline.limits.bboxIouMin)) limits.bboxIouMin = baseline.limits.bboxIouMin;
    if (Number.isFinite(baseline.limits.blinkThreshold)) limits.blinkThreshold = baseline.limits.blinkThreshold;
  }

  const flags = [];
  const metrics = { limits };
  const checks = [];

  const neutral = byPhase(capture, "neutral");
  const smile = byPhase(capture, "smile");
  const release = byPhase(capture, "release");
  const relax = byPhase(capture, "relax");

  if (!neutral.length) flags.push("no_neutral");
  if (!smile.length) flags.push("no_smile");
  if (!release.length) flags.push("no_release");
  if (!relax.length) flags.push("no_relax");

  if (capture.frames.length) {
    const pose = poseRanges(capture.frames);
    metrics.poseRanges = pose;
    const poseMax = Math.max(pose.yaw, pose.pitch, pose.roll);
    const poseOk = poseMax <= limits.poseRangeDeg;
    checks.push({ name: "pose_range", value: poseMax, limit: limits.poseRangeDeg, ok: poseOk });
    if (!poseOk) flags.push("pose_excess");

    const iouResult = worstPerPhaseIoU(capture);
    metrics.minBBoxIoUPerPhase = iouResult.perPhase;
    metrics.worstBBoxIoU = iouResult.worst;
    const iouOk = iouResult.worst >= limits.bboxIouMin;
    checks.push({ name: "bbox_iou", value: iouResult.worst, limit: limits.bboxIouMin, ok: iouOk, comparator: ">=" });
    if (!iouOk) flags.push("frame_shift");
  }

  if (neutral.length) {
    const bf = blinkFraction(neutral, limits.blinkThreshold);
    metrics.blinkFractionNeutral = bf;
    const bfOk = bf <= limits.blinkFracMax;
    checks.push({ name: "blink_frac", value: bf, limit: limits.blinkFracMax, ok: bfOk });
    if (!bfOk) flags.push("blinky_neutral");
  }

  const smilePool = smile;
  let smilePeak = 0;
  for (const f of smilePool) if (f.smile > smilePeak) smilePeak = f.smile;
  metrics.smilePeak = smilePeak;
  const peakOk = smilePeak >= limits.smilePeakFloor;
  checks.push({ name: "smile_peak", value: smilePeak, limit: limits.smilePeakFloor, ok: peakOk, comparator: ">=" });
  if (!peakOk) flags.push("weak_smile");

  if (smile.length) {
    const holdFloor = Math.max(0.25, smilePeak * 0.6);
    let dropped = 0;
    for (const f of smile) if (f.smile < holdFloor) dropped++;
    const dropFrac = dropped / smile.length;
    metrics.smileDropFracInHold = dropFrac;
    const holdOk = dropFrac <= limits.smileHoldDropFrac;
    checks.push({ name: "smile_hold", value: dropFrac, limit: limits.smileHoldDropFrac, ok: holdOk });
    if (!holdOk) flags.push("smile_dropped_in_smile");
  }

  if (neutral.length && smile.length) {
    const mRelax = meanPose(neutral);
    const mHold = meanPose(smile);
    const drift = Math.max(
      Math.abs(mHold.yaw - mRelax.yaw),
      Math.abs(mHold.pitch - mRelax.pitch),
      Math.abs(mHold.roll - mRelax.roll),
    );
    metrics.poseDriftDeg = drift;
    const driftOk = drift <= limits.poseDriftDeg;
    checks.push({ name: "pose_drift", value: drift, limit: limits.poseDriftDeg, ok: driftOk });
    if (!driftOk) flags.push("pose_drift");
  }

  const expectedFrames = capture.frames.length;
  const framesWithFace = capture.frames.filter((f) => f.landmarks && f.landmarks.length).length;
  const missingFrac = expectedFrames ? 1 - framesWithFace / expectedFrames : 0;
  metrics.missingFaceFrac = missingFrac;
  const faceOk = missingFrac <= limits.missingFaceFrac;
  checks.push({ name: "face_presence", value: missingFrac, limit: limits.missingFaceFrac, ok: faceOk });
  if (!faceOk) flags.push("face_missing");

  const maxPossibleFlags = 10;
  const score = Math.max(0, 1 - flags.length / maxPossibleFlags);
  return { score, flags, metrics, checks };
}
