// FILE: mossCanvasLaunch.ts
// Purpose: Resolve and request the real Moss Canvas desktop app (open-hoola-canvas /
// apps/codex-canvas), never a draft-card marketing shell.
// Layer: Web renderer → desktop bridge helper
// Approach (PR229g interim, Astra policy-blocked → hand-patch): prefer window.mossCanvasBridge /
// mossCanvas.execute / desktopBridge.openMossCanvasApp IPC, then legacy open-hoola-canvas
// event. Bare vite at MOSS_CANVAS_DEV_WEB_URL can look "up" under no-cors opaque fetch but
// HoolaDesktopProjectsPage only opens when window.hoolaDesktop.projects exists (Electron
// preload) — iframe embed of vite alone whitescreens. Primary path = launch Moss Canvas.app
// (prefer release 94a451916201). Start projects UI: `npm run desktop:dev` in moss-canvas or
// open the packaged app. Full in-process embed remains deferred.

export const MOSS_CANVAS_SOURCE_HOME = "/Users/moss/Codex/tools/moss-canvas" as const;

/** Candidate .app / executable locations mirrored from moss-canvas MCP resolveDesktopLaunch. */
export const MOSS_CANVAS_APP_CANDIDATES: readonly string[] = [
  "/Applications/Moss Canvas.app",
  "/Users/moss/Codex/tools/moss-canvas/apps/codex-canvas/release/94a451916201/Moss Canvas.app",
  "/Users/moss/Codex/tools/moss-canvas/apps/codex-canvas/release/Moss Canvas.app",
  "/Users/moss/Codex/tools/moss-canvas/apps/codex-canvas/release/95d4abd55c29/Moss Canvas.app",
  "/Applications/Hoola Canvas.app",
  // demoted: broken wallpaper/error build
  "/Users/moss/Codex/tools/moss-canvas/apps/codex-canvas/release/0c31322000d1/Moss Canvas.app",
];

export const MOSS_CANVAS_DEV_WEB_URL = "http://127.0.0.1:5173" as const;

export const MOSS_CANVAS_DEV_PROBE_PATH = "/__moss/project-info" as const;

export type MossCanvasEmbedProbe = {
  /** Readable CORS HTTP ok + Moss Canvas shell HTML (or probe JSON). Never trust no-cors opaque. */
  readonly shellReachable: boolean;
  /**
   * True only when the embed target can show projects home (HoolaDesktopProjectsPage).
   * Bare vite iframes lack Electron `hoolaDesktop.projects`, so this stays false until an
   * in-process / preload-backed guest exists — otherwise Images shows a blank white frame.
   */
  readonly projectsEmbedReady: boolean;
  readonly detail: string;
};

