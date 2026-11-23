/**
 * SafeDraft — UI wiring.
 *
 * Flow: user text → PII Shield (mask, local & deterministic) → Firebase AI
 * Logic hybrid generation on the MASKED text → placeholders restored
 * locally → final text. The original text and the placeholder mapping
 * never leave the browser.
 */
import {
  mask,
  restore,
  summarize,
  findLeaks,
  repairPlaceholders,
  analyzeAiOutput,
} from "./pii-shield.js";
import { initFirebaseAI, generateWithRoute, chooseRoute } from "./firebase-ai.js";
import { buildGenerationPrompt, splitVariants } from "./prompts.js";
import { SAMPLE_JA, SAMPLE_EN, SAMPLE_DEMO_EN } from "./samples.js";

const $ = (id) => document.getElementById(id);

const els = {
  input: $("input"),
  charCount: $("char-count"),
  routeHint: $("route-hint"),
  shieldPreview: $("shield-preview"),
  entityList: $("entity-list"),
  shieldSummary: $("shield-summary"),
  result: $("result"),
  routeBadge: $("route-badge"),
  status: $("status"),
  log: $("log"),
  btnSampleJa: $("btn-sample-ja"),
  btnSampleEn: $("btn-sample-en"),
  btnShield: $("btn-shield"),
  btnRestoreDemo: $("btn-restore-demo"),
  btnAi: $("btn-ai"),
  btnDemo: $("btn-demo"),
  optStyle: $("opt-style"),
  optLength: $("opt-length"),
  optVariants: $("opt-variants"),
  variants: $("variants"),
  demoSteps: [1, 2, 3, 4].map((n) => $(`demo-step-${n}`)),
};

let lastMask = null; // { maskedText, entities, maskedSpans }
let lastShieldMs = null; // wall-clock time of the last mask() run
let demoActive = false;

