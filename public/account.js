const VISIBILITY_LABELS = {
  public: "Public",
  trusted: "Trusted+",
  family: "Family+",
  admin: "Admin only"
};

const PERMISSION_LABELS = {
  default: "Default",
  trusted: "Trusted friend",
  family: "Family"
};

const state = {
  account: null,
  activeAdminTab: "visibility"
};

const elements = {
  heading: document.querySelector("#account-heading"),
  subtitle: document.querySelector("#account-subtitle"),
  username: document.querySelector("#account-username"),
  role: document.querySelector("#account-role"),
  summary: document.querySelector("#account-summary"),
  refresh: document.querySelector("#account-refresh"),
  logout: document.querySelector("#account-logout"),
  adminPanel: document.querySelector("#admin-panel"),
  profileForm: document.querySelector("#profile-form"),
  profileEmail: document.querySelector("#profile-email"),
  profilePhone: document.querySelector("#profile-phone"),
  profileError: document.querySelector("#profile-error"),
  profileSuccess: document.querySelector("#profile-success"),
  passwordForm: document.querySelector("#password-form"),
  passwordError: document.querySelector("#password-error"),
  passwordSuccess: document.querySelector("#password-success"),
  currentPassword: document.querySelector("#current-password"),
  newPassword: document.querySelector("#new-password"),
  confirmPassword: document.querySelector("#confirm-password"),
  adminTabs: Array.from(document.querySelectorAll("[data-admin-tab]")),
  adminPanels: Array.from(document.querySelectorAll("[data-admin-panel]")),
  visibilityForm: document.querySelector("#visibility-form"),
  pageGrid: document.querySelector("#page-visibility-grid"),
  libraryGrid: document.querySelector("#library-visibility-grid"),
  userList: document.querySelector("#user-list"),
  visibilityError: document.querySelector("#visibility-error"),
  visibilitySuccess: document.querySelector("#visibility-success"),
  deviceList: document.querySelector("#device-list")
};

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

function clearMessage(element) {
  element.hidden = true;
  element.textContent = "";
}

function showMessage(element, message) {
  element.hidden = false;
  element.textContent = message;
}

function renderSummary(user) {
  const approvalText = user.approved ? "Approved" : "Awaiting admin approval";
  const accessText = user.role === "admin" ? "Administrator" : (PERMISSION_LABELS[user.permissionLevel] || "Default");
  elements.heading.textContent = user.role === "admin" ? "Admin account" : "Your account";
  elements.subtitle.textContent = user.role === "admin"
    ? "You can manage your own profile here, approve users, and control what Hearthboard exposes to everyone else."
    : user.approved
      ? "Update your password, phone number, and email from one place."
      : "Your account is waiting for admin approval. Public galleries and your account page stay available in the meantime.";
  elements.username.textContent = user.username;
  elements.role.textContent = `${accessText} | ${approvalText}`;
  elements.summary.innerHTML = `
    <div class="summary-card">
      <strong>${user.email ? "Set" : "Empty"}</strong>
      <span>Email</span>
    </div>
    <div class="summary-card">
      <strong>${user.phone ? "Set" : "Empty"}</strong>
      <span>Phone</span>
    </div>
    <div class="summary-card">
      <strong>${accessText}</strong>
      <span>Access level</span>
    </div>
    <div class="summary-card">
      <strong>${user.householdMember ? "On roster" : "Off roster"}</strong>
      <span>Household board</span>
    </div>
  `;
}

