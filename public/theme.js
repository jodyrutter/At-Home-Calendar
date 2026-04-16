const THEME_STORAGE_KEY = "hearthboard-theme";
const DARK_THEME_COLOR = "#0f1726";
const LIGHT_THEME_COLOR = "#dd6b20";

function preferredTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedTheme === "light" || savedTheme === "dark") {
    return savedTheme;
  }

  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute("content", theme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }

  document.querySelectorAll("[data-theme-toggle]").forEach((toggle) => {
    toggle.checked = theme === "dark";
  });
}

function bindThemeToggles() {
  document.querySelectorAll("[data-theme-toggle]").forEach((toggle) => {
    toggle.addEventListener("change", () => {
      applyTheme(toggle.checked ? "dark" : "light");
    });
  });
}

applyTheme(preferredTheme());
bindThemeToggles();
