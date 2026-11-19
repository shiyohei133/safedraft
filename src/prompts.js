/**
 * SafeDraft — generation prompt construction.
 *
 * Pure, dependency-free module (shared by the UI and the Node test suite).
 * It turns the user's choices — task (rewrite / summarize), style, summary
 * length, number of variants — plus the MASKED text into one structured
 * prompt for Firebase AI Logic.
 *
 * The placeholder rules are the heart of SafeDraft: the model only ever
 * sees tokens like [NAME_1] or [EMAIL_2], and it must return them
 * byte-for-byte so the browser can restore the originals locally. The
 * rules are therefore stated first, absolutely, and repeated in the task
 * section.
 */

/** Rules the model must follow for placeholder tokens. Never weaken these. */
export const PLACEHOLDER_RULES = [
  "ABSOLUTE RULES — PLACEHOLDER TOKENS:",
  "The text contains placeholder tokens in square brackets, such as [NAME_1],",
  "[EMAIL_2], [MONEY_1], [PHONE_1] or [ADDRESS_1]. Each token stands for a real",
  "name, address, amount or other private value that you must never try to guess.",
  "- Copy every placeholder EXACTLY as written: same letters, same number, same",
  "  square brackets, no added spaces.",
  "- Never translate, reformat, renumber, merge, drop or invent placeholders.",
  "- Keep each placeholder in a grammatically natural position in your output,",
  "  the way the original value would appear.",
  "- Output ONLY the finished text: no explanations, no preamble, no quotes,",
  "  no markdown code fences.",
].join("\n");

/** Writing styles for the rewrite task (keys match the UI select). */
export const REWRITE_STYLES = Object.freeze({
  polite:
    "Style: polite, professional business writing. Courteous, clear, and " +
    "ready to send to a client or a supervisor.",
  casual:
    "Style: friendly and casual, like a message to a trusted colleague. " +
    "Warm and natural, but still clear and correct.",
  concise:
    "Style: concise and direct. Cut filler and redundancy, keep every fact, " +
    "and make each sentence carry information.",
});

/** Target lengths for the summarize task (keys match the UI select). */
export const SUMMARY_LENGTHS = Object.freeze({
  brief:
    "Length: a brief summary, about 25% of the original length. Keep only " +
    "the decisions, requests and deadlines.",
  standard:
    "Length: a standard summary, about 50% of the original length. Keep the " +
    "main points, key facts and any requested actions.",
  oneline:
    "Length: exactly one sentence that captures the single most important " +
    "point of the text.",
});

export const TASKS = Object.freeze({ REWRITE: "rewrite", SUMMARIZE: "summarize" });

/** Header line that starts each variant in multi-variant output. */
export const variantHeader = (k) => `### Version ${k}`;

/**
 * Build the full generation prompt.
 *
 * @param {object} opts
 * @param {"rewrite"|"summarize"} opts.task
 * @param {string} [opts.style]        key of REWRITE_STYLES (rewrite task)
 * @param {string} [opts.summaryLength] key of SUMMARY_LENGTHS (summarize task)
 * @param {number} [opts.variantCount] 1–3; >1 asks for headered variants
 * @param {string} opts.maskedText     the masked document (never the original)
 * @returns {string} the prompt to send to the model
 */
export function buildGenerationPrompt({
  task,
  style = "polite",
  summaryLength = "standard",
  variantCount = 1,
  maskedText,
}) {
  const lines = [
    "You are an expert writing assistant working on PRIVACY-MASKED text.",
    "",
    PLACEHOLDER_RULES,
    "",
  ];

  if (task === TASKS.SUMMARIZE) {
    lines.push(
      "TASK: Summarize the text below. Preserve every fact that matters — " +
        "who, what, how much, and by when — and keep every placeholder token " +
        "that carries one of those facts.",
      SUMMARY_LENGTHS[summaryLength] ?? SUMMARY_LENGTHS.standard,
    );
  } else {
    lines.push(
      "TASK: Rewrite the text below so it reads better, fixing awkward " +
        "phrasing and structure while preserving every fact and every request " +
        "in it. Do not add facts that are not in the original.",
      REWRITE_STYLES[style] ?? REWRITE_STYLES.polite,
    );
  }

  const n = Math.min(3, Math.max(1, Math.floor(variantCount) || 1));
  if (n > 1) {
    lines.push(
      "",
      `VARIANTS: Produce exactly ${n} different versions of the result. ` +
        `Begin each version with a header line in exactly this format: ` +
        `"${variantHeader(1)}", "${variantHeader(2)}"` +
        (n === 3 ? `, "${variantHeader(3)}"` : "") +
        `. Vary the phrasing and structure between versions; the facts and ` +
        `placeholder tokens must be identical in every version.`,
    );
  }

  lines.push("", "TEXT:", maskedText);
  return lines.join("\n");
}

const VARIANT_HEADER_RE = /^#{2,4}\s*Version\s+(\d+)\s*[:.]?\s*$/;

/**
 * Split a multi-variant model response into individual variants.
 *
 * Primary format: header lines ("### Version 1", …). If no headers are
 * found (the model ignored the instruction, or a single variant was
 * requested), the whole response is returned as one variant — the audit
 * pipeline downstream will flag any placeholder problems either way.
 *
 * @param {string} rawText
 * @param {number} [expectedCount] cap on the number of variants returned
 * @returns {string[]} trimmed, non-empty variants in order
 */
export function splitVariants(rawText, expectedCount = 3) {
  const text = String(rawText ?? "").replace(/\r\n/g, "\n");
  const cap = Math.min(3, Math.max(1, Math.floor(expectedCount) || 1));

  // Segment the response: one leading headerless segment (preamble or the
  // whole single-variant answer) plus one segment per Version header.
  const segments = [{ header: false, lines: [] }];
  for (const line of text.split("\n")) {
    if (VARIANT_HEADER_RE.test(line.trim())) {
      segments.push({ header: true, lines: [] });
    } else {
      segments[segments.length - 1].lines.push(line);
    }
  }
  const headerSegs = segments.filter((s) => s.header);
  let variants;
  if (headerSegs.length === 0) {
    variants = [segments[0].lines.join("\n")];
  } else {
    // A stray preamble ("Here you go:") is merged into the first variant
    // rather than silently discarded — SafeDraft never drops model output
    // without telling the user.
    const preamble = segments[0].lines.join("\n").trim();
    variants = headerSegs.map((s, i) => {
      const body = s.lines.join("\n");
      return i === 0 && preamble ? `${preamble}\n${body}` : body;
    });
  }
  const cleaned = variants.map((p) => p.trim()).filter((p) => p.length > 0);
  if (cleaned.length === 0) return text.trim() ? [text.trim()] : [];
  return cleaned.slice(0, cap);
}
