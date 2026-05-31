const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const dgram = require("node:dgram");
const { execFile } = require("node:child_process");

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, "public");
const PORT = Number(process.env.PORT || 47855);
const TARGET_SSID = process.env.CAMERA_SSID || "HNDEC_55-XXXXXX";
const CAMERA_SSID_PREFIX = "HNDEC_55-";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const COMMON_HOSTS = [
  "192.168.1.1",
  "192.168.4.1",
  "192.168.10.1",
  "192.168.100.1",
  "10.10.10.1",
];

const HTTP_CANDIDATES = [
  { port: 8080, path: "/?action=stream", label: "MJPEG action stream" },
  { port: 8080, path: "/stream", label: "MJPEG stream" },
  { port: 8080, path: "/video", label: "Video stream" },
  { port: 8080, path: "/videostream.cgi", label: "Legacy video stream" },
  { port: 8080, path: "/stream.mjpg", label: "MJPG stream" },
  { port: 8080, path: "/mjpeg.cgi", label: "MJPEG CGI" },
  { port: 8080, path: "/mjpeg/1", label: "MJPEG channel 1" },
  { port: 8080, path: "/shot.jpg", label: "JPEG snapshot" },
  { port: 8080, path: "/snapshot.jpg", label: "Snapshot" },
  { port: 8080, path: "/stream_simple.html", label: "Built-in stream page" },
  { port: 80, path: "/?action=stream", label: "MJPEG action stream" },
  { port: 80, path: "/stream", label: "MJPEG stream" },
  { port: 80, path: "/video", label: "Video stream" },
  { port: 80, path: "/videostream.cgi", label: "Legacy video stream" },
  { port: 80, path: "/video.cgi", label: "Video CGI" },
  { port: 80, path: "/mjpeg.cgi", label: "MJPEG CGI" },
  { port: 80, path: "/mjpg/video.mjpg", label: "MJPG video" },
  { port: 80, path: "/axis-cgi/mjpg/video.cgi", label: "Axis MJPEG" },
  { port: 80, path: "/shot.jpg", label: "JPEG snapshot" },
  { port: 80, path: "/snapshot.jpg", label: "Snapshot" },
  { port: 80, path: "/image.jpg", label: "Image snapshot" },
  { port: 80, path: "/", label: "Device homepage" },
  { port: 81, path: "/stream", label: "Port 81 stream" },
  { port: 81, path: "/mjpeg/1", label: "Port 81 MJPEG" },
  { port: 88, path: "/video", label: "Port 88 video" },
  { port: 5000, path: "/stream", label: "Port 5000 stream" },
  { port: 7070, path: "/stream", label: "Port 7070 stream" },
  { port: 8081, path: "/stream", label: "Port 8081 stream" },
];

const RTSP_CANDIDATES = [
  { port: 554, path: "/live", label: "RTSP live" },
  { port: 554, path: "/stream1", label: "RTSP stream1" },
  { port: 554, path: "/h264", label: "RTSP H264" },
  { port: 554, path: "/video", label: "RTSP video" },
  { port: 8554, path: "/live", label: "RTSP live 8554" },
  { port: 8554, path: "/stream", label: "RTSP stream 8554" },
];

const STREAM_BOUNDARY = "endoscopeframe";
const CAMERA_DISCOVERY_PACKET = Buffer.from([0x66, 0x30, 0x01, 0x01]);
const CAMERA_START_IMAGE_PACKET = Buffer.from([0x20, 0x36]);
const CAMERA_STOP_IMAGE_PACKET = Buffer.from([0x20, 0x37]);
const CAMERA_START_SENSOR_PACKET = Buffer.from([0x86, 0x06, 0x01]);

const orientationClients = new Set();
const cameraOrientation = {
  rotation: 0,
  angle: 0,
  x: 0,
  y: 0,
  z: 0,
  source: "waiting",
  updatedAt: 0,
};
const orientationDebug = [];
let lastOrientationBroadcast = 0;

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function safeJoinStatic(rawPath) {
  const decoded = decodeURIComponent(rawPath.split("?")[0]);
  const normalized = path.normalize(decoded === "/" ? "/index.html" : decoded);
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

function run(command, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || "",
        stderr: stderr || "",
        error: error ? error.message : "",
      });
    });
  });
}