function logEvent(message) {
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString();
  li.textContent = `${time} — ${message}`;
  els.log.prepend(li);
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

/** "1 item" / "2 items" — keeps user-facing counts grammatical. */
function plural(n, one, many) {
  return n === 1 ? one : many;
}

/** Translate raw SDK errors into something a first-time user can act on. */
function friendlyError(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/app-?check/i.test(msg)) {
    return (
      "The request was blocked by App Check. If you are running this locally, " +
      "register the App Check debug token once (see README → “App Check debug token”)."
    );
  }
  if (/fetch|network|offline|failed to fetch/i.test(msg)) {
    return "Network error — the cloud model could not be reached. Check your connection and try again.";
  }
  if (/quota|resource-exhausted/i.test(msg)) {
    return "The free quota for the cloud model is exhausted right now. Please try again later.";
  }
  return "AI generation failed. Technical details were written to the browser console.";
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render the masked text with each placeholder highlighted by type. */
function renderShieldPreview() {
  if (!lastMask) {
    els.shieldPreview.innerHTML = '<span class="muted">Masked text will appear here.</span>';
    els.entityList.innerHTML = "";
    els.shieldSummary.textContent = "";
    return;
  }
  const { maskedText, maskedSpans, entities } = lastMask;
  let html = "";
  let pos = 0;
  for (const span of maskedSpans) {
    html += escapeHtml(maskedText.slice(pos, span.start));
    html += `<mark class="ent ent-${span.type}" title="${span.type}">${escapeHtml(span.placeholder)}</mark>`;
    pos = span.end;
  }
  html += escapeHtml(maskedText.slice(pos));
  els.shieldPreview.innerHTML = html || '<span class="muted">(empty)</span>';

  // Entity chips show type + placeholder only — never the original value.
  els.entityList.innerHTML = entities
    .map(
      (e) =>
        `<li><span class="chip chip-${e.type}">${e.type}</span> <code>${escapeHtml(e.placeholder)}</code></li>`,
    )
    .join("");

  const counts = summarize(entities);
  const parts = Object.entries(counts).map(([t, n]) => `${t} × ${n}`);
  const timing =
    lastShieldMs !== null ? ` in ${Math.max(1, Math.round(lastShieldMs))} ms` : "";
  els.shieldSummary.textContent = entities.length
    ? `Shield applied${timing}: ${entities.length} ${plural(entities.length, "item", "items")} masked (${parts.join(", ")}) — 0 items left your device.`
    : "Shield applied: no personal data detected.";
}

function runShield({ log = true } = {}) {
  const text = els.input.value;
  const t0 = performance.now();
  lastMask = mask(text);
  lastShieldMs = performance.now() - t0;
  renderShieldPreview();
  const leaks = findLeaks(lastMask.maskedText, lastMask.entities);
  if (leaks.length > 0) {
    setStatus(`Warning: ${leaks.length} detected value(s) still visible in masked text.`, true);
  }
  if (log) {
    logEvent(
      `Shield: ${lastMask.entities.length} ${plural(lastMask.entities.length, "item", "items")} masked. ` +
        `Route preview: ${chooseRoute(lastMask.maskedText) === "cloud" ? "Cloud (long text)" : "On-device preferred"}.`,
    );
  }
  if (demoActive) {
    setDemoStep(2, "done");
    setDemoStep(3, "active");
  }
  updateMeta();
  return lastMask;
}

/* ------------------------------------------------------------------ */
/* 30-second demo flow                                                  */
/* ------------------------------------------------------------------ */

function setDemoStep(n, state) {
  const el = els.demoSteps[n - 1];
  if (!el) return;
  el.classList.remove("active", "done");
  el.removeAttribute("aria-current");
  el.querySelector(".step-state")?.remove();
  if (state === "active") el.setAttribute("aria-current", "step");
  if (state === "done") {
    // Screen readers get the completion state; sighted users see the color.
    const marker = document.createElement("span");
    marker.className = "visually-hidden step-state";
    marker.textContent = " (completed)";
    el.append(marker);
  }
  if (state) el.classList.add(state);
}

function resetDemoSteps() {
  demoActive = false;
  for (let n = 1; n <= 4; n++) setDemoStep(n, null);
}

/** One click: load the demo email, mask it, and point at the AI button. */
function startDemo() {
  demoActive = true;
  els.input.value = SAMPLE_DEMO_EN;
  setDemoStep(1, "done");
  setDemoStep(2, "active");
  runShield();
  setStatus(
    "Demo loaded: 13 personal items were masked locally. Now press “Generate with AI” — " +
      "the model receives only the placeholders you see in panel 2.",
  );
  els.btnAi.focus();
}

/** Live masking while typing (debounced, silent — no log spam). */
let liveTimer = null;
function scheduleLiveShield() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => runShield({ log: false }), 250);
}

function updateMeta() {
  const len = els.input.value.length;
  els.charCount.textContent = `${len} characters`;
  // Route decisions are made on the MASKED text (what is actually sent),
  // matching generateWithRoute's route basis.
  const route = chooseRoute(lastMask?.maskedText ?? els.input.value);
  els.routeHint.textContent =
    len === 0
      ? ""
      : route === "cloud"
        ? "Long document — will be routed to the cloud model (still masked)."
        : "Short text — the on-device model will be tried first.";
}

/** Local round-trip demo: mask → restore, no AI involved. */
function runRestoreDemo() {
  const { maskedText, entities } = runShield();
  const restored = restore(maskedText, entities);
  els.result.textContent = restored;
  els.routeBadge.textContent = "Local demo (no AI)";
  els.routeBadge.className = "badge badge-local";
  const ok = restored === els.input.value;
  setStatus(
    ok
      ? "Round-trip OK: restoring the placeholders reproduces the original text exactly."
      : "Round-trip mismatch — please report this.",
    !ok,
  );
  logEvent("Local restore demo executed.");
}

/* ------------------------------------------------------------------ */
/* AI generation: structured prompt → variants → per-variant audit      */
/* ------------------------------------------------------------------ */

function currentTask() {
  return document.querySelector('input[name="task"]:checked')?.value ?? "rewrite";
}

/**
 * Run one raw model output through the accident pipeline: repair near-miss
 * placeholders ([email_1], ［EMAIL_1］, brackets dropped…), audit what is
 * still missing / duplicated / unknown, then restore originals locally.
 */
