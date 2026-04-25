const ROUTES = {
  pi: {
    label: "Raspberry Pi",
    baseUrl: String(import.meta.env.VITE_HEARTHBOARD_PI_URL || "https://192.168.1.220:42069").trim(),
    kind: "local"
  },
  backup: {
    label: "Windows backup",
    baseUrl: String(import.meta.env.VITE_HEARTHBOARD_WINDOWS_BACKUP_URL || "https://192.168.1.118:42069").trim(),
    kind: "local"
  },
  remote: {
    label: "DuckDNS",
    baseUrl: String(import.meta.env.VITE_HEARTHBOARD_REMOTE_URL || "https://jodyrutter-sh.duckdns.org").trim(),
    kind: "remote"
  }
};

const searchParams = new URLSearchParams(window.location.search);
const preferredRouteId = searchParams.get("preferredRoute") === "remote" ? "remote" : "pi";

const elements = {
  retry: document.querySelector("#retry-connection"),
  openPreferred: document.querySelector("#open-preferred"),
  openPi: document.querySelector("#open-pi"),
  openBackup: document.querySelector("#open-backup"),
  openRemote: document.querySelector("#open-remote"),
  openPreferredLabel: document.querySelector("#open-preferred-label"),
  connectionPill: document.querySelector("#connection-pill"),
  connectionTitle: document.querySelector("#connection-title"),
  connectionDescription: document.querySelector("#connection-description"),
  connectionRoute: document.querySelector("#connection-route"),
  notificationStatus: document.querySelector("#notification-status")
};

const state = {
  probeToken: 0,
  opening: false
};

function mobileUrl(baseUrl) {
  const url = new URL("/", baseUrl);
  url.searchParams.set("mobileApp", "1");
  return url.toString();
}

function openRoute(routeId) {
  if (state.opening) {
    return;
  }

  const route = ROUTES[routeId];
  if (!route) {
    return;
  }

  state.opening = true;
  window.location.assign(mobileUrl(route.baseUrl));
}

function describePreferredRoute(routeId) {
  const route = ROUTES[routeId];
  const isRemote = route?.kind === "remote";
  elements.connectionTitle.textContent = isRemote ? "Ready to open DuckDNS" : `Ready to open ${route.label}`;
  elements.connectionDescription.textContent = isRemote
    ? "Android detected a non-local connection. Tap the main button to open your public DuckDNS board."
    : "Android detected a local-style connection. Tap the main button to open the best local Hearthboard route.";
  elements.connectionRoute.textContent = route.label;
  elements.notificationStatus.textContent = "Runs after sign in";
  elements.openPreferredLabel.textContent = isRemote ? "Open DuckDNS route" : `Open ${route.label}`;
}

function setStatus({ pillClass, pillText, title, description, routeLabel, notificationLabel }) {
  elements.connectionPill.className = `connection-pill ${pillClass}`;
  elements.connectionPill.textContent = pillText;
  elements.connectionTitle.textContent = title;
  elements.connectionDescription.textContent = description;
  elements.connectionRoute.textContent = routeLabel;
  elements.notificationStatus.textContent = notificationLabel;
}

function describeProbeError(error) {
  if (!error) {
    return "The route did not answer.";
  }

  const message = String(error.message || error);
  if (message.includes("ERR_CONNECTION_REFUSED")) {
    return "The route refused the connection.";
  }

  if (message.includes("timed out")) {
    return "The route timed out before responding.";
  }

  if (message.includes("Unable to resolve host")) {
    return "Android could not resolve the route hostname.";
  }

  return message;
}

async function probeRoute(routeId) {
  const route = ROUTES[routeId];
  if (!route) {
    return { ok: false, error: "Unknown route." };
  }

  const healthUrl = new URL("/api/health", route.baseUrl).toString();
  const startedAt = performance.now();
  const nativeHttp = window.Capacitor?.Plugins?.CapacitorHttp;

  try {
    if (nativeHttp?.request) {
      const response = await nativeHttp.request({
        url: healthUrl,
        method: "GET",
        connectTimeout: 5000,
        readTimeout: 5000,
        headers: {
          "X-Hearthboard-Mobile-App": "1"
        }
      });

      const status = Number(response?.status ?? 0);
      if (status >= 200 && status < 300) {
        return { ok: true, ms: Math.round(performance.now() - startedAt), status };
      }

      return { ok: false, error: `HTTP ${status || "unknown"}` };
    }

    const response = await fetch(healthUrl, {
      method: "GET",
      cache: "no-store",
      headers: {
        "X-Hearthboard-Mobile-App": "1"
      }
    });

    if (response.ok) {
      return { ok: true, ms: Math.round(performance.now() - startedAt), status: response.status };
    }

    return { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: describeProbeError(error) };
  }
}

function preferredOrder() {
  return preferredRouteId === "remote"
    ? ["remote", "pi", "backup"]
    : ["pi", "backup", "remote"];
}

async function runRouteSelection() {
  const probeToken = state.probeToken + 1;
  state.probeToken = probeToken;
  state.opening = false;

  const failures = [];
  for (const routeId of preferredOrder()) {
    const route = ROUTES[routeId];
    setStatus({
      pillClass: "waiting",
      pillText: "Checking",
      title: `Checking ${route.label}`,
      description: `Testing whether the ${route.label} route is reachable from this app before opening Hearthboard.`,
      routeLabel: route.label,
      notificationLabel: "Testing"
    });

    const result = await probeRoute(routeId);
    if (state.probeToken !== probeToken) {
      return;
    }

    if (result.ok) {
      setStatus({
        pillClass: routeId,
        pillText: "Ready",
        title: `Opening ${route.label}`,
        description: `${route.label} responded in about ${result.ms} ms. Opening Hearthboard in the app now.`,
        routeLabel: route.label,
        notificationLabel: "Ready"
      });
      window.setTimeout(() => {
        if (state.probeToken === probeToken) {
          openRoute(routeId);
        }
      }, 250);
      return;
    }

    failures.push(`${route.label}: ${result.error}`);
  }

  setStatus({
    pillClass: "error",
    pillText: "Offline",
    title: "Hearthboard is not reachable",
    description: `The app could not confirm either route. ${failures.join(" ")}`,
    routeLabel: "Unavailable",
    notificationLabel: "Offline"
  });
}

elements.retry.addEventListener("click", () => {
  runRouteSelection();
});
elements.openPreferred.addEventListener("click", () => openRoute(preferredRouteId));
elements.openPi.addEventListener("click", () => openRoute("pi"));
elements.openBackup.addEventListener("click", () => openRoute("backup"));
elements.openRemote.addEventListener("click", () => openRoute("remote"));

describePreferredRoute(preferredRouteId);
runRouteSelection();
