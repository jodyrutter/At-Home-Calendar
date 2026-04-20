// Shared helpers that every Hearthboard front-end module can import. Keep
// this file small and dependency-free so it loads once and the browser can
// cache it aggressively.

const HTML_ESCAPE_TABLE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "/": "&#47;"
};

const HTML_ESCAPE_REGEX = /[&<>"'`/]/g;

/**
 * Escape an arbitrary value for safe interpolation into HTML. This is the
 * workhorse we use anywhere a user-controlled string flows into a template
 * literal that becomes innerHTML. Always prefer textContent when the
 * surrounding element is purely text; reach for this when you genuinely
 * need to build up HTML by template literal.
 *
 * null/undefined render as an empty string so templates don't show the
 * literal word "undefined" when a field is missing.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).replace(HTML_ESCAPE_REGEX, (ch) => HTML_ESCAPE_TABLE[ch]);
}

/**
 * Escape a value for use inside an HTML attribute that's wrapped in double
 * quotes. Identical to escapeHtml for our character set, but the intent
 * is clearer at the call site.
 */
export function escapeAttr(value) {
  return escapeHtml(value);
}
