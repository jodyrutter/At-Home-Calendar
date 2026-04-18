const WEB_SEARCH_STORAGE_KEY = "hearthboard-assistant-use-web";

const state = {
  status: null,
  messages: [],
  busy: false,
  useWebSearch: localStorage.getItem(WEB_SEARCH_STORAGE_KEY) === "true"
};

const elements = {
  refreshButton: document.querySelector("#assistant-refresh"),
  clearButton: document.querySelector("#assistant-clear"),
  busy: document.querySelector("#assistant-busy"),
  chat: document.querySelector("#assistant-chat"),
  form: document.querySelector("#assistant-form"),
  prompt: document.querySelector("#assistant-prompt"),
  useWeb: document.querySelector("#assistant-use-web"),
  submit: document.querySelector("#assistant-submit"),
  status: document.querySelector("#assistant-status"),
  helpCard: document.querySelector("#assistant-help-card"),
  emptyStateTemplate: document.querySelector("#assistant-empty-state-template")
};

if (elements.useWeb) {
  elements.useWeb.checked = state.useWebSearch;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function statusLabel(status) {
  if (!status?.reachable) {
    return "Offline";
  }

  if (!status.ready) {
    return "Needs model";
  }

  return status.loaded ? "Awake" : "Sleeping";
}

function webSearchLabel(webSearch) {
  if (!webSearch?.enabled) {
    return "Unavailable";
  }

  return webSearch.provider === "brave" ? "Brave API" : "DuckDuckGo";
}

function renderStatus() {
  const status = state.status;
  const assistantName = status?.name || "Jody AI";
  if (!status) {
    if (elements.helpCard) {
      elements.helpCard.hidden = true;
    }
    elements.status.innerHTML = `
      <div class="assistant-status-shell">
        <span class="assistant-status-pill" data-state="waiting">Checking</span>
        <p class="muted">Looking for ${escapeHtml(assistantName)} on this PC.</p>
      </div>
    `;
    return;
  }

  if (elements.helpCard) {
    elements.helpCard.hidden = Boolean(status.ready);
  }

  const pillState = !status.reachable ? "offline" : status.ready && status.loaded ? "ready" : "waiting";
  const activeModel = status.activeModel || "Not installed yet";
  const loadedModel = status.loadedModel || "Sleeping";
  const webSearch = status.webSearch || { enabled: false, provider: "none", mode: "off" };
  const awakeKeepAlive = status.awakeKeepAlive || "5m";
  const detail = !status.reachable
    ? `${assistantName} is offline on this PC right now.`
    : !status.ready
      ? `${assistantName} can see the local runtime, but the recommended model is not installed yet.`
      : status.loaded
        ? `${assistantName} is awake right now and will automatically fall asleep after ${awakeKeepAlive} without a new question.`
        : `${assistantName} is installed and ready, but currently sleeping to stay light on GPU usage.`;

  const webSearchDetail = !webSearch.enabled
    ? "Web search is currently unavailable."
    : webSearch.provider === "brave"
      ? "Web search is using the Brave Search API with citations."
      : "Web search is using a best-effort DuckDuckGo fallback with citations.";

  const errorMarkup = status.error ? `<p class="form-error">${escapeHtml(status.error)}</p>` : "";
  const powerButtonLabel = status.loaded ? `Put ${assistantName} to sleep` : `Wake ${assistantName}`;
  const powerButtonAction = status.loaded ? "sleep" : "wake";
  const powerButtonDisabled = !status.reachable || !status.ready || state.busy ? "disabled" : "";

  elements.status.innerHTML = `
    <div class="assistant-status-shell">
      <span class="assistant-status-pill" data-state="${pillState}">${statusLabel(status)}</span>
      <p class="muted">${escapeHtml(detail)}</p>
      <div class="assistant-status-actions">
        <button class="button button-primary" type="button" data-power-action="${powerButtonAction}" ${powerButtonDisabled}>${escapeHtml(powerButtonLabel)}</button>
      </div>
      <div class="assistant-status-list">
        <div class="assistant-status-row">
          <span>Configured model</span>
          <strong>${escapeHtml(status.configuredModel || "hearthboard-assistant")}</strong>
        </div>
        <div class="assistant-status-row">
          <span>Selected model</span>
          <strong>${escapeHtml(activeModel)}</strong>
        </div>
        <div class="assistant-status-row">
          <span>Loaded now</span>
          <strong>${escapeHtml(loadedModel)}</strong>
        </div>
        <div class="assistant-status-row">
          <span>Fallback model</span>
          <strong>${escapeHtml(status.fallbackModel || "qwen2.5:7b")}</strong>
        </div>
        <div class="assistant-status-row">
          <span>Web search</span>
          <strong>${escapeHtml(webSearchLabel(webSearch))}</strong>
        </div>
        <div class="assistant-status-row">
          <span>Search mode</span>
          <strong>${escapeHtml(webSearch.mode || "off")}</strong>
        </div>
        <div class="assistant-status-row">
          <span>Sleep timer</span>
          <strong>${escapeHtml(String(awakeKeepAlive))}</strong>
        </div>
        <div class="assistant-status-row">
          <span>Known local models</span>
          <strong>${escapeHtml(String(status.availableModels?.length || 0))}</strong>
        </div>
      </div>
      <p class="muted">${escapeHtml(webSearchDetail)}</p>
      ${errorMarkup}
    </div>
  `;

  elements.status.querySelector("[data-power-action]")?.addEventListener("click", async () => {
    await togglePower(powerButtonAction);
  });
}

function renderSources(container, sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "assistant-message-sources";

  const title = document.createElement("div");
  title.className = "assistant-message-sources-title";
  title.textContent = "Sources";
  wrapper.append(title);

  sources.forEach((source, index) => {
    const item = document.createElement("div");
    item.className = "assistant-message-source";

    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = `${index + 1}. ${source.title || source.url}`;

    const snippet = document.createElement("span");
    snippet.textContent = source.snippet || source.url;

    item.append(link, snippet);
    wrapper.append(item);
  });

  container.append(wrapper);
}

function renderChat() {
  if (state.messages.length === 0) {
    const fragment = elements.emptyStateTemplate.content.cloneNode(true);
    elements.chat.replaceChildren(fragment);
    elements.chat.querySelectorAll("[data-suggestion]").forEach((button) => {
      button.addEventListener("click", () => {
        elements.prompt.value = button.dataset.suggestion || "";
        elements.prompt.focus();
      });
    });
    return;
  }

  elements.chat.innerHTML = "";
  state.messages.forEach((message) => {
    const article = document.createElement("article");
    article.className = "assistant-message";
    article.dataset.role = message.role;

    const header = document.createElement("div");
    header.className = "assistant-message-header";
    header.textContent = message.role === "user" ? "You" : "Jody AI";

    const body = document.createElement("div");
    body.className = "assistant-message-body";
    body.textContent = message.content;

    article.append(header, body);
    renderSources(article, message.sources);
    elements.chat.append(article);
  });

  elements.chat.scrollTop = elements.chat.scrollHeight;
}

function setBusy(nextBusy) {
  state.busy = nextBusy;
  elements.submit.disabled = nextBusy;
  elements.prompt.disabled = nextBusy;
  elements.refreshButton.disabled = nextBusy;
  elements.clearButton.disabled = nextBusy;
  if (elements.useWeb) {
    elements.useWeb.disabled = nextBusy;
  }
  elements.busy.hidden = !nextBusy;
}

async function loadStatus() {
  try {
    state.status = await api("/api/assistant/status");
  } catch (error) {
    state.status = {
      name: "Jody AI",
      reachable: false,
      ready: false,
      loaded: false,
      configuredModel: "hearthboard-assistant",
      fallbackModel: "qwen2.5:7b",
      keepAlive: "0",
      availableModels: [],
      webSearch: {
        enabled: false,
        provider: "none",
        mode: "off"
      },
      error: error.message
    };
  }

  renderStatus();
}

async function togglePower(action) {
  if (state.busy) {
    return;
  }

  setBusy(true);
  try {
    const payload = await api("/api/assistant/power", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ action })
    });

    state.status = payload.status;
  } catch (error) {
    if (!state.status) {
      state.status = {
        name: "Jody AI",
        reachable: false,
        ready: false,
        loaded: false,
        configuredModel: "hearthboard-assistant",
        fallbackModel: "qwen2.5:7b",
        keepAlive: "0",
        availableModels: [],
        webSearch: {
          enabled: false,
          provider: "none",
          mode: "off"
        }
      };
    }
    state.status.error = error.message;
  } finally {
    setBusy(false);
    renderStatus();
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const prompt = elements.prompt.value.trim();
  if (!prompt || state.busy) {
    return;
  }

  state.messages.push({ role: "user", content: prompt });
  renderChat();
  elements.prompt.value = "";
  setBusy(true);

  try {
    const payload = await api("/api/assistant/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: state.messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        useWeb: state.useWebSearch
      })
    });

    state.messages.push({
      role: payload.message?.role === "assistant" ? "assistant" : "assistant",
      content: payload.message?.content || "No response returned.",
      sources: payload.sources || []
    });

    await loadStatus();
  } catch (error) {
    state.messages.push({
      role: "assistant",
      content: `I could not answer that yet: ${error.message}`
    });
  } finally {
    setBusy(false);
    renderChat();
    elements.prompt.focus();
  }
}

function clearChat() {
  state.messages = [];
  renderChat();
  elements.prompt.focus();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => {
    if (!state.busy) {
      loadStatus();
    }
  });

  elements.clearButton.addEventListener("click", clearChat);
  elements.form.addEventListener("submit", handleSubmit);
  elements.prompt.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });

  elements.useWeb?.addEventListener("change", () => {
    state.useWebSearch = Boolean(elements.useWeb.checked);
    localStorage.setItem(WEB_SEARCH_STORAGE_KEY, String(state.useWebSearch));
  });
}

bindEvents();
renderStatus();
renderChat();
loadStatus();