async function runPowerShell(command, timeout = 10000) {
  return run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    timeout,
  );
}

function parseWlanInterfaces(output) {
  const result = {
    state: "",
    ssid: "",
    bssid: "",
    signal: "",
    radioType: "",
    receiveRateMbps: "",
    transmitRateMbps: "",
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (key === "state") result.state = value;
    if (key === "ssid" && !key.includes("bssid")) result.ssid = value;
    if (key === "ap bssid") result.bssid = value;
    if (key === "signal") result.signal = value;
    if (key === "radio type") result.radioType = value;
    if (key === "receive rate (mbps)") result.receiveRateMbps = value;
    if (key === "transmit rate (mbps)") result.transmitRateMbps = value;
  }

  return result;
}

function parseVisibleNetworks(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*SSID\s+\d+\s+:\s+(.*)$/i))
    .filter(Boolean)
    .map((match) => match[1].trim())
    .filter((ssid) => ssid.length > 0);
}

function normalizeJsonList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function parseIpConfig(output) {
  const configs = [];
  let current = null;

  function finishCurrent() {
    if (current && (current.IPv4Address || current.IPv4Gateway)) {
      configs.push(current);
    }
  }

  for (const rawLine of output.split(/\r?\n/)) {
    const adapterMatch = rawLine.match(/adapter\s+(.+):\s*$/i);
    if (adapterMatch) {
      finishCurrent();
      current = {
        InterfaceAlias: adapterMatch[1].trim(),
        IPv4Address: null,
        IPv4Gateway: null,
        DnsServer: "",
      };
      continue;
    }

    if (!current) continue;
    const line = rawLine.trim();
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).replace(/\.+/g, "").trim().toLowerCase();
    const value = line.slice(index + 1).trim().replace(/\(Preferred\)/i, "").trim();
    if (!value) continue;
    if (key.startsWith("ipv4 address")) current.IPv4Address = value;
    if (key.startsWith("default gateway") && /^\d+\.\d+\.\d+\.\d+$/.test(value)) current.IPv4Gateway = value;
    if (key.startsWith("dns servers")) current.DnsServer = value;
  }

  finishCurrent();
  return configs;
}

function getOsNetworkInterfaceConfig() {
  const configs = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    const ipv4 = (entries || []).find((entry) => entry.family === "IPv4" && !entry.internal);
    if (!ipv4?.address) continue;
    const parts = ipv4.address.split(".");
    const inferredGateway = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.1` : "";
    configs.push({
      InterfaceAlias: name,
      IPv4Address: ipv4.address,
      IPv4Gateway: inferredGateway,
      DnsServer: "",
    });
  }
  return configs;
}

async function getIpConfiguration() {
  const ipconfig = await run("ipconfig", ["/all"], 10000);
  if (ipconfig.ok && ipconfig.stdout) {
    const parsed = parseIpConfig(ipconfig.stdout);
    if (parsed.length) return parsed;
  }

  if (process.platform !== "win32") {
    return getOsNetworkInterfaceConfig();
  }

  const command = `
    $configs = Get-NetIPConfiguration | ForEach-Object {
      [PSCustomObject]@{
        InterfaceAlias = $_.InterfaceAlias
        IPv4Address = (($_.IPv4Address | Select-Object -First 1).IPAddress)
        IPv4Gateway = (($_.IPv4DefaultGateway | Select-Object -First 1).NextHop)
        DnsServer = ($_.DNSServer.ServerAddresses -join ', ')
      }
    }
    $configs | ConvertTo-Json -Compress
  `;
  const result = await runPowerShell(command, 30000);
  if (!result.ok || !result.stdout.trim()) return getOsNetworkInterfaceConfig();
  try {
    const parsed = normalizeJsonList(JSON.parse(result.stdout));
    return parsed.length ? parsed : getOsNetworkInterfaceConfig();
  } catch {
    return getOsNetworkInterfaceConfig();
  }
}

function isTargetSsid(ssid) {
  const value = String(ssid || "").trim();
  return value === TARGET_SSID || value.toUpperCase().startsWith(CAMERA_SSID_PREFIX);
}

async function getNetworkStatus() {
  const [interfaces, networks, ipConfigurations] = await Promise.all([
    process.platform === "win32"
      ? run("netsh", ["wlan", "show", "interfaces"], 10000)
      : Promise.resolve({ ok: false, stdout: "" }),
    process.platform === "win32"
      ? run("netsh", ["wlan", "show", "networks", "mode=bssid"], 10000)
      : Promise.resolve({ ok: false, stdout: "" }),
    getIpConfiguration(),
  ]);

  const wlan = parseWlanInterfaces(interfaces.stdout);
  const visibleNetworks = parseVisibleNetworks(networks.stdout);
  const detectedSsid = isTargetSsid(wlan.ssid)
    ? wlan.ssid
    : visibleNetworks.find(isTargetSsid) || "";
  const gateways = unique(ipConfigurations
    .map((item) => item.IPv4Gateway)
    .filter(Boolean));

  return {
    platform: process.platform,
    canAutoConnectWifi: process.platform === "win32",
    targetSsid: detectedSsid || TARGET_SSID,
    wlan,
    visibleNetworks,
    ipConfigurations,
    gateways,
    connectedToTarget: isTargetSsid(wlan.ssid),
    targetVisible: visibleNetworks.some(isTargetSsid),
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function ipv4Broadcast(address) {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return "";
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.255`;
}

