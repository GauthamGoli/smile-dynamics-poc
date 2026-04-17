import { FaceLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";
import { log, setStatus, showError } from "./ui.js";
import { render as drawOverlay, ROI_GROUPS, toggleState, annotateState } from "./draw.js";
import * as hud from "./hud.js";
import { createCaptureController } from "./capture.js";
import { extract } from "./features.js";
import { createCalibrationController, loadBaseline, clearBaseline } from "./calibration.js";
import { createScratch, sampleAllROIs, diffSnapshots, grabVideoFrameJpeg } from "./pixels.js";
import { flattenVectorKeys, getPath } from "./repeatability.js";
import {
  computeMedianVectors, fetchBaseline, computeZScores,
  postSession, fetchSessions, deleteSession,
  renderSessionCard, renderSessionHistory, renderTrendCharts,
} from "./session.js";

window.__rings = hud.getRings();
window.__runningStats = hud.runningStats;
console.log("debug: window.__rings and window.__runningStats exposed");

const WASM_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_PATH = "./vendor/face_landmarker.task";

const video = document.getElementById("cam");
const overlay = document.getElementById("overlay");
const fpsEl = document.getElementById("hud-fps");
const faceEl = document.getElementById("hud-face");

window.addEventListener("error", (e) => showError(String(e.error ?? e.message)));
window.addEventListener("unhandledrejection", (e) => showError(String(e.reason)));

function phaseDurations(capture) {
  const out = [];
  for (const [p, b] of Object.entries(capture.phases)) {
    const t0 = capture.frames[b.first].t;
    const t1 = capture.frames[b.last].t;
    out.push(`${p}:${Math.round(t1 - t0)}ms(${b.last - b.first + 1}f)`);
  }
  return out.join(" ");
}

function serializeCapture(capture) {
  return {
    reason: capture.reason,
    startedAt: capture.startedAt,
    endedAt: capture.endedAt,
    phases: capture.phases,
    frames: capture.frames.map((f) => ({
      t: f.t,
      phase: f.phase,
      smile: f.smile,
      blendshapes: f.blendshapes,
      transform: f.transform,
      landmarks: f.landmarks,
    })),
  };
}


function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace(/Z$/, "");
}

function pickPerson(titleText) {
  return new Promise((resolve, reject) => {
    const picker = document.getElementById("person-picker");
    const title = document.getElementById("picker-title");
    if (titleText) title.textContent = titleText;
    picker.classList.remove("hidden");
    const cleanup = () => {
      picker.classList.add("hidden");
      picker.querySelectorAll("[data-person]").forEach((b) => b.removeEventListener("click", onPick));
      picker.querySelector(".picker-cancel").removeEventListener("click", onCancel);
    };
    const onPick = (e) => { const p = e.currentTarget.dataset.person; cleanup(); resolve(p); };
    const onCancel = () => { cleanup(); reject(new Error("cancelled")); };
    picker.querySelectorAll("[data-person]").forEach((b) => b.addEventListener("click", onPick));
    picker.querySelector(".picker-cancel").addEventListener("click", onCancel);
  });
}

function dataUrlToBase64(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

window.__timestampSlug = timestampSlug;

async function startCamera() {
  setStatus("requesting camera…");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  log(`camera: ${settings.width}x${settings.height} @ ${settings.frameRate ?? "?"}fps`);

  await tryLockExposure(track);
  return track;
}

async function tryLockExposure(track) {
  const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  if (caps.exposureMode && caps.exposureMode.includes("manual")) {
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: "manual" }] });
      log("exposure lock: manual (applied)");
      return;
    } catch (err) {
      log(`exposure lock: manual rejected (${err.name})`);
    }
  }
  log("exposure lock: not supported in this browser — uncontrolled variable");
}

