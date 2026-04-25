// stats.js â€” Hearthboard speed-test client + interactive SVG chart.
//
// Two test targets:
//   - "internet": Cloudflare's speed.cloudflare.com endpoints (anycast, so
//     the test automatically runs against whichever Cloudflare colo the
//     user's ISP routes them to). /meta reports the colo.
//   - "lan": the Hearthboard server's own /api/speedtest endpoints, which
//     report device-to-self-hosted-box throughput. Useful for diagnosing
//     Wi-Fi or LAN switching issues separately from the internet pipe.
//
// The UI lets the user switch between them, shows which server each sample
// came from, and if the chosen target fails mid-run we auto-fall-back to
// the other target with a notice.

const TARGETS = {
  internetPi: {
    id: "internetPi",
    label: "Pi Internet",
    provider: "Hearthboard Pi",
    historySource: "internet",
    machineFilter: "pi",
    manualDisabled: true,
    blurb:
      "Background internet samples collected on the Raspberry Pi every 5 minutes."
  },
  internetDesktop: {
    id: "internetDesktop",
    label: "PC Internet",
    provider: "Desktop PC",
    historySource: "internet",
    machineFilter: "desktop",
    manualDisabled: true,
    blurb:
      "Background internet samples collected on the PC every hour and synced to the Pi."
  },
  lan: {
    id: "lan",
    label: "Local network",
    provider: "Hearthboard server",
    historySource: "lan",
    machineFilter: "all",
    downloadUrl: (bytes) =>
      "/api/speedtest/download?size=" + bytes + "&k=" + Math.random(),
    uploadUrl: "/api/speedtest/upload",
    metaUrl: null,
    downloadChunkBytes: 4 * 1024 * 1024,
    downloadMaxBytes: 12 * 1024 * 1024,
    downloadMinDurationMs: 3000,
    uploadBytes: 6 * 1024 * 1024,
    uploadContentType: "application/octet-stream",
    pingBytes: 2048,
    includeCredentials: true,
    blurb:
      "Device-to-Hearthboard-server throughput. Useful for diagnosing Wi-Fi or LAN issues, NOT your actual internet speed."
  }
};

const TARGET_ORDER = ["lan"];
const DEFAULT_TARGET_ID = "internetPi";

const WINDOWS = [
  { key: "15m", label: "15 min", ms: 15 * 60_000 },
  { key: "1h", label: "1 hour", ms: 60 * 60_000 },
  { key: "24h", label: "24 hrs", ms: 24 * 60 * 60_000 },
  { key: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { key: "30d", label: "30 days", ms: 30 * 86_400_000 },
  { key: "custom", label: "Custom", ms: null }
];

const POLL_HISTORY_MS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
// Upload can take a while on slow ISP uplinks (a 5 MB payload at 5 Mbps
// is ~8 seconds just on the ISP side, plus server hop and upstream
// forward). 70 s gives slow uplinks headroom without hanging forever.
const UPLOAD_FETCH_TIMEOUT_MS = 70_000;
const LATENCY_PINGS = 5;
const STORAGE_KEY_TARGET = "hearthboard.stats.target";

const state = {
  targetId: loadStoredTarget(),
  targetMeta: null, // { colo, city, region, country } â€” filled when target = internet
  window: "1h",
  customFrom: null, // epoch ms or null
  customTo: null,
  history: { results: [], latest: null, averages: null },
  running: false,
  autoRunTimer: null,
  pollTimer: null,
  lastAutoRun: 0,
  failoverNotice: null
};

function loadStoredTarget() {
  try {
    const v = localStorage.getItem(STORAGE_KEY_TARGET);
    if (v === "internet") return "internetPi";
    if (v && TARGETS[v]) return v;
  } catch (_) {}
  return DEFAULT_TARGET_ID;
}

function saveTarget(id) {
  try {
    localStorage.setItem(STORAGE_KEY_TARGET, id);
  } catch (_) {}
}

const els = {
  runBtn: document.getElementById("stats-run-button"),
  runStatus: document.getElementById("stats-running-status"),
  runPhase: document.getElementById("stats-running-phase"),
  currentDown: document.getElementById("stats-current-download"),
  currentUp: document.getElementById("stats-current-upload"),
  lastRun: document.getElementById("stats-last-run"),
  sampleCount: document.getElementById("stats-sample-count"),
  summary: document.getElementById("stats-summary"),
  emptyState: document.getElementById("stats-empty-state"),
  chartHost: document.getElementById("stats-chart-host"),
  chartSvg: document.getElementById("stats-chart-svg"),
  tooltip: document.getElementById("stats-chart-tooltip"),
  chips: Array.from(document.querySelectorAll(".stats-window-chip")),
  targetChips: Array.from(document.querySelectorAll(".stats-target-chip")),
  serverLabel: document.getElementById("stats-server-label"),
  targetNote: document.getElementById("stats-target-note"),
  customRange: document.getElementById("stats-custom-range"),
  customFrom: document.getElementById("stats-custom-from"),
  customTo: document.getElementById("stats-custom-to"),
  customApply: document.getElementById("stats-custom-apply")
};

// --- formatting helpers ------------------------------------------------------

function fmtMbps(value) {
  if (!Number.isFinite(value) || value <= 0) return "â€”";
  if (value >= 100) return value.toFixed(0) + " Mbps";
  if (value >= 10) return value.toFixed(1) + " Mbps";
  return value.toFixed(2) + " Mbps";
}

function fmtLatency(value) {
  if (!Number.isFinite(value) || value <= 0) return "â€”";
  if (value >= 1000) return (value / 1000).toFixed(2) + " s";
  return Math.round(value) + " ms";
}

function fmtTimeForWindow(date, windowKey) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const now = Date.now();
  const diff = now - date.getTime();
  if (windowKey === "7d" || windowKey === "30d" || windowKey === "custom") {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric" });
  }
  if (windowKey === "24h") {
    if (diff < 22 * 3600_000) {
      return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric" });
  }
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtRelative(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 15_000) return "just now";
  if (ms < 60_000) return Math.round(ms / 1000) + "s ago";
  if (ms < 3600_000) return Math.round(ms / 60_000) + "m ago";
  if (ms < 86_400_000) return Math.round(ms / 3600_000) + "h ago";
  return Math.round(ms / 86_400_000) + "d ago";
}

function tsOf(r) {
  // Server field is `ts` (ISO); be tolerant of older clients too.
  const raw = r && (r.ts || r.timestamp);
  if (raw == null) return NaN;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 1_000_000_000_000) return n;
  return Date.parse(String(raw));
}

