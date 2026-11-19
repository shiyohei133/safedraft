/**
 * Unit tests for the generation prompt builder (src/prompts.js).
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGenerationPrompt,
  splitVariants,
  PLACEHOLDER_RULES,
} from "../src/prompts.js";

const MASKED = "Dear [NAME_1], your invoice [ID_NUMBER_1] of [MONEY_1] is due.";

test("prompt embeds the placeholder rules and the masked text verbatim", () => {
  const p = buildGenerationPrompt({ task: "rewrite", maskedText: MASKED });
  assert.ok(p.includes(PLACEHOLDER_RULES));
  assert.ok(p.includes("EXACTLY as written"));
  assert.ok(p.endsWith(MASKED));
  assert.ok(p.includes("PRIVACY-MASKED"));
});

test("rewrite styles produce distinct instructions", () => {
  const polite = buildGenerationPrompt({ task: "rewrite", style: "polite", maskedText: MASKED });
  const casual = buildGenerationPrompt({ task: "rewrite", style: "casual", maskedText: MASKED });
  const concise = buildGenerationPrompt({ task: "rewrite", style: "concise", maskedText: MASKED });
  assert.ok(polite.includes("polite, professional"));
  assert.ok(casual.includes("friendly and casual"));
  assert.ok(concise.includes("concise and direct"));
  assert.notEqual(polite, casual);
  assert.notEqual(casual, concise);
});

test("unknown style falls back to polite", () => {
  const p = buildGenerationPrompt({ task: "rewrite", style: "nope", maskedText: MASKED });
  assert.ok(p.includes("polite, professional"));
});

test("summarize lengths produce distinct instructions", () => {
  const brief = buildGenerationPrompt({ task: "summarize", summaryLength: "brief", maskedText: MASKED });
  const standard = buildGenerationPrompt({ task: "summarize", summaryLength: "standard", maskedText: MASKED });
  const oneline = buildGenerationPrompt({ task: "summarize", summaryLength: "oneline", maskedText: MASKED });
  assert.ok(brief.includes("25%"));
  assert.ok(standard.includes("50%"));
  assert.ok(oneline.includes("exactly one sentence"));
  assert.ok(brief.includes("Summarize"));
});

test("single variant asks for no headers; 3 variants ask for exactly 3 headered versions", () => {
  const one = buildGenerationPrompt({ task: "rewrite", variantCount: 1, maskedText: MASKED });
  assert.ok(!one.includes("### Version"));
  const three = buildGenerationPrompt({ task: "rewrite", variantCount: 3, maskedText: MASKED });
  assert.ok(three.includes("exactly 3 different versions"));
  assert.ok(three.includes('"### Version 1"'));
  assert.ok(three.includes('"### Version 3"'));
});

test("variantCount is clamped to 1..3", () => {
  const p = buildGenerationPrompt({ task: "rewrite", variantCount: 99, maskedText: MASKED });
  assert.ok(p.includes("exactly 3 different versions"));
  assert.ok(!p.includes("Version 4"));
});

test("splitVariants splits on Version headers and keeps placeholders intact", () => {
  const raw = [
    "### Version 1",
    "Dear [NAME_1], please pay [MONEY_1].",
    "### Version 2",
    "Hi [NAME_1] — [MONEY_1] is due.",
    "### Version 3",
    "[NAME_1], a reminder: [MONEY_1].",
  ].join("\n");
  const parts = splitVariants(raw, 3);
  assert.equal(parts.length, 3);
  assert.ok(parts[0].includes("[NAME_1]") && parts[0].includes("[MONEY_1]"));
  assert.ok(parts[2].startsWith("[NAME_1]"));
  assert.ok(!parts.some((p) => p.includes("###")));
});

test("splitVariants without headers returns the whole text as one variant", () => {
  const raw = "Just one rewrite of [NAME_1]'s text.";
  assert.deepEqual(splitVariants(raw, 3), [raw]);
});

test("splitVariants tolerates header variants and stray preamble", () => {
  const raw = "Here you go:\n## Version 1:\nAlpha [EMAIL_1]\n#### Version 2\nBeta [EMAIL_1]";
  const parts = splitVariants(raw, 2);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].includes("Alpha [EMAIL_1]"));
  assert.ok(parts[1].includes("Beta [EMAIL_1]"));
});

test("splitVariants caps the count and handles empty output", () => {
  const raw = "### Version 1\nA\n### Version 2\nB\n### Version 3\nC\n### Version 4\nD";
  assert.equal(splitVariants(raw, 2).length, 2);
  assert.deepEqual(splitVariants("", 3), []);
  assert.deepEqual(splitVariants("   \n ", 3), []);
});
