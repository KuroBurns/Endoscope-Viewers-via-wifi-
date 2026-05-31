const ROTATION_SETTINGS_KEY = "wifi-endoscope-viewer-rotation-settings-v1";
const SENSOR_AXIS_OPTIONS = ["auto", "xyz", "xy", "xz", "yz"];
const SENSOR_PLANES = ["xy", "xz", "yz"];

function readRotationSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(ROTATION_SETTINGS_KEY) || "{}");
    return {
      rotationOffset: Number.isFinite(stored.rotationOffset) ? stored.rotationOffset : 0,
      rotationDirection: stored.rotationDirection === -1 ? -1 : 1,
      smoothingMs: Number.isFinite(stored.smoothingMs) ? stored.smoothingMs : 70,
      sensorAxis: SENSOR_AXIS_OPTIONS.includes(stored.sensorAxis) ? stored.sensorAxis : "auto",
      baselineVector: sanitizeVector(stored.baselineVector),
      lockedPlane: SENSOR_PLANES.includes(stored.lockedPlane) ? stored.lockedPlane : null,
    };
  } catch {
    return {
      rotationOffset: 0,
      rotationDirection: 1,
      smoothingMs: 70,
      sensorAxis: "auto",
      baselineVector: null,
      lockedPlane: null,
    };
  }
}

const rotationSettings = readRotationSettings();

const state = {
  network: null,
  endpoints: [],
  activeEndpoint: null,
  rotation: 0,
  targetRotation: 0,
  autoRotate: true,
  rotationOffset: rotationSettings.rotationOffset,
  rotationDirection: rotationSettings.rotationDirection,
  smoothingMs: rotationSettings.smoothingMs,
  sensorAxis: rotationSettings.sensorAxis,
  baselineVector: rotationSettings.baselineVector,
  lockedPlane: rotationSettings.lockedPlane,
  sensorSamples: [],
  lastRawRotation: 0,
  lastSensorPayload: null,
  lastSensorSource: "waiting",
  lastDeviceType: null,
  lastSensorAt: 0,
  orientationEvents: null,
  orientationAnimation: null,
  lastAnimationAt: 0,
  lastStatusAt: 0,
  lastSensorStatusAt: 0,
  mirrored: false,
  snapshotTimer: null,
  recorder: null,
  recordChunks: [],
  recordStartedAt: 0,
  timerInterval: null,
};

const els = {
  wifiStatus: document.querySelector("#wifiStatus"),
  ipStatus: document.querySelector("#ipStatus"),
  gatewayStatus: document.querySelector("#gatewayStatus"),
  streamStatus: document.querySelector("#streamStatus"),
  rotationStatus: document.querySelector("#rotationStatus"),
  sensorStatus: document.querySelector("#sensorStatus"),
  offsetStatus: document.querySelector("#offsetStatus"),
  smoothingValue: document.querySelector("#smoothingValue"),
  smoothingRange: document.querySelector("#smoothingRange"),
  sensorAxis: document.querySelector("#sensorAxis"),
  gyroDebugButton: document.querySelector("#gyroDebugButton"),
  gyroDebug: document.querySelector("#gyroDebug"),
  settingsButton: document.querySelector("#settingsButton"),
  closeSettings: document.querySelector("#closeSettings"),
  settingsDrawer: document.querySelector("#settingsDrawer"),
  drawerScrim: document.querySelector("#drawerScrim"),
  refreshNetwork: document.querySelector("#refreshNetwork"),
  scanButton: document.querySelector("#scanButton"),
  connectButton: document.querySelector("#connectButton"),
  ssidInput: document.querySelector("#ssidInput"),
  manualUrl: document.querySelector("#manualUrl"),
  manualPlay: document.querySelector("#manualPlay"),
  clearResults: document.querySelector("#clearResults"),
  resultsList: document.querySelector("#resultsList"),
  logList: document.querySelector("#logList"),
  videoShell: document.querySelector("#videoShell"),
  streamImage: document.querySelector("#streamImage"),
  streamFrame: document.querySelector("#streamFrame"),
  emptyState: document.querySelector("#emptyState"),
  emptyHint: document.querySelector("#emptyHint"),
  toggleShape: document.querySelector("#toggleShape"),
  rotateButton: document.querySelector("#rotateButton"),
  mirrorButton: document.querySelector("#mirrorButton"),
  autoRotateButton: document.querySelector("#autoRotateButton"),
  calibrateButton: document.querySelector("#calibrateButton"),
  invertRotateButton: document.querySelector("#invertRotateButton"),
  snapshotButton: document.querySelector("#snapshotButton"),
  recordButton: document.querySelector("#recordButton"),
  recordTimer: document.querySelector("#recordTimer"),
  captureCanvas: document.querySelector("#captureCanvas"),
};

