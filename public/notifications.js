import { escapeHtml } from "/util.js";

const elements = {
  heading: document.querySelector("#notifications-heading"),
  summary: document.querySelector("#notifications-summary"),
  error: document.querySelector("#notifications-error"),
  list: document.querySelector("#notifications-list"),
  emptyTemplate: document.querySelector("#notifications-empty-template")
};

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function emptyStateNode() {
  return elements.emptyTemplate.content.firstElementChild.cloneNode(true);
}

function renderSummary(payload) {
  const total = payload.notifications.length;
  const unread = payload.unreadCount || 0;
  elements.heading.textContent = unread === 0 ? "All caught up" : `${unread} unread reminder${unread === 1 ? "" : "s"}`;
  elements.summary.innerHTML = `
    <div class="summary-card">
      <strong>${unread}</strong>
      <span>Unread</span>
    </div>
    <div class="summary-card">
      <strong>${total}</strong>
      <span>Total queued</span>
    </div>
    <div class="summary-card">
      <strong>${payload.user?.avatar?.kind === "image" ? "Custom" : "Initial"}</strong>
      <span>Current portrait</span>
    </div>
  `;
}

function reminderCard(notification) {
  const article = document.createElement("article");
  article.className = "notification-card";
  article.dataset.dismissed = String(Boolean(notification.dismissed));
  const siblingCount = Math.max(0, Number(notification.totalForEvent || 1) - 1);
  const siblingBadge = siblingCount > 0
    ? `<span class="notification-pill notification-pill-muted">+${siblingCount} more reminder${siblingCount === 1 ? "" : "s"} for this event</span>`
    : "";
  article.innerHTML = `
    <div class="notification-card-topline">
      <div>
        <p class="meta-label">Scheduled ${escapeHtml(formatTimestamp(notification.scheduledAt))}</p>
        <h3>${escapeHtml(notification.title)}</h3>
      </div>
      <span class="notification-pill">${notification.dismissed ? "Dismissed" : escapeHtml(notification.offsetLabel)}</span>
    </div>
    <p class="notification-body">${escapeHtml(notification.body)}</p>
    <p class="event-card-meta">${escapeHtml(notification.eventTitle)}${notification.location ? ` | ${escapeHtml(notification.location)}` : ""}${notification.aiGenerated ? " | Jody AI written" : ""}</p>
    ${siblingBadge}
    <div class="notification-actions">
      <a class="button button-secondary" href="${escapeHtml(notification.url)}">Open event</a>
      ${notification.dismissed ? "" : `<button class="button button-secondary" type="button" data-action="dismiss">Dismiss this one</button>`}
      ${notification.dismissed ? "" : `<button class="button button-primary" type="button" data-action="complete">Task finished</button>`}
    </div>
  `;

  const dismissButton = article.querySelector('button[data-action="dismiss"]');
  if (dismissButton) {
    dismissButton.addEventListener("click", async () => {
      dismissButton.disabled = true;
      try {
        await api(`/api/account/notifications/${encodeURIComponent(notification.id)}/dismiss`, { method: "POST" });
        await loadNotifications();
      } catch (error) {
        elements.error.hidden = false;
        elements.error.textContent = error.message;
        dismissButton.disabled = false;
      }
    });
  }

  const completeButton = article.querySelector('button[data-action="complete"]');
  if (completeButton) {
    completeButton.addEventListener("click", async () => {
      completeButton.disabled = true;
      if (dismissButton) dismissButton.disabled = true;
      try {
        await api(`/api/account/notifications/event/${encodeURIComponent(notification.eventId)}/complete`, { method: "POST" });
        await loadNotifications();
      } catch (error) {
        elements.error.hidden = false;
        elements.error.textContent = error.message;
        completeButton.disabled = false;
        if (dismissButton) dismissButton.disabled = false;
      }
    });
  }

  return article;
}

function renderNotifications(payload) {
  renderSummary(payload);
  elements.list.innerHTML = "";
  elements.error.hidden = true;

  if (!payload.notifications.length) {
    elements.list.append(emptyStateNode());
    return;
  }

  payload.notifications.forEach((notification) => {
    elements.list.append(reminderCard(notification));
  });
}

async function loadNotifications() {
  const payload = await api("/api/account/notifications");
  renderNotifications(payload);
  window.dispatchEvent(new Event("hearthboard:nav-refresh"));
}

loadNotifications().catch((error) => {
  elements.error.hidden = false;
  elements.error.textContent = error.message;
});
