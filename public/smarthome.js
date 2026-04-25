// Smart Home Control Panel
// Talks to /api/smarthome/devices (poll) and /api/smarthome/command (POST).
// Fixture grouping: lights whose friendly_name ends with '#' are members of
// a fixture. The fixture display name is the base with trailing digits stripped.
// e.g.  "Bedroom 1#", "Bedroom 2#" → fixture "Bedroom" (3 bulbs → 1 card).

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3000;
const BRIGHTNESS_DEBOUNCE_MS = 80;

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  devices: [],        // raw device list from API
  connected: false,
  enabled: false,
  loading: true,
  error: null,
  // Track which sliders are being actively dragged to avoid clobbering them
  activeDrags: new Set()
};

// ── DOM refs ─────────────────────────────────────────────────────────────────

const elMain = document.getElementById("sh-main");
const elSkeleton = document.getElementById("sh-skeleton");
const elStats = document.getElementById("sh-stats");
const elGlobalActions = document.getElementById("sh-global-actions");
const elAllOff = document.getElementById("sh-all-off");
const elAllOn = document.getElementById("sh-all-on");
const elConnection = document.getElementById("sh-connection");
const elConnLabel = document.getElementById("sh-conn-label");

// ── API ───────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

async function sendCommand(targets, command) {
  return api("/api/smarthome/command", {
    method: "POST",
    body: JSON.stringify({ targets, command })
  });
}

// ── Device grouping ───────────────────────────────────────────────────────────

function groupDevices(devices) {
  const fixtureMap = new Map();
  const standalones = [];

  for (const device of devices) {
    if (device.fixtureId) {
      if (!fixtureMap.has(device.fixtureId)) {
        fixtureMap.set(device.fixtureId, {
          id: device.fixtureId,
          name: device.fixtureName,
          lights: []
        });
      }
      fixtureMap.get(device.fixtureId).lights.push(device);
    } else {
      standalones.push(device);
    }
  }

  return { fixtures: [...fixtureMap.values()], standalones };
}

// ── Computed helpers ──────────────────────────────────────────────────────────

function fixtureInfo(fixture) {
  const lights = fixture.lights;
  const onLights = lights.filter(l => l.state?.state === "ON");
  const avgBrightness = onLights.length > 0
    ? Math.round(
        onLights
          .filter(l => l.state?.brightness != null)
          .reduce((s, l, _, arr) => s + l.state.brightness / (arr.length || 1), 0)
      )
    : 0;

  return {
    isOn: onLights.length > 0,
    allOn: onLights.length === lights.length,
    onCount: onLights.length,
    totalCount: lights.length,
    brightness: avgBrightness,
    supportsBrightness: lights.some(l => l.features?.includes("brightness")),
    allNames: lights.map(l => l.friendlyName)
  };
}

function lightInfo(device) {
  return {
    isOn: device.state?.state === "ON",
    brightness: device.state?.brightness ?? 0,
    supportsBrightness: device.features?.includes("brightness")
  };
}

function brightnessPercent(raw) {
  return Math.round((Math.min(254, Math.max(0, raw)) / 254) * 100);
}

function brightnessLabel(raw, isOn) {
  if (!isOn) return "Off";
  return `${brightnessPercent(raw)}%`;
}

// ── Optimistic state update ───────────────────────────────────────────────────

function optimisticUpdate(targetNames, command) {
  for (const device of state.devices) {
    if (targetNames.includes(device.friendlyName)) {
      device.state = { ...(device.state || {}), ...command };
    }
  }
}

// ── Command helpers ───────────────────────────────────────────────────────────

async function doToggle(targets, currentlyOn) {
  const command = { state: currentlyOn ? "OFF" : "ON" };
  optimisticUpdate(targets, command);
  render();
  try {
    await sendCommand(targets, command);
  } catch (err) {
    console.warn("[smarthome] toggle failed:", err.message);
  }
}

async function doBrightness(targets, rawValue) {
  const command = { state: "ON", brightness: rawValue };
  optimisticUpdate(targets, command);
  // No full re-render — just update stats so UI stays snappy
  renderStats();
  try {
    await sendCommand(targets, command);
  } catch (err) {
    console.warn("[smarthome] brightness failed:", err.message);
  }
}

// ── Slider track fill ─────────────────────────────────────────────────────────

function setSliderFill(slider, rawValue, isOn) {
  const pct = isOn ? Math.round((rawValue / 254) * 100) : 0;
  slider.style.setProperty("--sh-fill", `${pct}%`);
}

// ── Render helpers ────────────────────────────────────────────────────────────

function buildTogglePill(isOn, onClickFn) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sh-toggle-pill";
  btn.setAttribute("data-on", String(isOn));
  btn.textContent = isOn ? "ON" : "OFF";
  btn.setAttribute("aria-pressed", String(isOn));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClickFn();
  });
  return btn;
}

