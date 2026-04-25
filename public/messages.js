// Hearthboard messages page.
//
// Renders a two-pane layout: thread list on the left, active conversation
// on the right. Supports the Household channel (always present) plus any
// 1:1 DMs the signed-in user has opened. Message bodies are stored
// encrypted server-side (messaging/crypto.js); this page sees them only
// decrypted, over an authenticated session cookie.
//
// Polling model: while the tab is visible, poll the active thread every
// 5s for new messages and the threads list every 15s for unread-count
// updates. Both polls skip when the tab is hidden.

const POLL_STREAM_MS = 5000;
const POLL_LIST_MS = 15000;

const elements = {
  threads: document.getElementById("messages-threads"),
  stream: document.getElementById("messages-stream"),
  composer: document.getElementById("messages-composer"),
  composerInput: document.getElementById("messages-composer-input"),
  composerError: document.getElementById("messages-composer-error"),
  sendButton: document.getElementById("messages-send-button"),
  paneKicker: document.getElementById("messages-pane-kicker"),
  paneTitle: document.getElementById("messages-pane-title"),
  paneMeta: document.getElementById("messages-pane-meta"),
  heading: document.getElementById("messages-heading"),
  subtitle: document.getElementById("messages-subtitle"),
  newDmButton: document.getElementById("new-dm-button"),
  newDmDialog: document.getElementById("new-dm-dialog"),
  newDmContacts: document.getElementById("new-dm-contacts"),
  newDmError: document.getElementById("new-dm-error")
};

const state = {
  me: null,
  conversations: [],
  activeConversationId: null,
  messagesByConversation: new Map(), // id -> {messages, fetchedAt}
  pollStreamHandle: 0,
  pollListHandle: 0
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function api(path, init = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
    body: init.body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload;
}

function fmtRelativeTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  const d = new Date(then);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtDayStamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function renderThreads() {
  const root = elements.threads;
  if (!root) return;
  root.innerHTML = "";
  if (!state.conversations.length) {
    root.innerHTML = '<p class="muted">No conversations yet.</p>';
    return;
  }
  for (const convo of state.conversations) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "thread-item";
    if (convo.id === state.activeConversationId) {
      item.classList.add("is-active");
    }
    if (convo.unreadCount > 0) {
      item.classList.add("has-unread");
    }
    item.dataset.conversationId = convo.id;

    const title = document.createElement("span");
    title.className = "thread-item-title";
    title.textContent = convo.type === "household" ? "Household" : convo.title || "Direct message";

    const kicker = document.createElement("span");
    kicker.className = "thread-item-kicker";
    kicker.textContent = convo.type === "household" ? "Everyone" : "DM";

    const preview = document.createElement("span");
    preview.className = "thread-item-preview";
    if (convo.lastMessage) {
      const who = convo.lastMessage.senderId === state.me?.id ? "You" : convo.lastMessage.senderName;
      preview.textContent = `${who}: ${convo.lastMessage.preview || ""}`;
    } else {
      preview.textContent = "No messages yet";
    }

    const when = document.createElement("span");
    when.className = "thread-item-when";
    when.textContent = fmtRelativeTime(convo.lastMessage?.createdAt || convo.lastMessageAt);

    item.append(kicker, title, preview, when);
    if (convo.unreadCount > 0) {
      const dot = document.createElement("span");
      dot.className = "thread-item-unread";
      dot.textContent = convo.unreadCount > 99 ? "99+" : String(convo.unreadCount);
      item.append(dot);
    }

    item.addEventListener("click", () => {
      setActiveConversation(convo.id).catch((err) => {
        console.error("Could not open thread", err);
      });
    });

    root.append(item);
  }
}

function renderActiveThread() {
  const convo = state.conversations.find((c) => c.id === state.activeConversationId);
  if (!convo) {
    elements.paneKicker.textContent = "";
    elements.paneTitle.textContent = "Select a conversation";
    elements.paneMeta.textContent = "";
    elements.composer.hidden = true;
    elements.stream.innerHTML = '<div class="empty-state"><p>Pick a thread on the left.</p></div>';
    return;
  }
  elements.paneKicker.textContent = convo.type === "household" ? "Household channel" : "Direct message";
  elements.paneTitle.textContent = convo.type === "household" ? "Household" : convo.title;
  if (convo.type === "dm") {
    const other = convo.members.find((m) => m.id !== state.me?.id);
    elements.paneMeta.textContent = other ? `with ${other.name}` : "";
  } else {
    elements.paneMeta.textContent = "Everyone in the household";
  }

  const bundle = state.messagesByConversation.get(convo.id);
  const messages = bundle?.messages || [];
  renderStream(messages);
  elements.composer.hidden = false;
}