function log(message) {
  const item = document.createElement("div");
  item.className = "log-line";
  item.textContent = `${new Date().toLocaleTimeString("id-ID")}  ${message}`;
  els.logList.prepend(item);
  while (els.logList.children.length > 40) {
    els.logList.lastElementChild.remove();
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || data.connectOutput || `HTTP ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

function firstIpv4(network) {
  const configs = network?.ipConfigurations || [];
  const wifiConfig = configs.find((item) => item.InterfaceAlias === "Wi-Fi" && item.IPv4Address);
  const anyConfig = configs.find((item) => item.IPv4Address);
  return (wifiConfig || anyConfig)?.IPv4Address || "-";
}

function firstGateway(network) {
  return network?.gateways?.[0] || "-";
}

function setStatusClass(element, name) {
  element.classList.remove("good", "warn", "bad");
  if (name) element.classList.add(name);
}

function normalizeDegrees(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function shortestAngleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeVector(vector) {
  if (!vector || typeof vector !== "object") return null;
  const x = Number(vector.x);
  const y = Number(vector.y);
  const z = Number(vector.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  const magnitude = Math.hypot(x, y, z);
  if (!Number.isFinite(magnitude) || magnitude < 1) return null;
  return { x, y, z };
}

function vectorFromPayload(payload) {
  return sanitizeVector({
    x: payload?.x,
    y: payload?.y,
    z: payload?.z,
  });
}

function planeAngle(vector, plane) {
  if (plane === "xz") return normalizeDegrees(-(Math.atan2(vector.x, vector.z) * 180) / Math.PI);
  if (plane === "yz") return normalizeDegrees(-(Math.atan2(vector.y, vector.z) * 180) / Math.PI);
  return normalizeDegrees(-(Math.atan2(vector.x, vector.y) * 180) / Math.PI);
}

function planeMagnitude(vector, plane) {
  if (plane === "xz") return Math.hypot(vector.x, vector.z);
  if (plane === "yz") return Math.hypot(vector.y, vector.z);
  return Math.hypot(vector.x, vector.y);
}

function rememberSensorSample(vector) {
  const now = Date.now();
  state.sensorSamples.push({ ...vector, t: now });
  state.sensorSamples = state.sensorSamples.filter((sample) => now - sample.t <= 1200).slice(-48);
}

function averageRecentVector(ms = 650) {
  const now = Date.now();
  const samples = state.sensorSamples.filter((sample) => now - sample.t <= ms);
  const source = samples.length ? samples : state.sensorSamples;
  if (!source.length) return null;
  const total = source.reduce(
    (sum, sample) => ({
      x: sum.x + sample.x,
      y: sum.y + sample.y,
      z: sum.z + sample.z,
    }),
    { x: 0, y: 0, z: 0 },
  );
  return sanitizeVector({
    x: total.x / source.length,
    y: total.y / source.length,
    z: total.z / source.length,
  });
}

function chooseStablePlane(baseline) {
  const samples = state.sensorSamples.length ? state.sensorSamples : [baseline];
  const scored = SENSOR_PLANES.map((plane) => {
    const baseAngle = planeAngle(baseline, plane);
    let magnitude = 0;
    let jitter = 0;
    let count = 0;
    for (const sample of samples) {
      const planeStrength = planeMagnitude(sample, plane);
      if (planeStrength < 200) continue;
      magnitude += planeStrength;
      jitter += Math.abs(shortestAngleDelta(baseAngle, planeAngle(sample, plane)));
      count += 1;
    }
    if (!count) return { plane, score: 0 };
    const averageMagnitude = magnitude / count;
    const averageJitter = jitter / count;
    return {
      plane,
      score: averageMagnitude / (1 + averageJitter * 2.8),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.plane || "xy";
}

function saveRotationSettings() {
  localStorage.setItem(
    ROTATION_SETTINGS_KEY,
    JSON.stringify({
      rotationOffset: state.rotationOffset,
      rotationDirection: state.rotationDirection,
      smoothingMs: state.smoothingMs,
      sensorAxis: state.sensorAxis,
      baselineVector: state.baselineVector,
      lockedPlane: state.lockedPlane,
    }),
  );
}

function rotationFromAxes(payload) {
  if (state.sensorAxis === "auto") {
    return Number(payload.rotation);
  }
  const vector = vectorFromPayload(payload);
  if (!vector) {
    return Number(payload.rotation);
  }

  if (state.sensorAxis === "xyz") {
    return rotationFromXyz(vector);
  }
  if (state.sensorAxis === "xz") {
    return planeAngle(vector, "xz");
  }
  if (state.sensorAxis === "yz") {
    return planeAngle(vector, "yz");
  }
  return planeAngle(vector, "xy");
}

function rotationFromXyz(vector) {
  const baseline = state.baselineVector;
  if (!baseline) return planeAngle(vector, "xy");

  const plane = state.lockedPlane || chooseStablePlane(baseline);
  const baselineMagnitude = planeMagnitude(baseline, plane);
  const currentMagnitude = planeMagnitude(vector, plane);
  if (baselineMagnitude < 200 || currentMagnitude < Math.max(200, baselineMagnitude * 0.18)) {
    return state.lastRawRotation;
  }
  return normalizeDegrees(shortestAngleDelta(planeAngle(baseline, plane), planeAngle(vector, plane)));
}

function calibratedRotation(rawRotation) {
  return normalizeDegrees(state.rotationOffset + state.rotationDirection * normalizeDegrees(rawRotation));
}

function renderRotationStatus(extra = "") {
  const mode = state.autoRotate ? "Auto" : "Manual";
  els.rotationStatus.textContent = `${mode} ${state.rotation.toFixed(1)} deg${extra ? ` ${extra}` : ""}`;
  setStatusClass(els.rotationStatus, state.autoRotate ? "good" : "warn");

  if (els.sensorStatus) {
    if (state.lastSensorAt) {
      const age = Date.now() - state.lastSensorAt;
      const vector = state.lastSensorPayload ? vectorFromPayload(state.lastSensorPayload) : null;
      const sourceLabel =
        state.lastSensorSource === "sensor-heading"
          ? "Heading"
          : state.lastSensorSource === "sensor-accelerometer"
          ? "Accelerometer"
          : "Sensor";
      els.sensorStatus.textContent = vector
        ? `${sourceLabel} X ${Math.round(vector.x)} Y ${Math.round(vector.y)} Z ${Math.round(vector.z)}`
        : `${state.lastRawRotation.toFixed(1)} raw`;
      setStatusClass(els.sensorStatus, age < 1600 ? "good" : "warn");
    } else {
      els.sensorStatus.textContent = "Waiting";
      setStatusClass(els.sensorStatus, "warn");
    }
  }

  if (els.offsetStatus) {
    const direction = state.rotationDirection === 1 ? "+" : "-";
    const calibrated = state.sensorAxis === "xyz" && state.baselineVector
      ? `XYZ-${(state.lockedPlane || "xy").toUpperCase()}`
      : state.sensorAxis === "auto"
      ? "Auto"
      : "Offset";
    els.offsetStatus.textContent = `${calibrated} ${direction} ${state.rotationOffset.toFixed(1)}`;
  }

  if (els.smoothingValue) {
    els.smoothingValue.textContent = `${state.smoothingMs} ms`;
  }

  if (els.smoothingRange) {
    els.smoothingRange.value = String(state.smoothingMs);
  }

  if (els.sensorAxis) {
    els.sensorAxis.value = state.sensorAxis;
  }

  els.autoRotateButton.classList.toggle("active", state.autoRotate);
  els.autoRotateButton.textContent = state.autoRotate ? "Auto rotation on" : "Auto rotation off";
}

function renderNetwork(network) {
  state.network = network;
  const ssid = network?.wlan?.ssid || "Not connected";
  els.ssidInput.value = network?.targetSsid || els.ssidInput.value;
  els.wifiStatus.textContent = ssid;
  els.ipStatus.textContent = firstIpv4(network);
  els.gatewayStatus.textContent = firstGateway(network);
  setStatusClass(els.wifiStatus, network?.connectedToTarget ? "good" : network?.targetVisible ? "warn" : "bad");

  if (network?.connectedToTarget) {
    log(`Laptop is connected to ${ssid}.`);
  } else if (network?.targetVisible) {
    log(`${network.targetSsid} is visible and ready to connect.`);
  } else {
    log("Camera SSID is not visible yet. Turn on the device and keep it close to the laptop.");
  }
}

async function refreshNetwork() {
  els.refreshNetwork.disabled = true;
  try {
    const network = await api("/api/network");
    renderNetwork(network);
  } catch (error) {
    log(`Failed to read network status: ${error.message}`);
  } finally {
    els.refreshNetwork.disabled = false;
  }
}

function endpointLabel(endpoint) {
  const kind = endpoint.kind?.toUpperCase() || "HTTP";
  return `${kind} ${endpoint.status || ""}`.trim();
}

function renderResults(results) {
  state.endpoints = results;
  els.resultsList.innerHTML = "";
  for (const endpoint of results) {
    const card = document.createElement("article");
    card.className = `endpoint ${endpoint.playable ? "playable" : ""}`;

    const title = document.createElement("strong");
    title.textContent = endpoint.url;
    card.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "meta";
    for (const text of [endpointLabel(endpoint), endpoint.contentType, endpoint.label]) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = text || "-";
      meta.appendChild(pill);
    }
    card.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "endpoint-actions";

    if (endpoint.kind !== "rtsp") {
      const playButton = document.createElement("button");
      playButton.className = endpoint.playable ? "primary-action" : "";
      playButton.textContent = endpoint.kind === "html" ? "Open" : "Play";
      playButton.addEventListener("click", () => playEndpoint(endpoint));
      actions.appendChild(playButton);
    }

    const copyButton = document.createElement("button");
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(endpoint.url);
      log("Endpoint URL copied.");
    });
    actions.appendChild(copyButton);

    card.appendChild(actions);
    els.resultsList.appendChild(card);
  }
}

async function scanCamera() {
  els.scanButton.disabled = true;
  els.streamStatus.textContent = "Scanning";
  setStatusClass(els.streamStatus, "warn");
  log("Scanning camera endpoints.");
  try {
    const data = await api("/api/scan");
    renderNetwork(data.network);
    renderResults(data.results);
    const playable = data.results.find((endpoint) => endpoint.playable);
    const html = data.results.find((endpoint) => endpoint.kind === "html");
    if (playable) {
      playEndpoint(playable);
      closeSettingsDrawer();
      log(`Stream found: ${playable.url}`);
    } else if (html && data.network?.connectedToTarget) {
      playEndpoint(html);
      closeSettingsDrawer();
      log("No direct MJPEG stream was found; opening the device page.");
    } else {
      els.streamStatus.textContent = "Not found";
      setStatusClass(els.streamStatus, "bad");
      els.emptyHint.textContent = "Try a manual URL or make sure the laptop is connected to the camera Wi-Fi.";
      log("No browser-playable stream was found yet.");
    }
  } catch (error) {
    els.streamStatus.textContent = "Scan failed";
    setStatusClass(els.streamStatus, "bad");
    log(`Scan failed: ${error.message}`);
  } finally {
    els.scanButton.disabled = false;
  }
}

async function connectWifi() {
  const ssid = els.ssidInput.value.trim();
  if (!ssid) return;
  els.connectButton.disabled = true;
  log(`Trying to connect to ${ssid}.`);
  try {
    const result = await api("/api/connect", {
      method: "POST",
      body: JSON.stringify({ ssid }),
    });
    log(result.connectOutput || `Connection command was sent for ${ssid}.`);
    setTimeout(refreshNetwork, 3200);
  } catch (error) {
    log(`Connection did not finish: ${error.message}`);
    if (error.data?.connectOutput) log(error.data.connectOutput);
  } finally {
    els.connectButton.disabled = false;
  }
}

function proxyUrl(url) {
  if (url.startsWith("/api/camera/")) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  }
  const source = state.activeEndpoint?.sourceAddress || "";
  return `/api/proxy?url=${encodeURIComponent(url)}&source=${encodeURIComponent(source)}&t=${Date.now()}`;
}

function stopOrientationEvents() {
  if (state.orientationEvents) {
    state.orientationEvents.close();
    state.orientationEvents = null;
  }
}

function startOrientationEvents() {
  stopOrientationEvents();
  if (!window.EventSource) {
    log("This browser engine does not support automatic rotation events.");
    return;
  }
  state.orientationEvents = new EventSource("/api/camera/orientation");
  state.orientationEvents.addEventListener("orientation", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!["sensor-heading", "sensor-accelerometer", "camera-sensor"].includes(payload.source)) return;
    state.lastSensorSource = payload.source;
    state.lastDeviceType = payload.deviceType || null;
    const vector = vectorFromPayload(payload);
    if (vector) rememberSensorSample(vector);
    state.lastSensorPayload = payload;
    const rawRotation = rotationFromAxes(payload);
    if (!Number.isFinite(rawRotation)) return;
    if (state.lastSensorAt && state.sensorAxis !== "auto" && state.baselineVector) {
      const elapsed = Math.max(16, Date.now() - state.lastSensorAt);
      const jump = Math.abs(shortestAngleDelta(state.lastRawRotation, rawRotation));
      const maxJump = clamp(elapsed * 1.15, 38, 115);
      if (jump > maxJump) {
        renderRotationStatus("gyro stabil");
        return;
      }
    }
    state.lastRawRotation = normalizeDegrees(rawRotation);
    state.lastSensorAt = Date.now();
    if (state.lastSensorAt - state.lastSensorStatusAt > 160) {
      state.lastSensorStatusAt = state.lastSensorAt;
      renderRotationStatus();
    }
    if (!state.autoRotate) return;
    updateRotationTarget(calibratedRotation(state.lastRawRotation));
  });
  state.orientationEvents.addEventListener("error", () => {
    renderRotationStatus("sensor menunggu");
  });
}

async function showGyroDebug() {
  if (!els.gyroDebug) return;
  els.gyroDebug.textContent = "Reading gyro data...";
  try {
    const data = await api("/api/camera/orientation-debug");
    const samples = data.samples || [];
    const rows = samples.slice(0, 14).map((sample) => {
      const orientation = sample.orientation;
      const time = sample.at ? sample.at.slice(11, 19) : "--:--:--";
      if (!orientation) {
        return `${time} no-parse len=${sample.length} ${sample.hex}`;
      }
      const source = orientation.source || "?";
      const type = orientation.deviceType ? ` t${orientation.deviceType}` : "";
      const offset = Number.isFinite(orientation.payloadOffset) ? ` off=${orientation.payloadOffset}` : "";
      const mode = orientation.fallbackMode ? ` ${orientation.fallbackMode}` : "";
      const heading = Number.isFinite(orientation.sensorHeading) ? ` head=${orientation.sensorHeading}` : "";
      return `${time} ${source}${type} rot=${orientation.rotation}${heading} x=${orientation.x} y=${orientation.y} z=${orientation.z}${offset}${mode}`;
    });
    els.gyroDebug.textContent = rows.join("\n") || "No gyro packets yet. Start the UDP stream first.";
    log("Gyro debug updated.");
  } catch (error) {
    els.gyroDebug.textContent = `Failed to read gyro debug: ${error.message}`;
    log(`Gyro debug failed: ${error.message}`);
  }
}

function stopSnapshotRefresh() {
  if (state.snapshotTimer) {
    clearInterval(state.snapshotTimer);
    state.snapshotTimer = null;
  }
}

function updateRotationTarget(rawRotation) {
  const next = normalizeDegrees(rawRotation);
  const currentDelta = Math.abs(shortestAngleDelta(state.targetRotation, next));
  if (currentDelta < 0.12) return;
  state.targetRotation = next;
  if (!state.orientationAnimation) {
    state.lastAnimationAt = performance.now();
    state.orientationAnimation = requestAnimationFrame(animateRotation);
  }
}

function animateRotation(now) {
  const elapsed = Math.min(48, Math.max(8, now - state.lastAnimationAt));
  state.lastAnimationAt = now;
  const delta = shortestAngleDelta(state.rotation, state.targetRotation);
  const alpha = 1 - Math.exp(-elapsed / state.smoothingMs);

  if (Math.abs(delta) < 0.025) {
    state.rotation = state.targetRotation;
  } else {
    state.rotation = normalizeDegrees(state.rotation + delta * alpha);
  }

  applyTransform(false);

  if (now - state.lastStatusAt > 120) {
    state.lastStatusAt = now;
    renderRotationStatus();
  }

  if (Math.abs(shortestAngleDelta(state.rotation, state.targetRotation)) >= 0.025 && state.autoRotate) {
    state.orientationAnimation = requestAnimationFrame(animateRotation);
  } else {
    state.orientationAnimation = null;
    renderRotationStatus();
  }
}

function applyTransform(updateStatus = true) {
  const scaleX = state.mirrored ? -1 : 1;
  const transform = `rotate(${state.rotation.toFixed(2)}deg) scaleX(${scaleX}) translateZ(0)`;
  els.streamImage.style.transform = transform;
  els.streamFrame.style.transform = transform;
  if (updateStatus) renderRotationStatus();
}

function playEndpoint(endpoint) {
  stopSnapshotRefresh();
  stopOrientationEvents();
  state.activeEndpoint = endpoint;
  els.videoShell.classList.remove("playing-image", "playing-frame");
  els.streamImage.removeAttribute("src");
  els.streamFrame.removeAttribute("src");

  if (endpoint.kind === "html") {
    els.streamFrame.src = proxyUrl(endpoint.url);
    els.videoShell.classList.add("playing-frame");
  } else {
    els.streamImage.src = proxyUrl(endpoint.url);
    els.videoShell.classList.add("playing-image");
    if (endpoint.kind === "snapshot") {
      state.snapshotTimer = setInterval(() => {
        els.streamImage.src = proxyUrl(endpoint.url);
      }, 160);
    }
  }

  applyTransform();
  if (endpoint.kind === "udp-jpeg") startOrientationEvents();
  els.streamStatus.textContent = endpoint.kind === "udp-jpeg" ? "UDP stream" : endpoint.kind.toUpperCase();
  setStatusClass(els.streamStatus, endpoint.playable ? "good" : "warn");
  log(`Playing ${endpoint.url}`);
}

function manualPlay() {
  const url = els.manualUrl.value.trim();
  if (!url) return;
  const kind = url.toLowerCase().includes(".html") ? "html" : "mjpeg";
  playEndpoint({
    url,
    label: "Manual",
    status: 200,
    contentType: "manual",
    kind,
    playable: kind !== "html",
  });
  closeSettingsDrawer();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentFrameToCanvas() {
  const image = els.streamImage;
  if (!state.activeEndpoint || !els.videoShell.classList.contains("playing-image")) {
    throw new Error("There is no active image frame.");
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error("Frame is not ready yet.");
  }
  const canvas = els.captureCanvas;
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((state.rotation * Math.PI) / 180);
  ctx.scale(state.mirrored ? -1 : 1, 1);
  ctx.drawImage(image, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
  ctx.restore();
  return canvas;
}

async function takeSnapshot() {
  try {
    const canvas = currentFrameToCanvas();
    canvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `endoscope-snapshot-${timestamp()}.png`);
      log("Snapshot saved.");
    }, "image/png");
  } catch (error) {
    log(`Snapshot failed: ${error.message}`);
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function drawRecordingFrame(canvas, ctx) {
  if (!state.recorder) return;
  try {
    const image = els.streamImage;
    if (image.naturalWidth && image.naturalHeight) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(currentFrameToCanvas(), 0, 0, canvas.width, canvas.height);
    }
  } catch {
    // Skip transient frames while MJPEG is reloading.
  }
  requestAnimationFrame(() => drawRecordingFrame(canvas, ctx));
}

function startTimer() {
  state.recordStartedAt = Date.now();
  state.timerInterval = setInterval(() => {
    const seconds = Math.floor((Date.now() - state.recordStartedAt) / 1000);
    const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    els.recordTimer.textContent = `${hh}:${mm}:${ss}`;
  }, 250);
}

function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
  els.recordTimer.textContent = "00:00:00";
}

function setRecordingVisual(recording) {
  els.recordButton.classList.toggle("recording", recording);
  const icon = els.recordButton.querySelector("img");
  const label = els.recordButton.querySelector("span");
  if (icon) icon.src = recording ? "./assets/video-stop.svg" : "./assets/video.svg";
  if (label) label.textContent = recording ? "Stop" : "Video";
}

function toggleRecording() {
  if (state.recorder) {
    state.recorder.stop();
    return;
  }

  try {
    const canvas = currentFrameToCanvas();
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(20);
    state.recordChunks = [];
    state.recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) state.recordChunks.push(event.data);
    });
    state.recorder.addEventListener("stop", () => {
      const blob = new Blob(state.recordChunks, { type: "video/webm" });
      downloadBlob(blob, `endoscope-recording-${timestamp()}.webm`);
      state.recorder = null;
      state.recordChunks = [];
      setRecordingVisual(false);
      stopTimer();
      log("Recording saved.");
    });
    state.recorder.start(500);
    setRecordingVisual(true);
    startTimer();
    drawRecordingFrame(canvas, ctx);
    log("Recording started.");
  } catch (error) {
    log(`Recording failed: ${error.message}`);
  }
}

function toggleShape() {
  const isRound = els.videoShell.classList.toggle("round");
  els.videoShell.classList.toggle("wide", !isRound);
  const icon = els.toggleShape.querySelector("img");
  if (icon) icon.src = isRound ? "./assets/mode-round.svg" : "./assets/mode-wide.svg";
}

function rotate() {
  state.autoRotate = false;
  state.rotation = normalizeDegrees(state.rotation + 90);
  state.targetRotation = state.rotation;
  if (state.orientationAnimation) {
    cancelAnimationFrame(state.orientationAnimation);
    state.orientationAnimation = null;
  }
  applyTransform();
  log("Manual rotation is active. Press auto rotation to follow the camera sensor again.");
}

function mirror() {
  state.mirrored = !state.mirrored;
  applyTransform();
  els.mirrorButton.classList.toggle("primary", state.mirrored);
}

function toggleAutoRotate() {
  state.autoRotate = !state.autoRotate;
  if (state.autoRotate && state.lastSensorAt) {
    updateRotationTarget(calibratedRotation(state.lastRawRotation));
  } else {
    state.targetRotation = state.rotation;
  }
  renderRotationStatus();
  log(state.autoRotate ? "Auto rotation is on." : "Auto rotation is off.");
}

function calibrateRotation() {
  if (!state.lastSensorAt) {
    log("Gyro data has not been received yet. Start the UDP stream, then calibrate again.");
    openSettingsDrawer();
    return;
  }
  const vector = state.lastSensorPayload ? vectorFromPayload(state.lastSensorPayload) : null;
  if (state.sensorAxis === "xyz" && vector) {
    state.baselineVector = averageRecentVector() || vector;
    state.lockedPlane = chooseStablePlane(state.baselineVector);
    state.lastRawRotation = 0;
    state.rotationOffset = 0;
  } else {
    state.baselineVector = null;
    state.lockedPlane = null;
    state.rotationOffset = normalizeDegrees(-state.rotationDirection * state.lastRawRotation);
  }
  state.autoRotate = true;
  saveRotationSettings();
  updateRotationTarget(0);
  renderRotationStatus("calibrated");
  log(
    state.sensorAxis === "xyz" && vector
      ? `XYZ calibration saved and locked to plane ${state.lockedPlane.toUpperCase()}: X ${Math.round(state.baselineVector.x)}, Y ${Math.round(state.baselineVector.y)}, Z ${Math.round(state.baselineVector.z)}.`
      : "Calibration saved. The current camera position is treated as upright 0 deg.",
  );
}

function invertRotationDirection() {
  const visibleRotation = state.rotation;
  state.rotationDirection = state.rotationDirection === 1 ? -1 : 1;
  state.rotationOffset = normalizeDegrees(visibleRotation - state.rotationDirection * state.lastRawRotation);
  saveRotationSettings();
  if (state.autoRotate && state.lastSensorAt) {
    updateRotationTarget(calibratedRotation(state.lastRawRotation));
  }
  renderRotationStatus();
  log("Sensor rotation direction was reversed.");
}

function setSmoothing(value) {
  state.smoothingMs = clamp(Math.round(Number(value) || 110), 60, 260);
  saveRotationSettings();
  renderRotationStatus();
}

function setSensorAxis(value) {
  state.sensorAxis = SENSOR_AXIS_OPTIONS.includes(value) ? value : "auto";
  if (state.sensorAxis === "auto") {
    state.baselineVector = null;
    state.lockedPlane = null;
  } else if (state.sensorAxis === "xyz") {
    if (state.baselineVector && !state.lockedPlane) state.lockedPlane = chooseStablePlane(state.baselineVector);
  } else {
    state.lockedPlane = null;
  }
  if (state.lastSensorPayload) {
    state.lastRawRotation = normalizeDegrees(rotationFromAxes(state.lastSensorPayload));
  }
  saveRotationSettings();
  if (state.autoRotate && state.lastSensorAt) {
    updateRotationTarget(calibratedRotation(state.lastRawRotation));
  }
  renderRotationStatus();
  log(`Sensor axis mode: ${state.sensorAxis.toUpperCase()}.`);
}

function openSettingsDrawer() {
  els.settingsDrawer.classList.add("open");
  els.drawerScrim.classList.add("open");
}

function closeSettingsDrawer() {
  els.settingsDrawer.classList.remove("open");
  els.drawerScrim.classList.remove("open");
}

els.settingsButton.addEventListener("click", openSettingsDrawer);
els.closeSettings.addEventListener("click", closeSettingsDrawer);
els.drawerScrim.addEventListener("click", closeSettingsDrawer);
els.refreshNetwork.addEventListener("click", refreshNetwork);
els.scanButton.addEventListener("click", scanCamera);
els.connectButton.addEventListener("click", connectWifi);
els.manualPlay.addEventListener("click", manualPlay);
els.manualUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") manualPlay();
});
els.clearResults.addEventListener("click", () => {
  state.endpoints = [];
  els.resultsList.innerHTML = "";
});
els.toggleShape.addEventListener("click", toggleShape);
els.rotateButton.addEventListener("click", rotate);
els.mirrorButton.addEventListener("click", mirror);
els.autoRotateButton.addEventListener("click", toggleAutoRotate);
els.calibrateButton.addEventListener("click", calibrateRotation);
els.invertRotateButton.addEventListener("click", invertRotationDirection);
els.sensorAxis.addEventListener("change", (event) => setSensorAxis(event.target.value));
els.smoothingRange.addEventListener("input", (event) => setSmoothing(event.target.value));
if (els.gyroDebugButton) els.gyroDebugButton.addEventListener("click", showGyroDebug);
els.snapshotButton.addEventListener("click", takeSnapshot);
els.recordButton.addEventListener("click", toggleRecording);

renderRotationStatus();
refreshNetwork().then(() => {
  if (state.network?.connectedToTarget) {
    scanCamera();
  }
});