async function initLandmarker() {
  setStatus("loading face landmarker…");
  const resolver = await FilesetResolver.forVisionTasks(WASM_PATH);
  const landmarker = await FaceLandmarker.createFromOptions(resolver, {
    baseOptions: { modelAssetPath: MODEL_PATH },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  log("face landmarker ready");
  return landmarker;
}

function resizeOverlay() {
  const rect = overlay.getBoundingClientRect();
  overlay.width = Math.round(rect.width * devicePixelRatio);
  overlay.height = Math.round(rect.height * devicePixelRatio);
}

function buildToggles() {
  const host = document.getElementById("roi-toggles");
  host.innerHTML = "";
  for (const g of ROI_GROUPS) {
    const id = `toggle-${g.key}`;
    const label = document.createElement("label");
    label.innerHTML = `<span class="swatch" style="background:${g.color}"></span>
      <input type="checkbox" id="${id}" ${toggleState[g.key] ? "checked" : ""}/> ${g.label}`;
    label.querySelector("input").addEventListener("change", (e) => {
      toggleState[g.key] = e.target.checked;
    });
    host.appendChild(label);
  }
  const annotLabel = document.createElement("label");
  annotLabel.innerHTML = `<span class="swatch" style="background:#ffffff"></span>
    <input type="checkbox" id="toggle-annotations" ${annotateState.on ? "checked" : ""}/> on-face labels`;
  annotLabel.querySelector("input").addEventListener("change", (e) => {
    annotateState.on = e.target.checked;
  });
  host.appendChild(annotLabel);
}

function startRenderLoop(landmarker, getActiveController, getDisplay, pixelHooks) {
  const ctx = overlay.getContext("2d");
  const hudHost = document.getElementById("hud");
  let frameCount = 0;
  let lastFpsTick = performance.now();
  let lastLandmarksAt = 0;
  let prevPhase = "idle";
  let pendingSnap = null;

  function loop() {
    const now = performance.now();
    if (video.readyState >= 2) {
      const result = landmarker.detectForVideo(video, now);
      const landmarks = result.faceLandmarks && result.faceLandmarks.length ? result.faceLandmarks[0] : null;
      let snap = null;
      if (landmarks) {
        lastLandmarksAt = now;
        const blendshapes = hud.toBlendshapeMap(result.faceBlendshapes?.[0]?.categories);
        const matrix = result.facialTransformationMatrixes?.[0]?.data;
        const pose = hud.poseFromMatrix(matrix);
        const geom = hud.geometricReadouts(landmarks);
        snap = hud.update(hudHost, { blendshapes, pose, geom });
      }
      const active = getActiveController();
      if (active) active.feed(now, result);

      if (pixelHooks) {
        const display = getDisplay();
        const curPhase = display.phase;
        if (prevPhase === "neutral" && curPhase === "smile") pendingSnap = "neutral";
        if (prevPhase === "smile" && curPhase === "release") pendingSnap = "peak";
        prevPhase = curPhase;
        if (pendingSnap && landmarks) {
          if (pendingSnap === "neutral") pixelHooks.onNeutral(landmarks);
          else if (pendingSnap === "peak") pixelHooks.onPeak(landmarks);
          pendingSnap = null;
        }
      }

      drawOverlay(landmarks, ctx, overlay.width, overlay.height, snap, getDisplay());
      frameCount++;
    }

    if (now - lastFpsTick >= 1000) {
      const fps = (frameCount * 1000) / (now - lastFpsTick);
      fpsEl.textContent = fps.toFixed(1);
      faceEl.textContent = now - lastLandmarksAt < 500 ? "yes" : "no";
      frameCount = 0;
      lastFpsTick = now;
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

async function main() {
  try {
    resizeOverlay();
    window.addEventListener("resize", resizeOverlay);
    const stageEl = document.querySelector(".stage");
    const ro = new ResizeObserver(resizeOverlay);
    ro.observe(stageEl);
    buildToggles();
    const [, landmarker] = await Promise.all([startCamera(), initLandmarker()]);

    const state = {
      baseline: loadBaseline(),
      activeController: null,
      lastCapture: null,
      pixelSnapshots: { neutral: null, peak: null },
      pendingResolver: null,
      restBanner: null,
      lastSession: null,
      currentSession: null,
      neutralJpeg: null,
      capturedJpegsPerRun: [],
    };
    const scratch = createScratch();

    function snapSummary(snap) {
      if (!snap) return "null";
      const keys = Object.keys(snap);
      const nonZero = keys.filter((k) => snap[k].n > 0).length;
      const example = keys.find((k) => snap[k].n > 0);
      const ex = example ? `${example}: L=${snap[example].meanL.toFixed(1)} edge=${snap[example].edgeDensity.toFixed(1)} n=${snap[example].n}` : "no-nonzero";
      return `${nonZero}/${keys.length} rois, ${ex}`;
    }

    function formatBytes(n) {
      if (n < 1024) return `${n}B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
      return `${(n / (1024 * 1024)).toFixed(2)}MB`;
    }

    const pixelHooks = {
      onNeutral: (landmarks) => {
        if (state.activeController !== capture) return;
        const t0 = performance.now();
        const snap = sampleAllROIs(video, landmarks, video.videoWidth, video.videoHeight, scratch.canvas, scratch.ctx);
        state.pixelSnapshots.neutral = snap;
        const jpeg = grabVideoFrameJpeg(video, scratch.canvas, scratch.ctx, 0.9);
        state.neutralJpeg = jpeg;
        const jpegNote = jpeg ? ` + jpeg ${formatBytes(jpeg.length)}` : "";
        log(`neutral snap (${(performance.now() - t0).toFixed(1)} ms) — ${snapSummary(snap)}${jpegNote}`);
      },
      onPeak: (landmarks) => {
        if (state.activeController !== capture) return;
        const t0 = performance.now();
        const snap = sampleAllROIs(video, landmarks, video.videoWidth, video.videoHeight, scratch.canvas, scratch.ctx);
        state.pixelSnapshots.peak = snap;
        log(`peak snap (${(performance.now() - t0).toFixed(1)} ms) — ${snapSummary(snap)}`);
      },
    };

    const calibrateBtn = document.getElementById("btn-calibrate");
    const captureBtn = document.getElementById("btn-capture");

    function refreshBaselineLabel() {
      if (state.baseline) {
        calibrateBtn.textContent = `Recalibrate (pose≤${state.baseline.limits.poseRangeDeg.toFixed(0)}°)`;
      } else {
        calibrateBtn.textContent = "Calibrate";
      }
    }
    refreshBaselineLabel();

    const calib = createCalibrationController({
      onPhaseChange: (p) => { setStatus(`calib: ${p}`); log(`calib phase → ${p}`); },
      onDone: (baseline) => {
        state.baseline = baseline;
        log(`calibrated: pose≤${baseline.limits.poseRangeDeg.toFixed(1)}°, bboxIoU≥${baseline.limits.bboxIouMin.toFixed(3)}, blinkThr=${baseline.limits.blinkThreshold.toFixed(2)}`);
        refreshBaselineLabel();
        calibrateBtn.disabled = false;
        captureBtn.disabled = false;
        setTimeout(() => { state.activeController = null; }, 500);
      },
    });

    const capture = createCaptureController({
      onPhaseChange: (p) => {
        setStatus(`capture: ${p}`);
        log(`phase → ${p}`);
        if (p === "countdown") {
          state.pixelSnapshots = { neutral: null, peak: null };
          state.neutralJpeg = null;
        }
      },
      onDone: (res) => {
        const pixelDiff = diffSnapshots(state.pixelSnapshots.neutral, state.pixelSnapshots.peak);
        const enriched = { ...res, pixelSnapshots: state.pixelSnapshots, pixelDiff };
        const vectors = extract(enriched, state.baseline);
        state.lastCapture = { capture: enriched, vectors };
        log(`trial done (${res.reason}) frames=${res.frames.length}`);
        setTimeout(() => { state.activeController = null; }, 300);
        if (state.pendingResolver) {
          const resolve = state.pendingResolver;
          state.pendingResolver = null;
          resolve(vectors);
        }
      },
    });

    function runSingleCapture() {
      return new Promise((resolve) => {
        state.pendingResolver = resolve;
        state.activeController = capture;
        capture.start();
      });
    }

    calibrateBtn.disabled = false;
    captureBtn.disabled = false;
    calibrateBtn.addEventListener("click", () => {
      calibrateBtn.disabled = true;
      captureBtn.disabled = true;
      state.activeController = calib;
      calib.start();
    });
    captureBtn.addEventListener("click", async () => {
      if (captureBtn.disabled) return;
      let person;
      try { person = await pickPerson("Who's capturing? (3 trials)"); } catch { return; }
      const sessionId = timestampSlug();
      state.currentSession = { person, sessionId, type: "triple" };
      log(`session → ${person}/${sessionId} (3 trials)`);
      captureBtn.disabled = true;
      calibrateBtn.disabled = true;
      const sessionResultEl = document.getElementById("session-result");
      sessionResultEl.textContent = "running…";

      try {
        const trials = [];
        const jpegs = [];
        for (let i = 0; i < 3; i++) {
          if (i > 0) {
            state.restBanner = { phase: "rest", action: `Trial ${i + 1} of 3`, subtext: "get ready", progress: null };
            await sleep(3000);
            state.restBanner = null;
          }
          const vectors = await runSingleCapture();
          trials.push(vectors);
          jpegs.push(state.neutralJpeg);
        }

        const passedTrials = trials.filter((t) => t.quality?.flags?.length === 0);
        const pool = passedTrials.length >= 2 ? passedTrials : trials;
        const medianVectors = computeMedianVectors(pool);

        const baselineData = await fetchBaseline(person);
        const zScores = computeZScores(medianVectors, baselineData);

        const images = jpegs.map((jpeg, i) => jpeg ? {
          filename: `${person}_neutral_${String(i + 1).padStart(2, "0")}.jpg`,
          content: dataUrlToBase64(jpeg),
          encoding: "base64",
        } : null).filter(Boolean);

        await postSession({
          sessionId, person,
          trials: trials.length,
          trialsPassed: passedTrials.length,
          vectors: medianVectors,
          quality: trials.map((t) => t.quality),
          baseline: zScores,
          images,
        });
        log(`session saved → ${person}/${sessionId} (${passedTrials.length}/${trials.length} passed)`);

        renderSessionCard(sessionResultEl, { medianVectors, zScores, trials, passedTrials, baselineData });
        await refreshHistory(activeHistoryPerson || person);
      } catch (err) {
        showError(String(err));
      } finally {
        captureBtn.disabled = false;
        calibrateBtn.disabled = false;
        state.activeController = null;
      }
    });
    let activeHistoryPerson = null;
    let cachedSessions = [];
    let activeView = "list";
    const listEl = document.getElementById("session-history-list");
    const trendsEl = document.getElementById("session-history-trends");

    async function refreshHistory(person) {
      activeHistoryPerson = person;
      document.querySelectorAll(".history-tab").forEach((b) => {
        b.classList.toggle("active", b.dataset.person === person);
      });
      try {
        cachedSessions = await fetchSessions(person);
        renderCurrentView();
      } catch (err) {
        listEl.textContent = `error: ${err}`;
      }
    }

    function renderCurrentView() {
      document.querySelectorAll(".view-tab").forEach((b) => {
        b.classList.toggle("active", b.dataset.view === activeView);
      });
      if (activeView === "list") {
        listEl.style.display = "";
        trendsEl.style.display = "none";
        renderSessionHistory(listEl, cachedSessions, {
          onDelete: () => refreshHistory(activeHistoryPerson),
        });
      } else {
        listEl.style.display = "none";
        trendsEl.style.display = "";
        renderTrendCharts(trendsEl, cachedSessions);
      }
    }

    document.querySelectorAll(".history-tab").forEach((b) => {
      b.addEventListener("click", () => refreshHistory(b.dataset.person));
    });
    document.querySelectorAll(".view-tab").forEach((b) => {
      b.addEventListener("click", () => { activeView = b.dataset.view; renderCurrentView(); });
    });
    refreshHistory("Sameen");

    const historyBtn = document.getElementById("btn-history");
    const historyPanel = document.getElementById("history-panel");
    const historyClose = document.getElementById("btn-history-close");
    const mainEl = document.querySelector("main");

    historyBtn.addEventListener("click", async () => {
      mainEl.classList.add("main-hidden");
      historyPanel.classList.remove("panel-hidden");
      await refreshHistory(activeHistoryPerson || "Sameen");
    });
    historyClose.addEventListener("click", () => {
      historyPanel.classList.add("panel-hidden");
      mainEl.classList.remove("main-hidden");
    });

    setStatus("ready");
    log("Phase 8 checkpoint: click Start repeatability (N=10). CV table + per-vector progression plots populate; HTML report + session JSON exportable.");
    startRenderLoop(
      landmarker,
      () => state.activeController,
      () => state.restBanner ?? (state.activeController ? state.activeController.getDisplay() : { phase: "idle", action: "", subtext: "", progress: null }),
      pixelHooks,
    );
  } catch (err) {
    if (err && err.name === "NotAllowedError") {
      showError("camera permission denied — grant access and reload");
    } else if (err && err.name === "NotFoundError") {
      showError("no camera found");
    } else {
      showError(`boot failed: ${err?.message ?? err}`);
    }
  }
}

main();
