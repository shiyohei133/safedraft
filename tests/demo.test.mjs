/**
 * Tests for the 30-second demo document (src/samples.js → SAMPLE_DEMO_EN).
 * The demo is the first thing a judge touches, so its promises are pinned:
 * exactly 13 masked items across 9 entity types (the number the UI and
 * README advertise — the count includes the sender's name twice and the
 * ZIP code), zero leaks, and a lossless mask → restore round-trip.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mask, restore, findLeaks, summarize } from "../src/pii-shield.js";
import { SAMPLE_DEMO_EN, SAMPLE_EN, SAMPLE_JA } from "../src/samples.js";

test("demo email masks exactly 13 items across 9 types", () => {
  const { entities } = mask(SAMPLE_DEMO_EN);
  assert.equal(entities.length, 13, `expected exactly 13 entities, got ${entities.length}`);
  const counts = summarize(entities);
  const types = Object.keys(counts);
  assert.equal(types.length, 9, `expected 9 types, got ${types.join(",")}`);
  for (const t of ["NAME", "EMAIL", "PHONE", "ADDRESS", "POSTAL_CODE", "MONEY", "CREDIT_CARD", "DATE", "ID_NUMBER"]) {
    assert.ok(counts[t] >= 1, `demo must contain at least one ${t}`);
  }
  assert.equal(counts.NAME, 2, "sender's name appears twice");
  assert.equal(counts.MONEY, 2, "two amounts");
  assert.equal(counts.DATE, 2, "two dates");
  assert.equal(counts.ID_NUMBER, 2, "invoice + customer numbers");
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

test("shorter samples mask exactly 10 items each (not the demo's 13)", () => {
  // The "Load sample" buttons load different, shorter documents than the
  // 13-item demo email. Pin their counts so a future edit cannot silently
  // change what the UI's "10 items masked" summary reports.
  for (const [name, sample] of [["SAMPLE_EN", SAMPLE_EN], ["SAMPLE_JA", SAMPLE_JA]]) {
    const { entities } = mask(sample);
    assert.equal(entities.length, 10, `${name}: expected exactly 10 entities, got ${entities.length}`);
  }
});