function isPrivateHost(host) {
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(String(host || ""));
}

function wifiConfigFromStatus(status) {
  const configs = status.ipConfigurations || [];
  return configs.find((item) => {
    const alias = String(item.InterfaceAlias || "").toLowerCase();
    return alias === "wi-fi" || alias.includes("wireless") || alias.includes("wifi");
  });
}

function sourceAddressFromStatus(status) {
  if (!status.connectedToTarget) return "";
  return wifiConfigFromStatus(status)?.IPv4Address || "";
}

function hostCandidatesFromStatus(status, manualHost) {
  const hosts = [];
  if (manualHost) hosts.push(manualHost);
  const wifiConfig = wifiConfigFromStatus(status);
  if (wifiConfig?.IPv4Gateway) hosts.push(wifiConfig.IPv4Gateway);
  hosts.push(...status.gateways);
  hosts.push(...COMMON_HOSTS);
  return unique(hosts);
}

function buildHttpUrl(host, candidate) {
  return `http://${host}:${candidate.port}${candidate.path}`;
}

function classifyProbe(url, response, label) {
  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  const sample = response.sample || "";
  const status = response.statusCode || 0;
  let kind = "unknown";
  let playable = false;

  if (status === 401 || status === 403) {
    kind = "auth";
  } else if (status < 200 || status >= 300) {
    kind = "error";
  } else if (contentType.includes("multipart/x-mixed-replace")) {
    kind = "mjpeg";
    playable = true;
  } else if (contentType.startsWith("image/")) {
    kind = "snapshot";
    playable = true;
  } else if (sample.startsWith("--") && sample.toLowerCase().includes("content-type: image/")) {
    kind = "mjpeg";
    playable = true;
  } else if (sample.includes("#EXTM3U")) {
    kind = "hls";
  } else if (contentType.includes("text/html") || sample.toLowerCase().includes("<html")) {
    kind = "html";
  } else if (status >= 200 && status < 300) {
    kind = "http";
  }

  return {
    url,
    label,
    status,
    contentType: contentType || "unknown",
    kind,
    playable,
    sample: sample.slice(0, 4096),
  };
}

