import { toBlendshapeMap } from "./hud.js";

export const PHASES = ["idle", "countdown", "neutral", "smile", "release", "relax", "done"];

const CFG = {
  countdownMs: 2500,
  neutralMs: 1500,
  smileMs: 2750,
  releaseMs: 1200,
  relaxMs: 3000,
};

export const PHASE_DURATIONS_MS = {
  countdown: CFG.countdownMs,
  neutral: CFG.neutralMs,
  smile: CFG.smileMs,
  release: CFG.releaseMs,
  relax: CFG.relaxMs,
};

export const PHASE_DISPLAY = {
  idle: { action: "Ready", subtext: "click Start capture", record: false },
  countdown: { action: "Get ready", subtext: "face the camera, relaxed", record: false },
  neutral: { action: "Neutral", subtext: "stay still, neutral face", record: true },
  smile: { action: "Smile", subtext: "big natural smile and hold", record: true },
  release: { action: "Release", subtext: "let the smile drop", record: true },
  relax: { action: "Relax", subtext: "face back to neutral", record: true },
  done: { action: "Done", subtext: "processing…", record: false },
};

function cloneLandmarks(lms) {
  const out = new Array(lms.length);
  for (let i = 0; i < lms.length; i++) {
    const p = lms[i];
    out[i] = { x: p.x, y: p.y, z: p.z };
  }
  return out;
}

export function createCaptureController({ onPhaseChange, onDone }) {
  let phase = "idle";
  let phaseStartedAt = 0;
  let captureStartedAt = 0;
  const frames = [];
  let latestT = 0;

  function setPhase(next, t) {
    phase = next;
    phaseStartedAt = t;
    if (onPhaseChange) onPhaseChange(next);
  }

  function start() {
    const t = performance.now();
    frames.length = 0;
    captureStartedAt = t;
    latestT = t;
    setPhase("countdown", t);
  }

  function cancel() {
    setPhase("idle", performance.now());
  }

  function feed(t, result) {
    latestT = t;
    if (phase === "idle" || phase === "done") return;

    if (phase === "countdown") {
      if (t - phaseStartedAt >= CFG.countdownMs) setPhase("neutral", t);
      return;
    }

    const landmarks = result.faceLandmarks?.[0];
    let smile = 0;
    if (landmarks) {
      const blendshapes = toBlendshapeMap(result.faceBlendshapes?.[0]?.categories);
      const matrixSrc = result.facialTransformationMatrixes?.[0]?.data;
      const transform = matrixSrc ? Array.from(matrixSrc) : null;
      smile = ((blendshapes.mouthSmileLeft ?? 0) + (blendshapes.mouthSmileRight ?? 0)) / 2;

      if (PHASE_DISPLAY[phase].record) {
        frames.push({
          t,
          phase,
          landmarks: cloneLandmarks(landmarks),
          blendshapes,
          transform,
          smile,
        });
      }
    }

    const sinceStart = t - phaseStartedAt;

    if (phase === "neutral") {
      if (sinceStart >= CFG.neutralMs) setPhase("smile", t);
    } else if (phase === "smile") {
      if (sinceStart >= CFG.smileMs) setPhase("release", t);
    } else if (phase === "release") {
      if (sinceStart >= CFG.releaseMs) setPhase("relax", t);
    } else if (phase === "relax") {
      if (sinceStart >= CFG.relaxMs) finish(t, "ok");
    }
  }

  function finish(t, reason) {
    setPhase("done", t);
    const result = {
      reason,
      startedAt: captureStartedAt,
      endedAt: t,
      frames: frames.slice(),
      phases: summarizePhases(frames),
    };
    if (onDone) onDone(result);
  }

  function getPhase() { return phase; }

  function getDisplay() {
    const display = PHASE_DISPLAY[phase] ?? PHASE_DISPLAY.idle;
    const duration = PHASE_DURATIONS_MS[phase];
    const elapsed = latestT - phaseStartedAt;
    let action = display.action;
    let subtext = display.subtext;
    let progress = null;

    if (phase === "countdown") {
      const remaining = Math.max(0, CFG.countdownMs - elapsed);
      action = `Get ready · ${Math.ceil(remaining / 1000)}`;
      progress = Math.min(1, elapsed / CFG.countdownMs);
    } else if (phase === "smile") {
      const remaining = Math.max(0, CFG.smileMs - elapsed);
      action = `Smile · ${Math.ceil(remaining / 1000)}`;
      progress = Math.min(1, elapsed / CFG.smileMs);
    } else if (phase === "relax") {
      const remaining = Math.max(0, CFG.relaxMs - elapsed);
      action = `Relax · ${Math.ceil(remaining / 1000)}`;
      progress = Math.min(1, elapsed / CFG.relaxMs);
    } else if (duration != null) {
      progress = Math.min(1, elapsed / duration);
    }

    return { phase, action, subtext, progress };
  }

  return { start, cancel, feed, getPhase, getDisplay };
}

function summarizePhases(frames) {
  const bounds = {};
  for (let i = 0; i < frames.length; i++) {
    const p = frames[i].phase;
    if (!bounds[p]) bounds[p] = { first: i, last: i };
    else bounds[p].last = i;
  }
  return bounds;
}