function formatTimestamp(value) {
  if (!value) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function visibilitySelect(name, value) {
  const select = document.createElement("select");
  select.name = name;
  Object.entries(VISIBILITY_LABELS).forEach(([option, label]) => {
    const element = document.createElement("option");
    element.value = option;
    element.textContent = label;
    element.selected = option === value;
    select.append(element);
  });
  return select;
}

function renderVisibilityGrid(target, items, prefix) {
  target.innerHTML = "";
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "visibility-row";

    const label = document.createElement("div");
    label.className = "visibility-title";
    label.textContent = item.label;

    const lanWrap = document.createElement("label");
    lanWrap.className = "visibility-field";
    lanWrap.innerHTML = "<span>LAN</span>";
    lanWrap.append(visibilitySelect(`${prefix}.${item.id}.lan`, item.visibility.lan));

    const remoteWrap = document.createElement("label");
    remoteWrap.className = "visibility-field";
    remoteWrap.innerHTML = "<span>Internet</span>";
    remoteWrap.append(visibilitySelect(`${prefix}.${item.id}.remote`, item.visibility.remote));

    row.append(label, lanWrap, remoteWrap);
    target.append(row);
  });
}

function renderDeviceList(devices) {
  if (!elements.deviceList) {
    return;
  }

  elements.deviceList.innerHTML = "";
  if (!Array.isArray(devices) || devices.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<p>No device activity has been logged yet.</p>";
    elements.deviceList.append(empty);
    return;
  }

  const groups = new Map();
  devices.forEach((device) => {
    const key = device.ip || "Unknown IP";
    const group = groups.get(key) || [];
    group.push(device);
    groups.set(key, group);
  });

  [...groups.entries()]
    .sort((left, right) => {
      const leftTime = Math.max(...left[1].map((device) => new Date(device.lastSeenAt || 0).getTime()));
      const rightTime = Math.max(...right[1].map((device) => new Date(device.lastSeenAt || 0).getTime()));
      return rightTime - leftTime;
    })
    .forEach(([ip, groupedDevices]) => {
      const wrapper = document.createElement("section");
      wrapper.className = "device-group";
      const anonymousHits = groupedDevices.reduce((total, device) => total + (device.anonymousVisitCount || 0), 0);
      const authenticatedHits = groupedDevices.reduce((total, device) => total + (device.authenticatedVisitCount || 0), 0);
      const knownUsers = [...new Set(groupedDevices.flatMap((device) => device.usernames || []))];

      wrapper.innerHTML = `
        <div class="device-group-header ${anonymousHits > 0 ? "has-anonymous" : ""}">
          <div>
            <h3>${ip}</h3>
            <p class="device-card-meta">${groupedDevices.length} device${groupedDevices.length === 1 ? "" : "s"} | ${authenticatedHits} authenticated hit${authenticatedHits === 1 ? "" : "s"} | ${anonymousHits} anonymous hit${anonymousHits === 1 ? "" : "s"}</p>
            <p class="device-card-meta">${knownUsers.length ? `Users seen here: ${knownUsers.join(", ")}` : "No signed-in users seen from this IP yet"}</p>
          </div>
          <span class="device-group-badge ${anonymousHits > 0 ? "is-warn" : ""}">${anonymousHits > 0 ? "Anonymous activity seen" : "Known activity only"}</span>
        </div>
      `;

      const list = document.createElement("div");
      list.className = "device-group-list";

      groupedDevices
        .sort((left, right) => new Date(right.lastSeenAt || 0).getTime() - new Date(left.lastSeenAt || 0).getTime())
        .forEach((device) => {
          const card = document.createElement("article");
          card.className = `device-card${(device.anonymousVisitCount || 0) > 0 ? " has-anonymous" : ""}`;
          card.innerHTML = `
            <div class="device-card-topline">
              <h3>${device.label || "Unknown device"}</h3>
              <span class="device-card-ip">${device.host || "Unknown host"}</span>
            </div>
            <p class="device-card-meta">First seen ${formatTimestamp(device.firstSeenAt)} | Last seen ${formatTimestamp(device.lastSeenAt)}</p>
            <p class="device-card-meta">${device.visitCount || 0} request${device.visitCount === 1 ? "" : "s"} | ${device.authenticatedVisitCount || 0} authenticated | ${device.anonymousVisitCount || 0} anonymous</p>
            <p class="device-card-meta">${device.usernames?.length ? `Signed in as ${device.usernames.join(", ")}` : "Never authenticated"}</p>
            <p class="device-card-agent">${device.userAgent || "Unknown user agent"}</p>
          `;
          list.append(card);
        });

      wrapper.append(list);
      elements.deviceList.append(wrapper);
    });
}

