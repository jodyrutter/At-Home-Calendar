import { randomBytes } from "node:crypto";

const OOKLA_SERVER_LIST_URL = "https://www.speedtest.net/api/js/servers?search=tampa";
const OOKLA_BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const OOKLA_CACHE_TTL_MS = 30 * 60_000;
const CLOUDFLARE_SPEEDTEST_ORIGIN = "https://speed.cloudflare.com";

const PROFILES = {
  background: {
    latencyPings: 3,
    pingBytes: 64 * 1024,
    downloadChunkBytes: 8 * 1024 * 1024,
    downloadMaxBytes: 24 * 1024 * 1024,
    downloadMinDurationMs: 2500,
    uploadBytes: 2 * 1024 * 1024
  },
  manual: {
    latencyPings: 5,
    pingBytes: 64 * 1024,
    downloadChunkBytes: 25 * 1024 * 1024,
    downloadMaxBytes: 100 * 1024 * 1024,
    downloadMinDurationMs: 5500,
    uploadBytes: 5 * 1024 * 1024
  },
  hourly: {
    latencyPings: 5,
    pingBytes: 64 * 1024,
    downloadChunkBytes: 16 * 1024 * 1024,
    downloadMaxBytes: 64 * 1024 * 1024,
    downloadMinDurationMs: 4500,
    uploadBytes: 5 * 1024 * 1024
  }
};

let ooklaCache = {
  server: null,
  fetchedAt: 0,
  lastError: null
};

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nowMs() {
  return Date.now();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeOoklaServer(entry) {
  if (!entry || typeof entry !== "object") return null;
  const url = trimmed(entry.url);
  const host = trimmed(entry.host);
  if (!url && !host) return null;
  return {
    id: trimmed(entry.id),
    sponsor: trimmed(entry.sponsor),
    name: trimmed(entry.name),
    country: trimmed(entry.country),
    host,
    url,
    lat: trimmed(entry.lat),
    lon: trimmed(entry.lon),
    distance: Number(entry.distance) || null
  };
}

function ooklaServerBase(server) {
  const raw = trimmed(server?.url) || trimmed(server?.host);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    try {
      return new URL("https://" + raw.replace(/^\/+/, "")).origin;
    } catch {
      return null;
    }
  }
}

async function discoverOoklaTampaServer() {
  const age = nowMs() - ooklaCache.fetchedAt;
  if (ooklaCache.server && age < OOKLA_CACHE_TTL_MS) {
    return ooklaCache.server;
  }

  try {
    const res = await fetchWithTimeout(OOKLA_SERVER_LIST_URL, {
      headers: {
        "User-Agent": OOKLA_BROWSER_UA,
        Accept: "application/json"
      },
      cache: "no-store"
    }, 8000);
    if (!res.ok) throw new Error("Ookla API " + res.status);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) {
      throw new Error("No Tampa servers returned");
    }
    const servers = list.map(sanitizeOoklaServer).filter(Boolean);
    const spectrum =
      servers.find((entry) => /spectrum|charter/i.test(entry.sponsor || "") && /tampa/i.test(entry.name || "")) ||
      servers.find((entry) => /tampa/i.test(entry.name || ""));
    if (!spectrum) {
      throw new Error("No Tampa speedtest server matched");
    }
    ooklaCache = {
      server: spectrum,
      fetchedAt: nowMs(),
      lastError: null
    };
    return spectrum;
  } catch (err) {
    ooklaCache = {
      server: ooklaCache.server,
      fetchedAt: nowMs(),
      lastError: String(err?.message || err)
    };
    if (ooklaCache.server) {
      return ooklaCache.server;
    }
    throw err;
  }
}

function normalizeProfile(profile) {
  if (!profile) return { ...PROFILES.manual };
  if (typeof profile === "string" && PROFILES[profile]) {
    return { ...PROFILES[profile] };
  }
  return {
    ...PROFILES.manual,
    ...(profile || {})
  };
}

async function drainResponseBody(response, onChunk) {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (onChunk) onChunk(buffer.byteLength);
    return buffer.byteLength;
  }

  const reader = response.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (onChunk) onChunk(value.byteLength);
  }
  return total;
}

async function measureLatency(target, profile) {
  const samples = [];
  for (let index = 0; index < profile.latencyPings; index += 1) {
    const started = performance.now();
    try {
      const res = await fetchWithTimeout(target.downloadUrl(profile.pingBytes), {
        headers: target.headers,
        cache: "no-store"
      }, 4000);
      if (!res.ok) continue;
      await drainResponseBody(res);
      samples.push(performance.now() - started);
    } catch {
      // Skip failed pings.
    }
  }

  if (!samples.length) return null;
  samples.sort((left, right) => left - right);
  const trimmedSamples = samples.length > 2 ? samples.slice(0, -1) : samples;
  const avg = trimmedSamples.reduce((sum, value) => sum + value, 0) / trimmedSamples.length;
  return {
    avg,
    best: samples[0]
  };
}