function probeHttp(url, label, timeout = 1800, localAddress = "") {
  return new Promise((resolve) => {
    let settled = false;
    const urlObj = new URL(url);
    const client = urlObj.protocol === "https:" ? https : http;
    const req = client.request(
      urlObj,
      {
        method: "GET",
        headers: {
          "user-agent": "WiFi-Endoscope-Viewer/1.0",
          accept: "*/*",
          connection: "close",
        },
        localAddress: localAddress || undefined,
        timeout,
      },
      (response) => {
        const chunks = [];
        let total = 0;

        function finish() {
          if (settled) return;
          settled = true;
          const buffer = Buffer.concat(chunks, total);
          const sample = buffer.toString("utf8", 0, Math.min(buffer.length, 4096));
          resolve(classifyProbe(url, {
            statusCode: response.statusCode,
            headers: response.headers,
            sample,
          }, label));
          req.destroy();
        }

        response.on("data", (chunk) => {
          chunks.push(chunk);
          total += chunk.length;
          const contentType = String(response.headers["content-type"] || "").toLowerCase();
          if (total >= 65536 || contentType.includes("multipart/x-mixed-replace")) {
            finish();
          }
        });
        response.on("end", finish);
        response.on("error", () => finish());
      },
    );

    req.on("timeout", () => {
      if (!settled) {
        settled = true;
        req.destroy();
        resolve(null);
      }
    });
    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    req.end();
  });
}

function extractUrlsFromHtml(baseUrl, html) {
  const found = new Set();
  const attributes = html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi);
  for (const match of attributes) {
    const value = match[1];
    if (!/stream|mjpeg|mjpg|video|shot|snap|image/i.test(value)) continue;
    try {
      found.add(new URL(value, baseUrl).toString());
    } catch {
      // Ignore malformed relative URLs from embedded device pages.
    }
  }

  const strings = html.matchAll(/["']([^"']*(?:stream|mjpeg|mjpg|video|shot|snap|image)[^"']*)["']/gi);
  for (const match of strings) {
    const value = match[1];
    if (value.length > 180 || value.includes("<")) continue;
    try {
      found.add(new URL(value, baseUrl).toString());
    } catch {
      // Ignore non-URL strings.
    }
  }
  return [...found];
}

async function scanHttpEndpoints(hosts, localAddress = "") {
  const results = [];
  const pending = [];
  const pushProbe = (url, label) => {
    pending.push(async () => {
      const result = await probeHttp(url, label, 1800, localAddress);
      if (result && localAddress) result.sourceAddress = localAddress;
      if (result) results.push(result);
    });
  };

  for (const host of hosts) {
    for (const candidate of HTTP_CANDIDATES) {
      pushProbe(buildHttpUrl(host, candidate), candidate.label);
    }
  }

  await runWithConcurrency(pending, 18);

  const htmlResults = results.filter((item) => item.kind === "html" && item.sample);
  const extracted = [];
  for (const item of htmlResults) {
    for (const url of extractUrlsFromHtml(item.url, item.sample)) {
      if (!results.some((result) => result.url === url)) extracted.push(url);
    }
  }

  await runWithConcurrency(extracted.map((url) => async () => {
    const result = await probeHttp(url, "Discovered from device page", 1800, localAddress);
    if (result && localAddress) result.sourceAddress = localAddress;
    if (result) results.push(result);
  }), 10);

  return results
    .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
    .filter((item) => item.kind !== "error")
    .sort((a, b) => {
      if (a.playable !== b.playable) return a.playable ? -1 : 1;
      const rank = { mjpeg: 0, snapshot: 1, hls: 2, html: 3, http: 4, auth: 5, unknown: 6, error: 7 };
      return (rank[a.kind] ?? 10) - (rank[b.kind] ?? 10);
    });
}

function probeRtsp(url, timeout = 1300, localAddress = "") {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;

    function done(result) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    }

    socket.setTimeout(timeout);
    socket.connect({
      port: Number(parsed.port || 554),
      host: parsed.hostname,
      localAddress: localAddress || undefined,
    }, () => {
      socket.write(`OPTIONS ${url} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: WiFi-Endoscope-Viewer/1.0\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n\r\n") || buffer.length > 4096) {
        done({
          url,
          label: "RTSP stream",
          status: buffer.includes("RTSP/1.0") ? 200 : 0,
          contentType: "application/rtsp",
          kind: "rtsp",
          playable: false,
          sample: buffer.slice(0, 240),
        });
      }
    });
    socket.on("timeout", () => done(null));
    socket.on("error", () => done(null));
    socket.on("close", () => {
      if (buffer.includes("RTSP/1.0")) {
        done({
          url,
          label: "RTSP stream",
          status: 200,
          contentType: "application/rtsp",
          kind: "rtsp",
          playable: false,
          sample: buffer.slice(0, 240),
        });
      } else {
        done(null);
      }
    });
  });
}

async function scanRtspEndpoints(hosts, localAddress = "") {
  const urls = [];
  for (const host of hosts) {
    for (const candidate of RTSP_CANDIDATES) {
      urls.push(`rtsp://${host}:${candidate.port}${candidate.path}`);
    }
  }
  const results = [];
  await runWithConcurrency(urls.map((url) => async () => {
    const result = await probeRtsp(url, 1300, localAddress);
    if (result && localAddress) result.sourceAddress = localAddress;
    if (result) results.push(result);
  }), 12);
  return results;
}

function isUdpJpegPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  const eof = buffer[1] & 0xff;
  const sequence = buffer[2] & 0xff;
  return sequence >= 1 && sequence <= 40 && (eof === 0 || eof === 1);
}

function normalizeDegrees(value) {
  const normalized = ((Number(value) % 360) + 360) % 360;
  return Number(normalized.toFixed(2));
}

function hexSample(buffer, max = 48) {
  if (!Buffer.isBuffer(buffer)) return "";
  return Array.from(buffer.subarray(0, max))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function rememberOrientationDebug(packet, orientation, remote = {}) {
  orientationDebug.unshift({
    at: new Date().toISOString(),
    remote: `${remote.address || "-"}:${remote.port || "-"}`,
    length: Buffer.isBuffer(packet) ? packet.length : 0,
    hex: hexSample(packet),
    orientation: orientation
      ? {
          source: orientation.source,
          rotation: orientation.rotation,
          angle: orientation.angle,
          x: orientation.x,
          y: orientation.y,
          z: orientation.z,
          magnitude: orientation.magnitude,
          sensorHeading: orientation.sensorHeading,
          deviceType: orientation.deviceType,
          payloadOffset: orientation.payloadOffset,
          fallbackMode: orientation.fallbackMode,
        }
      : null,
  });
  while (orientationDebug.length > 80) orientationDebug.pop();
}

function parseCameraSensorPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) return null;

  if (buffer.length >= 20) {
    const sensorHeading = buffer.readUInt16BE(18);
    if (sensorHeading <= 360) {
      const x = buffer.readInt16BE(0);
      const y = buffer.readInt16BE(2);
      const z = buffer.readInt16BE(4);
      return {
        rotation: normalizeDegrees(sensorHeading),
        angle: sensorHeading,
        x,
        y,
        z,
        magnitude: Math.round(Math.hypot(x, y, z)),
        sensorHeading,
        payloadOffset: 18,
        fallbackMode: "beken-heading-u16be-18",
        source: "sensor-heading",
        updatedAt: Date.now(),
      };
    }
  }

  const offsets = [0];
  const eof = buffer[1] & 0xff;
  const sequence = buffer[2] & 0xff;
  if (buffer.length >= 10 && (eof === 0 || eof === 1) && sequence >= 1 && sequence <= 40) {
    offsets.unshift(4);
  }

  const candidates = offsets
    .filter((offset) => offset + 5 < buffer.length)
    .map((offset) => {
      const x = buffer.readInt16BE(offset);
      const y = buffer.readInt16BE(offset + 2);
      const z = buffer.readInt16BE(offset + 4);
      const magnitude = Math.hypot(x, y, z);
      return { offset, x, y, z, magnitude };
    })
    .filter((candidate) => Number.isFinite(candidate.magnitude) && candidate.magnitude >= 1200);
  if (!candidates.length) return null;

  candidates.sort((a, b) => Math.abs(a.magnitude - 16384) - Math.abs(b.magnitude - 16384));
  const { offset, x, y, z, magnitude } = candidates[0];

  const angle = Math.atan2(x, y) * 180 / Math.PI;
  return {
    rotation: normalizeDegrees(angle),
    angle: Number(angle.toFixed(1)),
    x,
    y,
    z,
    magnitude: Math.round(magnitude),
    payloadOffset: offset,
    fallbackMode: "android-accelerometer-xy",
    source: "sensor-accelerometer",
    updatedAt: Date.now(),
  };
}