// --- network helpers ---------------------------------------------------------

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const signal = options.signal
    ? mergeSignals(options.signal, controller.signal)
    : controller.signal;
  return fetch(url, { ...options, signal }).finally(() => clearTimeout(timer));
}

function mergeSignals(a, b) {
  if (!a) return b;
  if (!b) return a;
  const c = new AbortController();
  const onAbort = () => c.abort();
  a.addEventListener("abort", onAbort);
  b.addEventListener("abort", onAbort);
  if (a.aborted || b.aborted) c.abort();
  return c.signal;
}

// --- Target meta lookup -----------------------------------------------------
// Each target can expose a metaUrl returning a JSON blob describing the
// upstream server (Ookla â†’ sponsor+name+host; Cloudflare â†’ colo+city).
// The label renderer looks at state.targetMeta and formats accordingly.

async function fetchTargetMeta(targetId) {
  const t = TARGETS[targetId || state.targetId];
  if (!t || !t.metaUrl) return null;
  try {
    const res = await fetchWithTimeout(t.metaUrl, {
      credentials: t.includeCredentials ? "same-origin" : "omit",
      cache: "no-store"
    }, 8000);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("[stats] meta fetch failed for " + (t.id || "?"), err);
    return null;
  }
}

// Backward-compat alias for any existing call sites.
const fetchCloudflareMeta = () => fetchTargetMeta("internet");

function describeTarget(targetId, meta) {
  const t = TARGETS[targetId];
  if (!t) return "Unknown target";
  if (targetId === "internetPi") {
    return "Hearthboard Pi";
  }
  if (targetId === "internetDesktop") {
    return "Desktop PC";
  }
  if (targetId === "lan") {
    return "Hearthboard Â· LAN (" + location.host + ")";
  }
  return t.provider;
}

function renderTargetLabel() {
  if (!els.serverLabel) return;
  els.serverLabel.textContent = describeTarget(state.targetId, state.targetMeta);
  const t = TARGETS[state.targetId];
  if (!els.targetNote) return;
  const parts = [];
  if (t && t.blurb) parts.push(t.blurb);
  const latest = state.history && state.history.latest ? state.history.latest : null;
  if ((state.targetId === "internetPi" || state.targetId === "internetDesktop") && latest) {
    const upstream = latest.serverLocation || latest.target || "";
    if (upstream) {
      parts.push("Latest upstream: " + upstream + ".");
    }
    if (state.targetId === "internetDesktop") {
      parts.push("Desktop samples arrive hourly, so 1 hour or 24 hour windows work best.");
    }
  }
  if (state.failoverNotice) {
    parts.push(state.failoverNotice);
  }
  els.targetNote.textContent = parts.join(" ");
  els.targetNote.hidden = parts.length === 0;
}

function renderRunButtonState() {
  if (!els.runBtn) return;
  const target = TARGETS[state.targetId];
  const label = els.runBtn.querySelector(".run-label");
  if (state.running) {
    els.runBtn.disabled = true;
    return;
  }
  if (target && target.manualDisabled) {
    els.runBtn.disabled = true;
    els.runBtn.title = "This view is fed by background samples.";
    if (label) label.textContent = "Background only";
    if (els.runStatus) els.runStatus.hidden = true;
    return;
  }
  els.runBtn.disabled = false;
  els.runBtn.title = "";
  if (label) label.textContent = "Run test";
}

// --- server I/O --------------------------------------------------------------

async function fetchHistory() {
  try {
    const target = TARGETS[state.targetId] || TARGETS[DEFAULT_TARGET_ID];
    const params = new URLSearchParams();
    if (state.window === "custom" && state.customFrom && state.customTo) {
      params.set("from", String(state.customFrom));
      params.set("to", String(state.customTo));
    } else {
      params.set("window", state.window);
    }
    params.set("source", target.historySource || "all");
    if (target.machineFilter && target.machineFilter !== "all") {
      params.set("machine", target.machineFilter);
    }

    const res = await fetch("/api/speedtest/history?" + params.toString(), {
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!res.ok) throw new Error("history " + res.status);
    const data = await res.json();
    state.history = {
      results: Array.isArray(data.results) ? data.results : [],
      latest: data.latest || null,
      averages: data.averages || null,
      from: data.from,
      to: data.to
    };
    render();
  } catch (err) {
    // Silent fail â€” we'll just keep the last rendering.
    console.warn("[stats] history fetch failed", err);
  }
}

async function postResult(result) {
  try {
    const res = await fetch("/api/speedtest/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(result)
    });
    if (!res.ok) throw new Error("results " + res.status);
    return await res.json();
  } catch (err) {
    console.warn("[stats] failed to persist result", err);
    return null;
  }
}

// --- measurement primitives --------------------------------------------------

async function measureLatency(target, count = LATENCY_PINGS) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    try {
      const res = await fetchWithTimeout(target.downloadUrl(target.pingBytes), {
        credentials: target.includeCredentials ? "same-origin" : "omit",
        cache: "no-store"
      }, 4000);
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } else {
        await res.arrayBuffer();
      }
      samples.push(performance.now() - started);
    } catch (err) {
      // Skip failed pings.
    }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  // Drop the worst sample to smooth out a single jitter spike.
  const trimmed = samples.length > 2 ? samples.slice(0, -1) : samples;
  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  return { avg, best: samples[0], samples };
}