function permissionSelect(value) {
  const select = document.createElement("select");
  select.className = "user-access-select";
  Object.entries(PERMISSION_LABELS).forEach(([option, label]) => {
    const element = document.createElement("option");
    element.value = option;
    element.textContent = label;
    element.selected = option === value;
    select.append(element);
  });
  return select;
}

function renderUserList(users) {
  if (!elements.userList) {
    return;
  }

  elements.userList.innerHTML = "";
  if (!Array.isArray(users) || users.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<p>No user accounts have been created yet.</p>";
    elements.userList.append(empty);
    return;
  }

  users.forEach((user) => {
    const card = document.createElement("article");
    card.className = `user-card${user.pendingApproval ? " is-pending" : ""}`;
    card.innerHTML = `
      <div class="user-card-topline">
        <div>
          <h3>${user.memberName || user.username}</h3>
          <p class="device-card-meta">@${user.username} | ${user.role === "admin" ? "Admin" : (PERMISSION_LABELS[user.permissionLevel] || "Default")}</p>
        </div>
        <span class="device-group-badge ${user.pendingApproval ? "is-warn" : ""}">${user.pendingApproval ? "Pending approval" : "Approved"}</span>
      </div>
    `;

    if (!user.canEdit) {
      const note = document.createElement("p");
      note.className = "device-card-meta";
      note.textContent = "The admin account always keeps full access and stays on the household roster.";
      card.append(note);
      elements.userList.append(card);
      return;
    }

    const controls = document.createElement("form");
    controls.className = "user-card-controls";

    const permissionWrap = document.createElement("label");
    permissionWrap.className = "visibility-field";
    permissionWrap.innerHTML = "<span>Access level</span>";
    const permission = permissionSelect(user.permissionLevel);
    permission.name = "permissionLevel";
    permissionWrap.append(permission);

    const approvedWrap = document.createElement("label");
    approvedWrap.className = "checkbox-field user-card-checkbox";
    approvedWrap.innerHTML = `<input name="approved" type="checkbox" ${user.approved ? "checked" : ""} /><span>Approved by admin</span>`;

    const rosterWrap = document.createElement("label");
    rosterWrap.className = "checkbox-field user-card-checkbox";
    rosterWrap.innerHTML = `<input name="householdMember" type="checkbox" ${user.directHouseholdMember ? "checked" : ""} /><span>Show on household roster and calendar</span>`;

    const syncRosterCheckbox = () => {
      const rosterInput = rosterWrap.querySelector("input");
      if (!rosterInput) {
        return;
      }

      if (permission.value === "family") {
        rosterInput.checked = true;
        rosterInput.disabled = true;
      } else {
        rosterInput.disabled = false;
      }
    };
    permission.addEventListener("change", syncRosterCheckbox);
    syncRosterCheckbox();

    const actions = document.createElement("div");
    actions.className = "assistant-form-actions";
    const status = document.createElement("span");
    status.className = "muted";
    status.textContent = user.pendingApproval
      ? "Pending accounts stay limited until you approve them."
      : "Access updates apply immediately after saving.";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "button button-primary";
    submit.textContent = "Save user";
    actions.append(status, submit);

    const error = document.createElement("p");
    error.className = "form-error";
    error.hidden = true;

    controls.append(permissionWrap, approvedWrap, rosterWrap, error, actions);
    controls.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      error.textContent = "";

      try {
        await api(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            permissionLevel: permission.value,
            approved: approvedWrap.querySelector("input")?.checked,
            householdMember: rosterWrap.querySelector("input")?.checked
          })
        });
        await loadAccount();
      } catch (updateError) {
        error.hidden = false;
        error.textContent = updateError.message;
      }
    });

    card.append(controls);
    elements.userList.append(card);
  });
}

