// FILE: mossCanvasPrewarm.ts
// Purpose: Warm Moss Canvas before its first open, so clicking 画布 on a chat image does not wait
//   for the editor's code (about 25 MB) to load and compile from scratch.
// Layer: Web utility
// Notes: Once per app session, when a chat shows a finished image and the browser is idle, a
//   hidden, inert Canvas page (`?moss_prewarm=1`) loads off-screen in the same frame context as the
//   real Canvas, loads the editor code without mounting anything, says so, and is removed. It
//   loads twice, because Chromium caches compiled code only once a script has run more than once.
//   A Canvas build that does not advertise `moss-canvas-prewarm` in its page is never loaded here:
//   an older build would start a full editor in the hidden frame.

import { resolveWsHttpUrl } from "./wsHttpUrl";

export const MOSS_CANVAS_PREWARM_META = /<meta\s+name="moss-canvas-prewarm"\s+content="1"\s*\/?>/u;
export const MOSS_CANVAS_PREWARMED_MESSAGE = "moss-canvas-prewarmed";
const PREWARM_ROUNDS = 2;
const PREWARM_ROUND_TIMEOUT_MS = 60_000;
const PREWARM_IDLE_TIMEOUT_MS = 8_000;

type PrewarmState = "idle" | "scheduled" | "running" | "done";
let state: PrewarmState = "idle";

/** The Canvas page URL the real editor uses, without any credential. */
export function mossCanvasPrewarmUrl(): URL {
  const url = new URL(resolveWsHttpUrl("/canvas/", { includeLegacyToken: false }));
  url.search = "";
  url.searchParams.set("moss_prewarm", "1");
  return url;
}

function isCanvasOpen(): boolean {
  return Boolean(document.querySelector('iframe[src*="/canvas/"]:not([src*="moss_prewarm"])'));
}

function loadHiddenRound(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "";
    // Off-screen and inert: never visible, never focusable, never in the layout.
    frame.style.cssText =
      "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;visibility:hidden";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", receive);
      window.clearTimeout(timer);
      frame.remove();
      resolve(ok);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== url.origin) return;
      if (event.data?.type === MOSS_CANVAS_PREWARMED_MESSAGE) finish(event.data.ok !== false);
    };
    const timer = window.setTimeout(() => finish(false), PREWARM_ROUND_TIMEOUT_MS);
    window.addEventListener("message", receive);
    frame.src = url.toString();
    document.body.append(frame);
  });
}

async function runPrewarm(fetchImpl: typeof fetch): Promise<void> {
  state = "running";
  try {
    const url = mossCanvasPrewarmUrl();
    const page = await fetchImpl(url.toString(), { credentials: "omit", cache: "no-cache" });
    if (!page.ok || !MOSS_CANVAS_PREWARM_META.test(await page.text())) return;
    for (let round = 0; round < PREWARM_ROUNDS; round += 1) {
      // Once a real Canvas is open there is nothing left to warm.
      if (isCanvasOpen()) return;
      if (!(await loadHiddenRound(url))) return;
    }
  } catch {
    // Prewarming is only an optimisation; the real open still works.
  } finally {
    state = "done";
  }
}

/** Warm Canvas once, when the browser is next idle. Safe to call on every render. */
export function scheduleMossCanvasPrewarm(fetchImpl: typeof fetch = fetch): void {
  if (state !== "idle" || typeof window === "undefined" || typeof document === "undefined") return;
  state = "scheduled";
  const start = () => void runPrewarm(fetchImpl);
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(start, { timeout: PREWARM_IDLE_TIMEOUT_MS });
  else window.setTimeout(start, 2_000);
}

/** Test seam. */
export function resetMossCanvasPrewarmForTests(): void {
  state = "idle";
}
