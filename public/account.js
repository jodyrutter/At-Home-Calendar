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
  activeAdminTab: "visibility",
  // Legacy gallery-picker state kept around so any residual references don't
  // explode. The new flow is a direct upload into public/avatars/.
  avatarLibraries: [],
  avatarLibraryId: "",
  avatarPath: "",
  avatarCurrentPath: "",
  avatarFolders: [],
  avatarImages: [],
  avatarUploading: false
};

// Maximum dimension the client-side resize pass shrinks portraits down to
// before we send them to the server. 512 px is plenty for avatar circles and
// reliably keeps JPEG-0.85 output well under 1 MB.
const PORTRAIT_MAX_EDGE = 512;
const PORTRAIT_JPEG_QUALITY = 0.85;
const PORTRAIT_HARD_LIMIT_BYTES = 1_000_000; // 1 MB target

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
  avatarPreview: document.querySelector("#avatar-preview"),
  avatarPreviewFallback: document.querySelector("#avatar-preview-fallback"),
  avatarPreviewImage: document.querySelector("#avatar-preview-image"),
  avatarClear: document.querySelector("#avatar-clear"),
  avatarUpload: document.querySelector("#avatar-upload"),
  avatarFileInput: document.querySelector("#avatar-file-input"),
  avatarStatus: document.querySelector("#avatar-status"),
  avatarError: document.querySelector("#avatar-error"),
  avatarSuccess: document.querySelector("#avatar-success"),
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
  deviceSummary: document.querySelector("#device-summary"),
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

function avatarInitial() {
  const username = state.account?.user?.username || "h";
  return username.charAt(0).toUpperCase() || "H";
}

function activeAvatarLibrary() {
  return state.avatarLibraries.find((library) => library.id === state.avatarLibraryId) || null;
}

function stagedAvatar() {
  if (!state.avatarLibraryId || !state.avatarPath) {
    return null;
  }

  const file = state.avatarImages.find((entry) => entry.path === state.avatarPath);
  if (!file) {
    return null;
  }

  return {
    kind: "image",
    thumbnailUrl: file.thumbnailUrl || file.url,
    imageUrl: file.url
  };
}

function renderAvatarPreview(avatar = null) {
  const selected = avatar || state.account?.user?.avatar || null;
  elements.avatarPreviewFallback.textContent = avatarInitial();

  if (selected?.kind === "image" && (selected.thumbnailUrl || selected.imageUrl)) {
    elements.avatarPreviewImage.hidden = false;
    // Add a cache-buster so freshly uploaded images show immediately
    const url = selected.thumbnailUrl || selected.imageUrl;
    elements.avatarPreviewImage.src = selected.updatedAt
      ? `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(selected.updatedAt)}`
      : url;
    elements.avatarPreviewFallback.hidden = true;
    return;
  }

  elements.avatarPreviewImage.hidden = true;
  elements.avatarPreviewImage.removeAttribute("src");
  elements.avatarPreviewFallback.hidden = false;
}

// Client-side resize to keep portrait uploads small. We read the file into an
// Image, draw it to a canvas downscaled to PORTRAIT_MAX_EDGE on the long side,
// then export as JPEG. Browser canvas is plenty for this — no server-side
// image library needed. Returns a { blob, width, height, bytes } record.
async function resizePortrait(file) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("Pick an image file.");
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This image could not be decoded."));
    image.src = dataUrl;
  });

  const { naturalWidth: sw, naturalHeight: sh } = img;
  if (!sw || !sh) {
    throw new Error("This image has no pixels to crop.");
  }

  // Center-crop to a square before resizing — cleaner for avatars.
  const side = Math.min(sw, sh);
  const sx = Math.floor((sw - side) / 2);
  const sy = Math.floor((sh - side) / 2);

  const edge = Math.min(PORTRAIT_MAX_EDGE, side);
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, side, side, 0, 0, edge, edge);

  // Loop quality down if somehow we exceed the hard limit.
  let quality = PORTRAIT_JPEG_QUALITY;
  let blob = await canvasToBlob(canvas, "image/jpeg", quality);
  while (blob && blob.size > PORTRAIT_HARD_LIMIT_BYTES && quality > 0.4) {
    quality -= 0.1;
    blob = await canvasToBlob(canvas, "image/jpeg", quality);
  }
  if (!blob) {
    throw new Error("Could not encode the image.");
  }

  return { blob, width: edge, height: edge, bytes: blob.size };
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

