// Runs synchronously in <head> before the stylesheet paints so the body
// never flashes a light background for a dark-mode visitor. Loaded as an
// external script (instead of inline) so our CSP can drop 'unsafe-inline'
// from script-src without introducing per-request nonces.
(() => {
  try {
    const savedTheme = localStorage.getItem("hearthboard-theme");
    const preferredDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = savedTheme || (preferredDark ? "dark" : "light");
  } catch {
    // localStorage can throw in sandboxed/private contexts. In that case we
    // just fall through to whatever the stylesheet defaults to.
  }
})();