async function measureDownload(target, profile) {
  let totalBytes = 0;
  const started = performance.now();
  while (true) {
    const res = await fetchWithTimeout(target.downloadUrl(profile.downloadChunkBytes), {
      headers: target.headers,
      cache: "no-store"
    }, 30_000);
    if (!res.ok) throw new Error("download " + res.status);
    totalBytes += await drainResponseBody(res);
    const elapsedMs = performance.now() - started;
    if (totalBytes >= profile.downloadMaxBytes) break;
    if (elapsedMs >= profile.downloadMinDurationMs && totalBytes > 0) break;
  }

  const elapsedSeconds = Math.max((performance.now() - started) / 1000, 0.001);
  return {
    bytes: totalBytes,
    seconds: elapsedSeconds,
    mbps: (totalBytes * 8) / 1_000_000 / elapsedSeconds
  };
}

async function measureUpload(target, profile) {
  const payload = randomBytes(profile.uploadBytes);
  const started = performance.now();
  const res = await fetchWithTimeout(target.uploadUrl, {
    method: "POST",
    headers: {
      ...target.headers,
      "Content-Type": "application/octet-stream"
    },
    body: payload
  }, 70_000);
  const responseText = await res.text();
  if (!res.ok) {
    throw new Error("upload " + res.status + (responseText ? " — " + responseText.slice(0, 160) : ""));
  }
  const elapsedSeconds = Math.max((performance.now() - started) / 1000, 0.001);
  return {
    bytes: payload.byteLength,
    seconds: elapsedSeconds,
    mbps: (payload.byteLength * 8) / 1_000_000 / elapsedSeconds
  };
}

function buildOoklaTarget(server) {
  const base = ooklaServerBase(server);
  if (!base) throw new Error("bad Ookla server URL");
  const downloadCandidates = [
    (bytes) => base + "/download?nocache=" + Math.random() + "&size=" + bytes,
    () => base + "/speedtest/random4000x4000.jpg?x=" + Math.random()
  ];
  return {
    id: "internet",
    provider: server?.sponsor ? server.sponsor + " · Tampa (Ookla)" : "Spectrum · Tampa (Ookla)",
    serverLocation: [server?.sponsor, server?.name || "Tampa, FL"].filter(Boolean).join(" · "),
    headers: {
      "User-Agent": OOKLA_BROWSER_UA,
      Accept: "*/*"
    },
    downloadUrl(bytes) {
      return downloadCandidates[0](bytes);
    },
    legacyDownloadUrl() {
      return downloadCandidates[1]();
    },
    uploadUrl: base + "/upload?nocache=" + Math.random()
  };
}

function buildCloudflareTarget(meta = null) {
  return {
    id: "internetCloudflare",
    provider: "Cloudflare speed test",
    serverLocation: meta && meta.colo
      ? [meta.city, meta.country].filter(Boolean).join(", ") + " (" + meta.colo + ")"
      : "Cloudflare",
    headers: {},
    downloadUrl(bytes) {
      return CLOUDFLARE_SPEEDTEST_ORIGIN + "/__down?bytes=" + bytes + "&r=" + Math.random();
    },
    uploadUrl: CLOUDFLARE_SPEEDTEST_ORIGIN + "/__up"
  };
}

async function fetchCloudflareMeta() {
  try {
    const res = await fetchWithTimeout(CLOUDFLARE_SPEEDTEST_ORIGIN + "/meta", {
      cache: "no-store"
    }, 6000);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function runOoklaTarget(profile) {
  const server = await discoverOoklaTampaServer();
  const target = buildOoklaTarget(server);

  let latency = await measureLatency(target, profile);
  let download;
  try {
    download = await measureDownload(target, profile);
  } catch (err) {
    const legacyTarget = {
      ...target,
      downloadUrl() {
        return target.legacyDownloadUrl();
      }
    };
    latency = latency || await measureLatency(legacyTarget, profile);
    download = await measureDownload(legacyTarget, {
      ...profile,
      downloadChunkBytes: profile.downloadMaxBytes,
      downloadMaxBytes: profile.downloadMaxBytes
    });
  }

  const upload = await measureUpload(target, profile);
  return {
    source: "internet",
    target: target.provider,
    serverLocation: target.serverLocation,
    latencyMs: latency ? latency.avg : 0,
    downloadMbps: download.mbps,
    uploadMbps: upload.mbps,
    providerId: target.id
  };
}

async function runCloudflareTarget(profile) {
  const meta = await fetchCloudflareMeta();
  const target = buildCloudflareTarget(meta);
  const latency = await measureLatency(target, profile);
  const download = await measureDownload(target, profile);
  const upload = await measureUpload(target, profile);
  return {
    source: "internet",
    target: target.provider,
    serverLocation: target.serverLocation,
    latencyMs: latency ? latency.avg : 0,
    downloadMbps: download.mbps,
    uploadMbps: upload.mbps,
    providerId: target.id
  };
}

export async function runInternetSpeedTest(options = {}) {
  const profile = normalizeProfile(options.profile || "manual");
  const errors = [];

  try {
    return await runOoklaTarget(profile);
  } catch (err) {
    errors.push("ookla: " + String(err?.message || err));
  }

  try {
    return await runCloudflareTarget(profile);
  } catch (err) {
    errors.push("cloudflare: " + String(err?.message || err));
  }

  throw new Error(errors.join(" | ") || "internet speed test failed");
}

export function listSpeedtestProfiles() {
  return Object.keys(PROFILES);
}
