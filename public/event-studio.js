const searchParams = new URLSearchParams(window.location.search);

const state = {
  members: [],
  events: [],
  notificationTargets: [],
  reminderOptions: [],
  annoyIntervalOptions: [],
  annoyLevelOptions: [],
  currentUser: null,
  selectedDate: searchParams.get("date") || toDateKey(new Date()),
  editingEventId: searchParams.get("event") || ""
};

const elements = {
  form: document.querySelector("#event-form"),
  title: document.querySelector("#event-modal-title"),
  kicker: document.querySelector("#event-studio-kicker"),
  dateHeading: document.querySelector("#event-studio-date"),
  targetsCount: document.querySelector("#event-studio-targets"),
  remindersCount: document.querySelector("#event-studio-reminders"),
  membersCount: document.querySelector("#event-studio-members"),
  memberCheckboxes: document.querySelector("#member-checkboxes"),
  notificationsEnabled: document.querySelector("#event-notifications-enabled"),
  notificationConfig: document.querySelector("#event-notification-config"),
  notificationTargetCheckboxes: document.querySelector("#notification-target-checkboxes"),
  notificationOffsetCheckboxes: document.querySelector("#notification-offset-checkboxes"),
  annoyMode: document.querySelector("#event-annoy-mode"),
  annoyLevelWrap: document.querySelector("#event-annoy-level-wrap"),
  annoyLevel: document.querySelector("#event-annoy-level"),
  annoyLevelPicker: document.querySelector("#event-annoy-level-picker"),
  annoyLevelDisplay: document.querySelector("#event-annoy-level-display"),
  aiReminderCopy: document.querySelector("#event-ai-reminders"),
  aiUseWeb: document.querySelector("#event-ai-use-web"),
  aiUseWebWrap: document.querySelector("#event-ai-use-web-wrap"),
  annoyIntervalWrap: document.querySelector("#event-annoy-interval-wrap"),
  annoyInterval: document.querySelector("#event-annoy-interval"),
  formError: document.querySelector("#event-form-error"),
  formSuccess: document.querySelector("#event-form-success"),
  deleteEvent: document.querySelector("#delete-event"),
  resetButton: document.querySelector("#reset-event-form"),
  saveButton: document.querySelector("#save-event-button"),
  backLink: document.querySelector("#event-studio-back")
};

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDateInput(date) {
  return toDateKey(date);
}