function buildSlider(brightness, isOn, onInput, onSettle) {
  const wrapper = document.createElement("div");
  wrapper.className = "sh-controls";

  const dimIcon = document.createElement("span");
  dimIcon.className = "sh-dim-sun";
  dimIcon.setAttribute("aria-hidden", "true");
  dimIcon.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-10a1 1 0 0 1 1 1v1a1 1 0 0 1-2 0V6a1 1 0 0 1 1-1Zm0 14a1 1 0 0 1 1 1v1a1 1 0 0 1-2 0v-1a1 1 0 0 1 1-1Zm8-7a1 1 0 0 1-1 1h-1a1 1 0 0 1 0-2h1a1 1 0 0 1 1 1ZM5 12a1 1 0 0 1-1 1H3a1 1 0 0 1 0-2h1a1 1 0 0 1 1 1Zm11.36-4.95a1 1 0 0 1 0 1.41l-.7.7a1 1 0 0 1-1.42-1.41l.7-.7a1 1 0 0 1 1.42 0ZM8.05 16.95a1 1 0 0 1 0 1.41l-.7.7a1 1 0 0 1-1.42-1.41l.7-.7a1 1 0 0 1 1.42 0Zm8.9 1.41a1 1 0 0 1-1.41 0l-.7-.7a1 1 0 1 1 1.41-1.41l.7.7a1 1 0 0 1 0 1.41ZM7.05 8.76a1 1 0 0 1-1.41 0l-.7-.7a1 1 0 1 1 1.41-1.41l.7.7a1 1 0 0 1 0 1.41Z"/></svg>`;

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "sh-slider";
  slider.min = "0";
  slider.max = "254";
  slider.value = String(isOn ? brightness : 0);
  slider.disabled = !isOn;
  setSliderFill(slider, isOn ? brightness : 0, isOn);

  let debounceHandle = null;

  slider.addEventListener("pointerdown", () => state.activeDrags.add(slider));
  slider.addEventListener("pointerup", () => state.activeDrags.delete(slider));
  slider.addEventListener("blur", () => state.activeDrags.delete(slider));

  slider.addEventListener("input", () => {
    const raw = Number(slider.value);
    setSliderFill(slider, raw, true);
    onInput(raw);
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      onSettle(raw);
    }, BRIGHTNESS_DEBOUNCE_MS);
  });

  const pctLabel = document.createElement("span");
  pctLabel.className = "sh-pct-label";
  pctLabel.textContent = brightnessLabel(brightness, isOn);

  wrapper.append(dimIcon, slider, pctLabel);
  return { wrapper, slider, pctLabel };
}

// ── Render a standalone light card ────────────────────────────────────────────