function broadcastOrientation(orientation, force = false) {
  const previousRotation = cameraOrientation.rotation;
  Object.assign(cameraOrientation, orientation);
  const now = Date.now();
  if (!force && now - lastOrientationBroadcast < 32) return;
  if (!force && Math.abs((orientation.rotation || 0) - previousRotation) < 0.05) return;
  lastOrientationBroadcast = now;
  const payload = `event: orientation\ndata: ${JSON.stringify(cameraOrientation)}\n\n`;
  for (const client of orientationClients) {
    try {
      client.write(payload);
    } catch {
      orientationClients.delete(client);
    }
  }
}

function buildUdpJpegEndpoint(host, sourceAddress, info = "") {
  const params = new URLSearchParams({
    protocol: "beken",
    host,
  });
  if (sourceAddress) params.set("source", sourceAddress);
  return {
    url: `/api/camera/stream?${params.toString()}`,
    label: "UDP JPEG stream",
    status: 200,
    contentType: `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
    kind: "udp-jpeg",
    playable: true,
    sourceAddress,
    host,
    sample: info,
  };
}

function sendUdp(socket, payload, port, host) {
  return new Promise((resolve) => {
    socket.send(payload, port, host, () => resolve());
  });
}

function makeCameraTargets(hosts, sourceAddress = "") {
  const targets = [];
  const broadcast = ipv4Broadcast(sourceAddress);
  if (broadcast) targets.push({ host: broadcast, port: 46526, payload: CAMERA_DISCOVERY_PACKET });
  targets.push({ host: "255.255.255.255", port: 46526, payload: CAMERA_DISCOVERY_PACKET });
  for (const host of unique(hosts).filter(isPrivateHost)) {
    targets.push({ host, port: 44506, payload: CAMERA_START_IMAGE_PACKET });
    targets.push({ host, port: 52219, payload: CAMERA_START_SENSOR_PACKET });
  }
  return targets;
}

function probeUdpJpegStream(hosts, sourceAddress = "", timeout = 1600) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const targets = makeCameraTargets(hosts, sourceAddress);
    let settled = false;
    let info = "";
    let lastHost = hosts.find(isPrivateHost) || "192.168.1.1";
    let interval = null;

    function finish(endpoint) {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      socket.close();
      resolve(endpoint);
    }

    socket.on("message", (message, remote) => {
      if (remote.port === 46526) {
        info = message.toString("utf8", 0, Math.min(message.length, 512));
        if (remote.address) lastHost = remote.address;
      }
      if (remote.port === 44506 && isUdpJpegPacket(message)) {
        finish(buildUdpJpegEndpoint(remote.address || lastHost, sourceAddress, info));
      }
    });

    socket.on("error", () => finish(null));
    socket.bind({ address: sourceAddress || "0.0.0.0", port: 0 }, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // Some adapters reject broadcast toggles while disconnected.
      }
      const sendAll = () => {
        for (const target of targets) {
          socket.send(target.payload, target.port, target.host);
        }
      };
      sendAll();
      interval = setInterval(sendAll, 150);
      setTimeout(() => finish(null), timeout);
    });
  });
}

async function scanUdpJpegEndpoints(hosts, sourceAddress = "") {
  if (!sourceAddress) return [];
  const endpoint = await probeUdpJpegStream(hosts, sourceAddress);
  return endpoint ? [endpoint] : [];
}

function createUdpJpegFrameAssembler(onFrame) {
  const frames = new Map();

  return (packet) => {
    if (!isUdpJpegPacket(packet)) return;
    const frameId = packet[0] & 0xff;
    const isEof = (packet[1] & 0xff) === 1;
    const sequence = packet[2] & 0xff;
    const payload = packet.subarray(4);
    let frame = frames.get(frameId);

    if (!frame) {
      frame = {
        chunks: new Map(),
        expected: 0,
        createdAt: Date.now(),
      };
      frames.set(frameId, frame);
    }

    frame.chunks.set(sequence, Buffer.from(payload));
    if (isEof) frame.expected = sequence;

    for (const [id, value] of frames) {
      if (Date.now() - value.createdAt > 1500) frames.delete(id);
    }
    while (frames.size > 8) {
      const oldest = [...frames.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      frames.delete(oldest[0]);
    }

    if (!frame.expected || frame.chunks.size < frame.expected) return;

    const chunks = [];
    for (let index = 1; index <= frame.expected; index++) {
      const chunk = frame.chunks.get(index);
      if (!chunk) return;
      chunks.push(chunk);
    }

    frames.delete(frameId);
    const jpeg = Buffer.concat(chunks);
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return;
    onFrame(jpeg);
  };
}

async function handleUdpJpegStream(req, res, url) {
  const status = await getNetworkStatus();
  const sourceAddress = url.searchParams.get("source") || sourceAddressFromStatus(status);
  const hosts = hostCandidatesFromStatus(status, url.searchParams.get("host") || "");
  const host = hosts.find(isPrivateHost) || "192.168.1.1";
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let closed = false;
  let interval = null;
  let latestStreamOrientation = null;
  let lastFrameAt = 0;

  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    expires: "0",
    "access-control-allow-origin": "*",
    connection: "close",
  });

  const assemble = createUdpJpegFrameAssembler((jpeg) => {
    if (closed || res.destroyed) return;
    lastFrameAt = Date.now();
    res.write(`--${STREAM_BOUNDARY}\r\n`);
    res.write("Content-Type: image/jpeg\r\n");
    res.write(`Content-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write("\r\n");
    if (latestStreamOrientation && lastFrameAt - latestStreamOrientation.updatedAt < 750) {
      broadcastOrientation(latestStreamOrientation);
    }
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    try {
      socket.send(CAMERA_STOP_IMAGE_PACKET, 44506, host);
    } catch {
      // Best effort stop signal.
    }
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Socket may already be closed by an error.
      }
    }, 120);
  }

  socket.on("message", (message, remote) => {
    if (remote.port === 44506) assemble(message);
    if (remote.port === 52219) {
      const orientation = parseCameraSensorPacket(message);
      rememberOrientationDebug(message, orientation, remote);
      if (orientation) {
        latestStreamOrientation = orientation;
        if (Date.now() - lastFrameAt > 250) broadcastOrientation(orientation);
      }
    }
  });
  socket.on("error", () => cleanup());
  req.on("close", cleanup);
  res.on("close", cleanup);

  socket.bind({ address: sourceAddress || "0.0.0.0", port: 0 }, () => {
    try {
      socket.setBroadcast(true);
    } catch {
      // Keep going; direct unicast is usually enough once the gateway is known.
    }
    const targets = makeCameraTargets(hosts, sourceAddress);
    const sendStart = () => {
      for (const target of targets) {
        socket.send(target.payload, target.port, target.host);
      }
      socket.send(CAMERA_START_IMAGE_PACKET, 44506, host);
      socket.send(CAMERA_START_SENSOR_PACKET, 52219, host);
    };
    sendStart();
    interval = setInterval(sendStart, 1200);
  });
}