function renderStream(messages) {
  const root = elements.stream;
  if (!root) return;

  if (!messages.length) {
    root.innerHTML = '<div class="empty-state"><p>No messages yet. Say hi.</p></div>';
    return;
  }

  const frag = document.createDocumentFragment();
  let lastDay = "";

  for (const message of messages) {
    const dayKey = new Date(message.createdAt).toDateString();
    if (dayKey !== lastDay) {
      const sep = document.createElement("div");
      sep.className = "messages-day-sep";
      sep.textContent = fmtDayStamp(message.createdAt);
      frag.append(sep);
      lastDay = dayKey;
    }

    const isMine = message.author?.id === state.me?.id;
    const wrap = document.createElement("article");
    wrap.className = "message-row";
    if (isMine) wrap.classList.add("is-mine");
    wrap.dataset.messageId = message.id;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    const header = document.createElement("div");
    header.className = "message-bubble-header";

    const who = document.createElement("span");
    who.className = "message-bubble-author";
    who.textContent = isMine ? "You" : (message.author?.name || "Someone");
    const ts = document.createElement("span");
    ts.className = "message-bubble-time";
    ts.textContent = fmtTime(message.createdAt);
    header.append(who, ts);

    const body = document.createElement("div");
    body.className = "message-bubble-body";
    // Render plain text safely but preserve line breaks.
    const safeHtml = escapeHtml(message.body).replace(/\n/g, "<br />");
    body.innerHTML = safeHtml;

    bubble.append(header, body);

    if (isMine) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "message-bubble-delete";
      deleteBtn.title = "Delete message";
      deleteBtn.setAttribute("aria-label", "Delete message");
      deleteBtn.textContent = "×";
      deleteBtn.addEventListener("click", () => {
        deleteMessage(message.id).catch((err) => showComposerError(err.message));
      });
      bubble.append(deleteBtn);
    }

    wrap.append(bubble);
    frag.append(wrap);
  }

  root.innerHTML = "";
  root.append(frag);
  requestAnimationFrame(() => {
    root.scrollTop = root.scrollHeight;
  });
}

function showComposerError(msg) {
  if (!elements.composerError) return;
  elements.composerError.textContent = msg || "";
  elements.composerError.hidden = !msg;
}

async function loadConversations() {
  const payload = await api("/api/messages/conversations");
  state.conversations = Array.isArray(payload.conversations) ? payload.conversations : [];

  // If the active thread is gone (e.g. deleted), pick the first.
  if (
    state.activeConversationId &&
    !state.conversations.find((c) => c.id === state.activeConversationId)
  ) {
    state.activeConversationId = null;
  }
  if (!state.activeConversationId && state.conversations.length) {
    // Prefer the household channel on first visit.
    const household = state.conversations.find((c) => c.type === "household");
    state.activeConversationId = household ? household.id : state.conversations[0].id;
  }

  // Update heading counts.
  const unread = state.conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  elements.heading.textContent = unread > 0 ? `${unread} unread` : "All caught up";
  elements.subtitle.textContent =
    state.conversations.length === 1
      ? "Just the household channel right now."
      : `${state.conversations.length} threads`;

  renderThreads();
  // Don't clobber stream mid-scroll; renderActiveThread re-reads cache.
  renderActiveThread();
}

async function loadActiveMessages() {
  const id = state.activeConversationId;
  if (!id) return;
  const payload = await api(`/api/messages/conversations/${encodeURIComponent(id)}/messages`);
  state.messagesByConversation.set(id, {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    fetchedAt: Date.now()
  });
  renderActiveThread();
  // Mark as read now that we've displayed it.
  markReadIfActive(id).catch(() => {});
}

