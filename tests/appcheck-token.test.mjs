/**
 * Unit tests for the App Check debug-token intake (src/appcheck-token.js).
 * The token values used here are dummies — never real tokens.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPlausibleDebugToken,
  parseActParam,
  resolveDebugToken,
  removeActParam,
  APPCHECK_DEBUG_TOKEN_KEY,
} from "../src/appcheck-token.js";

const DUMMY = "11111111-2222-3333-4444-555555555555";

test("plausibility check accepts opaque tokens, rejects junk", () => {
  assert.equal(isPlausibleDebugToken(DUMMY), true);
  assert.equal(isPlausibleDebugToken("short"), false);
  assert.equal(isPlausibleDebugToken("has spaces in it........"), false);
  assert.equal(isPlausibleDebugToken(""), false);
  assert.equal(isPlausibleDebugToken(null), false);
  assert.equal(isPlausibleDebugToken(undefined), false);
  assert.equal(isPlausibleDebugToken("x".repeat(513)), false);
});

test("parseActParam extracts act and ignores other params", () => {
  assert.equal(parseActParam(`?act=${DUMMY}&foo=bar`), DUMMY);
  assert.equal(parseActParam(`?foo=bar&act=${DUMMY}`), DUMMY);
  assert.equal(parseActParam("?foo=bar"), null);
  assert.equal(parseActParam(""), null);
  assert.equal(parseActParam(null), null);
  assert.equal(parseActParam("?act=1"), null); // too short — not a token
});

test("resolveDebugToken: query wins over stored, stored is the fallback", () => {
  assert.deepEqual(resolveDebugToken({ search: `?act=${DUMMY}`, stored: "stored-token-value" }), {
    token: DUMMY,
    source: "query",
  });
  assert.deepEqual(resolveDebugToken({ search: "", stored: "stored-token-value" }), {
    token: "stored-token-value",
    source: "session",
  });
  assert.deepEqual(resolveDebugToken({ search: "?act=nope", stored: "bad" }), {
    token: null,
    source: null,
  });
  assert.deepEqual(resolveDebugToken({}), { token: null, source: null });
});

test("removeActParam strips only act and preserves the rest of the URL", () => {
  const cleaned = removeActParam(`https://example.com/app/?act=${DUMMY}&lang=en#top`);
  assert.ok(!cleaned.includes("act="));
  assert.ok(cleaned.includes("lang=en"));
  assert.ok(cleaned.includes("#top"));
  assert.equal(removeActParam("https://example.com/app/"), "https://example.com/app/");
  assert.equal(removeActParam("not a url"), "not a url");
});

test("storage key is stable and namespaced", () => {
  assert.equal(APPCHECK_DEBUG_TOKEN_KEY, "safedraft.appcheck.debugToken");
});
