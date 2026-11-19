/**
 * Tests for the 30-second demo document (src/samples.js → SAMPLE_DEMO_EN).
 * The demo is the first thing a judge touches, so its promises are pinned:
 * at least 12 masked items across at least 8 entity types, zero leaks,
 * and a lossless mask → restore round-trip.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mask, restore, findLeaks, summarize } from "../src/pii-shield.js";
import { SAMPLE_DEMO_EN } from "../src/samples.js";

test("demo email masks at least 12 items across at least 8 types", () => {
  const { entities } = mask(SAMPLE_DEMO_EN);
  assert.ok(entities.length >= 12, `expected >=12 entities, got ${entities.length}`);
  const counts = summarize(entities);
  const types = Object.keys(counts);
  assert.ok(types.length >= 8, `expected >=8 types, got ${types.join(",")}`);
  for (const t of ["NAME", "EMAIL", "PHONE", "ADDRESS", "MONEY", "CREDIT_CARD", "DATE", "ID_NUMBER"]) {
    assert.ok(counts[t] >= 1, `demo must contain at least one ${t}`);
  }
});

test("demo email: nothing detected remains visible after masking", () => {
  const { maskedText, entities } = mask(SAMPLE_DEMO_EN);
  assert.deepEqual(findLeaks(maskedText, entities), []);
  for (const raw of ["Sarah Mitchell", "sarah.mitchell@example.com", "78704", "4242"]) {
    assert.ok(!maskedText.includes(raw), `masked demo text must not contain ${raw}`);
  }
});

test("demo email: mask → restore round-trip is lossless", () => {
  const { maskedText, entities } = mask(SAMPLE_DEMO_EN);
  assert.equal(restore(maskedText, entities), SAMPLE_DEMO_EN);
});