function renderAdminTabs() {
  elements.adminTabs.forEach((tab) => {
    const isActive = tab.dataset.adminTab === state.activeAdminTab;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  elements.adminPanels.forEach((panel) => {
    panel.hidden = panel.dataset.adminPanel !== state.activeAdminTab;
  });
}

function render() {
  const { user, isAdmin, pageVisibility, libraries, devices, users } = state.account;
  renderSummary(user);
  elements.profileEmail.value = user.email || "";
  elements.profilePhone.value = user.phone || "";
  elements.adminPanel.hidden = !isAdmin;

  if (isAdmin) {
    const pages = [
      { id: "calendar", label: "Calendar", visibility: pageVisibility.calendar },
      { id: "gallery", label: "Gallery", visibility: pageVisibility.gallery },
      { id: "assistant", label: "Jody AI", visibility: pageVisibility.assistant }
    ];
    renderVisibilityGrid(elements.pageGrid, pages, "page");
    renderVisibilityGrid(elements.libraryGrid, libraries, "library");
    renderUserList(users);
    renderDeviceList(devices);
    renderAdminTabs();
  }
}

async function loadAccount() {
  state.account = await api("/api/account");
  render();
}

elements.refresh?.addEventListener("click", () => {
  loadAccount().catch((error) => {
    showMessage(elements.profileError, error.message);
  });
});

elements.logout?.addEventListener("click", async () => {
  await fetch("/api/session/logout", { method: "POST" });
  window.location.replace("/login");
});

elements.adminTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.activeAdminTab = tab.dataset.adminTab || "visibility";
    renderAdminTabs();
  });
});

elements.profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage(elements.profileError);
  clearMessage(elements.profileSuccess);

  try {
    const payload = await api("/api/account/profile", {
      method: "PATCH",
      body: JSON.stringify({
        email: elements.profileEmail.value,
        phone: elements.profilePhone.value
      })
    });
    state.account.user = payload.user;
    render();
    showMessage(elements.profileSuccess, "Profile updated.");
  } catch (error) {
    showMessage(elements.profileError, error.message);
  }
});

elements.passwordForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage(elements.passwordError);
  clearMessage(elements.passwordSuccess);

  if (elements.newPassword.value !== elements.confirmPassword.value) {
    showMessage(elements.passwordError, "The new password confirmation did not match.");
    return;
  }

  try {
    await api("/api/account/password", {
      method: "PATCH",
      body: JSON.stringify({
        currentPassword: elements.currentPassword.value,
        newPassword: elements.newPassword.value
      })
    });
    elements.passwordForm.reset();
    showMessage(elements.passwordSuccess, "Password updated.");
  } catch (error) {
    showMessage(elements.passwordError, error.message);
  }
});

elements.visibilityForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage(elements.visibilityError);
  clearMessage(elements.visibilitySuccess);

  const formData = new FormData(elements.visibilityForm);
  const pageVisibility = {};
  const libraryVisibility = {};

  for (const [key, value] of formData.entries()) {
    const [scope, id, audience] = String(key).split(".");
    if (scope === "page") {
      pageVisibility[id] = pageVisibility[id] || {};
      pageVisibility[id][audience] = value;
    } else if (scope === "library") {
      libraryVisibility[id] = libraryVisibility[id] || {};
      libraryVisibility[id][audience] = value;
    }
  }

  try {
    const payload = await api("/api/admin/visibility", {
      method: "PATCH",
      body: JSON.stringify({
        pageVisibility,
        libraryVisibility
      })
    });
    state.account.pageVisibility = payload.pageVisibility;
    state.account.libraries = state.account.libraries.map((library) => ({
      ...library,
      visibility: payload.libraryVisibility[library.id] || library.visibility
    }));
    render();
    showMessage(elements.visibilitySuccess, "Visibility settings saved.");
  } catch (error) {
    showMessage(elements.visibilityError, error.message);
  }
});

loadAccount().catch((error) => {
  if (error.message.toLowerCase().includes("sign in")) {
    window.location.replace(`/login?next=${encodeURIComponent("/account")}`);
    return;
  }

  showMessage(elements.profileError, error.message);
});
