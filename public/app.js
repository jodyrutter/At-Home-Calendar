const searchParams = new URLSearchParams(window.location.search);

const state = {
  householdName: "",
  timezone: "",
  members: [],
  events: [],
  bulletins: [],
  currentUser: null,
  selectedDate: searchParams.get("date") || toDateKey(new Date()),
  visibleMonth: startOfMonth(searchParams.get("date") ? parseDateKey(searchParams.get("date")) : new Date()),
  activeFilters: new Set(),
  filtersInitialized: false,
  editingBulletinId: null,
  highlightedEventId: searchParams.get("event") || ""
};

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const elements = {
  householdName: document.querySelector("#household-name"),
  householdTimezone: document.querySelector("#household-timezone"),
  summaryCards: document.querySelector("#summary-cards"),
  monthLabel: document.querySelector("#month-label"),
  weekdayRow: document.querySelector("#weekday-row"),
  calendarGrid: document.querySelector("#calendar-grid"),
  selectedDayLabel: document.querySelector("#selected-day-label"),
  selectedDayEvents: document.querySelector("#selected-day-events"),
  upcomingEvents: document.querySelector("#upcoming-events"),
  bulletinList: document.querySelector("#bulletin-list"),
  memberFilters: document.querySelector("#member-filters"),
  memberList: document.querySelector("#member-list"),
  bulletinModal: document.querySelector("#bulletin-modal"),
  bulletinForm: document.querySelector("#bulletin-form"),
  bulletinModalTitle: document.querySelector("#bulletin-modal-title"),
  deleteBulletin: document.querySelector("#delete-bulletin"),
  bulletinFormError: document.querySelector("#bulletin-form-error"),
  emptyStateTemplate: document.querySelector("#empty-state-template")
};

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftDate(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatMonthLabel(date) {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
}

function formatDayLabel(dateValue) {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(parseDateKey(dateValue));
}

function formatEventRange(event) {
  const start = new Date(event.start);
  const end = new Date(event.end);

  if (event.allDay) {
    return `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(start)} all day`;
  }

  const sameDay = toDateKey(start) === toDateKey(end);
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) {
    return `${timeFormat.format(start)} to ${timeFormat.format(end)}`;
  }

  const dateTimeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${dateTimeFormat.format(start)} to ${dateTimeFormat.format(end)}`;
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function getMember(memberId) {
  return state.members.find((member) => member.id === memberId);
}

function notificationTarget(targetUserId) {
  return state.notificationTargets?.find((target) => target.id === targetUserId) || null;
}

function reminderOption(offsetMinutes) {
  return state.reminderOptions?.find((option) => option.offsetMinutes === offsetMinutes) || null;
}

function eventNotificationSummary(event) {
  const notifications = event.notifications || {};
  if (!notifications.enabled) {
    return "";
  }

  const targetLabels = (notifications.targetUserIds || [])
    .map((userId) => notificationTarget(userId)?.label)
    .filter(Boolean)
    .join(", ");
  const offsetLabels = (notifications.offsetsMinutes || [])
    .map((offsetMinutes) => reminderOption(offsetMinutes)?.label || `${offsetMinutes} min before`)
    .join(", ");
  const annoyLabel = notifications.annoyMode ? `Annoy level ${notifications.annoyLevel || 5}` : "";
  const aiLabel = notifications.aiGenerated ? `Jody AI ${notifications.aiStatus || "pending"}` : "";
  const doneLabel = state.currentUser && notifications.completedBy?.[state.currentUser.id] ? "Done" : "";

  return [targetLabels ? `Notify: ${targetLabels}` : "", offsetLabels ? `When: ${offsetLabels}` : "", annoyLabel, aiLabel, doneLabel]
    .filter(Boolean)
    .join(" | ");
}

function eventOverlapsDay(event, dateKey) {
  const target = parseDateKey(dateKey);
  const dayStart = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999);
  return new Date(event.start) <= dayEnd && new Date(event.end) >= dayStart;
}

function filteredEvents() {
  if (state.members.length === 0) {
    return state.events;
  }

  if (state.activeFilters.size === 0) {
    return state.events.filter((event) => event.memberIds.length === 0);
  }

  if (state.activeFilters.size === state.members.length) {
    return state.events;
  }

  return state.events.filter((event) => event.memberIds.some((memberId) => state.activeFilters.has(memberId)));
}

function categoryColor(category) {
  const palette = {
    Meals: "#ea580c",
    School: "#2563eb",
    Work: "#7c3aed",
    Chores: "#0f766e",
    Health: "#dc2626",
    Travel: "#ca8a04",
    Social: "#db2777",
    General: "#475569"
  };

  return palette[category] || palette.General;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Something went wrong.");
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function loadBoard() {
  const payload = await api("/api/bootstrap");
  state.householdName = payload.householdName;
  state.timezone = payload.timezone;
  state.members = payload.members;
  state.events = payload.events;
  state.bulletins = payload.bulletins || [];
  state.notificationTargets = payload.notificationTargets || [];
  state.reminderOptions = payload.reminderOptions || [];
  state.currentUser = payload.currentUser || null;

  const validMemberIds = new Set(payload.members.map((member) => member.id));
  state.activeFilters = new Set([...state.activeFilters].filter((memberId) => validMemberIds.has(memberId)));

  if (!state.filtersInitialized) {
    payload.members.forEach((member) => state.activeFilters.add(member.id));
    state.filtersInitialized = true;
  }

  render();
  window.dispatchEvent(new Event("hearthboard:mobile-sync"));
}

function render() {
  renderHeader();
  renderFilters();
  renderCalendar();
  renderSelectedDay();
  renderUpcoming();
  renderBulletins();
  renderMembers();
  scrollHighlightedEventIntoView();
}

function renderHeader() {
  const todayKey = toDateKey(new Date());
  const thisWeekEnd = shiftDate(new Date(), 7);
  const weekCount = filteredEvents().filter((event) => {
    const start = new Date(event.start);
    return start >= new Date() && start <= thisWeekEnd;
  }).length;
  const todayCount = filteredEvents().filter((event) => eventOverlapsDay(event, todayKey)).length;

  elements.householdName.textContent = state.householdName;
  elements.householdTimezone.textContent = `Timezone: ${state.timezone}`;
  elements.summaryCards.innerHTML = `
    <div class="summary-card">
      <strong>${todayCount}</strong>
      <span>Items on today's board</span>
    </div>
    <div class="summary-card">
      <strong>${weekCount}</strong>
      <span>Upcoming in the next 7 days</span>
    </div>
    <div class="summary-card">
      <strong>${state.bulletins.length}</strong>
      <span>Live messages on the board</span>
    </div>
  `;
}

function renderFilters() {
  elements.memberFilters.innerHTML = "";

  const everyoneButton = document.createElement("button");
  everyoneButton.type = "button";
  everyoneButton.className = "member-chip";
  everyoneButton.dataset.active = String(state.activeFilters.size === state.members.length);
  everyoneButton.textContent = "Everyone";
  everyoneButton.addEventListener("click", () => {
    if (state.activeFilters.size === state.members.length) {
      state.activeFilters.clear();
    } else {
      state.members.forEach((member) => state.activeFilters.add(member.id));
    }
    render();
  });
  elements.memberFilters.append(everyoneButton);

  state.members.forEach((member) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "member-chip";
    button.dataset.active = String(state.activeFilters.has(member.id));
    button.innerHTML = `<span class="member-swatch" style="background:${member.color}"></span>${member.name}`;
    button.addEventListener("click", () => {
      if (state.activeFilters.has(member.id)) {
        state.activeFilters.delete(member.id);
      } else {
        state.activeFilters.add(member.id);
      }
      render();
    });
    elements.memberFilters.append(button);
  });
}

function renderCalendar() {
  elements.monthLabel.textContent = formatMonthLabel(state.visibleMonth);
  elements.weekdayRow.innerHTML = weekdayLabels.map((label) => `<div>${label}</div>`).join("");
  elements.calendarGrid.innerHTML = "";

  const monthStart = startOfMonth(state.visibleMonth);
  const gridStart = shiftDate(monthStart, -monthStart.getDay());
  const visibleEvents = filteredEvents();

  for (let index = 0; index < 42; index += 1) {
    const day = shiftDate(gridStart, index);
    const dateKey = toDateKey(day);
    const dayEvents = visibleEvents.filter((event) => eventOverlapsDay(event, dateKey)).slice(0, 3);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    if (day.getMonth() !== state.visibleMonth.getMonth()) {
      button.classList.add("other-month");
    }
    if (dateKey === state.selectedDate) {
      button.classList.add("selected");
    }
    if (dateKey === toDateKey(new Date())) {
      button.classList.add("today");
    }

    button.innerHTML = `
      <div class="day-topline">
        <span class="day-number">${day.getDate()}</span>
        <span class="meta-label">${dayEvents.length ? `${dayEvents.length} item${dayEvents.length > 1 ? "s" : ""}` : ""}</span>
      </div>
      <div class="stack">
        ${dayEvents.map((event) => `
          <div class="event-pill" style="border-left-color:${categoryColor(event.category)}">
            <strong>${event.title}</strong><br />
            <span>${event.allDay ? "All day" : formatEventRange(event)}</span>
          </div>
        `).join("")}
      </div>
    `;
    button.addEventListener("click", () => {
      state.selectedDate = dateKey;
      render();
    });
    elements.calendarGrid.append(button);
  }
}

function renderSelectedDay() {
  elements.selectedDayLabel.textContent = formatDayLabel(state.selectedDate);
  const dayEvents = filteredEvents().filter((event) => eventOverlapsDay(event, state.selectedDate));
  elements.selectedDayEvents.innerHTML = "";

  if (dayEvents.length === 0) {
    elements.selectedDayEvents.append(emptyStateNode());
    return;
  }

  dayEvents.forEach((event) => {
    elements.selectedDayEvents.append(eventCard(event));
  });
}

function renderUpcoming() {
  const now = new Date();
  const upcoming = filteredEvents()
    .filter((event) => new Date(event.end) >= now)
    .slice(0, 8);

  elements.upcomingEvents.innerHTML = "";
  if (upcoming.length === 0) {
    elements.upcomingEvents.append(emptyStateNode());
    return;
  }

  upcoming.forEach((event) => {
    elements.upcomingEvents.append(eventCard(event, false));
  });
}

function renderMembers() {
  elements.memberList.innerHTML = "";

  state.members.forEach((member) => {
    const assignments = state.events.filter((event) => event.memberIds.includes(member.id)).length;
    const article = document.createElement("article");
    article.className = "member-card";
    article.innerHTML = `
      <h3><span class="member-swatch" style="background:${member.color}"></span>${member.name}</h3>
      <p>${member.role || (member.username ? `@${member.username}` : "Household account")}</p>
      <p>${assignments} scheduled item${assignments === 1 ? "" : "s"}</p>
    `;
    elements.memberList.append(article);
  });
}

function renderBulletins() {
  elements.bulletinList.innerHTML = "";
  if (state.bulletins.length === 0) {
    const node = emptyStateNode();
    node.querySelector("p").textContent = "No household messages yet.";
    elements.bulletinList.append(node);
    return;
  }

  state.bulletins.forEach((bulletin) => {
    elements.bulletinList.append(bulletinCard(bulletin));
  });
}

function currentUserCompletion(event) {
  return state.currentUser ? event.notifications?.completedBy?.[state.currentUser.id] || null : null;
}

function currentUserCanComplete(event) {
  return Boolean(state.currentUser && event.notifications?.enabled && event.notifications?.targetUserIds?.includes(state.currentUser.id));
}

async function setEventCompletion(eventId, completed) {
  await api(`/api/account/events/${eventId}/completion`, {
    method: "POST",
    body: JSON.stringify({ completed })
  });
  await loadBoard();
}

function eventStudioUrl(event = null) {
  const url = new URL("/calendar/studio", window.location.origin);
  url.searchParams.set("date", state.selectedDate);
  if (event?.id) {
    url.searchParams.set("event", event.id);
  }
  if (window.location.search.includes("mobileApp=1")) {
    url.searchParams.set("mobileApp", "1");
  }
  return `${url.pathname}${url.search}`;
}

function eventCard(event, includeEdit = true) {
  const article = document.createElement("article");
  article.className = "event-card";
  article.dataset.eventId = event.id;
  if (state.highlightedEventId && state.highlightedEventId === event.id) {
    article.classList.add("event-card-highlight");
  }

  const assignedNames = event.memberIds.map((memberId) => getMember(memberId)?.name).filter(Boolean).join(", ");
  const completedAt = currentUserCompletion(event);
  const canComplete = currentUserCanComplete(event);

  article.innerHTML = `
    <h3>${event.title}</h3>
    <p class="event-card-meta">${formatEventRange(event)}</p>
    <p class="event-card-meta">${event.category}${event.location ? ` | ${event.location}` : ""}</p>
    <p class="event-card-meta">${assignedNames || "Unassigned"}</p>
    ${eventNotificationSummary(event) ? `<p class="event-card-meta">${eventNotificationSummary(event)}</p>` : ""}
    ${completedAt ? `<p class="event-card-meta">Done by you at ${formatTimestamp(completedAt)}</p>` : ""}
    ${event.description ? `<p class="event-card-meta">${event.description}</p>` : ""}
  `;

  if (includeEdit || canComplete) {
    const actions = document.createElement("div");
    actions.className = "event-card-actions";

    if (canComplete) {
      const completeButton = document.createElement("button");
      completeButton.type = "button";
      completeButton.className = "link-button";
      completeButton.textContent = completedAt ? "Mark not done" : "Mark done";
      completeButton.addEventListener("click", async () => {
        try {
          await setEventCompletion(event.id, !completedAt);
        } catch (error) {
          alert(error.message);
        }
      });
      actions.append(completeButton);
    }

    if (includeEdit) {
      const editLink = document.createElement("a");
      editLink.className = "link-button";
      editLink.href = eventStudioUrl(event);
      editLink.textContent = "Edit";
      actions.append(editLink);
    }

    article.append(actions);
  }

  return article;
}

function bulletinCard(bulletin) {
  const article = document.createElement("article");
  article.className = "bulletin-card";
  article.dataset.tone = bulletin.tone;
  article.dataset.pinned = String(Boolean(bulletin.pinned));
  article.innerHTML = `
    <div class="bulletin-topline">
      <h3>${bulletin.title}</h3>
      <button type="button" class="link-button">Edit</button>
    </div>
    <div class="bulletin-meta">
      <div class="bulletin-tag-row">
        <span class="bulletin-tag">${bulletin.tone}</span>
        ${bulletin.pinned ? '<span class="bulletin-tag pinned">Pinned</span>' : ""}
      </div>
      <span class="event-card-meta">${bulletin.author} | ${formatTimestamp(bulletin.createdAt)}</span>
    </div>
    <p class="bulletin-message">${bulletin.message}</p>
  `;

  article.querySelector(".link-button").addEventListener("click", () => openBulletinModal(bulletin));
  return article;
}

function emptyStateNode() {
  return elements.emptyStateTemplate.content.firstElementChild.cloneNode(true);
}

function scrollHighlightedEventIntoView() {
  if (!state.highlightedEventId) {
    return;
  }

  const highlighted = document.querySelector(`.event-card[data-event-id="${state.highlightedEventId}"]`);
  if (!highlighted) {
    return;
  }

  highlighted.scrollIntoView({ behavior: "smooth", block: "center" });
  state.highlightedEventId = "";
}

function resetBulletinForm() {
  state.editingBulletinId = null;
  elements.bulletinModalTitle.textContent = "Post message";
  elements.deleteBulletin.hidden = true;
  elements.bulletinFormError.hidden = true;
  elements.bulletinForm.reset();
  elements.bulletinForm.elements.tone.value = "Note";
}

function openBulletinModal(bulletin = null) {
  if (!bulletin) {
    resetBulletinForm();
    elements.bulletinModal.showModal();
    return;
  }

  state.editingBulletinId = bulletin.id;
  elements.bulletinModalTitle.textContent = "Edit message";
  elements.deleteBulletin.hidden = false;
  elements.bulletinFormError.hidden = true;
  elements.bulletinForm.elements.title.value = bulletin.title;
  elements.bulletinForm.elements.author.value = bulletin.author || "";
  elements.bulletinForm.elements.tone.value = bulletin.tone;
  elements.bulletinForm.elements.pinned.checked = Boolean(bulletin.pinned);
  elements.bulletinForm.elements.message.value = bulletin.message;
  elements.bulletinModal.showModal();
}

function closeModal(modal) {
  modal.close();
}

async function handleBulletinSubmit(event) {
  event.preventDefault();
  elements.bulletinFormError.hidden = true;

  const formData = new FormData(elements.bulletinForm);
  const body = {
    title: String(formData.get("title") || "").trim(),
    author: String(formData.get("author") || "").trim(),
    tone: String(formData.get("tone") || "Note"),
    pinned: formData.get("pinned") === "on",
    message: String(formData.get("message") || "").trim()
  };

  try {
    if (state.editingBulletinId) {
      await api(`/api/bulletins/${state.editingBulletinId}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      await api("/api/bulletins", { method: "POST", body: JSON.stringify(body) });
    }
    await loadBoard();
    closeModal(elements.bulletinModal);
  } catch (error) {
    elements.bulletinFormError.textContent = error.message;
    elements.bulletinFormError.hidden = false;
  }
}

