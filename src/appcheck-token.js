/**
 * SafeDraft — App Check debug token intake.
 *
 * Pure, dependency-free helpers (shared by firebase-ai.js and the Node
 * test suite) that decide which App Check debug token to use:
 *
 *   1. A token passed once via the URL query `?act=<token>` — handy for
 *      judges and for testing on a second device. The token is moved into
 *      sessionStorage (tab-scoped, gone when the tab closes) and scrubbed
 *      from the address bar by the caller.
 *   2. A token already stored in sessionStorage by an earlier `?act=` visit.
 *   3. Nothing — the caller then falls back to the localhost auto-debug
 *      provider (token printed to the console).
 *
 * The token VALUE is a credential-like string: it is never hardcoded, never
 * logged, and never written to the repository. Only these shape checks live
 * here.
 */

/** sessionStorage key for the tab-scoped debug token. */
export const APPCHECK_DEBUG_TOKEN_KEY = "safedraft.appcheck.debugToken";

/**
 * Shape check only: debug tokens are long opaque strings. Reject anything
 * short, huge, or containing whitespace so a stray query value (e.g.
 * `?act=1`) can never be mistaken for a token.
 */
export function isPlausibleDebugToken(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 512 &&
    !/\s/.test(value)
  );
}

/** Extract a plausible `act` token from a query string, or null. */
export function parseActParam(search) {
  if (!search) return null;
  try {
    const token = new URLSearchParams(search).get("act");
    return isPlausibleDebugToken(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Decide the debug token to use.
 *
 * @param {object} opts
 * @param {string} [opts.search]  location.search (may contain ?act=…)
 * @param {string|null} [opts.stored] value previously kept in sessionStorage
 * @returns {{ token: string|null, source: "query"|"session"|null }}
 */
export function resolveDebugToken({ search = "", stored = null } = {}) {
  const fromQuery = parseActParam(search);
  if (fromQuery) return { token: fromQuery, source: "query" };
  if (isPlausibleDebugToken(stored)) return { token: stored, source: "session" };
  return { token: null, source: null };
}

/**
 * Return the URL with the `act` parameter removed (all other parameters
 * preserved), so the token does not linger in the address bar or history.
 */
export function removeActParam(href) {
  try {
    const url = new URL(href);
    url.searchParams.delete("act");
    return url.toString();
  } catch {
    return href;
  }
}