async function measureDownload(target, onProgress) {
  let totalBytes = 0;
  const started = performance.now();
  let lastTick = started;

  // Keep pulling chunks until we hit the byte cap OR we've been running
  // at least target.downloadMinDurationMs (so fast links still get a few
  // seconds of measurement instead of spiking off a sub-second sample).
  while (true) {
    const chunk = target.downloadChunkBytes;
    const res = await fetchWithTimeout(target.downloadUrl(chunk), {
      credentials: target.includeCredentials ? "same-origin" : "omit",
      cache: "no-store"
    });
    if (!res.ok) throw new Error("download " + res.status);

    if (!res.body) {
      const buf = await res.arrayBuffer();
      totalBytes += buf.byteLength;
    } else {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        const now = performance.now();
        if (onProgress && now - lastTick > 150) {
          lastTick = now;
          const elapsed = (now - started) / 1000;
          if (elapsed > 0) onProgress(totalBytes, elapsed);
        }
      }
    }

    const elapsedMs = performance.now() - started;
    if (totalBytes >= target.downloadMaxBytes) break;
    if (elapsedMs >= target.downloadMinDurationMs && totalBytes > 0) break;
  }

  const elapsed = (performance.now() - started) / 1000;
  const mbps = elapsed > 0 ? (totalBytes * 8) / 1_000_000 / elapsed : 0;
  return { bytes: totalBytes, seconds: elapsed, mbps };
}

function makePayload(bytes) {
  const arr = new Uint8Array(bytes);
  // crypto.getRandomValues only accepts <=64KB per call; chunk it.
  const chunk = 65536;
  for (let i = 0; i < arr.byteLength; i += chunk) {
    const slice = arr.subarray(i, Math.min(i + chunk, arr.byteLength));
    try {
      crypto.getRandomValues(slice);
    } catch (e) {
      // Fallback â€” pseudo-random is fine for throughput testing.
      for (let j = 0; j < slice.length; j++) slice[j] = (Math.random() * 256) | 0;
    }
  }
  return arr;
}

async function measureUpload(target, onProgress) {
  const payload = makePayload(target.uploadBytes);
  const started = performance.now();
  let progressTimer = null;
  if (onProgress) {
    progressTimer = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed > 0) {
        // fetch doesn't expose upload progress; extrapolate from elapsed.
        onProgress(Math.min(payload.byteLength, Math.round((payload.byteLength * elapsed) / 3.5)), elapsed);
      }
    }, 200);
  }
  try {
    const res = await fetchWithTimeout(target.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": target.uploadContentType },
      credentials: target.includeCredentials ? "same-origin" : "omit",
      body: payload
    }, UPLOAD_FETCH_TIMEOUT_MS);
    const elapsed = (performance.now() - started) / 1000;
    if (!res.ok) {
      // Pull the real upstream error body so "up failed (reason)" in
      // the UI tells us what the proxy actually saw, instead of just
      // "upload 502".
      let detail = "";
      try {
        const body = await res.text();
        try {
          const json = JSON.parse(body);
          detail = json.detail || json.error || body.slice(0, 160);
        } catch (_) {
          detail = body.slice(0, 160);
        }
      } catch (_) {}
      throw new Error("upload " + res.status + (detail ? " â€” " + detail : ""));
    }
    // Parse JSON response â€” our proxy always returns { receivedBytes,
    // upstreamStatus, ... }. If receivedBytes is missing, fall back to
    // the payload length we sent.
    let received = payload.byteLength;
    try {
      const json = await res.json();
      if (json && Number.isFinite(Number(json.receivedBytes))) {
        received = Number(json.receivedBytes);
      }
    } catch (_) {
      // non-JSON response â€” trust payload length
    }
    const mbps = elapsed > 0 ? (received * 8) / 1_000_000 / elapsed : 0;
    return { bytes: received, seconds: elapsed, mbps };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

// --- main test runner --------------------------------------------------------

function setRunning(flag, phase) {
  state.running = flag;
  els.runBtn.classList.toggle("is-running", flag);
  els.runBtn.disabled = flag;
  if (els.runStatus) els.runStatus.hidden = !flag;
  if (els.runPhase && phase) els.runPhase.textContent = phase;
  const label = els.runBtn.querySelector(".run-label");
  if (label) label.textContent = flag ? "Runningâ€¦" : "Run test";
  if (!flag) renderRunButtonState();
}

async function runOneTarget(target) {
  setRunning(true, "Measuring latencyâ€¦");
  const latency = await measureLatency(target);

  setRunning(true, "Measuring downloadâ€¦");
  const download = await measureDownload(target, (bytes, elapsed) => {
    const mbps = (bytes * 8) / 1_000_000 / elapsed;
    els.currentDown.textContent = fmtMbps(mbps).replace(" Mbps", "");
  });
  els.currentDown.textContent = fmtMbps(download.mbps).replace(" Mbps", "");

  // Upload is best-effort: if the proxy (or the upstream) chokes on the
  // upload phase, we'd still rather report the download + latency we
  // already have than throw the whole run away and fall back to LAN.
  setRunning(true, "Measuring uploadâ€¦");
  let upload;
  let uploadError = null;
  try {
    upload = await measureUpload(target, (bytes, elapsed) => {
      const mbps = elapsed > 0 ? (bytes * 8) / 1_000_000 / elapsed : 0;
      els.currentUp.textContent = fmtMbps(mbps).replace(" Mbps", "");
    });
    els.currentUp.textContent = fmtMbps(upload.mbps).replace(" Mbps", "");
  } catch (err) {
    console.warn("[stats] upload measurement failed", err);
    uploadError = err;
    upload = { bytes: 0, seconds: 0, mbps: 0 };
    els.currentUp.textContent = "â€”";
  }

  return {
    latency: latency ? latency.avg : null,
    latencyBest: latency ? latency.best : null,
    download,
    upload,
    uploadError
  };
}