async function markReadIfActive(conversationId) {
  if (!conversationId) return;
  await api(`/api/messages/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: "POST"
  });
  // Refresh unread badge in the nav.
  window.dispatchEvent(new CustomEvent("hearthboard:nav-refresh"));
  // Refresh thread list so the sidebar unread dot disappears.
  await loadConversations();
}

async function setActiveConversation(id) {
  if (state.activeConversationId === id) return;
  state.activeConversationId = id;
  renderThreads();
  renderActiveThread();
  await loadActiveMessages();
}

async function sendMessage(event) {
  event?.preventDefault();
  showComposerError("");
  const body = elements.composerInput.value.trim();
  if (!body) return;
  if (!state.activeConversationId) return;

  elements.sendButton.disabled = true;
  try {
    const payload = await api(
      `/api/messages/conversations/${encodeURIComponent(state.activeConversationId)}/messages`,
      { method: "POST", body: JSON.stringify({ body }) }
    );

    // Append locally for instant feedback.
    const bundle = state.messagesByConversation.get(state.activeConversationId) || { messages: [] };
    bundle.messages = [...bundle.messages, payload.message];
    bundle.fetchedAt = Date.now();
    state.messagesByConversation.set(state.activeConversationId, bundle);
    elements.composerInput.value = "";
    renderActiveThread();
    // Refresh the thread list so lastMessage preview + order update.
    loadConversations().catch(() => {});
  } catch (err) {
    showComposerError(err.message || "Could not send that message.");
  } finally {
    elements.sendButton.disabled = false;
  }
}

async function deleteMessage(messageId) {
  await api(`/api/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
  const id = state.activeConversationId;
  if (!id) return;
  const bundle = state.messagesByConversation.get(id);
  if (bundle) {
    bundle.messages = bundle.messages.filter((m) => m.id !== messageId);
    state.messagesByConversation.set(id, bundle);
  }
  renderActiveThread();
  loadConversations().catch(() => {});
}

// --- New-DM dialog --------------------------------------------------------

async function openNewDmDialog() {
  elements.newDmError.hidden = true;
  elements.newDmError.textContent = "";
  elements.newDmContacts.innerHTML = '<p class="muted">Loading contacts...</p>';
  elements.newDmDialog.showModal?.();
  try {
    const payload = await api("/api/messages/contacts");
    const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
    if (!contacts.length) {
      elements.newDmContacts.innerHTML =
        '<p class="muted">No other household members to message yet.</p>';
      return;
    }
    elements.newDmContacts.innerHTML = "";
    for (const contact of contacts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "new-dm-contact";
      button.innerHTML =
        `<span class="new-dm-contact-name">${escapeHtml(contact.name)}</span>` +
        `<span class="new-dm-contact-role muted">@${escapeHtml(contact.username)}</span>`;
      button.addEventListener("click", () => {
        startDm(contact.id).catch((err) => {
          elements.newDmError.textContent = err.message || "Could not open DM.";
          elements.newDmError.hidden = false;
        });
      });
      elements.newDmContacts.append(button);
    }
  } catch (err) {
    elements.newDmError.textContent = err.message || "Could not load contacts.";
    elements.newDmError.hidden = false;
  }
}

async function startDm(otherUserId) {
  const payload = await api("/api/messages/conversations/dm", {
    method: "POST",
    body: JSON.stringify({ otherUserId })
  });
  elements.newDmDialog.close?.();
  await loadConversations();
  if (payload.conversation?.id) {
    await setActiveConversation(payload.conversation.id);
  }
}

// --- Polling --------------------------------------------------------------

function schedulePolls() {
  stopPolls();
  state.pollStreamHandle = window.setInterval(() => {
    if (document.hidden || !state.activeConversationId) return;
    loadActiveMessages().catch(() => {});
  }, POLL_STREAM_MS);
  state.pollListHandle = window.setInterval(() => {
    if (document.hidden) return;
    loadConversations().catch(() => {});
  }, POLL_LIST_MS);
}

function stopPolls() {
  if (state.pollStreamHandle) clearInterval(state.pollStreamHandle);
  if (state.pollListHandle) clearInterval(state.pollListHandle);
  state.pollStreamHandle = 0;
  state.pollListHandle = 0;
}

// --- Boot -----------------------------------------------------------------

async function boot() {
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      window.location.href = "/login";
      return;
    }
    state.me = session.user || null;

    elements.composer.addEventListener("submit", sendMessage);
    elements.composerInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage(event);
      }
    });
    elements.newDmButton.addEventListener("click", () => openNewDmDialog());

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        loadActiveMessages().catch(() => {});
        loadConversations().catch(() => {});
      }
    });

    await loadConversations();
    if (state.activeConversationId) {
      await loadActiveMessages();
    }
    schedulePolls();
  } catch (err) {
    console.error("Could not boot messages page", err);
    elements.heading.textContent = "Messaging unavailable";
    elements.subtitle.textContent = err?.message || "Unknown error.";
  }
}

boot();