function formatTimeInput(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDayLabel(dateValue) {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(parseDateKey(dateValue));
}

function combineDateAndTime(dateValue, timeValue, allDay, useEndOfDay = false) {
  if (allDay) {
    return new Date(`${dateValue}T${useEndOfDay ? "23:59" : "00:00"}:00`);
  }

  return new Date(`${dateValue}T${timeValue}:00`);
}

function studioBackUrl() {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("date", state.selectedDate);
  if (window.location.search.includes("mobileApp=1")) {
    url.searchParams.set("mobileApp", "1");
  }
  return `${url.pathname}${url.search}`;
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

function clearMessages() {
  elements.formError.hidden = true;
  elements.formSuccess.hidden = true;
}

function renderMemberCheckboxes() {
  elements.memberCheckboxes.innerHTML = "";
  state.members.forEach((member) => {
    const label = document.createElement("label");
    label.innerHTML = `
      <input type="checkbox" name="memberIds" value="${member.id}" />
      <span><span class="member-swatch" style="background:${member.color}"></span>${member.name}</span>
    `;
    elements.memberCheckboxes.append(label);
  });
}

function renderNotificationCheckboxes() {
  elements.notificationTargetCheckboxes.innerHTML = "";
  elements.notificationOffsetCheckboxes.innerHTML = "";
  elements.annoyInterval.innerHTML = "";
  renderAnnoyLevelPicker();

  state.notificationTargets.forEach((target) => {
    const label = document.createElement("label");
    label.innerHTML = `
      <input type="checkbox" name="notificationTargetUserIds" value="${target.id}" />
      <span>${target.label}</span>
    `;
    elements.notificationTargetCheckboxes.append(label);
  });

  state.reminderOptions.forEach((option) => {
    const label = document.createElement("label");
    label.innerHTML = `
      <input type="checkbox" name="notificationOffsetsMinutes" value="${option.offsetMinutes}" />
      <span>${option.label}</span>
    `;
    elements.notificationOffsetCheckboxes.append(label);
  });

  state.annoyIntervalOptions.forEach((option) => {
    const element = document.createElement("option");
    element.value = String(option.intervalMinutes);
    element.textContent = option.label;
    elements.annoyInterval.append(element);
  });

}

function renderAnnoyLevelPicker() {
  if (!elements.annoyLevelPicker) {
    return;
  }
  const existing = Number(elements.annoyLevel?.value || 5);
  elements.annoyLevelPicker.innerHTML = "";
  const options = state.annoyLevelOptions.length
    ? state.annoyLevelOptions
    : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, label: `Level ${i + 1}` }));

  options.forEach((option) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "annoy-level-pill";
    pill.dataset.level = String(option.level);
    pill.setAttribute("role", "radio");
    pill.setAttribute("aria-checked", String(option.level === existing));
    pill.setAttribute("aria-label", option.label || `Level ${option.level}`);
    pill.textContent = String(option.level);
    pill.addEventListener("click", () => setAnnoyLevel(option.level, { focus: true }));
    elements.annoyLevelPicker.append(pill);
  });

  setAnnoyLevel(existing, { focus: false });
}

function setAnnoyLevel(level, { focus = false } = {}) {
  const numeric = Math.max(1, Math.min(10, Number(level) || 5));
  if (elements.annoyLevel) {
    elements.annoyLevel.value = String(numeric);
  }
  if (elements.annoyLevelDisplay) {
    elements.annoyLevelDisplay.textContent = String(numeric);
  }
  if (elements.annoyLevelPicker) {
    Array.from(elements.annoyLevelPicker.querySelectorAll(".annoy-level-pill")).forEach((pill) => {
      const pillLevel = Number(pill.dataset.level);
      const active = pillLevel === numeric;
      pill.setAttribute("aria-checked", String(active));
      pill.dataset.active = String(active);
      pill.dataset.scale = pillLevel <= numeric ? "on" : "off";
    });
  }
  if (elements.annoyLevelWrap?.dataset) {
    elements.annoyLevelWrap.dataset.level = String(numeric);
  }
  renderAnnoyLevelIndicator();
  if (focus && elements.annoyLevelPicker) {
    const target = elements.annoyLevelPicker.querySelector(`[data-level="${numeric}"]`);
    target?.focus({ preventScroll: true });
  }
}

function toggleTimeFields() {
  const allDay = elements.form.elements.allDay.checked;
  elements.form.elements.startTime.disabled = allDay;
  elements.form.elements.endTime.disabled = allDay;
}

function toggleNotificationFields() {
  const enabled = elements.notificationsEnabled.checked;
  elements.notificationConfig.hidden = !enabled;
  Array.from(elements.form.querySelectorAll('input[name="notificationTargetUserIds"], input[name="notificationOffsetsMinutes"]')).forEach((input) => {
    input.disabled = !enabled;
  });
  elements.annoyMode.disabled = !enabled;
  // Annoyance level stays editable any time notifications are on. We hide the
  // field via a data-hidden attribute + CSS instead of the HTML `hidden`
  // attribute, because adjacent CSS display rules were overriding `hidden`.
  if (elements.annoyLevelWrap) {
    elements.annoyLevelWrap.dataset.hidden = enabled ? "false" : "true";
    elements.annoyLevelWrap.dataset.annoyOn = elements.annoyMode.checked ? "1" : "0";
  }
  if (elements.annoyLevelPicker) {
    Array.from(elements.annoyLevelPicker.querySelectorAll(".annoy-level-pill")).forEach((pill) => {
      pill.disabled = !enabled;
    });
  }
  elements.aiReminderCopy.disabled = !enabled;
  elements.aiUseWeb.disabled = !enabled || !elements.aiReminderCopy.checked;
  elements.aiUseWebWrap.hidden = !enabled || !elements.aiReminderCopy.checked;
  elements.annoyInterval.disabled = true;
  elements.annoyIntervalWrap.hidden = true;
}