const SHELL_TITLE_RE = /<title>\s*Moss Canvas\s*<\/title>/i;
const SHELL_ROOT_RE = /id=["']root["']/;

/**
 * Validate local moss-canvas vite for embed. Uses CORS so status/body are readable.
 * Opaque no-cors success is intentionally NOT treated as reachable.
 */
export async function probeMossCanvasDevEmbed(
  baseUrl: string = MOSS_CANVAS_DEV_WEB_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<MossCanvasEmbedProbe> {
  const root = baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    // Prefer the project-info JSON seam when middleware is live; fall back to index HTML markers.
    const probeUrl = `${root}${MOSS_CANVAS_DEV_PROBE_PATH}`;
    const infoRes = await fetchImpl(probeUrl, {
      method: "GET",
      mode: "cors",
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json, text/html;q=0.8" },
    });
    if (infoRes.ok) {
      const contentType = (infoRes.headers.get("content-type") || "").toLowerCase();
      const body = await infoRes.text();
      if (contentType.includes("application/json") || body.trimStart().startsWith("{")) {
        try {
          const json = JSON.parse(body) as { ok?: unknown };
          if (json && json.ok === true) {
            // Shell + project-info up, but bare browser iframe still cannot host projects UI.
            return {
              shellReachable: true,
              projectsEmbedReady: false,
              detail:
                "vite project-info ok; projects home needs Moss Canvas.app (hoolaDesktop.projects), not bare iframe",
            };
          }
        } catch {
          // fall through to HTML markers
        }
      }
      if (SHELL_TITLE_RE.test(body) && SHELL_ROOT_RE.test(body)) {
        return {
          shellReachable: true,
          projectsEmbedReady: false,
          detail:
            "Moss Canvas vite shell HTML ok; projects grid not embeddable without Electron preload — use desktop launch",
        };
      }
    }

    const indexRes = await fetchImpl(`${root}/`, {
      method: "GET",
      mode: "cors",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!indexRes.ok) {
      return {
        shellReachable: false,
        projectsEmbedReady: false,
        detail: `vite HTTP ${indexRes.status}`,
      };
    }
    const html = await indexRes.text();
    if (SHELL_TITLE_RE.test(html) && SHELL_ROOT_RE.test(html)) {
      return {
        shellReachable: true,
        projectsEmbedReady: false,
        detail:
          "Moss Canvas vite shell HTML ok; projects grid not embeddable without Electron preload — use desktop launch",
      };
    }
    return {
      shellReachable: false,
      projectsEmbedReady: false,
      detail: "vite responded but HTML was not Moss Canvas shell",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      shellReachable: false,
      projectsEmbedReady: false,
      detail: `vite probe failed (${reason})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type MossCanvasLaunchResult =
  | {
      readonly ok: true;
      readonly via: "mossCanvasBridge" | "mossCanvasExecute" | "desktopIpc" | "legacyEvent";
    }
  | { readonly ok: false; readonly reason: string };

interface LaunchHost {
  readonly mossCanvasBridge?: { open(input: { source: "moss-synara"; surface: string }): unknown };
  readonly mossCanvas?: {
    execute(command: {
      action: "canvas.ui.open_main_menu";
      args: { source: "moss-synara"; surface: string };
    }): unknown;
  };
  readonly hoolaCanvas?: {
    execute(command: {
      action: "canvas.ui.open_main_menu";
      args: { source: "moss-synara"; surface: string };
    }): unknown;
  };
  readonly desktopBridge?: {
    openMossCanvasApp?: (input?: { surface?: string }) => Promise<boolean> | boolean;
  };
  readonly dispatchEvent?: (event: Event) => boolean;
}

function getHost(): LaunchHost {
  if (typeof window !== "undefined") return window as unknown as LaunchHost;
  return globalThis as unknown as LaunchHost;
}

/**
 * Ask the real Moss Canvas product to open (projects home / tldraw host).
 * Does not mount any draft-card fake shell.
 */
export async function launchMossCanvasDesktop(
  surface: string = "images",
): Promise<MossCanvasLaunchResult> {
  const detail = { source: "moss-synara" as const, surface: surface.trim() || "images" };
  const host = getHost();

  const bridge = host.mossCanvasBridge;
  if (typeof bridge?.open === "function") {
    try {
      await Promise.resolve(bridge.open(detail));
      return { ok: true, via: "mossCanvasBridge" };
    } catch {
      // Continue to other seams.
    }
  }

  const command = {
    action: "canvas.ui.open_main_menu" as const,
    args: detail,
  };
  for (const canvas of [host.mossCanvas, host.hoolaCanvas]) {
    if (typeof canvas?.execute !== "function") continue;
    try {
      await Promise.resolve(canvas.execute(command));
      return { ok: true, via: "mossCanvasExecute" };
    } catch {
      // Try next alias.
    }
  }

  const openApp = host.desktopBridge?.openMossCanvasApp;
  if (typeof openApp === "function") {
    try {
      const opened = await Promise.resolve(openApp({ surface: detail.surface }));
      if (opened) return { ok: true, via: "desktopIpc" };
    } catch {
      // Fall through to event.
    }
  }

  if (typeof host.dispatchEvent === "function" && typeof CustomEvent === "function") {
    try {
      host.dispatchEvent(new CustomEvent("open-hoola-canvas", { detail }));
      return { ok: true, via: "legacyEvent" };
    } catch {
      // ignore
    }
  }

  return {
    ok: false,
    reason:
      "Moss Canvas desktop was not reachable. Install Moss Canvas.app or run `npm run desktop:dev` in /Users/moss/Codex/tools/moss-canvas.",
  };
}

export function describeMossCanvasIntegration(): string {
  return [
    "Images → real Moss Canvas only (moss-canvas / open-hoola-canvas).",
    "UI path: HoolaDesktopProjectsPage (projects home) → open project → HoolaTldrawApp.",
    "Moss primary path launches Moss Canvas.app (prefer release 94a451916201); bare vite iframe is not projects-ready.",
    "Dev: `npm run desktop:dev` in /Users/moss/Codex/tools/moss-canvas (or open the packaged app).",
  ].join(" ");
}
