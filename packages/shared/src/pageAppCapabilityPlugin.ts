// FILE: pageAppCapabilityPlugin.ts
// Purpose: The plugin interface every 应用页 capability implements. A
// capability has up to three halves, each registered with one line:
//   1. frame half  (this file's `PageAppFramePlugin`), registered in
//      `pageAppFrameRuntime.ts` `PAGE_APP_FRAME_PLUGINS`: plain JS that builds
//      the namespace `moss.use(name)` resolves inside the page.
//   2. shell half  (`PageAppShellPlugin` below), registered in
//      `apps/web/src/components/pageApps/capabilities/index.ts`: checks
//      consent/rate limits and answers calls, usually by relaying to the server.
//   3. server half (`PageAppServerCapability`), registered in
//      `apps/server/src/pages/apps/capabilities/index.ts`: does the work that
//      needs storage, models or the network, after the server re-checks the
//      declaration and the stored consent.
// Layer: Shared (framework-free; the server and web halves import these types)

import type {
  PageAppCallError,
  PageAppCapabilities,
  PageAppFrameMode,
  PageAppPermissionState,
  PageAppViewer,
} from "@moss/contracts";

// ---------------------------------------------------------------------------
// 1. Frame half
// ---------------------------------------------------------------------------

/**
 * A frame plugin is JavaScript source for one function expression
 * `function (bridge) { return namespace; }`. It is inlined into every served
 * 应用页 before the page's own scripts, so it must be self-contained ES2020
 * with no imports and no references to anything but `bridge` and standard
 * globals. The runtime freezes whatever it returns.
 *
 * `bridge` offers (see `pageAppFrameRuntime.ts`):
 *   bridge.call(method, args)                 -> Promise<value>, rejects PageAppCallError
 *   bridge.watch(method, args, next, end)     -> cancel(); `end(error?)` fires once
 *   bridge.error(code, message)               -> a frozen { code, message } to throw
 *   bridge.use(name)                          -> another capability's namespace or null
 */
export interface PageAppFramePlugin {
  readonly name: string;
  readonly frameSource: string;
}

// ---------------------------------------------------------------------------
// 2. Shell half
// ---------------------------------------------------------------------------

/**
 * How a capability asks the viewer:
 * - "none": no prompt (identity reads, `permissions` itself).
 * - "standing": ask on first use, remember per page (db, ai).
 * - "per-use": the shell confirms every use in its own dialog (downloads);
 *   reports "granted" through `permissions.state()`.
 */
export type PageAppConsentClass = "none" | "standing" | "per-use";

export interface PageAppRateLimit {
  /** Calls allowed in a burst. */
  readonly burst: number;
  /** Calls refilled per minute. */
  readonly perMinute: number;
}

/** What the shell knows about the running page when a call arrives. */
export interface PageAppShellContext {
  readonly appId: string;
  readonly revision: number;
  readonly title: string;
  readonly mode: PageAppFrameMode;
  readonly viewer: PageAppViewer;
  readonly capabilities: PageAppCapabilities;
  /** This capability's declared config (`capabilities[name]`). */
  readonly config: unknown;
  /** Relay to the server half: `pageApps.call`. */
  readonly serverCall: (method: string, args: unknown) => Promise<unknown>;
  /** Relay to the server half: `pageApps.watch`. Returns cancel. */
  readonly serverWatch: (method: string, args: unknown, sink: PageAppWatchSink) => () => void;
  /** Ask the viewer in a Moss dialog; resolves their answer. */
  readonly confirm: (request: PageAppConfirmRequest) => Promise<boolean>;
  /** Same dialog, also reporting the remember checkbox. */
  readonly confirmChoice: (request: PageAppConfirmRequest) => Promise<PageAppConfirmResult>;
  /** The iframe the page runs in, to place shell UI beside its content. */
  readonly frameElement: () => PageAppFrameElement | null;
  /** Current permission states (after consent bookkeeping). */
  readonly permissionStates: () => Record<string, PageAppPermissionState>;
  /** Ask for several standing grants in one dialog. */
  readonly requestPermissions: (
    names: readonly string[] | undefined,
  ) => Promise<Record<string, PageAppPermissionState>>;
  /** Open the page's permissions panel; resolves when it closes. */
  readonly managePermissions: () => Promise<void>;
  /** Aborted when the frame unloads or the shell unmounts. */
  readonly signal: AbortSignal;
}

export interface PageAppWatchSink {
  readonly next: (value: unknown) => void;
  readonly end: (error?: PageAppCallError) => void;
}

export interface PageAppConfirmRequest {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  /** Optional detail lines (file name, size, ...). */
  readonly details?: readonly string[];
  /** "danger" draws the confirm button as destructive. */
  readonly tone?: "default" | "danger";
  /** When set, the dialog offers a checkbox with this label; see `confirmChoice`. */
  readonly rememberLabel?: string;
}

/** The page's iframe as the shell sees it (structural, so the server needs no DOM types). */
export interface PageAppFrameElement {
  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface PageAppConfirmResult {
  readonly confirmed: boolean;
  /** The viewer ticked `rememberLabel` (always false without one). */
  readonly remember: boolean;
}

export interface PageAppShellPlugin {
  readonly name: string;
  readonly consent: PageAppConsentClass;
  /** Modes this capability is served in. Guests get a reduced set. */
  readonly modes: readonly PageAppFrameMode[];
  /** Name and one-line purpose shown in the consent dialog and permissions panel. */
  readonly label: string;
  readonly purpose: string;
  readonly rateLimit?: PageAppRateLimit;
  /** Request/response methods. Unknown methods reject `invalid_argument`. */
  readonly call?: (ctx: PageAppShellContext, method: string, args: unknown) => Promise<unknown>;
  /** Streaming methods (`bridge.watch`). Returns cancel. */
  readonly watch?: (
    ctx: PageAppShellContext,
    method: string,
    args: unknown,
    sink: PageAppWatchSink,
  ) => () => void;
}

/** Error a shell or server half throws to reach page code with a stable code. */
export class PageAppCapabilityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PageAppCapabilityError";
    this.code = code;
  }
  toJSON(): PageAppCallError {
    return { code: this.code, message: this.message };
  }
}

export function toPageAppCallError(error: unknown): PageAppCallError {
  if (error instanceof PageAppCapabilityError) return error.toJSON();
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const code = (error as { code: unknown }).code;
    const message = (error as { message: unknown }).message;
    if (typeof code === "string" && typeof message === "string") return { code, message };
  }
  return { code: "unavailable", message: "The capability failed unexpectedly." };
}