async function runSpeedTest(options = {}) {
  if (state.running) return;
  const runStarted = Date.now();
  state.failoverNotice = null;
  renderTargetLabel();

  const primaryId = state.targetId;
  if (!TARGETS[primaryId] || TARGETS[primaryId].manualDisabled) {
    renderRunButtonState();
    return;
  }
  const fallbackChain = TARGET_ORDER.filter(id => id !== primaryId);
  const attempts = [primaryId, ...fallbackChain];

  let lastError = null;
  let ranTarget = null;
  let sample = null;

  for (const id of attempts) {
    const target = TARGETS[id];
    if (!target) continue;
    try {
      sample = await runOneTarget(target);
      ranTarget = id;
      // If we fell back away from the user's choice, make a note and
      // refresh meta so the server label updates to reflect the fallback
      // target (e.g. "Cloudflare Â· Miami" instead of "Spectrum Tampa").
      if (id !== primaryId) {
        state.failoverNotice =
          "Primary target (" + TARGETS[primaryId].label + ") failed â€” showing " +
          target.label + " results instead.";
        state.targetMeta = await fetchTargetMeta(id);
        renderTargetLabel();
      }
      break;
    } catch (err) {
      console.warn("[stats] target failed:", id, err);
      lastError = err;
    }
  }

  if (!sample || !ranTarget) {
    setRunning(false);
    els.lastRun.textContent = "Test failed: " + (lastError && lastError.message ? lastError.message : "unknown error");
    renderTargetLabel();
    return;
  }

  // Normalize which "source" this row lands under. Ookla Tampa and the
  // hidden Cloudflare fallback both belong on the Internet chart, not
  // LAN â€” they're both ISP-routed measurements.
  const sourceForChart = ranTarget.startsWith("internet") ? "internet" : ranTarget;
  const meta = state.targetMeta || {};
  const serverLocation =
    ranTarget === "internet"
      ? [meta.sponsor, meta.name || meta.city].filter(Boolean).join(" Â· ")
      : ranTarget === "internetCloudflare"
        ? [meta.city, meta.country].filter(Boolean).join(", ") +
          (meta.colo ? " (" + meta.colo + ")" : "")
        : null;

  const result = {
    downloadMbps: sample.download.mbps,
    uploadMbps: sample.upload.mbps,
    latencyMs: sample.latency || 0,
    source: sourceForChart,
    target: TARGETS[ranTarget].provider,
    serverLocation: serverLocation || null,
    runtimeMs: Date.now() - runStarted
  };
  await postResult(result);
  state.lastAutoRun = Date.now();
  const upPart = sample.uploadError
    ? " Â· up failed (" + (sample.uploadError.message || "unknown") + ")"
    : " Â· up " + fmtMbps(sample.upload.mbps);
  els.lastRun.textContent = "Just ran via " + TARGETS[ranTarget].label +
    " â€” down " + fmtMbps(sample.download.mbps) +
    upPart +
    (sample.latency ? " Â· latency " + fmtLatency(sample.latency) : "");
  setRunning(false);
  await fetchHistory();
  renderTargetLabel();
}

// --- chart rendering ---------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      node.setAttribute(k, String(v));
    }
  }
  return node;
}

function niceCeil(value) {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const rel = value / pow;
  let mult;
  if (rel <= 1) mult = 1;
  else if (rel <= 2) mult = 2;
  else if (rel <= 2.5) mult = 2.5;
  else if (rel <= 5) mult = 5;
  else mult = 10;
  return mult * pow;
}

function smoothPath(points) {
  if (!points.length) return "";
  if (points.length === 1) {
    const p = points[0];
    return "M" + p.x + "," + p.y;
  }
  let path = "M" + points[0].x + "," + points[0].y;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path += " C" + cp1x + "," + cp1y + " " + cp2x + "," + cp2y + " " + p2.x + "," + p2.y;
  }
  return path;
}

function currentWindowRange() {
  if (state.history && state.history.from && state.history.to) {
    const from = tsOf({ ts: state.history.from });
    const to = tsOf({ ts: state.history.to });
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      return { xMin: from, xMax: to };
    }
  }
  if (state.window === "custom" && state.customFrom && state.customTo) {
    return { xMin: state.customFrom, xMax: state.customTo };
  }
  const def = WINDOWS.find(w => w.key === state.window) || WINDOWS[1];
  const now = Date.now();
  return { xMin: now - (def.ms || 60 * 60_000), xMax: now };
}

function polylinePoints(points) {
  return points.map(point => point.x + "," + point.y).join(" ");
}

function ensureCanvasChartElements() {
  let canvas = els.chartHost.querySelector("[data-stats-canvas]");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.setAttribute("data-stats-canvas", "true");
    canvas.className = "stats-chart-canvas";
    els.chartHost.insertBefore(canvas, els.tooltip);
  }

  let hoverLine = els.chartHost.querySelector("[data-stats-hover-line]");
  if (!hoverLine) {
    hoverLine = document.createElement("div");
    hoverLine.setAttribute("data-stats-hover-line", "true");
    hoverLine.className = "stats-chart-hover-line";
    hoverLine.hidden = true;
    els.chartHost.insertBefore(hoverLine, els.tooltip);
  }

  let hoverDot = els.chartHost.querySelector("[data-stats-hover-dot]");
  if (!hoverDot) {
    hoverDot = document.createElement("div");
    hoverDot.setAttribute("data-stats-hover-dot", "true");
    hoverDot.className = "stats-chart-hover-dot";
    hoverDot.hidden = true;
    els.chartHost.insertBefore(hoverDot, els.tooltip);
  }

  return { canvas, hoverLine, hoverDot };
}