async function runWithConcurrency(tasks, limit) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      await task();
    }
  });
  await Promise.all(workers);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 128 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function openWifiProfileXml(ssid) {
  const escaped = escapeXml(ssid);
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${escaped}</name>
  <SSIDConfig>
    <SSID>
      <name>${escaped}</name>
    </SSID>
  </SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM>
    <security>
      <authEncryption>
        <authentication>open</authentication>
        <encryption>none</encryption>
        <useOneX>false</useOneX>
      </authEncryption>
    </security>
  </MSM>
</WLANProfile>`;
}

async function connectWifi(ssid) {
  const safeSsid = String(ssid || TARGET_SSID).trim();
  if (!safeSsid) throw new Error("SSID is empty.");
  if (process.platform !== "win32") {
    return {
      ssid: safeSsid,
      profileAdded: false,
      connected: false,
      unsupported: true,
      connectOutput: "Automatic Wi-Fi connection is only available on Windows. Connect to the camera Wi-Fi manually, then press Scan.",
    };
  }
  const xmlPath = path.join(os.tmpdir(), `endoscope-${Date.now()}.xml`);
  await fsp.writeFile(xmlPath, openWifiProfileXml(safeSsid), "utf8");

  const add = await run("netsh", ["wlan", "add", "profile", `filename=${xmlPath}`, "user=current"], 10000);
  const connect = await run("netsh", ["wlan", "connect", `name=${safeSsid}`, `ssid=${safeSsid}`], 12000);

  try {
    await fsp.rm(xmlPath, { force: true });
  } catch {
    // Temporary profile file cleanup is best-effort.
  }

  return {
    ssid: safeSsid,
    profileAdded: add.ok,
    connected: connect.ok,
    addOutput: add.stdout || add.stderr || add.error,
    connectOutput: connect.stdout || connect.stderr || connect.error,
  };
}

async function handleProxy(req, res, targetUrl, localAddress = "") {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    sendText(res, 400, "Invalid stream URL.");
    return;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    sendText(res, 400, "The proxy only supports HTTP/HTTPS. RTSP must be opened with VLC or FFmpeg.");
    return;
  }

  const client = parsed.protocol === "https:" ? https : http;
  const proxyReq = client.request(
    parsed,
    {
      method: "GET",
      headers: {
        "user-agent": "WiFi-Endoscope-Viewer/1.0",
        accept: req.headers.accept || "*/*",
        connection: "keep-alive",
      },
      localAddress: localAddress || undefined,
    },
    (proxyRes) => {
      const headers = {
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
        expires: "0",
        "access-control-allow-origin": "*",
      };
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!["x-frame-options", "content-security-policy", "content-length"].includes(key.toLowerCase())) {
          headers[key] = value;
        }
      }
      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (error) => {
    if (!res.headersSent) sendText(res, 502, `Failed to open stream: ${error.message}`);
    else res.destroy(error);
  });
  req.on("close", () => proxyReq.destroy());
  proxyReq.end();
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/network") {
    sendJson(res, 200, await getNetworkStatus());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/scan") {
    const status = await getNetworkStatus();
    const manualHost = url.searchParams.get("host") || "";
    const hosts = hostCandidatesFromStatus(status, manualHost);
    const sourceAddress = sourceAddressFromStatus(status);
    const udpResults = await scanUdpJpegEndpoints(hosts, sourceAddress);
    if (udpResults.length) {
      sendJson(res, 200, {
        checkedAt: new Date().toISOString(),
        hosts,
        sourceAddress,
        network: status,
        results: udpResults,
      });
      return true;
    }
    const [httpResults, rtspResults] = await Promise.all([
      scanHttpEndpoints(hosts, sourceAddress),
      scanRtspEndpoints(hosts, sourceAddress),
    ]);
    sendJson(res, 200, {
      checkedAt: new Date().toISOString(),
      hosts,
      sourceAddress,
      network: status,
      results: [...udpResults, ...httpResults, ...rtspResults],
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/connect") {
    try {
      const body = await parseBody(req);
      const result = await connectWifi(body.ssid || TARGET_SSID);
      sendJson(res, result.connected ? 200 : 409, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/proxy") {
    const requestedSource = url.searchParams.get("source") || "";
    const sourceAddress = requestedSource || sourceAddressFromStatus(await getNetworkStatus());
    await handleProxy(req, res, url.searchParams.get("url") || "", sourceAddress);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/camera/stream") {
    await handleUdpJpegStream(req, res, url);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/camera/orientation-debug") {
    sendJson(res, 200, {
      current: cameraOrientation,
      samples: orientationDebug,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/camera/orientation") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    orientationClients.add(res);
    broadcastOrientation(cameraOrientation, true);
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
    }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      orientationClients.delete(res);
    });
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  const filePath = safeJoinStatic(url.pathname);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function openBrowser(url) {
  if (process.env.CAMERA_OPEN_BROWSER === "0") return;
  const command = process.platform === "win32"
    ? ["cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  run(command[0], command[1], 3000).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (await handleApi(req, res, url)) return;
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Wi-Fi Endoscope Viewer is running at ${url}`);
  console.log(`Target SSID: ${TARGET_SSID}`);
  openBrowser(url);
});