function renderAnnoyLevelIndicator() {
  if (!elements.annoyLevel) {
    return;
  }

  const level = Math.max(1, Math.min(10, Number(elements.annoyLevel.value || 5)));
  if (elements.annoyLevelWrap) {
    elements.annoyLevelWrap.dataset.level = String(level);
    elements.annoyLevelWrap.style.setProperty("--annoy-level", String(level));
  }
}

function setSubmitState(isSaving) {
  elements.saveButton.disabled = isSaving;
  elements.saveButton.textContent = isSaving
    ? (state.editingEventId ? "Updating..." : "Saving...")
    : (state.editingEventId ? "Update event" : "Save event");
}

function resetForm(dateValue = state.selectedDate) {
  clearMessages();
  setSubmitState(false);
  elements.form.reset();

  const date = parseDateKey(dateValue);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 18, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 19, 0, 0, 0);

  elements.form.elements.date.value = formatDateInput(start);
  elements.form.elements.endDate.value = formatDateInput(end);
  elements.form.elements.startTime.value = formatTimeInput(start);
  elements.form.elements.endTime.value = formatTimeInput(end);
  setAnnoyLevel(5);
  elements.annoyInterval.value = "10";

  Array.from(elements.form.querySelectorAll('input[name="memberIds"]')).forEach((input) => {
    input.checked = false;
  });
  Array.from(elements.form.querySelectorAll('input[name="notificationTargetUserIds"]')).forEach((input) => {
    input.checked = state.currentUser ? input.value === state.currentUser.id : false;
  });
  Array.from(elements.form.querySelectorAll('input[name="notificationOffsetsMinutes"]')).forEach((input) => {
    input.checked = ["60", "10", "0"].includes(input.value);
  });

  toggleTimeFields();
  toggleNotificationFields();
}

function applyStudioMode(eventItem = null) {
  const editing = Boolean(eventItem);
  elements.kicker.textContent = editing ? "Editing on the board" : "Event studio";
  elements.title.textContent = editing ? "Edit event" : "Add event";
  elements.deleteEvent.hidden = !editing;
  elements.dateHeading.textContent = editing ? eventItem.title : formatDayLabel(state.selectedDate);
}

function populateForm(eventItem) {
  const start = new Date(eventItem.start);
  const end = new Date(eventItem.end);

  elements.form.elements.title.value = eventItem.title;
  elements.form.elements.date.value = formatDateInput(start);
  elements.form.elements.endDate.value = formatDateInput(end);
  elements.form.elements.startTime.value = formatTimeInput(start);
  elements.form.elements.endTime.value = formatTimeInput(end);
  elements.form.elements.category.value = eventItem.category;
  elements.form.elements.location.value = eventItem.location || "";
  elements.form.elements.description.value = eventItem.description || "";
  elements.form.elements.allDay.checked = Boolean(eventItem.allDay);
  elements.notificationsEnabled.checked = Boolean(eventItem.notifications?.enabled);
  elements.annoyMode.checked = Boolean(eventItem.notifications?.annoyMode);
  setAnnoyLevel(eventItem.notifications?.annoyLevel || 5);
  elements.aiReminderCopy.checked = Boolean(eventItem.notifications?.aiGenerated);
  elements.aiUseWeb.checked = Boolean(eventItem.notifications?.aiUseWeb);
  elements.annoyInterval.value = String(eventItem.notifications?.annoyIntervalMinutes || 10);

  Array.from(elements.form.querySelectorAll('input[name="memberIds"]')).forEach((input) => {
    input.checked = eventItem.memberIds.includes(input.value);
  });
  Array.from(elements.form.querySelectorAll('input[name="notificationTargetUserIds"]')).forEach((input) => {
    input.checked = Boolean(eventItem.notifications?.targetUserIds?.includes(input.value));
  });
  Array.from(elements.form.querySelectorAll('input[name="notificationOffsetsMinutes"]')).forEach((input) => {
    input.checked = Boolean(eventItem.notifications?.offsetsMinutes?.includes(Number(input.value)));
  });

  toggleTimeFields();
  toggleNotificationFields();
}