function auditVariant(rawText, entities) {
  const { text: repairedText, repaired } = repairPlaceholders(rawText, entities);
  const { missing, unknown, duplicated } = analyzeAiOutput(repairedText, entities);
  return {
    restored: restore(repairedText, entities),
    repaired,
    missing,
    unknown,
    duplicated,
  };
}

let lastVariants = []; // auditVariant() results, in display order
let lastRoute = null;
let selectedVariant = -1;

function variantTags(v) {
  const tags = [];
  if (lastRoute === "On-device") tags.push('<span class="tag tag-device"><span aria-hidden="true">⚡</span> On-device</span>');
  else if (lastRoute === "Cloud") tags.push('<span class="tag tag-cloud"><span aria-hidden="true">☁</span> Cloud</span>');
  const problems = v.missing.length + v.unknown.length;
  if (problems > 0) {
    tags.push(
      `<span class="tag tag-warn">⚠ ${v.missing.length} lost · ${v.unknown.length} unknown ${plural(v.unknown.length, "placeholder", "placeholders")}</span>`,
    );
  } else if (v.repaired.length > 0) {
    tags.push(
      `<span class="tag tag-repaired">${v.repaired.length} ${plural(v.repaired.length, "placeholder", "placeholders")} auto-repaired</span>`,
    );
  } else {
    tags.push('<span class="tag tag-ok">✓ All data restored</span>');
  }
  if (v.duplicated.length > 0) {
    tags.push('<span class="tag">placeholder reused by model</span>');
  }
  return tags.join(" ");
}

function renderVariants() {
  els.variants.innerHTML = "";
  lastVariants.forEach((v, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "variant-card" + (i === selectedVariant ? " selected" : "");
    card.setAttribute("aria-pressed", i === selectedVariant ? "true" : "false");
    card.innerHTML =
      `<span class="variant-head"><span class="variant-title">Version ${i + 1}</span> ${variantTags(v)}</span>` +
      `<span class="variant-text">${escapeHtml(v.restored)}</span>`;
    card.addEventListener("click", () => selectVariant(i));
    els.variants.append(card);
  });
}

function selectVariant(i) {
  if (i < 0 || i >= lastVariants.length) return;
  selectedVariant = i;
  els.result.textContent = lastVariants[i].restored;
  renderVariants();
}

