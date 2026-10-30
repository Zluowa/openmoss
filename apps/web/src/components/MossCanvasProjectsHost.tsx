// FILE: MossCanvasProjectsHost.tsx
// Purpose: Images rail host for real Moss Canvas — primary path launches Moss Canvas.app
// (projects + tldraw). Bare vite embed only when probe.projectsEmbedReady (never no-cors opaque).
// Layer: Web shell destination host

import { useCallback, useEffect, useRef, useState } from "react";

import { DeviceShutterIcon, PlusIcon, XIcon } from "~/lib/icons";
import {
  describeMossCanvasIntegration,
  launchMossCanvasDesktop,
  MOSS_CANVAS_DEV_WEB_URL,
  MOSS_CANVAS_SOURCE_HOME,
  probeMossCanvasDevEmbed,
  type MossCanvasEmbedProbe,
  type MossCanvasLaunchResult,
} from "~/lib/mossCanvasLaunch";

export interface MossCanvasProjectsHostProps {
  readonly onClose: () => void;
}

/**
 * Interim Images surface while full in-process embed of moss-canvas React is deferred.
 * Opening uses the real Moss Canvas desktop product (HoolaDesktopProjectsPage → HoolaTldrawApp).
 * Do not mount a blank iframe just because local vite answered an opaque no-cors fetch.
 */