async function loadStudio() {
  const payload = await api("/api/bootstrap");
  state.members = payload.members;
  state.events = payload.events;
  state.notificationTargets = payload.notificationTargets || [];
  state.reminderOptions = payload.reminderOptions || [];
  state.annoyIntervalOptions = payload.annoyIntervalOptions || [];
  state.annoyLevelOptions = payload.annoyLevelOptions || [];
  state.currentUser = payload.currentUser || null;

  renderMemberCheckboxes();
  renderNotificationCheckboxes();
  elements.targetsCount.textContent = String(state.notificationTargets.length);
  elements.remindersCount.textContent = String(state.reminderOptions.length);
  elements.membersCount.textContent = String(state.members.length);
  elements.backLink.href = studioBackUrl();

  const eventItem = state.editingEventId ? state.events.find((entry) => entry.id === state.editingEventId) : null;
  if (state.editingEventId && !eventItem) {
    state.editingEventId = "";
  }

  if (eventItem) {
    state.selectedDate = eventItem.start.slice(0, 10);
  }

  resetForm(state.selectedDate);
  applyStudioMode(eventItem);
  if (eventItem) {
    populateForm(eventItem);
  }
  elements.backLink.href = studioBackUrl();
}

function submissionBodyFromForm() {
  const formData = new FormData(elements.form);
  const allDay = formData.get("allDay") === "on";
  const payload = {
    title: String(formData.get("title") || "").trim(),
    date: formData.get("date"),
    endDate: formData.get("endDate"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    category: formData.get("category"),
    location: formData.get("location"),
    description: formData.get("description"),
    allDay,
    memberIds: formData.getAll("memberIds"),
    notificationsEnabled: formData.get("notificationsEnabled") === "on",
    notificationTargetUserIds: formData.getAll("notificationTargetUserIds"),
    notificationOffsetsMinutes: formData.getAll("notificationOffsetsMinutes"),
    annoyMode: formData.get("annoyMode") === "on",
    // Read directly from the select rather than FormData, because disabled
    // form controls are silently dropped by FormData. The select can briefly
    // be disabled (e.g. before notifications are enabled), and we still want
    // its current value to round-trip to the server.
    annoyLevel: elements.annoyLevel?.value ?? formData.get("annoyLevel"),
    aiGenerated: formData.get("aiGenerated") === "on",
    aiUseWeb: formData.get("aiUseWeb") === "on",
    annoyIntervalMinutes: formData.get("annoyIntervalMinutes")
  };

  if (!payload.title) {
    throw new Error("Event title is required.");
  }
  if (!payload.date || !payload.endDate) {
    throw new Error("Choose a start date and an end date.");
  }
  if (!allDay && (!payload.startTime || !payload.endTime)) {
    throw new Error("Choose a start and end time.");
  }
  if (payload.notificationsEnabled && payload.notificationTargetUserIds.length === 0) {
    throw new Error("Choose at least one account to notify.");
  }
  if (payload.notificationsEnabled && !payload.annoyMode && payload.notificationOffsetsMinutes.length === 0) {
    throw new Error("Choose at least one reminder time.");
  }

  const startDate = combineDateAndTime(payload.date, payload.startTime || "00:00", allDay);
  const endDate = combineDateAndTime(payload.endDate, payload.endTime || "23:59", allDay, true);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error("Start and end times must be valid.");
  }
  if (endDate.getTime() < startDate.getTime()) {
    throw new Error("Event end time must be after the start time.");
  }

  return {
    requestBody: {
      title: payload.title,
      category: payload.category,
      location: payload.location,
      description: payload.description,
      allDay,
      memberIds: payload.memberIds,
      notifications: {
        enabled: payload.notificationsEnabled,
        targetUserIds: payload.notificationTargetUserIds,
        offsetsMinutes: payload.notificationOffsetsMinutes.map((value) => Number(value)),
        annoyMode: payload.annoyMode,
        annoyLevel: Number(payload.annoyLevel || 5),
        aiGenerated: payload.aiGenerated,
        aiUseWeb: payload.aiUseWeb,
        annoyIntervalMinutes: Number(payload.annoyIntervalMinutes || 10)
      },
      start: startDate.toISOString(),
      end: endDate.toISOString()
    },
    selectedDate: toDateKey(startDate)
  };
}

