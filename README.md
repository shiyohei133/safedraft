# SafeDraft

**The AI never sees your original text.**

SafeDraft is a privacy-shielded AI writing assistant for the drafts you
hesitate to paste into a cloud AI: customer emails with names and order
numbers, invoices with amounts and addresses, support replies with phone
numbers. Before anything reaches a model, a **deterministic PII shield**
(rules and dictionaries — no AI) masks personal data locally in your
browser. The AI only ever receives placeholders like `[NAME_1]` or
`[EMAIL_2]`; after generation, the placeholders are restored locally.

Built for **#BuildHybridAI 2026**.

## Try it in 30 seconds

Click **“Start the demo”**. A realistic support email loads — it contains
**13 pieces of personal data** (the sender's name twice, an email, a phone
number, a home address and ZIP code, invoice and customer numbers, a card
number, two amounts, two dates). The shield masks all 13 locally, in
milliseconds. Press
**“Generate with AI”** and the model rewrites a text it could never trace
back to a real person; your values are restored in the browser at the end.
The badge on the result tells you whether the answer came from the
**on-device** model or the **cloud** — and the transparency log shows
every masking and routing decision.

## How it works

```
Your draft
   │
   ▼
PII Shield (local, deterministic — regex + dictionaries, unit-tested)
   │  masked text + a placeholder map that never leaves the tab
   ▼
Firebase AI Logic — hybrid inference
   ├─ short text → on-device first (Gemini Nano via Chrome Prompt API),
   │               cloud fallback          [InferenceMode.PREFER_ON_DEVICE]
   └─ long text  → cloud Gemini          [InferenceMode.PREFER_IN_CLOUD]
   │  every response reports its route (response.inferenceSource),
   │  shown in the UI as an ⚡ On-device / ☁ Cloud badge
   ▼
Placeholder audit & repair → restoration (local) → final text
```

### What the shield detects

Email addresses, URLs, phone numbers (JP incl. toll-free/Navi Dial,
international, US), credit-card shaped numbers (with Luhn validation),
postal codes (JP, US ZIP, UK, Canadian, German PLZ), dates (JP / ISO /
US / EU / month-name forms), money amounts (a currency marker is
required), Japanese and English names (honorific / label / dictionary
based, including old-form surname variants and halfwidth katakana),
Japanese, English and German street addresses (including building names,
room numbers, P.O. boxes and apartment/suite units), and ID numbers
(labelled IDs, order numbers, My Number style digit runs, US SSNs, and
IBANs validated with the mod-97 check). Detection runs on a
width-normalized copy of the text, so full-width IME input (`０９０-…`,
`ｔａｒｏ＠…`) and halfwidth katakana (`ﾀﾅｶ ﾀﾛｳ`) are caught as reliably
as half-width input, while restoration always reproduces your original
characters.

### Generation options

- **Rewrite** in three styles — *Polite & professional*, *Casual*,
  *Concise* — or **Summarize** at three lengths (~25%, ~50%, one line).
- **1–3 versions per generation.** Each version is audited independently:
  placeholders the model altered are auto-repaired, and any version with
  a lost, duplicated or invented placeholder is tagged with a warning
  instead of failing silently. Click a version to select it as the result.
- Prompts are built by a dedicated module (`src/prompts.js`) whose first
  and strongest instruction is that placeholder tokens must be copied
  byte-for-byte.

## Tech

- **Firebase AI Logic** (Web SDK v13.0.0, loaded from the Firebase CDN as
  ES modules) with `InferenceMode.PREFER_ON_DEVICE` — Gemini Nano
  on-device, Gemini (`gemini-3.5-flash-lite`) in the cloud, via the
  Gemini Developer API backend. Reporting the actual inference route via
  `response.inferenceSource` requires SDK v12.5.0+; this project pins
  v13.0.0.
- **Firebase App Check** (Fraud Defense / reCAPTCHA Enterprise) protects
  the AI Logic endpoint; debug tokens are supported for local work and
  for judge testing (see below).
- Vanilla JS ES modules — no build step. The PII shield, the prompt
  builder and the App Check token intake are pure modules shared by the
  UI and the Node test suite (**80 unit tests**).

## Project structure

```
index.html            the single-page app
styles.css
src/
  pii-shield.js       deterministic masking / restore / AI-output audit
  prompts.js          structured generation prompts + variant splitting
  firebase-ai.js      Firebase AI Logic hybrid inference + App Check setup
  appcheck-token.js   App Check debug-token intake (?act= / sessionStorage)
  firebase-config.js  public Firebase web config (identifiers, not secrets)
  app.js              UI wiring, demo flow, transparency log
  samples.js          sample documents incl. the 30-second demo email
scripts/serve.mjs     zero-dependency dev server
tests/                node:test suites for the pure modules
firebase.json         Firebase Hosting config (deploy-ready)
```

## Run locally

Requirements: Node.js 18+ (for the dev server and tests) and Chrome 139+
desktop (for on-device inference; the app still works via cloud fallback
in other browsers).

```bash
npm test          # 80 unit tests for the shield, prompts and token intake
npm run dev       # http://localhost:5173
```

### App Check debug token

App Check is enforced for AI Logic. Three ways to run with a debug
token, in priority order:

1. **`?act=<token>` link** — open the app once with a registered debug
   token in the query string. The token is moved into `sessionStorage`
   (tab-scoped, gone when the tab closes) and scrubbed from the address
   bar. This is how judges can test a hosted build without any console
   access.
2. **sessionStorage** — a token stored by an earlier `?act=` visit is
   reused automatically for the rest of the tab session.
3. **Localhost auto-debug** — on `http://localhost` the SDK's debug
   provider is enabled automatically: open the app, copy the
   `AppCheck debug token: "…"` value printed in the browser console, and
   register it once in the
   [Firebase console](https://console.firebase.google.com/project/safedraft-5e55c/appcheck)
   under **App Check → Apps → SafeDraft Web → Manage debug tokens**.

Until a token is registered, shield / restore features work fully
offline; only AI generation calls may be rejected by App Check
enforcement.

## Deploy (Firebase Hosting)

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting   # project: safedraft-5e55c (.firebaserc)
```

`firebase.json` serves the app root and excludes tests, scripts and
tooling files from the deployed site.

## Privacy design

- The placeholder → original mapping exists **only in memory** in the tab.
  It is never written to storage, never logged, and never sent to Firebase.
- The AI prompt contains the masked text only. The UI shows exactly what
  the AI is allowed to see before you send it, plus a transparency log of
  masking and routing decisions.
- The Firebase web config in `src/firebase-config.js` consists of public
  identifiers (not secrets); access control is via App Check. Debug
  tokens and service-account keys are git-ignored and never committed.

## Limitations (honest list)

- Regex/dictionary detection is a **risk-reduction layer, not a guarantee**.
  Unusual name spellings, free-form addresses (address patterns focus on
  JP / US / UK / German formats), or PII written in words
  (e.g. "zero nine zero…") can be missed. Always review the masked preview
  before generating — that is why SafeDraft shows it by default.
- On-device inference requires Chrome 139+ on desktop with Gemini Nano
  available; otherwise requests fall back to the cloud model (the badge
  always tells you which route actually served the response).
- Placeholders are restored verbatim. If a model alters one, near-miss
  forms (different brackets, stray spaces, lower-casing, dropped
  brackets) are repaired automatically before restoration; placeholders
  that were dropped entirely, duplicated, or invented by the model are
  reported with a warning instead of failing silently. If a model swaps
  two placeholders of the same type, the swap itself cannot be detected
  mechanically — the restored text should still be proofread, like any
  AI output.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
