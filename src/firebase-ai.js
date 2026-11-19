/**
 * SafeDraft — Firebase AI Logic (hybrid inference) integration.
 *
 * Uses the Firebase AI Logic Web SDK with InferenceMode.PREFER_ON_DEVICE:
 * short / sensitive rewrites try the on-device model (Gemini Nano via the
 * Chrome Prompt API) first and fall back to a cloud-hosted Gemini model.
 * Longer documents are routed to a PREFER_IN_CLOUD model instance.
 *
 * Every response reports its route via `response.inferenceSource`, which
 * the UI surfaces as an "On-device" / "Cloud" badge — the user can always
 * see where their (masked) text was processed.
 *
 * Docs: https://firebase.google.com/docs/ai-logic/hybrid-on-device-inference
 */
// Official Firebase JS SDK v13.0.0, loaded from the Firebase CDN as ES
// modules (the CDN builds of the `firebase/app`, `firebase/app-check` and
// `firebase/ai` packages — no bundler required).
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app-check.js";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-ai.js";
import { firebaseConfig, appCheckSiteKey } from "./firebase-config.js";
import {
  resolveDebugToken,
  removeActParam,
  APPCHECK_DEBUG_TOKEN_KEY,
} from "./appcheck-token.js";

/** Cloud fallback model (the SDK v13 default for hybrid mode). */
export const CLOUD_MODEL = "gemini-3.5-flash-lite";

/** Masked texts longer than this are routed to the cloud-leaning model. */
export const CLOUD_ROUTE_THRESHOLD = 800;

let hybridModel = null;
let cloudModel = null;
let deviceInitAttempted = false;

/**
 * Decide which route a masked text should take, deterministically.
 * Returns "on-device" (hybrid, on-device preferred) or "cloud".
 */
export function chooseRoute(maskedText) {
  return maskedText.length > CLOUD_ROUTE_THRESHOLD ? "cloud" : "on-device";
}

function isLocalhost() {
  return (
    typeof location !== "undefined" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  );
}

/**
 * Decide the App Check debug token setup. Must run BEFORE initializeAppCheck.
 *
 * Priority:
 *  1. `?act=<token>` in the URL — the token is moved into sessionStorage
 *     (tab-scoped) and scrubbed from the address bar, so a judge can open
 *     a single link and generate immediately. The token value itself is
 *     never logged or stored anywhere else.
 *  2. A token kept in sessionStorage by an earlier `?act=` visit.
 *  3. Localhost only: the SDK's auto debug token (printed to the console,
 *     safelisted once in the Firebase console — see README).
 *
 * @returns {"query"|"session"|"localhost-auto"|null} where the token came from
 */
function setupAppCheckDebugToken() {
  try {
    const stored = sessionStorage.getItem(APPCHECK_DEBUG_TOKEN_KEY);
    const { token, source } = resolveDebugToken({
      search: location.search,
      stored,
    });
    if (token) {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
      if (source === "query") {
        sessionStorage.setItem(APPCHECK_DEBUG_TOKEN_KEY, token);
        history.replaceState(null, "", removeActParam(location.href));
      }
      return source;
    }
  } catch {
    // sessionStorage/history unavailable (rare) — fall through to localhost.
  }
  if (isLocalhost()) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    return "localhost-auto";
  }
  return null;
}

/**
 * Initialize Firebase + App Check + AI Logic model instances.
 * Safe to call once at startup. Returns a status object for the UI.
 */
export function initFirebaseAI() {
  const app = initializeApp(firebaseConfig);

  // App Check. A debug token (from ?act=, sessionStorage, or the localhost
  // auto-debug provider) is installed when available; otherwise the
  // reCAPTCHA Enterprise provider attests the page normally.
  const appCheckDebugSource = setupAppCheckDebugToken();
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });

  const ai = getAI(app, { backend: new GoogleAIBackend() });

  hybridModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: { model: CLOUD_MODEL },
  });
  cloudModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_IN_CLOUD,
    inCloudParams: { model: CLOUD_MODEL },
  });

  return {
    ok: true,
    cloudModel: CLOUD_MODEL,
    appCheckDebug: appCheckDebugSource !== null,
    appCheckDebugSource,
  };
}

/**
 * Must be called from a user-gesture handler before the first prompt
 * (Chrome user-activation requirement for the Prompt API). Triggers the
 * on-device model download if needed. Failures are non-fatal: the hybrid
 * model will simply fall back to the cloud.
 */
export async function ensureDeviceModel(onProgress) {
  if (!hybridModel || deviceInitAttempted) return;
  deviceInitAttempted = true;
  try {
    // Bound the wait: if device-model setup stalls (unsupported browser,
    // slow download), proceed anyway — PREFER_ON_DEVICE falls back to the
    // cloud model automatically at generation time.
    const timeout = new Promise((resolve) => setTimeout(resolve, 10000));
    await Promise.race([
      Promise.resolve(
        hybridModel.initializeDeviceModel((val) => {
          if (typeof onProgress === "function") onProgress(val);
        }),
      ),
      timeout,
    ]);
  } catch {
    // On-device model unavailable — cloud fallback covers the request.
  }
}

/** Map the SDK's inferenceSource value to a UI label. */
export function routeLabel(inferenceSource) {
  const s = String(inferenceSource ?? "").toLowerCase();
  if (s.includes("device")) return "On-device";
  if (s.includes("cloud")) return "Cloud";
  return "Unknown";
}

/**
 * Run one generation against MASKED text only. The caller is responsible
 * for masking before calling and restoring placeholders afterwards.
 *
 * `routeBasis` is the text whose length decides the route (normally the
 * masked document itself, without any instruction prefix), so the UI's
 * route hint and the actual routing always agree.
 *
 * @returns {Promise<{ text: string, source: string, route: string }>}
 *   `source` is the raw inferenceSource reported by the SDK,
 *   `route` is "On-device" | "Cloud" | "Unknown".
 */
export async function generateWithRoute(maskedPrompt, routeBasis = maskedPrompt) {
  if (!hybridModel) throw new Error("Firebase AI is not initialized yet.");
  const route = chooseRoute(routeBasis);
  const model = route === "cloud" ? cloudModel : hybridModel;
  if (route === "on-device") await ensureDeviceModel();
  const result = await model.generateContent(maskedPrompt);
  const response = result.response;
  return {
    text: response.text(),
    source: response.inferenceSource ?? "unknown",
    route: routeLabel(response.inferenceSource),
  };
}