async function handleSubmit(event) {
  event.preventDefault();
  clearMessages();

  try {
    const { requestBody, selectedDate } = submissionBodyFromForm();
    setSubmitState(true);
    if (state.editingEventId) {
      await api(`/api/events/${state.editingEventId}`, { method: "PATCH", body: JSON.stringify(requestBody) });
    } else {
      await api("/api/events", { method: "POST", body: JSON.stringify(requestBody) });
    }
    state.selectedDate = selectedDate;
    elements.formSuccess.hidden = false;
    elements.formSuccess.textContent = state.editingEventId ? "Event updated." : "Event added to the board.";
    setTimeout(() => {
      window.location.href = studioBackUrl();
    }, 700);
  } catch (error) {
    elements.formError.hidden = false;
    elements.formError.textContent = error.message;
  } finally {
    setSubmitState(false);
  }
}

async function handleDelete() {
  if (!state.editingEventId) {
    return;
  }

  clearMessages();
  try {
    await api(`/api/events/${state.editingEventId}`, { method: "DELETE" });
    elements.formSuccess.hidden = false;
    elements.formSuccess.textContent = "Event removed from the board.";
    setTimeout(() => {
      window.location.href = studioBackUrl();
    }, 500);
  } catch (error) {
    elements.formError.hidden = false;
    elements.formError.textContent = error.message;
  }
}

elements.form.addEventListener("submit", handleSubmit);
elements.resetButton.addEventListener("click", () => {
  const eventItem = state.editingEventId ? state.events.find((entry) => entry.id === state.editingEventId) : null;
  resetForm(state.selectedDate);
  applyStudioMode(eventItem);
  if (eventItem) {
    populateForm(eventItem);
  }
});
elements.form.elements.allDay.addEventListener("change", toggleTimeFields);
elements.notificationsEnabled.addEventListener("change", toggleNotificationFields);
elements.annoyMode.addEventListener("change", toggleNotificationFields);
elements.aiReminderCopy.addEventListener("change", toggleNotificationFields);
// Keyboard nav for the pill radiogroup (arrows jump between levels).
if (elements.annoyLevelPicker) {
  elements.annoyLevelPicker.addEventListener("keydown", (event) => {
    const current = Number(elements.annoyLevel?.value || 5);
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = Math.min(10, current + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = Math.max(1, current - 1);
    } else if (event.key === "Home") {
      next = 1;
    } else if (event.key === "End") {
      next = 10;
    }
    if (next !== null) {
      event.preventDefault();
      setAnnoyLevel(next, { focus: true });
    }
  });
}
elements.deleteEvent.addEventListener("click", handleDelete);

loadStudio().catch((error) => {
  elements.formError.hidden = false;
  elements.formError.textContent = error.message;
});