function renderChartStable() {
  const svg = els.chartSvg;
  svg.innerHTML = "";
  chartGeometry = null;
  hideTooltip();

  const { canvas, hoverLine, hoverDot } = ensureCanvasChartElements();
  const hostWidth = Math.round(
    els.chartHost?.clientWidth ||
    els.chartHost?.getBoundingClientRect?.().width ||
    0
  );
  const width = Math.max(320, hostWidth || 600);
  const height = 360;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const margin = { top: 24, right: 56, bottom: 36, left: 48 };
  const innerWidth = Math.max(120, width - margin.left - margin.right);
  const innerHeight = Math.max(120, height - margin.top - margin.bottom);

  const results = (state.history.results || [])
    .map(r => ({
      t: tsOf(r),
      dl: Number(r.downloadMbps) || 0,
      ul: Number(r.uploadMbps) || 0,
      lat: Number(r.latencyMs) || 0,
      source: r.source || "internet",
      location: r.serverLocation || null,
      runner: r.runner || null
    }))
    .filter(r => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);

  if (!results.length) {
    els.emptyState.hidden = false;
    svg.hidden = true;
    canvas.hidden = true;
    return;
  }

  const windowRange = currentWindowRange();
  let xMin = Number.isFinite(windowRange.xMin) ? windowRange.xMin : results[0].t;
  let xMax = Number.isFinite(windowRange.xMax) ? windowRange.xMax : results[results.length - 1].t;
  if (!(xMax > xMin)) {
    xMin = results[0].t - 60_000;
    xMax = results[results.length - 1].t + 60_000;
    if (!(xMax > xMin)) {
      xMin -= 30_000;
      xMax += 30_000;
    }
  }

  els.emptyState.hidden = true;
  svg.hidden = true;
  canvas.hidden = false;

  const xAt = t => margin.left + ((t - xMin) / (xMax - xMin)) * innerWidth;
  const maxSpeed = Math.max(10, niceCeil(Math.max(...results.map(r => Math.max(r.dl, r.ul, 0))) * 1.15));
  const maxLat = Math.max(50, niceCeil(Math.max(...results.map(r => r.lat || 0)) * 1.15));
  const ySpeedAt = v => margin.top + innerHeight - (Math.max(0, Math.min(maxSpeed, v)) / maxSpeed) * innerHeight;
  const yLatAt = v => margin.top + innerHeight - (Math.max(0, Math.min(maxLat, v)) / maxLat) * innerHeight;
  const dark = document.documentElement.dataset.theme === "dark";
  const axisColor = dark ? "rgba(245, 230, 211, 0.55)" : "rgba(19, 34, 56, 0.55)";
  const gridColor = dark ? "rgba(255, 255, 255, 0.08)" : "rgba(19, 34, 56, 0.08)";

  const drawText = (text, x, y, align = "center", color = axisColor) => {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    ctx.restore();
  };

  const drawLine = (x1, y1, x2, y2, color, widthPx = 1, dash = []) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  };

  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const speedValue = (maxSpeed * i) / steps;
    const speedY = ySpeedAt(speedValue);
    drawLine(margin.left, speedY, margin.left + innerWidth, speedY, gridColor, 1, [3, 5]);
    drawText(Math.round(speedValue) + "", margin.left - 10, speedY + 1, "right");

    const latencyValue = (maxLat * i) / steps;
    const latencyY = yLatAt(latencyValue);
    drawText(Math.round(latencyValue) + "ms", margin.left + innerWidth + 10, latencyY + 1, "left", "#8b5cf6");
  }

  const tickCount = Math.min(6, Math.max(2, Math.floor(innerWidth / 120)));
  for (let i = 0; i <= tickCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / tickCount;
    drawText(fmtTimeForWindow(new Date(t), state.window), xAt(t), margin.top + innerHeight + 22, "center");
  }

  const dlPoints = results.map(r => ({ x: xAt(r.t), y: ySpeedAt(r.dl) }));
  const ulPoints = results.map(r => ({ x: xAt(r.t), y: ySpeedAt(r.ul) }));
  const latPoints = results.map(r => ({ x: xAt(r.t), y: yLatAt(r.lat) }));
  const baseY = margin.top + innerHeight;

  const strokeSeries = (points, strokeStyle, lineWidth = 2.5, dash = []) => {
    if (!points.length) return;
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    ctx.restore();
  };

  const fillArea = (points, startColor, endColor) => {
    if (points.length < 2) return;
    const gradient = ctx.createLinearGradient(0, margin.top, 0, baseY);
    gradient.addColorStop(0, startColor);
    gradient.addColorStop(1, endColor);
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(points[0].x, baseY);
    ctx.lineTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.lineTo(points[points.length - 1].x, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const isDesktopSample = result => result.client === "desktop" || /desktop/i.test(String(result.runner || ""));
  const piRingColor = dark ? "rgba(245, 230, 211, 0.72)" : "rgba(19, 34, 56, 0.58)";

  fillArea(dlPoints, "rgba(245, 158, 11, 0.35)", "rgba(221, 107, 32, 0)");
  fillArea(ulPoints, "rgba(20, 184, 166, 0.25)", "rgba(15, 118, 110, 0)");

  strokeSeries(dlPoints, "#f59e0b");
  strokeSeries(ulPoints, "#14b8a6");
  strokeSeries(latPoints, "#8b5cf6", 2, [5, 4]);

  results.forEach((result, i) => {
    const desktopSample = isDesktopSample(result);
    const drawPoint = (point, radius, fill, opacity = 1) => {
      if (!desktopSample) {
        ctx.save();
        ctx.strokeStyle = piRingColor;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (desktopSample) {
        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.fillStyle = fill;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = desktopSample ? 2.2 : (radius > 3 ? 1.5 : 1);
      ctx.globalAlpha = opacity;

      if (desktopSample) {
        const size = radius + 2.5;
        ctx.beginPath();
        ctx.moveTo(point.x, point.y - size);
        ctx.lineTo(point.x + size, point.y);
        ctx.lineTo(point.x, point.y + size);
        ctx.lineTo(point.x - size, point.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.restore();
    };
    drawPoint(dlPoints[i], 3.5, "#f59e0b");
    drawPoint(ulPoints[i], 3.5, "#14b8a6");
    drawPoint(latPoints[i], 2.5, "#8b5cf6", 0.8);
  });

  chartGeometry = {
    surface: canvas,
    width,
    height,
    margin,
    innerWidth,
    innerHeight,
    xMin,
    xMax,
    xAt,
    results,
    dlPoints,
    ulPoints,
    latPoints,
    hoverLine,
    hoverDot
  };

  canvas.onmousemove = onChartPointerMove;
  canvas.onmouseleave = hideTooltip;
  canvas.ontouchstart = onChartTouch;
  canvas.ontouchmove = onChartTouch;
  canvas.ontouchend = hideTooltip;
}

function renderChart() {
  try {
    return renderChartStable();
  } catch (error) {
    console.warn("[stats] chart render failed", error);
    els.chartSvg.innerHTML = "";
    els.chartSvg.hidden = true;
    els.emptyState.hidden = false;
    chartGeometry = null;
    hideTooltip();
  }

  const svg = els.chartSvg;
  svg.innerHTML = "";

  const rect = els.chartHost.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width || 600));
  const height = 360;
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("preserveAspectRatio", "none");

  const margin = { top: 24, right: 48, bottom: 36, left: 48 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const { xMin, xMax } = currentWindowRange();

  const results = (state.history.results || [])
    .map(r => ({
      t: tsOf(r),
      dl: Number(r.downloadMbps) || 0,
      ul: Number(r.uploadMbps) || 0,
      lat: Number(r.latencyMs) || 0,
      source: r.source || "internet",
      location: r.serverLocation || null,
      runner: r.runner || null
    }))
    .filter(r => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);

  if (!results.length) {
    els.emptyState.hidden = false;
    svg.hidden = true;
    hideTooltip();
    return;
  }
  els.emptyState.hidden = true;
  svg.hidden = false;

  // Scales
  const xAt = t => margin.left + ((t - xMin) / (xMax - xMin)) * innerWidth;
  const maxSpeed = niceCeil(Math.max(10, ...results.map(r => Math.max(r.dl, r.ul))) * 1.15);
  const maxLat = niceCeil(Math.max(50, ...results.map(r => r.lat || 0)) * 1.15);
  const ySpeedAt = v => margin.top + innerHeight - (Math.max(0, Math.min(maxSpeed, v)) / maxSpeed) * innerHeight;
  const yLatAt = v => margin.top + innerHeight - (Math.max(0, Math.min(maxLat, v)) / maxLat) * innerHeight;

  // Defs: gradients
  const defs = svgEl("defs");
  const gradDl = svgEl("linearGradient", { id: "statsGradDl", x1: "0", y1: "0", x2: "0", y2: "1" });
  gradDl.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#f59e0b", "stop-opacity": "0.55" }));
  gradDl.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#dd6b20", "stop-opacity": "0" }));
  const gradUl = svgEl("linearGradient", { id: "statsGradUl", x1: "0", y1: "0", x2: "0", y2: "1" });
  gradUl.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#14b8a6", "stop-opacity": "0.5" }));
  gradUl.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#0f766e", "stop-opacity": "0" }));
  const strokeDl = svgEl("linearGradient", { id: "statsStrokeDl", x1: "0", y1: "0", x2: "1", y2: "0" });
  strokeDl.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#dd6b20" }));
  strokeDl.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#f59e0b" }));
  const strokeUl = svgEl("linearGradient", { id: "statsStrokeUl", x1: "0", y1: "0", x2: "1", y2: "0" });
  strokeUl.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#0f766e" }));
  strokeUl.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#14b8a6" }));
  const strokeLat = svgEl("linearGradient", { id: "statsStrokeLat", x1: "0", y1: "0", x2: "1", y2: "0" });
  strokeLat.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#8b5cf6" }));
  strokeLat.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#6366f1" }));
  defs.append(gradDl, gradUl, strokeDl, strokeUl, strokeLat);
  svg.appendChild(defs);

  // Y gridlines + labels (speed)
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (maxSpeed * i) / steps;
    const y = ySpeedAt(v);
    svg.appendChild(svgEl("line", {
      class: "grid-line",
      x1: margin.left,
      y1: y,
      x2: margin.left + innerWidth,
      y2: y
    }));
    const label = svgEl("text", {
      class: "axis-label",
      x: margin.left - 10,
      y: y + 4,
      "text-anchor": "end"
    });
    label.textContent = Math.round(v) + "";
    svg.appendChild(label);
  }
  // Y right-axis for latency
  for (let i = 0; i <= steps; i++) {
    const v = (maxLat * i) / steps;
    const y = yLatAt(v);
    const label = svgEl("text", {
      class: "axis-label",
      x: margin.left + innerWidth + 10,
      y: y + 4,
      "text-anchor": "start",
      fill: "#8b5cf6",
      opacity: "0.85"
    });
    label.textContent = Math.round(v) + "ms";
    svg.appendChild(label);
  }

  // X axis time ticks
  const tickCount = Math.min(6, Math.max(2, Math.floor(innerWidth / 120)));
  for (let i = 0; i <= tickCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / tickCount;
    const x = xAt(t);
    const label = svgEl("text", {
      class: "axis-label",
      x,
      y: margin.top + innerHeight + 22,
      "text-anchor": "middle"
    });
    label.textContent = fmtTimeForWindow(new Date(t), state.window);
    svg.appendChild(label);
  }

  // Build area paths (download, upload) â€” filled under curve.
  const dlPoints = results.map(r => ({ x: xAt(r.t), y: ySpeedAt(r.dl) }));
  const ulPoints = results.map(r => ({ x: xAt(r.t), y: ySpeedAt(r.ul) }));
  const latPoints = results.map(r => ({ x: xAt(r.t), y: yLatAt(r.lat) }));

  const baseY = margin.top + innerHeight;
  if (dlPoints.length >= 2) {
    const area = smoothPath(dlPoints) +
      " L" + dlPoints[dlPoints.length - 1].x + "," + baseY +
      " L" + dlPoints[0].x + "," + baseY + " Z";
    svg.appendChild(svgEl("path", { d: area, fill: "url(#statsGradDl)" }));
  }
  if (ulPoints.length >= 2) {
    const area = smoothPath(ulPoints) +
      " L" + ulPoints[ulPoints.length - 1].x + "," + baseY +
      " L" + ulPoints[0].x + "," + baseY + " Z";
    svg.appendChild(svgEl("path", { d: area, fill: "url(#statsGradUl)" }));
  }

  // Stroke paths
  svg.appendChild(svgEl("path", {
    class: "series-line",
    d: smoothPath(dlPoints),
    stroke: "url(#statsStrokeDl)"
  }));
  svg.appendChild(svgEl("path", {
    class: "series-line",
    d: smoothPath(ulPoints),
    stroke: "url(#statsStrokeUl)"
  }));
  svg.appendChild(svgEl("path", {
    class: "series-line",
    d: smoothPath(latPoints),
    stroke: "url(#statsStrokeLat)",
    "stroke-dasharray": "5 4",
    "stroke-width": "2"
  }));

  // Points
  const pointGroup = svgEl("g", { class: "series-points" });
  results.forEach((r, i) => {
    pointGroup.appendChild(svgEl("circle", {
      class: "series-point",
      cx: dlPoints[i].x,
      cy: dlPoints[i].y,
      r: 3.5,
      fill: "#f59e0b",
      stroke: "#fff",
      "stroke-width": "1.5"
    }));
    pointGroup.appendChild(svgEl("circle", {
      class: "series-point",
      cx: ulPoints[i].x,
      cy: ulPoints[i].y,
      r: 3.5,
      fill: "#14b8a6",
      stroke: "#fff",
      "stroke-width": "1.5"
    }));
    pointGroup.appendChild(svgEl("circle", {
      class: "series-point",
      cx: latPoints[i].x,
      cy: latPoints[i].y,
      r: 2.5,
      fill: "#8b5cf6",
      stroke: "#fff",
      "stroke-width": "1",
      opacity: "0.75"
    }));
  });
  svg.appendChild(pointGroup);

  // Hover group (rendered last so it's on top)
  const hoverLine = svgEl("line", {
    class: "hover-guide",
    x1: 0, y1: margin.top,
    x2: 0, y2: margin.top + innerHeight,
    visibility: "hidden"
  });
  svg.appendChild(hoverLine);
  const hoverDot = svgEl("circle", {
    r: 6,
    fill: "#fff",
    stroke: "#dd6b20",
    "stroke-width": "2",
    visibility: "hidden"
  });
  svg.appendChild(hoverDot);

  // Transparent overlay for hover
  const overlay = svgEl("rect", {
    x: margin.left,
    y: margin.top,
    width: innerWidth,
    height: innerHeight,
    fill: "transparent",
    style: "cursor:crosshair"
  });
  svg.appendChild(overlay);

  chartGeometry = {
    svg,
    width, height, margin, innerWidth, innerHeight,
    xMin, xMax, xAt,
    results, dlPoints, ulPoints, latPoints,
    hoverLine, hoverDot
  };

  overlay.addEventListener("mousemove", onChartPointerMove);
  overlay.addEventListener("mouseleave", hideTooltip);
  overlay.addEventListener("touchstart", onChartTouch, { passive: true });
  overlay.addEventListener("touchmove", onChartTouch, { passive: true });
  overlay.addEventListener("touchend", hideTooltip);
}

let chartGeometry = null;

function pointerToIndex(clientX) {
  if (!chartGeometry) return -1;
  const { surface, width, results, xAt } = chartGeometry;
  const box = surface.getBoundingClientRect();
  const scaleX = width / box.width;
  const localX = (clientX - box.left) * scaleX;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < results.length; i++) {
    const d = Math.abs(xAt(results[i].t) - localX);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function showTooltipAtIndex(i) {
  if (!chartGeometry || i < 0 || i >= chartGeometry.results.length) return hideTooltip();
  const { results, dlPoints, hoverLine, hoverDot, surface, width, height, margin, innerHeight } = chartGeometry;
  const r = results[i];
  const point = dlPoints[i];
  hoverLine.hidden = false;
  hoverLine.style.left = point.x + "px";
  hoverLine.style.top = margin.top + "px";
  hoverLine.style.height = innerHeight + "px";
  hoverDot.hidden = false;
  hoverDot.style.left = point.x + "px";
  hoverDot.style.top = point.y + "px";

  const date = new Date(r.t);
  const sourceLabel = r.source === "lan" ? "LAN" : "Internet";
  const runnerExtra = r.runner ? '<div class="t-sub">' + escapeHtml(r.runner) + '</div>' : "";
  const serverExtra = r.location ? '<div class="t-sub">' + escapeHtml(r.location) + '</div>' : "";
  els.tooltip.innerHTML =
    '<div class="t-time">' + escapeHtml(fmtTimeForWindow(date, state.window)) +
      ' Â· <span style="opacity:0.7">' + sourceLabel + '</span></div>' +
    runnerExtra +
    serverExtra +
    '<div class="t-row"><span class="k"><span class="dot" style="background:linear-gradient(135deg,#dd6b20,#f59e0b)"></span>Download</span><span class="v">' + fmtMbps(r.dl) + '</span></div>' +
    '<div class="t-row"><span class="k"><span class="dot" style="background:linear-gradient(135deg,#0f766e,#14b8a6)"></span>Upload</span><span class="v">' + fmtMbps(r.ul) + '</span></div>' +
    (r.lat ? '<div class="t-row"><span class="k"><span class="dot" style="background:linear-gradient(135deg,#8b5cf6,#6366f1)"></span>Latency</span><span class="v">' + fmtLatency(r.lat) + '</span></div>' : '');

  const surfaceBox = surface.getBoundingClientRect();
  const hostBox = els.chartHost.getBoundingClientRect();
  const px = surfaceBox.left - hostBox.left + (point.x / width) * surfaceBox.width;
  const py = surfaceBox.top - hostBox.top + (point.y / height) * surfaceBox.height;
  els.tooltip.style.left = px + "px";
  els.tooltip.style.top = py + "px";
  els.tooltip.classList.add("is-visible");
  els.tooltip.setAttribute("aria-hidden", "false");
}

function hideTooltip() {
  if (chartGeometry) {
    chartGeometry.hoverLine.hidden = true;
    chartGeometry.hoverDot.hidden = true;
  }
  els.tooltip.classList.remove("is-visible");
  els.tooltip.setAttribute("aria-hidden", "true");
}

function onChartPointerMove(ev) {
  const idx = pointerToIndex(ev.clientX);
  showTooltipAtIndex(idx);
}

function onChartTouch(ev) {
  const touch = ev.touches && ev.touches[0];
  if (!touch) return;
  const idx = pointerToIndex(touch.clientX);
  showTooltipAtIndex(idx);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- summary rendering -------------------------------------------------------

function renderSummary() {
  const results = state.history.results || [];
  const averages = state.history.averages;
  const latest = state.history.latest;

  if (latest) {
    els.currentDown.textContent = fmtMbps(latest.downloadMbps).replace(" Mbps", "");
    els.currentUp.textContent = fmtMbps(latest.uploadMbps).replace(" Mbps", "");
    const when = tsOf(latest);
    if (Number.isFinite(when)) {
      els.lastRun.textContent = "Last test " + fmtRelative(Date.now() - when) +
        (latest.latencyMs ? " Â· latency " + fmtLatency(latest.latencyMs) : "");
    }
  }

  const peakDl = results.reduce((m, r) => Math.max(m, Number(r.downloadMbps) || 0), 0);
  const peakUl = results.reduce((m, r) => Math.max(m, Number(r.uploadMbps) || 0), 0);
  const bestLat = results.reduce((m, r) => {
    const v = Number(r.latencyMs) || 0;
    return v > 0 ? Math.min(m, v) : m;
  }, Infinity);

  const fields = els.summary.querySelectorAll("[data-field]");
  fields.forEach(field => {
    const key = field.dataset.field;
    switch (key) {
      case "avgDownload":
        field.textContent = averages && averages.downloadMbps != null
          ? fmtMbps(averages.downloadMbps)
          : "â€”";
        break;
      case "avgUpload":
        field.textContent = averages && averages.uploadMbps != null
          ? fmtMbps(averages.uploadMbps)
          : "â€”";
        break;
      case "avgLatency":
        field.textContent = averages && averages.latencyMs != null
          ? fmtLatency(averages.latencyMs)
          : "â€”";
        break;
      case "peakDownload":
        field.textContent = "Peak: " + (peakDl > 0 ? fmtMbps(peakDl) : "â€”");
        break;
      case "peakUpload":
        field.textContent = "Peak: " + (peakUl > 0 ? fmtMbps(peakUl) : "â€”");
        break;
      case "bestLatency":
        field.textContent = "Best: " + (Number.isFinite(bestLat) ? fmtLatency(bestLat) : "â€”");
        break;
    }
  });

  els.sampleCount.textContent = results.length + " sample" + (results.length === 1 ? "" : "s");

  // Failover notice piggybacks on the "last run" copy.
  if (state.failoverNotice && els.lastRun) {
    els.lastRun.textContent = state.failoverNotice;
  }
}

function render() {
  renderSummary();
  renderChart();
  renderTargetLabel();
  renderRunButtonState();
}

// --- wiring ------------------------------------------------------------------

function setupChips() {
  els.chips.forEach(chip => {
    chip.addEventListener("click", () => {
      const next = chip.dataset.window;
      if (next === state.window) return;
      state.window = next;
      els.chips.forEach(other => {
        const isActive = other.dataset.window === next;
        other.classList.toggle("is-active", isActive);
        other.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      if (els.customRange) {
        els.customRange.hidden = next !== "custom";
      }
      if (next === "custom") {
        seedCustomRangeInputs();
      } else {
        fetchHistory();
      }
    });
  });
}

function seedCustomRangeInputs() {
  // Default the custom range to "last 24 hours" the first time someone
  // opens it, so they don't land on empty inputs.
  const end = state.customTo || Date.now();
  const start = state.customFrom || (end - 24 * 3600_000);
  if (els.customFrom) els.customFrom.value = localISOInput(start);
  if (els.customTo) els.customTo.value = localISOInput(end);
}

function localISOInput(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function setupCustomRangeApply() {
  if (!els.customApply) return;
  els.customApply.addEventListener("click", () => {
    const from = els.customFrom.value ? new Date(els.customFrom.value).getTime() : null;
    const to = els.customTo.value ? new Date(els.customTo.value).getTime() : null;
    if (!from || !to || from >= to) {
      // Don't fetch with a nonsense range.
      return;
    }
    state.customFrom = from;
    state.customTo = to;
    state.window = "custom";
    els.chips.forEach(other => {
      const isActive = other.dataset.window === "custom";
      other.classList.toggle("is-active", isActive);
      other.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    fetchHistory();
  });
}

function setupTargetPicker() {
  if (!els.targetChips.length) return;
  // Seed active state from storage.
  els.targetChips.forEach(chip => {
    const isActive = chip.dataset.target === state.targetId;
    chip.classList.toggle("is-active", isActive);
    chip.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  els.targetChips.forEach(chip => {
    chip.addEventListener("click", async () => {
      const next = chip.dataset.target;
      if (!TARGETS[next] || next === state.targetId) return;
      state.targetId = next;
      saveTarget(next);
      els.targetChips.forEach(other => {
        const isActive = other.dataset.target === next;
        other.classList.toggle("is-active", isActive);
        other.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      state.targetMeta = null;
      renderTargetLabel();
      await fetchHistory();
    });
  });
}

function setupRunButton() {
  els.runBtn.addEventListener("click", () => {
    runSpeedTest({ manual: true });
  });
}

function setupPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (!document.hidden) fetchHistory();
  }, POLL_HISTORY_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fetchHistory();
  });
  window.addEventListener("resize", () => {
    if (state.history.results && state.history.results.length) renderChart();
  });
}

async function init() {
  setupChips();
  setupCustomRangeApply();
  setupTargetPicker();
  setupRunButton();
  setupPolling();
  // Start with correct active chips for the persisted target.
  renderTargetLabel();
  await fetchHistory();
}

init();