function formatByteCount(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function handleAvatarFileChosen(file) {
  if (state.avatarUploading) {
    return;
  }
  if (!file) {
    return;
  }

  clearMessage(elements.avatarError);
  clearMessage(elements.avatarSuccess);
  state.avatarUploading = true;
  elements.avatarUpload.disabled = true;
  elements.avatarClear.disabled = true;
  elements.avatarPreview?.classList.add("is-uploading");

  try {
    if (elements.avatarStatus) {
      elements.avatarStatus.hidden = false;
      elements.avatarStatus.textContent = "Resizing image...";
    }

    const { blob, width, height, bytes } = await resizePortrait(file);

    // Optimistic preview: show the just-resized image before the upload lands.
    const previewUrl = URL.createObjectURL(blob);
    renderAvatarPreview({ kind: "image", imageUrl: previewUrl, thumbnailUrl: previewUrl });

    if (elements.avatarStatus) {
      elements.avatarStatus.textContent = `Uploading ${width}x${height} • ${formatByteCount(bytes)}...`;
    }

    const response = await fetch("/api/account/avatar", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Upload failed.");
    }

    // Server has saved the file; refresh our account state so preview and nav
    // avatar come from the server URL (so it persists across reloads).
    URL.revokeObjectURL(previewUrl);
    state.account = { ...state.account, user: payload.user };
    renderAvatarPreview(payload.user.avatar || null);
    showMessage(elements.avatarSuccess, `Portrait saved (${formatByteCount(bytes)}).`);
    if (elements.avatarStatus) {
      elements.avatarStatus.hidden = true;
      elements.avatarStatus.textContent = "";
    }
  } catch (error) {
    showMessage(elements.avatarError, error.message);
    if (elements.avatarStatus) {
      elements.avatarStatus.hidden = true;
      elements.avatarStatus.textContent = "";
    }
    renderAvatarPreview(state.account?.user?.avatar || null);
  } finally {
    state.avatarUploading = false;
    elements.avatarUpload.disabled = false;
    elements.avatarClear.disabled = false;
    elements.avatarPreview?.classList.remove("is-uploading");
    if (elements.avatarFileInput) {
      elements.avatarFileInput.value = "";
    }
  }
}

async function clearAvatar() {
  if (state.avatarUploading) {
    return;
  }
  clearMessage(elements.avatarError);
  clearMessage(elements.avatarSuccess);
  try {
    const payload = await api("/api/account/avatar", { method: "DELETE" });
    state.account = { ...state.account, user: payload.user };
    renderAvatarPreview(payload.user.avatar || null);
    showMessage(elements.avatarSuccess, "Portrait reset to your initial.");
  } catch (error) {
    showMessage(elements.avatarError, error.message);
  }
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

function renderDeviceSummary(summary) {
  if (!elements.deviceSummary) {
    return;
  }

  const payload = summary || {
    totalKnownIps: 0,
    totalIdentityClusters: 0,
    totalAuthenticatedRequests: 0,
    totalAnonymousRequests: 0,
    likelyPeople: 0
  };

  elements.deviceSummary.innerHTML = `
    <div class="summary-card">
      <strong>${payload.totalKnownIps}</strong>
      <span>Unique IPs</span>
    </div>
    <div class="summary-card">
      <strong>${payload.totalIdentityClusters}</strong>
      <span>Likely device clusters</span>
    </div>
    <div class="summary-card">
      <strong>${payload.likelyPeople}</strong>
      <span>Known signed-in people</span>
    </div>
    <div class="summary-card">
      <strong>${payload.totalAnonymousRequests}</strong>
      <span>Anonymous requests</span>
    </div>
  `;
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

  devices.forEach((group, index) => {
    const wrapper = document.createElement("details");
    wrapper.className = "device-group";
    if (index < 3 || group.anonymousRequests > 0) {
      wrapper.open = true;
    }

    const summary = document.createElement("summary");
    summary.className = `device-group-header ${group.anonymousRequests > 0 ? "has-anonymous" : ""}`;
    summary.innerHTML = `
      <div>
        <h3>${group.ip}</h3>
        <p class="device-card-meta">${group.identityCount} likely device cluster${group.identityCount === 1 ? "" : "s"} | ${group.authenticatedRequests} authenticated request${group.authenticatedRequests === 1 ? "" : "s"} | ${group.anonymousRequests} anonymous request${group.anonymousRequests === 1 ? "" : "s"}</p>
        <p class="device-card-meta">${group.usernames?.length ? `People seen here: ${group.usernames.join(", ")}` : "No signed-in people seen from this IP yet"}</p>
      </div>
      <span class="device-group-badge ${group.anonymousRequests > 0 ? "is-warn" : ""}">${group.anonymousRequests > 0 ? "Anonymous activity seen" : "Known activity only"}</span>
    `;
    wrapper.append(summary);

    const detailMeta = document.createElement("p");
    detailMeta.className = "device-card-meta";
    detailMeta.textContent = `First seen ${formatTimestamp(group.firstSeenAt)} | Last seen ${formatTimestamp(group.lastSeenAt)}${group.hostnames?.length ? ` | Hosts: ${group.hostnames.join(", ")}` : ""}`;
    wrapper.append(detailMeta);

    const list = document.createElement("div");
    list.className = "device-group-list";

    (group.identities || []).forEach((identity) => {
      const card = document.createElement("article");
      card.className = `device-card${identity.anonymousRequests > 0 ? " has-anonymous" : ""}`;
      card.innerHTML = `
        <div class="device-card-topline">
          <h3>${identity.label || "Unknown device"}</h3>
          <span class="device-card-ip">${identity.host || "Unknown host"}</span>
        </div>
        <p class="device-card-meta">${identity.distinctDeviceCount} stored device id${identity.distinctDeviceCount === 1 ? "" : "s"} | ${identity.requestCount} request${identity.requestCount === 1 ? "" : "s"}</p>
        <p class="device-card-meta">${identity.usernames?.length ? `Signed in as ${identity.usernames.join(", ")}` : "Never authenticated"}</p>
        <p class="device-card-meta">First seen ${formatTimestamp(identity.firstSeenAt)} | Last seen ${formatTimestamp(identity.lastSeenAt)}</p>
        <p class="device-card-agent">${identity.userAgent || "Unknown user agent"}</p>
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
  renderAvatarPreview(user.avatar || null);
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
    renderDeviceSummary(state.account.deviceSummary);
    renderDeviceList(devices);
    renderAdminTabs();
  }
}

async function loadAccount() {
  state.account = await api("/api/account");
  render();
  renderAvatarPreview(state.account?.user?.avatar || null);
  window.dispatchEvent(new Event("hearthboard:nav-refresh"));
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
    window.dispatchEvent(new Event("hearthboard:nav-refresh"));
    showMessage(elements.profileSuccess, "Profile updated.");
  } catch (error) {
    showMessage(elements.profileError, error.message);
  }
});

elements.avatarUpload?.addEventListener("click", () => {
  elements.avatarFileInput?.click();
});

elements.avatarFileInput?.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) {
    await handleAvatarFileChosen(file);
    window.dispatchEvent(new Event("hearthboard:nav-refresh"));
  }
});

elements.avatarClear?.addEventListener("click", async () => {
  await clearAvatar();
  window.dispatchEvent(new Event("hearthboard:nav-refresh"));
});

// Drag-and-drop onto the preview also triggers the upload.
if (elements.avatarPreview) {
  elements.avatarPreview.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.avatarPreview.classList.add("is-drop-target");
  });
  elements.avatarPreview.addEventListener("dragleave", () => {
    elements.avatarPreview.classList.remove("is-drop-target");
  });
  elements.avatarPreview.addEventListener("drop", async (event) => {
    event.preventDefault();
    elements.avatarPreview.classList.remove("is-drop-target");
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      await handleAvatarFileChosen(file);
      window.dispatchEvent(new Event("hearthboard:nav-refresh"));
    }
  });
}

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