export function MossCanvasProjectsHost({ onClose }: MossCanvasProjectsHostProps) {
  const [launchState, setLaunchState] = useState<"idle" | "pending" | "done">("idle");
  const [lastResult, setLastResult] = useState<MossCanvasLaunchResult | null>(null);
  const [probe, setProbe] = useState<MossCanvasEmbedProbe | null>(null);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [embedChecking, setEmbedChecking] = useState(true);
  const [embedLoadFailed, setEmbedLoadFailed] = useState(false);
  const autoDesktopRequested = useRef(false);

  const refreshEmbed = useCallback(async () => {
    setEmbedChecking(true);
    setEmbedLoadFailed(false);
    const result = await probeMossCanvasDevEmbed(MOSS_CANVAS_DEV_WEB_URL);
    setProbe(result);
    // Only iframe when projects home is actually embeddable — never shell-only vite.
    setEmbedUrl(result.projectsEmbedReady ? MOSS_CANVAS_DEV_WEB_URL : null);
    setEmbedChecking(false);
    return result;
  }, []);

  const openCanvas = useCallback(async () => {
    setLaunchState("pending");
    const result = await launchMossCanvasDesktop("images");
    setLastResult(result);
    setLaunchState("done");
    void refreshEmbed();
    return result;
  }, [refreshEmbed]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await refreshEmbed();
      if (cancelled) return;
      // One primary path: working projects embed OR clear desktop launch — never blank iframe + silent external.
      if (result.projectsEmbedReady) return;
      if (autoDesktopRequested.current) return;
      autoDesktopRequested.current = true;
      await openCanvas();
    })();
    return () => {
      cancelled = true;
    };
    // Mount-once boot: probe then desktop if embed is not projects-ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional single boot
  }, []);

  const statusLabel = (() => {
    if (embedChecking) return "正在检测 Moss Canvas 嵌入能力…";
    if (launchState === "pending") return "正在打开 Moss Canvas 桌面…";
    if (embedUrl) return "已嵌入 Moss Canvas 项目主页";
    if (lastResult?.ok) return `已通过 ${lastResult.via} 打开 Moss Canvas 桌面（项目主页）`;
    if (lastResult && !lastResult.ok) return lastResult.reason;
    if (probe && !probe.projectsEmbedReady && probe.shellReachable) {
      return "本地 vite 壳可达，但项目主页需 Moss Canvas.app — 请打开桌面";
    }
    if (probe && !probe.shellReachable) {
      return `本地 vite 不可用：${probe.detail}`;
    }
    return "等待 Moss Canvas 桌面 / bridge";
  })();

  const showEmbed = Boolean(embedUrl) && !embedLoadFailed;

  return (
    <section
      aria-label="Moss Canvas"
      data-moss-canvas-host
      data-canvas-surface="images"
      data-moss-canvas-integration="desktop-launch"
      data-moss-canvas-source={MOSS_CANVAS_SOURCE_HOME}
      data-moss-canvas-embed={showEmbed ? "ready" : "unavailable"}
      data-moss-canvas-shell={probe?.shellReachable ? "reachable" : "unavailable"}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-shell-background)] text-foreground"
    >
      <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-[var(--app-surface-divider)] px-5">
        <div className="flex items-center gap-2.5">
          <span
            className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background"
            aria-hidden="true"
          >
            <DeviceShutterIcon className="size-4" />
          </span>
          <div className="flex items-baseline gap-2">
            <h1 className="text-ui-lg font-semibold tracking-tight">Moss Canvas</h1>
            <span className="text-ui-sm text-muted-foreground">Projects · tldraw</span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close Moss Canvas"
          title="Close Moss Canvas"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </header>

      {showEmbed ? (
        <div className="relative min-h-0 flex-1" data-moss-canvas-embed-shell>
          <iframe
            title="Moss Canvas"
            src={embedUrl!}
            data-moss-canvas-embed
            className="min-h-0 h-full w-full border-0 bg-background"
            onError={() => {
              setEmbedLoadFailed(true);
              setEmbedUrl(null);
            }}
          />
          <div className="pointer-events-none absolute bottom-3 right-3 rounded-lg bg-background/90 px-3 py-1.5 text-ui-xs text-muted-foreground shadow-sm ring-1 ring-border/60">
            嵌入 Moss Canvas · {MOSS_CANVAS_DEV_WEB_URL}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" data-moss-canvas-fallback>
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:px-12 lg:py-14">
            <div className="max-w-2xl">
              <p className="mb-2 text-ui-sm font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Moss Canvas
              </p>
              <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                正在打开 Moss Canvas
              </h2>
              <p className="mt-3 text-ui-lg leading-6 text-muted-foreground">
                Images 只走我们自己的 Moss Canvas：项目主页（HoolaDesktopProjectsPage）→
                打开项目进入 tldraw（HoolaTldrawApp）。假壳已移除；不会再嵌入空白 vite 白屏。
              </p>
              <p
                className="mt-2 text-ui-sm leading-5 text-muted-foreground"
                data-moss-canvas-approach
              >
                {describeMossCanvasIntegration()}
              </p>
            </div>

            <div
              className="rounded-2xl border border-border/80 bg-card p-5 shadow-sm"
              data-moss-canvas-opening-card
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`inline-flex size-2.5 rounded-full ${
                    launchState === "pending" || embedChecking
                      ? "animate-pulse bg-amber-400"
                      : lastResult?.ok
                        ? "bg-emerald-500"
                        : "bg-muted-foreground/50"
                  }`}
                  aria-hidden="true"
                />
                <p className="text-ui-lg font-medium" data-moss-canvas-launch-status>
                  {statusLabel}
                </p>
              </div>
              {probe ? (
                <p
                  className="mt-2 text-ui-sm leading-5 text-muted-foreground"
                  data-moss-canvas-probe-detail
                >
                  探测：{probe.detail}
                </p>
              ) : null}
              <p className="mt-2 text-ui-sm leading-5 text-muted-foreground">
                主路径：打开 Moss Canvas.app（优先 release 94a451916201）。本地 vite（
                {MOSS_CANVAS_DEV_WEB_URL}）仅在 projects 可嵌入时才会
                iframe；否则显示本重试卡，避免白屏。
              </p>
              <div
                className="mt-4 flex flex-wrap items-center gap-3"
                data-moss-canvas-projects-actions
              >
                <button
                  type="button"
                  data-moss-canvas-open-desktop
                  onClick={() => void openCanvas()}
                  disabled={launchState === "pending"}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-4 text-ui-lg font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  {launchState === "pending" ? "Opening Moss Canvas…" : "重试打开 Moss Canvas"}
                </button>
                <button
                  type="button"
                  data-moss-canvas-retry-embed
                  onClick={() => void refreshEmbed()}
                  disabled={embedChecking}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-background px-4 text-ui-lg font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {embedChecking ? "检测嵌入中…" : "重新探测嵌入"}
                </button>
              </div>
            </div>

            <section
              aria-labelledby="moss-canvas-projects-heading"
              data-moss-canvas-projects-home
              className="rounded-2xl border border-border/80 bg-card p-6 shadow-sm"
            >
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 id="moss-canvas-projects-heading" className="text-ui-lg font-semibold">
                    Projects
                  </h3>
                  <p className="mt-1 text-ui-sm text-muted-foreground">
                    真项目网格与 tldraw 在 Moss Canvas.app（
                    <code className="text-ui-xs">{MOSS_CANVAS_SOURCE_HOME}</code>
                    ）。开发可用 <code className="text-ui-xs">npm run desktop:dev</code>。
                  </p>
                </div>
              </div>
              <div
                className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/20 px-6 py-10 text-center"
                data-moss-canvas-projects-empty
              >
                <p className="text-ui-lg font-medium">在 Moss Canvas 中打开项目主页</p>
                <p className="mt-2 max-w-md text-ui-sm leading-5 text-muted-foreground">
                  完整项目网格 / 文件夹 / 新建项目与 tldraw 画布由 moss-canvas Electron
                  宿主提供。嵌入未就绪时请用上方重试，勿停留在空白页。
                </p>
              </div>
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