function buildLightCard(device) {
  const info = lightInfo(device);

  const card = document.createElement("article");
  card.className = `sh-card card${info.isOn ? " is-on" : ""}`;
  card.dataset.deviceId = device.friendlyName;

  // Header
  const head = document.createElement("div");
  head.className = "sh-card-head";

  const icon = document.createElement("div");
  icon.className = "sh-card-icon";
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>`;

  const textBlock = document.createElement("div");
  textBlock.className = "sh-card-text";

  const nameEl = document.createElement("h2");
  nameEl.className = "sh-card-name";
  nameEl.textContent = device.friendlyName;

  const metaEl = document.createElement("p");
  metaEl.className = "sh-card-meta";
  metaEl.textContent = device.model || "Zigbee light";

  textBlock.append(nameEl, metaEl);

  const togglePill = buildTogglePill(info.isOn, () => {
    doToggle([device.friendlyName], info.isOn);
  });

  head.append(icon, textBlock, togglePill);
  card.append(head);

  // Brightness
  if (info.supportsBrightness) {
    const { wrapper, pctLabel } = buildSlider(
      info.brightness,
      info.isOn,
      (raw) => {
        pctLabel.textContent = `${brightnessPercent(raw)}%`;
      },
      (raw) => {
        doBrightness([device.friendlyName], raw);
      }
    );
    card.append(wrapper);
  }

  return card;
}

// ── Render a fixture card (grouped lights) ────────────────────────────────────

function buildFixtureCard(fixture) {
  const info = fixtureInfo(fixture);

  const card = document.createElement("article");
  card.className = `sh-card card is-fixture${info.isOn ? " is-on" : ""}`;
  card.dataset.fixtureId = fixture.id;

  // Header
  const head = document.createElement("div");
  head.className = "sh-card-head";

  const icon = document.createElement("div");
  icon.className = "sh-card-icon";
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>`;

  const textBlock = document.createElement("div");
  textBlock.className = "sh-card-text";

  const nameEl = document.createElement("h2");
  nameEl.className = "sh-card-name";
  nameEl.textContent = fixture.name;

  const metaEl = document.createElement("p");
  metaEl.className = "sh-card-meta";
  metaEl.textContent = `${info.totalCount} bulb${info.totalCount !== 1 ? "s" : ""} · ${info.onCount > 0 ? `${info.onCount} on` : "All off"}`;

  textBlock.append(nameEl, metaEl);

  const togglePill = buildTogglePill(info.isOn, () => {
    doToggle(info.allNames, info.isOn);
  });

  head.append(icon, textBlock, togglePill);
  card.append(head);

  // Master brightness slider
  if (info.supportsBrightness) {
    const { wrapper, pctLabel } = buildSlider(
      info.brightness,
      info.isOn,
      (raw) => {
        pctLabel.textContent = `${brightnessPercent(raw)}%`;
      },
      (raw) => {
        // Dim all bulbs in the fixture together
        doBrightness(info.allNames, raw);
      }
    );
    card.append(wrapper);
  }

  // Sub-bulb expander
  const details = document.createElement("details");
  details.className = "sh-bulbs-section";

  const summary = document.createElement("summary");
  summary.className = "sh-bulbs-toggle";
  summary.textContent = `${info.totalCount} individual bulb${info.totalCount !== 1 ? "s" : ""}`;
  details.append(summary);

  const bulbList = document.createElement("div");
  bulbList.className = "sh-bulb-list";

  for (const light of fixture.lights) {
    const li = lightInfo(light);
    const bulbRow = document.createElement("div");
    bulbRow.className = `sh-bulb${li.isOn ? " is-on" : ""}`;

    const bulbName = document.createElement("span");
    bulbName.className = "sh-bulb-name";
    // Show just the full name (the fixture part is already shown in the heading)
    bulbName.textContent = light.friendlyName;

    const bulbToggle = document.createElement("button");
    bulbToggle.type = "button";
    bulbToggle.className = "sh-bulb-toggle";
    bulbToggle.setAttribute("data-on", String(li.isOn));
    bulbToggle.setAttribute("aria-pressed", String(li.isOn));
    bulbToggle.textContent = li.isOn ? "ON" : "OFF";
    bulbToggle.addEventListener("click", () => {
      doToggle([light.friendlyName], li.isOn);
    });

    bulbRow.append(bulbName, bulbToggle);

    // Per-bulb brightness (compact)
    if (li.supportsBrightness) {
      const bulbPct = document.createElement("span");
      bulbPct.className = "sh-bulb-pct";
      bulbPct.textContent = li.isOn ? `${brightnessPercent(li.brightness)}%` : "";
      bulbRow.append(bulbPct);
    }

    bulbList.append(bulbRow);
  }

  details.append(bulbList);
  card.append(details);

  return card;
}

// ── Render stats strip ────────────────────────────────────────────────────────

function renderStats() {
  if (!elStats) return;
  const total = state.devices.length;
  const onCount = state.devices.filter(d => d.state?.state === "ON").length;

  elStats.innerHTML = "";

  if (!state.enabled) {
    const pill = document.createElement("span");
    pill.className = "sh-stat-pill";
    pill.textContent = "Smart home not configured";
    elStats.append(pill);
    return;
  }

  const countPill = document.createElement("span");
  countPill.className = `sh-stat-pill${onCount > 0 ? " is-on" : ""}`;
  countPill.textContent = total === 0
    ? "No lights found"
    : `${onCount} of ${total} light${total !== 1 ? "s" : ""} on`;

  elStats.append(countPill);

  if (!state.connected) {
    const errPill = document.createElement("span");
    errPill.className = "sh-stat-pill sh-stat-warn";
    errPill.textContent = "Broker disconnected";
    elStats.append(errPill);
  }
}

// ── Main render ───────────────────────────────────────────────────────────────

