const navRoot = document.querySelector(".site-nav");

async function api(path) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function setBellCount(button, count) {
  const badge = button?.querySelector("[data-nav-notification-count]");
  if (!badge) {
    return;
  }

  const unread = Math.max(0, Number.parseInt(String(count || "0"), 10) || 0);
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? "99+" : String(unread);
}

// Same as setBellCount but for the chat bubble; kept separate so the
// selectors are self-documenting if we ever diverge their behaviors.
function setMessagesCount(button, count) {
  const badge = button?.querySelector("[data-nav-messages-count]");
  if (!badge) {
    return;
  }
  const unread = Math.max(0, Number.parseInt(String(count || "0"), 10) || 0);
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? "99+" : String(unread);
}

function applyAvatar(button, avatar, username = "") {
  if (!button) {
    return;
  }

  const fallback = button.querySelector("[data-nav-avatar-fallback]");
  const image = button.querySelector("[data-nav-avatar-image]");
  const initial = avatar?.initial || String(username || "H").charAt(0).toUpperCase() || "H";

  if (fallback) {
    fallback.textContent = initial;
    fallback.hidden = avatar?.kind === "image";
  }

  if (image) {
    if (avatar?.kind === "image" && avatar.thumbnailUrl) {
      image.hidden = false;
      image.src = avatar.thumbnailUrl;
    } else {
      image.hidden = true;
      image.removeAttribute("src");
    }
  }
}

async function loadNav() {
  if (!navRoot) {
    return;
  }

  const bell = navRoot.querySelector("[data-nav-bell]");
  const messages = navRoot.querySelector("[data-nav-messages]");
  const avatar = navRoot.querySelector("[data-nav-avatar]");
  const login = navRoot.querySelector("[data-nav-login]");
  const activePage = navRoot.dataset.activePage || "";

  try {
    const payload = await api("/api/nav");
    const authenticated = Boolean(payload.authenticated);
    const user = payload.user || null;

    if (bell) {
      bell.hidden = !authenticated;
      bell.classList.toggle("is-active", activePage === "notifications");
      setBellCount(bell, payload.unreadNotifications || 0);
    }

    if (messages) {
      messages.hidden = !authenticated;
      messages.classList.toggle("is-active", activePage === "messages");
      setMessagesCount(messages, payload.unreadMessages || 0);
    }

    if (avatar) {
      avatar.hidden = !authenticated;
      avatar.classList.toggle("is-active", activePage === "account");
      applyAvatar(avatar, user?.avatar, user?.username);
    }

    if (login) {
      login.hidden = authenticated;
    }
  } catch {
    if (bell) {
      bell.hidden = true;
    }
    if (messages) {
      messages.hidden = true;
    }
    if (avatar) {
      avatar.hidden = true;
    }
    if (login) {
      login.hidden = false;
    }
  }
}

window.addEventListener("hearthboard:nav-refresh", () => {
  loadNav().catch(() => {});
});

loadNav().catch(() => {});