async function runAiGenerate() {
  const { maskedText, entities } = runShield();
  if (!maskedText.trim()) {
    setStatus("Please enter some text first.", true);
    return;
  }
  const task = currentTask();
  const variantCount = Number(els.optVariants.value) || 1;
  const prompt = buildGenerationPrompt({
    task,
    style: els.optStyle.value,
    summaryLength: els.optLength.value,
    variantCount,
    maskedText,
  });
  els.btnAi.disabled = true;
  if (demoActive) setDemoStep(3, "active");
  setStatus("Generating with Firebase AI Logic (masked text only)…");
  try {
    const { text, route } = await generateWithRoute(prompt, maskedText);
    lastRoute = route;
    const rawVariants = splitVariants(text, variantCount);
    lastVariants = rawVariants.map((v) => auditVariant(v, entities));
    selectedVariant = -1;
    if (lastVariants.length > 0) selectVariant(0);

    // Emoji is decorative; hide it from screen readers (badge text is
    // otherwise announced). innerHTML is safe here: all parts are internal.
    els.routeBadge.innerHTML =
      route === "On-device" ? '<span aria-hidden="true">⚡</span> On-device' : route === "Cloud" ? '<span aria-hidden="true">☁</span> Cloud' : `Route: ${route}`;
    els.routeBadge.className =
      "badge " + (route === "On-device" ? "badge-device" : "badge-cloud");
    logEvent(
      `AI ${task} finished: ${lastVariants.length} ${plural(lastVariants.length, "version", "versions")}. ` +
        `Inference route reported by SDK: ${route}.`,
    );
    for (const [i, v] of lastVariants.entries()) {
      if (v.repaired.length > 0) {
        logEvent(`Version ${i + 1}: repaired altered placeholder(s): ${v.repaired.join(", ")}.`);
      }
      if (v.duplicated.length > 0) {
        logEvent(
          `Version ${i + 1}: placeholder(s) used more than once by the model ` +
            `(restored at every position): ${v.duplicated.map((d) => `${d.placeholder} ×${d.count}`).join(", ")}.`,
        );
      }
      if (v.missing.length > 0) {
        logEvent(
          `Version ${i + 1}: warning — unrestorable placeholder(s): ${v.missing.map((e) => e.placeholder).join(", ")}.`,
        );
      }
      if (v.unknown.length > 0) {
        logEvent(`Version ${i + 1}: warning — unknown marker-like token(s): ${v.unknown.join(", ")}.`);
      }
    }
    const badVersions = lastVariants
      .map((v, i) => (v.missing.length + v.unknown.length > 0 ? i + 1 : null))
      .filter((x) => x !== null);
    const repairedCount = lastVariants.reduce((n, v) => n + v.repaired.length, 0);
    if (badVersions.length > 0) {
      setStatus(
        `Done, but ${badVersions.length === 1 ? `version ${badVersions[0]} has` : `versions ${badVersions.join(", ")} have`} placeholder problems — see the tags on each card.`,
        true,
      );
    } else if (repairedCount > 0) {
      setStatus(
        `Done — ${lastVariants.length} ${plural(lastVariants.length, "version", "versions")}. ${repairedCount} ${plural(repairedCount, "placeholder", "placeholders")} had been altered ` +
          `by the model and ${repairedCount === 1 ? "was" : "were"} repaired before restoring locally in your browser.`,
      );
    } else {
      setStatus(
        `Done — ${lastVariants.length} ${plural(lastVariants.length, "version", "versions")}, every placeholder restored locally in your browser. ` +
          (lastVariants.length > 1 ? "Click a version to select it." : ""),
      );
    }
    if (demoActive) {
      setDemoStep(3, "done");
      setDemoStep(4, "done");
    }
  } catch (err) {
    console.error(err);
    setStatus(friendlyError(err), true);
    logEvent("AI generation failed (see status message).");
  } finally {
    els.btnAi.disabled = false;
  }
}

function init() {
  els.btnDemo.addEventListener("click", startDemo);
  els.btnSampleJa.addEventListener("click", () => {
    resetDemoSteps();
    els.input.value = SAMPLE_JA;
    runShield();
  });
  els.btnSampleEn.addEventListener("click", () => {
    resetDemoSteps();
    els.input.value = SAMPLE_EN;
    runShield();
  });
  els.btnShield.addEventListener("click", runShield);
  els.btnRestoreDemo.addEventListener("click", runRestoreDemo);
  els.btnAi.addEventListener("click", runAiGenerate);
  for (const radio of document.querySelectorAll('input[name="task"]')) {
    radio.addEventListener("change", () => {
      const isSummarize = currentTask() === "summarize";
      els.optStyle.disabled = isSummarize;
      els.optLength.disabled = !isSummarize;
    });
  }
  els.input.addEventListener("input", () => {
    if (demoActive) resetDemoSteps();
    updateMeta();
    scheduleLiveShield();
  });
  $("btn-copy").addEventListener("click", async () => {
    const text = els.result.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Result copied to the clipboard.");
    } catch {
      setStatus("Copy failed — select the result text manually.", true);
    }
  });

  try {
    const info = initFirebaseAI();
    setStatus("Ready — paste a draft, load a sample, or start the 30-second demo.");
    const appCheckNote =
      info.appCheckDebugSource === "query"
        ? ", App Check debug token accepted from the link"
        : info.appCheckDebugSource === "session"
          ? ", App Check debug token from this tab's session"
          : info.appCheckDebug
            ? ", App Check debug mode (localhost auto-token)"
            : ", App Check on";
    logEvent(
      `Firebase initialized (project safedraft-5e55c, cloud fallback: ${info.cloudModel}${appCheckNote}).`,
    );
  } catch (err) {
    console.error(err);
    setStatus(friendlyError(err), true);
  }
  updateMeta();
}

init();