function render() {
  if (state.loading) return;

  // Hide skeleton
  if (elSkeleton) elSkeleton.hidden = true;

  renderStats();

  // Connection badge
  if (elConnection) {
    elConnection.hidden = !state.enabled;
    elConnection.classList.toggle("is-connected", state.connected);
    elConnection.classList.toggle("is-disconnected", !state.connected);
    if (elConnLabel) {
      elConnLabel.textContent = state.connected ? "Connected" : "Disconnected";
    }
  }

  // Global action buttons
  const hasLights = state.devices.length > 0;
  if (elGlobalActions) {
    elGlobalActions.hidden = !hasLights || !state.connected;
  }

  // Build light grid
  if (!elMain) return;

  const { fixtures, standalones } = groupDevices(state.devices);
  const allGrouped = [...fixtures, ...standalones];

  // Empty / unconfigured states
  if (!state.enabled) {
    elMain.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "sh-empty card";
    empty.innerHTML = `
      <div class="sh-empty-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>
      </div>
      <h2>Smart home not configured</h2>
      <p>Set <code>ZIGBEE_MQTT_URL</code> in your <code>.env</code> file to connect Hearthboard to your Zigbee2MQTT broker.</p>
      <p class="sh-empty-hint">Example: <code>ZIGBEE_MQTT_URL=mqtt://host.docker.internal:1883</code></p>
    `;
    elMain.append(empty);
    return;
  }

  if (state.enabled && !state.connected) {
    // Show last-known state (if any) even when broker is briefly disconnected
    if (allGrouped.length === 0) {
      elMain.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "sh-empty card";
      empty.innerHTML = `
        <div class="sh-empty-icon sh-empty-icon--warn">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z"/></svg>
        </div>
        <h2>Waiting for MQTT broker</h2>
        <p>Hearthboard is trying to connect to your Zigbee2MQTT broker. Make sure Zigbee2MQTT is running.</p>
      `;
      elMain.append(empty);
      return;
    }
  }

  if (allGrouped.length === 0) {
    elMain.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "sh-empty card";
    empty.innerHTML = `
      <div class="sh-empty-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>
      </div>
      <h2>No lights found yet</h2>
      <p>Connected to broker. Waiting for Zigbee2MQTT to report devices. If lights don&rsquo;t appear, check that they are paired in <a href="http://192.168.1.220:8099" target="_blank" rel="noopener">Zigbee2MQTT</a>.</p>
    `;
    elMain.append(empty);
    return;
  }

  // Build a stable grid — update existing cards in place to preserve slider
  // focus and open <details> states, rather than blowing away the entire DOM.
  const existingCards = new Map();
  for (const card of elMain.querySelectorAll("[data-fixture-id], [data-device-id]")) {
    const key = card.dataset.fixtureId || card.dataset.deviceId;
    if (key) existingCards.set(key, card);
  }

  // Build the full new card list
  const newCards = [];
  for (const fixture of fixtures) {
    newCards.push({ key: fixture.id, node: buildFixtureCard(fixture) });
  }
  for (const device of standalones) {
    newCards.push({ key: device.friendlyName, node: buildLightCard(device) });
  }

  // Replace content but preserve any <details> open state
  elMain.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "sh-grid";

  for (const { key, node } of newCards) {
    const prev = existingCards.get(key);
    if (prev) {
      // Preserve <details> open state across re-renders
      const prevDetails = prev.querySelector("details");
      const newDetails = node.querySelector("details");
      if (prevDetails && newDetails && prevDetails.open) {
        newDetails.open = true;
      }
      // Preserve active slider value if user is dragging
      const prevSlider = prev.querySelector(".sh-slider");
      const newSlider = node.querySelector(".sh-slider");
      if (prevSlider && newSlider && state.activeDrags.has(prevSlider)) {
        state.activeDrags.add(newSlider);
        state.activeDrags.delete(prevSlider);
        newSlider.value = prevSlider.value;
        setSliderFill(newSlider, Number(newSlider.value), true);
      }
    }
    grid.append(node);
  }

  elMain.append(grid);
}

// ── Global action wiring ──────────────────────────────────────────────────────

function allLightNames() {
  return state.devices.map(d => d.friendlyName);
}

if (elAllOff) {
  elAllOff.addEventListener("click", async () => {
    const names = allLightNames();
    if (names.length === 0) return;
    optimisticUpdate(names, { state: "OFF" });
    render();
    try { await sendCommand(names, { state: "OFF" }); }
    catch (err) { console.warn("[smarthome] all-off failed:", err.message); }
  });
}

if (elAllOn) {
  elAllOn.addEventListener("click", async () => {
    const names = allLightNames();
    if (names.length === 0) return;
    optimisticUpdate(names, { state: "ON" });
    render();
    try { await sendCommand(names, { state: "ON" }); }
    catch (err) { console.warn("[smarthome] all-on failed:", err.message); }
  });
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function loadDevices() {
  try {
    const data = await api("/api/smarthome/devices");
    state.devices = data.devices || [];
    state.connected = Boolean(data.connected);
    state.enabled = Boolean(data.enabled);
    state.loading = false;
    state.error = null;
    render();
  } catch (err) {
    state.loading = false;
    state.error = err.message;
    // Show error state only on the first load failure
    if (!elSkeleton?.hidden) {
      if (elSkeleton) elSkeleton.hidden = true;
      if (elMain) {
        elMain.innerHTML = "";
        const errDiv = document.createElement("div");
        errDiv.className = "sh-empty card";
        errDiv.innerHTML = `<h2>Could not load smart home</h2><p>${err.message}</p>`;
        elMain.append(errDiv);
      }
    }
  }
}

let pollHandle = null;

function startPolling() {
  loadDevices();
  if (!pollHandle) {
    pollHandle = setInterval(loadDevices, POLL_INTERVAL_MS);
  }
}

function stopPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    startPolling();
  }
});

startPolling();