async function deleteCurrentBulletin() {
  if (!state.editingBulletinId) {
    return;
  }

  await api(`/api/bulletins/${state.editingBulletinId}`, { method: "DELETE" });
  await loadBoard();
  closeModal(elements.bulletinModal);
}

function bindEvents() {
  document.querySelector("#open-create").addEventListener("click", () => {
    window.location.href = eventStudioUrl();
  });
  document.querySelector("#open-bulletin-modal").addEventListener("click", () => openBulletinModal());
  document.querySelector("#jump-today").addEventListener("click", () => {
    state.selectedDate = toDateKey(new Date());
    state.visibleMonth = startOfMonth(new Date());
    render();
  });
  document.querySelector("#prev-month").addEventListener("click", () => {
    state.visibleMonth = new Date(state.visibleMonth.getFullYear(), state.visibleMonth.getMonth() - 1, 1);
    render();
  });
  document.querySelector("#next-month").addEventListener("click", () => {
    state.visibleMonth = new Date(state.visibleMonth.getFullYear(), state.visibleMonth.getMonth() + 1, 1);
    render();
  });
  document.querySelector("#close-bulletin-modal").addEventListener("click", () => closeModal(elements.bulletinModal));
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => closeModal(document.querySelector(`#${button.dataset.closeDialog}`)));
  });
  elements.bulletinForm.addEventListener("submit", handleBulletinSubmit);
  elements.deleteBulletin.addEventListener("click", async () => {
    try {
      await deleteCurrentBulletin();
    } catch (error) {
      elements.bulletinFormError.textContent = error.message;
      elements.bulletinFormError.hidden = false;
    }
  });
}

bindEvents();
loadBoard().catch((error) => {
  elements.selectedDayEvents.innerHTML = `<div class="empty-state"><p>${error.message}</p></div>`;
});
