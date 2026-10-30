// FILE: RightDock.tsx
// Purpose: Tabbed multi-pane right sidebar shell (browser, diff, terminal, sidechat, git).
// Layer: Chat right-dock UI
// Depends on: ui/sidebar primitive, right-dock pane metadata, and a caller-provided pane renderer.

import {
  type CSSProperties,
  type ReactNode,
  type SVGProps,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Schema } from "effect";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import {
  type DockPaneRuntimeMode,
  EMPTY_PANE_ID_SET,
  reconcileKeepMountedPaneIds,
} from "~/lib/dockPaneActivation";
import { Maximize2, PanelRightOpenIcon, PlusIcon } from "~/lib/icons";
import type {
  RightDockPane,
  RightDockPaneKind,
  RightDockThreadState,
} from "~/rightDockStore.logic";
import type { McpAppDockEntrySnapshot } from "~/lib/mcpAppDockRegistry";
import { resolveActivePane } from "~/rightDockStore.logic";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { Sidebar, SidebarProvider, SidebarRail } from "../ui/sidebar";
import { CHAT_BACKGROUND_CLASS_NAME } from "./composerPickerStyles";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import {
  BottomPanelClosedIcon,
  BottomPanelOpenIcon,
  CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
  DOCK_HEADER_ICON_BUTTON_CLASS,
  SurfaceTabChip,
  SurfaceChipIcon,
} from "./chatHeaderControls";
import { McpAppDockPane } from "./McpAppDockPane";
import { McpAppNavigationControls } from "./McpAppNavigationControls";
import { AppsIcon } from "~/lib/icons";
import {
  RIGHT_DOCK_DEFAULT_WIDTH,
  RIGHT_DOCK_MIN_WIDTH,
  RIGHT_DOCK_WIDTH_STORAGE_KEY,
  normalizeRightDockWidth,
  resolvePersistedRightDockWidthRatio,
  resolveRightDockWidthBounds,
  resolveRightDockWidthFromRatio,
} from "./rightDockSizing.logic";
import { resolveRightDockChromeContract } from "./rightDockFullWidth.logic";
import {
  RIGHT_DOCK_FULL_WIDTH_CONTROL_TOOLTIP_DELAY_MS,
  RIGHT_DOCK_MOTION,
  resolveRightDockChromeMotionClass,
} from "./rightDockMotion.logic";
import {
  getRightDockPaneMeta,
  type RightDockLauncherItem,
  resolveRightDockAddMenuKinds,
  resolveRightDockPaneIcon,
} from "./rightDockPaneMeta";
import { useDesktopTopBarWindowControlsGutterClassName } from "~/hooks/useDesktopTopBarGutter";
import { type TranslationKey, useTranslation } from "~/localization";

export { RIGHT_DOCK_DEFAULT_WIDTH, RIGHT_DOCK_MIN_WIDTH };

const RIGHT_DOCK_LABEL_KEY_BY_KIND = {
  browser: "rightDock.pane.browser",
  device: "rightDock.pane.panel",
  diff: "rightDock.pane.diff",
  explorer: "rightDock.pane.files",
  file: "rightDock.pane.file",
  htmlRender: "rightDock.pane.file",
  imagePreview: "rightDock.pane.imagePreview",
  canvas: "chat.generatedImage.preview.canvasView",
  terminal: "rightDock.pane.terminal",
  sidechat: "rightDock.launcher.sideChats",
  subagents: "rightDock.pane.subagents",
  git: "rightDock.pane.git",
  pullRequest: "rightDock.pane.pullRequest",
} as const satisfies Record<RightDockPaneKind, TranslationKey>;

function RestorePanelWidthIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path
        d="M6.1664 8.80845C6.7325 8.80845 7.1918 9.26774 7.1918 9.83384V13.3338C7.19155 13.6236 6.9562 13.8592 6.6664 13.8592C6.37672 13.8591 6.14126 13.6235 6.14101 13.3338V10.5936L2.70547 14.0379C2.50071 14.243 2.16753 14.2435 1.9623 14.0389C1.75709 13.8342 1.75665 13.501 1.96133 13.2957L5.39101 9.85923H2.6664C2.37672 9.85909 2.14126 9.6235 2.14101 9.33384C2.14101 9.04397 2.37657 8.80858 2.6664 8.80845H6.1664Z"
        fill="currentColor"
      />
      <path
        d="M13.2943 1.96274C13.4989 1.75743 13.8311 1.75731 14.0365 1.96177C14.2419 2.16637 14.243 2.49854 14.0385 2.70395L10.6127 6.14145H13.3334C13.6233 6.14145 13.8588 6.37689 13.8588 6.66684C13.8587 6.95674 13.6233 7.19223 13.3334 7.19223H9.8334C9.26734 7.19223 8.80807 6.73288 8.80801 6.16684V2.66684C8.80801 2.37689 9.04345 2.14145 9.3334 2.14145C9.62335 2.14145 9.85879 2.37689 9.85879 2.66684V5.41098L13.2943 1.96274Z"
        fill="currentColor"
      />
    </svg>
  );
}

// Pane kinds whose content has a natural width, opened at that size rather than
// at the even split. The device pane frames a portrait phone, so its useful
// width is whatever lets the phone reach full height: a ~19.5:9 chassis stays
// height-bound well past 480px, and opening narrower only shrinks the device
// while leaving empty space above and below it.
const RIGHT_DOCK_PREFERRED_WIDTH: Partial<Record<RightDockPaneKind, number>> = {
  device: 38 * 16,
};

interface RightDockProps {
  state: RightDockThreadState;
  /** @deprecated RightDock now owns the Codex 320px minimum. */
  minWidth: number;
  /** @deprecated RightDock now owns the Codex 600px adaptive baseline. */
  defaultWidth: number | string;
  shouldAcceptWidth: (context: { nextWidth: number; wrapper: HTMLElement }) => boolean;
  paneLabelOverrides?: Record<string, string | undefined>;
  // Per-pane tab glyph overrides (same shape as label overrides) — e.g. a pull request pane
  // swapping the generic kind icon for its live state glyph.
  paneIconOverrides?: Record<string, ReactNode | undefined>;
  addMenuKinds: readonly RightDockPaneKind[];
  addAction?: { label: string; onClick: () => void } | undefined;
  launcherItems?: readonly RightDockLauncherItem[];
  // Single-pane hosts omit selection so their lone tab label is static; multi-pane chat hosts
  // provide the callback and keep the normal selectable-tab behavior.
  onSelectPane?: ((paneId: string) => void) | undefined;
  mcpAppEntries?: readonly McpAppDockEntrySnapshot[] | undefined;
  onSelectMcpApp?: ((entryId: string) => void) | undefined;
  onCloseMcpApp?: ((entryId: string) => void) | undefined;
  onClosePane: (paneId: string) => void;
  onCollapse: () => void;
  onOpenChange: (open: boolean) => void;
  fullWidth?: boolean | undefined;
  onFullWidthChange?: ((fullWidth: boolean) => void) | undefined;
  bottomPanelOpen?: boolean | undefined;
  onToggleBottomPanel?: (() => void) | undefined;
  bottomPanelShortcutLabel?: string | null | undefined;
  rightPanelShortcutLabel?: string | null | undefined;
  /** Stable outer shell supplied by the host; never infer width from the dock subtree. */
  layoutHostRef?: { readonly current: HTMLElement | null };
  /** Main-content sibling whose full-width contract is owned declaratively by the host. */
  mainContentRef?: { readonly current: HTMLElement | null };
  /**
   * Test/embedded hosts can provide the already-resolved caption gutter. Leaving
   * this unset preserves the normal desktop bridge-backed resolution path.
   */
  windowControlsGutterClassName?: string | null;
  containerMode?: "viewport" | "parent";
  onAddPane: (kind: RightDockPaneKind) => void;
  motionKey?: string;
  activePaneRuntimeMode?: DockPaneRuntimeMode;
  browserRuntimeMode?: DockPaneRuntimeMode;
  renderPane: (
    pane: RightDockPane,
    context: { runtimeMode: DockPaneRuntimeMode; isActive: boolean; isVisible: boolean },
  ) => ReactNode;
}

function RightDockLauncher(props: {
  items: readonly RightDockLauncherItem[];
  onOpen: (kind: RightDockPaneKind) => void;
}) {
  const { format, t } = useTranslation();
  return (
    <nav
      aria-label={t("rightDock.launcher.open")}
      className="flex h-full min-h-0 items-center justify-center overflow-y-auto p-6"
      data-testid="right-dock-empty-actions"
    >
      <div className="flex w-full max-w-sm flex-col gap-1.5">
        {props.items.map(({ kind, Icon, label }) => {
          return (
            <Button
              key={kind}
              variant="subtle"
              size="xl"
              className="h-11 w-full justify-start gap-3 rounded-xl px-4 text-ui-lg font-normal"
              aria-label={format("rightDock.launcher.openPane", { label })}
              data-testid={`right-dock-empty-action-${kind}`}
              onClick={() => props.onOpen(kind)}
            >
              <Icon className="size-4 shrink-0" />
              <span>{label}</span>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}

function RightDockTab(props: {
  pane: RightDockPane | McpAppDockEntrySnapshot;
  label: string;
  icon?: ReactNode;
  active: boolean;
  onSelect?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { format } = useTranslation();
  return (
    <SurfaceTabChip
      active={props.active}
      title={props.label}
      label={props.label}
      labelClassName="max-w-[10rem]"
      icon={
        props.icon ??
        ("kind" in props.pane ? (
          resolveRightDockPaneIcon(props.pane)
        ) : (
          <SurfaceChipIcon icon={AppsIcon} />
        ))
      }
      closeLabel={format("rightDock.closePane", { label: props.label })}
      onSelect={props.onSelect}
      onClose={props.onClose}
    />
  );
}

// Persist which keep-mounted panes (e.g. terminals) have been activated so they
// stay in the DOM while another tab is selected, pruned to live panes so closed
// panes drop out and the set never leaks across thread switches.
// The rendered set is derived synchronously so a kept pane never unmounts for a
// frame. A layout effect commits that set for the next render without mutating a
// ref during render (which is unsafe when React replays or abandons work).
function useKeepMountedPaneIds(
  panes: readonly RightDockPane[],
  activePane: RightDockPane | null,
): ReadonlySet<string> {
  const [committedPaneIds, setCommittedPaneIds] = useState<ReadonlySet<string>>(EMPTY_PANE_ID_SET);
  const activePaneId = activePane?.id ?? null;
  const activePaneKind = activePane?.kind ?? null;
  const renderedPaneIds = reconcileKeepMountedPaneIds({
    previous: committedPaneIds,
    panes,
    activePaneId,
    activePaneKind,
  });

  useLayoutEffect(() => {
    setCommittedPaneIds((current) => {
      const next = reconcileKeepMountedPaneIds({
        previous: current,
        panes,
        activePaneId,
        activePaneKind,
      });
      if (next.size === current.size && [...next].every((paneId) => current.has(paneId))) {
        return current;
      }
      return next;
    });
  }, [activePaneId, activePaneKind, panes]);

  return renderedPaneIds;
}

function resolveRightDockOuterShell(wrapper: HTMLElement): HTMLElement | null {
  let outerShell: HTMLElement | null = null;
  let ancestor = wrapper.parentElement;
  while (ancestor) {
    if (ancestor.matches("[data-slot='sidebar-wrapper']")) {
      outerShell = ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return outerShell;
}

function setInlineStyleIfChanged(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) === value) {
    return;
  }
  if (value === "") {
    element.style.removeProperty(property);
    return;
  }
  element.style.setProperty(property, value);
}

function resolveRightDockStableWidth(
  layoutHostRef: { readonly current: HTMLElement | null } | undefined,
  wrapper: HTMLElement | null = null,
): number {
  const hostWidth = layoutHostRef?.current?.getBoundingClientRect().width ?? 0;
  if (hostWidth > 0) {
    return Math.round(hostWidth);
  }
  const parentWidth = wrapper?.parentElement?.getBoundingClientRect().width ?? 0;
  if (parentWidth > 0) {
    // Pull-request pages predate the explicit chat host contract and never enter
    // full-width mode. Their direct parent is the route shell, not a dock child;
    // use it only for regular sizing and never mutate or inspect a sibling.
    return Math.round(parentWidth);
  }
  // Keep SSR/tests without a mounted route shell bounded by the outer viewport.
  return typeof window === "undefined" ? 0 : Math.round(window.innerWidth);
}

function RightDockSurface(
  props: RightDockProps & { readonly windowControlsGutterClassName: string | null },
) {
  const { format, t } = useTranslation();
  const activePane = resolveActivePane(props.state);
  const mcpAppEntries = props.mcpAppEntries ?? [];
  const activeMcpApp = mcpAppEntries.find((entry) => entry.selected) ?? null;
  const activeMcpAppId = activeMcpApp?.id ?? null;
  const onSelectPane = props.onSelectPane;
  const activePaneRuntimeMode = props.activePaneRuntimeMode ?? "live";
  const panelFullWidth = props.fullWidth ?? false;
  const panelWidthToggleLabel = panelFullWidth
    ? t("rightDock.restorePanel")
    : t("rightDock.expandPanel");
  const chromeContract = resolveRightDockChromeContract(panelFullWidth);
  const bottomPanelToggleLabel = t("rightDock.toggleBottomPanel");
  const rightPanelToggleLabel = t("rightDock.toggleRightSidebar");
  const bottomPanelOpen = props.bottomPanelOpen ?? false;
  const onToggleBottomPanel = props.onToggleBottomPanel ?? (() => {});
  const bottomPanelTooltip = props.bottomPanelShortcutLabel
    ? format("rightDock.toggleBottomPanelShortcut", {
        shortcut: props.bottomPanelShortcutLabel,
      })
    : bottomPanelToggleLabel;
  const rightPanelTooltip = props.rightPanelShortcutLabel
    ? format("rightDock.toggleRightSidebarShortcut", {
        shortcut: props.rightPanelShortcutLabel,
      })
    : rightPanelToggleLabel;
  const browserRuntimeMode = props.browserRuntimeMode ?? "live";
  // The dock is the right-most surface when open, so its header sits under the
  // fixed Windows caption cluster — reserve the same gutter the chat header uses.
  const desktopTopBarWindowControlsGutterClassName = props.windowControlsGutterClassName;

  const keepMountedPaneIds = useKeepMountedPaneIds(props.state.panes, activePane);
  const visibleAddMenuKinds = resolveRightDockAddMenuKinds(props.addMenuKinds, props.launcherItems);
  // Codex keeps the right panel as a sibling pane by default, including the
  // empty quick-start state. The width button is the explicit full-width mode.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const regularWidthRatioRef = useRef<number | undefined>(undefined);
  const minWidth = props.minWidth;
  const activePaneKind = activePane?.kind ?? null;

  useLayoutEffect(() => {
    const wrapper = contentRef.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const host = props.layoutHostRef?.current ?? null;
    const mainContent = props.mainContentRef?.current ?? null;
    if (!wrapper || (panelFullWidth && (!host || !mainContent))) {
      return;
    }

    if (!props.state.open) {
      return;
    }

    const outerShell = resolveRightDockOuterShell(wrapper);
    const applyMeasuredWidth = () => {
      // Explicit chat hosts are measured outside the dock subtree. The legacy
      // regular-only caller uses the viewport fallback above; full width always
      // requires both explicit refs and therefore has no feedback path.
      const hostRect = host?.getBoundingClientRect();
      const outerShellRect = outerShell?.getBoundingClientRect();
      const mainContentWidth = hostRect
        ? Math.round(
            Math.max(
              0,
              Math.min(hostRect.right, outerShellRect?.right ?? hostRect.right) - hostRect.left,
            ),
          )
        : resolveRightDockStableWidth(props.layoutHostRef, wrapper);
      const shellHeight = Math.round(hostRect?.height ?? window.innerHeight);
      if (mainContentWidth <= 0 || shellHeight <= 0) {
        return;
      }

      if (panelFullWidth) {
        setInlineStyleIfChanged(wrapper, "--sidebar-width", `${mainContentWidth}px`);
        return;
      }

      const preferredWidth = activePaneKind
        ? RIGHT_DOCK_PREFERRED_WIDTH[activePaneKind]
        : undefined;
      const storedValue = getLocalStorageItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, Schema.Finite);
      if (preferredWidth !== undefined && storedValue == null) {
        setInlineStyleIfChanged(
          wrapper,
          "--sidebar-width",
          `${Math.max(minWidth, preferredWidth)}px`,
        );
        return;
      }

      if (regularWidthRatioRef.current === undefined) {
        regularWidthRatioRef.current = resolvePersistedRightDockWidthRatio({
          storedValue,
          defaultWidth: RIGHT_DOCK_DEFAULT_WIDTH,
          mainContentWidth,
          shellHeight,
          widthMode: "regular",
        });
      }

      const nextWidth = resolveRightDockWidthFromRatio(
        regularWidthRatioRef.current,
        mainContentWidth,
        "regular",
      );
      setInlineStyleIfChanged(wrapper, "--sidebar-width", `${nextWidth}px`);
    };

    applyMeasuredWidth();
    const resizeObserver = new ResizeObserver(applyMeasuredWidth);
    if (host) {
      resizeObserver.observe(host);
    } else {
      window.addEventListener("resize", applyMeasuredWidth);
    }
    if (outerShell && outerShell !== host) {
      resizeObserver.observe(outerShell);
    }
    return () => {
      resizeObserver.disconnect();
      if (!host) {
        window.removeEventListener("resize", applyMeasuredWidth);
      }
    };
  }, [
    activePaneKind,
    minWidth,
    panelFullWidth,
    props.layoutHostRef,
    props.mainContentRef,
    props.state.open,
  ]);

  const shouldAcceptRegularWidth = (context: {
    currentWidth: number;
    nextWidth: number;
    rail: HTMLButtonElement;
    side: "left" | "right";
    sidebarRoot: HTMLElement;
    wrapper: HTMLElement;
  }) => {
    const shellWidth = resolveRightDockStableWidth(props.layoutHostRef, context.wrapper);
    if (shellWidth > 0) {
      const { maximum } = resolveRightDockWidthBounds(shellWidth, "regular");
      if (context.nextWidth > maximum) {
        return false;
      }
    }
    return props.shouldAcceptWidth(context);
  };

  const persistRegularWidth = (width: number) => {
    const wrapper = contentRef.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const shellWidth = resolveRightDockStableWidth(props.layoutHostRef, wrapper);
    if (shellWidth <= 0) {
      return;
    }
    const ratio = normalizeRightDockWidth(width, shellWidth, "regular");
    regularWidthRatioRef.current = ratio;
    setLocalStorageItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, ratio, Schema.Finite);
  };
  const renderedPanes = props.state.panes.filter(
    (pane) => pane.id === activePane?.id || keepMountedPaneIds.has(pane.id),
  );
  // Motion allowance keyed to the current motionKey: a key change (reposition/
  // remount) derives straight back to "suppressed" in that same render, and the
  // rAF below re-enables motion once the suppressed frame has painted. Mounting
  // with the dock open starts suppressed for the same reason.
  const [motionState, setMotionState] = useState<{
    key: RightDockProps["motionKey"];
    allow: boolean;
  }>(() => ({ key: props.motionKey, allow: !props.state.open }));
  const shouldSuppressChromeMotion = !(motionState.key === props.motionKey && motionState.allow);

  useEffect(() => {
    if (!shouldSuppressChromeMotion) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      setMotionState({ key: props.motionKey, allow: true });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [props.motionKey, shouldSuppressChromeMotion]);

  // Right-panel motion intentionally owns its timing instead of inheriting the
  // 300ms shared sidebar curve. The gap and panel use one 500ms spring-like
  // width/opacity contract so the chat surface never outruns the dock.
  const chromeMotionClass = resolveRightDockChromeMotionClass({
    suppressMotion: shouldSuppressChromeMotion,
  });

  return (
    <SidebarProvider
      defaultOpen={false}
      open={props.state.open}
      onOpenChange={props.onOpenChange}
      mobileOpen={props.state.open}
      onMobileOpenChange={props.onOpenChange}
      className={cn(
        "w-auto min-h-0 flex-none bg-transparent",
        props.containerMode === "parent" && "h-full",
      )}
      data-testid="right-dock-provider"
      style={
        {
          "--sidebar-width": panelFullWidth ? "100%" : `${RIGHT_DOCK_DEFAULT_WIDTH}px`,
        } as CSSProperties
      }
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className={cn(
          chromeContract.panelClassName,
          chromeMotionClass,
          props.containerMode === "parent" && "absolute inset-y-0 h-full",
        )}
        innerClassName={CHAT_BACKGROUND_CLASS_NAME}
        gapClassName={chromeMotionClass}
        data-motion-bounce={RIGHT_DOCK_MOTION.bounce}
        data-motion-duration-ms={RIGHT_DOCK_MOTION.durationMs}
        data-motion-type={RIGHT_DOCK_MOTION.type}
        data-testid="right-dock-panel"
        transparentSurface
        {...(chromeContract.resizable
          ? {
              resizable: {
                minWidth: RIGHT_DOCK_MIN_WIDTH,
                onResize: persistRegularWidth,
                shouldAcceptWidth: shouldAcceptRegularWidth,
              },
            }
          : {})}
      >
        <div
          ref={contentRef}
          data-right-dock-content
          className="flex h-full min-h-0 w-full flex-col"
        >
          <div
            className={cn(
              CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
              "gap-1 px-1.5",
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            {activeMcpApp?.displayMode === "fullscreen" &&
            (activeMcpApp.canGoBack || activeMcpApp.canGoForward) ? (
              <McpAppNavigationControls
                className="h-full px-1"
                canGoBack={activeMcpApp.canGoBack}
                canGoForward={activeMcpApp.canGoForward}
                onNavigate={activeMcpApp.navigate}
              />
            ) : null}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {props.state.panes.map((pane) => (
                <RightDockTab
                  key={pane.id}
                  pane={pane}
                  label={
                    props.paneLabelOverrides?.[pane.id] ??
                    t(RIGHT_DOCK_LABEL_KEY_BY_KIND[pane.kind])
                  }
                  icon={props.paneIconOverrides?.[pane.id]}
                  active={activeMcpAppId === null && pane.id === props.state.activePaneId}
                  onSelect={onSelectPane ? () => onSelectPane(pane.id) : undefined}
                  onClose={() => props.onClosePane(pane.id)}
                />
              ))}
              {mcpAppEntries.map((entry) => (
                <RightDockTab
                  key={entry.id}
                  pane={entry}
                  label={entry.title}
                  active={entry.id === activeMcpAppId}
                  onSelect={() => props.onSelectMcpApp?.(entry.id)}
                  onClose={() => props.onCloseMcpApp?.(entry.id)}
                />
              ))}
            </div>
            {props.onFullWidthChange ? (
              <IconButton
                variant="chrome"
                size="icon-xs"
                label={panelWidthToggleLabel}
                tooltip={panelWidthToggleLabel}
                tooltipSide="bottom"
                className={cn(
                  DOCK_HEADER_ICON_BUTTON_CLASS,
                  panelFullWidth && CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
                )}
                aria-pressed={panelFullWidth}
                data-testid="right-dock-width-toggle"
                onClick={() => props.onFullWidthChange?.(!panelFullWidth)}
              >
                {panelFullWidth ? <RestorePanelWidthIcon /> : <Maximize2 />}
              </IconButton>
            ) : null}
            {props.state.panes.length > 0 && visibleAddMenuKinds.length > 0 ? (
              <Menu modal={false}>
                <MenuTrigger
                  render={
                    <Button
                      variant="chrome"
                      size="icon-xs"
                      aria-label={t("rightDock.addPanel")}
                      title={t("rightDock.addPanel")}
                      className={DOCK_HEADER_ICON_BUTTON_CLASS}
                    />
                  }
                >
                  <PlusIcon className="size-3.5" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
                  {visibleAddMenuKinds.map((kind) => {
                    const { Icon } = getRightDockPaneMeta(kind);
                    const label = t(RIGHT_DOCK_LABEL_KEY_BY_KIND[kind]);
                    return (
                      <MenuItem key={kind} onClick={() => props.onAddPane(kind)}>
                        <Icon className="size-3.5 shrink-0" />
                        <span>{label}</span>
                      </MenuItem>
                    );
                  })}
                </ComposerPickerMenuPopup>
              </Menu>
            ) : null}
            {props.state.panes.length > 0 && visibleAddMenuKinds.length === 0 && props.addAction ? (
              <IconButton
                variant="chrome"
                size="icon-xs"
                label={props.addAction.label}
                tooltip={props.addAction.label}
                tooltipSide="bottom"
                className={DOCK_HEADER_ICON_BUTTON_CLASS}
                onClick={props.addAction.onClick}
              >
                <PlusIcon className="size-3.5" />
              </IconButton>
            ) : null}
            {panelFullWidth ? (
              <>
                <IconButton
                  variant="chrome"
                  size="icon-xs"
                  label={bottomPanelToggleLabel}
                  title={bottomPanelToggleLabel}
                  tooltip={bottomPanelTooltip}
                  tooltipDelay={RIGHT_DOCK_FULL_WIDTH_CONTROL_TOOLTIP_DELAY_MS}
                  tooltipSide="bottom"
                  className={cn(
                    DOCK_HEADER_ICON_BUTTON_CLASS,
                    bottomPanelOpen && CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
                  )}
                  aria-pressed={bottomPanelOpen}
                  data-testid="chat-header-bottom-panel-toggle"
                  onClick={onToggleBottomPanel}
                >
                  {bottomPanelOpen ? (
                    <BottomPanelOpenIcon className="size-4" />
                  ) : (
                    <BottomPanelClosedIcon className="size-4" />
                  )}
                </IconButton>
                <IconButton
                  variant="chrome"
                  size="icon-xs"
                  label={rightPanelToggleLabel}
                  title={rightPanelToggleLabel}
                  tooltip={rightPanelTooltip}
                  tooltipDelay={RIGHT_DOCK_FULL_WIDTH_CONTROL_TOOLTIP_DELAY_MS}
                  tooltipSide="bottom"
                  className={cn(
                    DOCK_HEADER_ICON_BUTTON_CLASS,
                    CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
                  )}
                  aria-pressed={props.state.open}
                  data-testid="chat-header-right-dock-toggle"
                  onClick={props.onCollapse}
                >
                  <PanelRightOpenIcon />
                </IconButton>
              </>
            ) : null}
          </div>
          <div className="relative min-h-0 flex-1">
            {activePane === null && activeMcpApp === null && props.launcherItems ? (
              <RightDockLauncher items={props.launcherItems} onOpen={props.onAddPane} />
            ) : null}
            {renderedPanes.map((pane) => {
              const isActive = activeMcpAppId === null && pane.id === activePane?.id;
              const isVisible = isActive && props.state.open;
              // Keep-mounted panes that are not the active tab are already
              // hydrated; browser panes may use an explicit runtime mode so a
              // floating browser can own the live guest while the dock stays preview-only.
              const runtimeMode: DockPaneRuntimeMode =
                pane.kind === "browser"
                  ? browserRuntimeMode
                  : isActive
                    ? activePaneRuntimeMode
                    : "live";
              return (
                <div
                  key={pane.id}
                  className={cn(
                    "absolute inset-0 flex min-h-0 w-full",
                    isActive ? undefined : "invisible pointer-events-none",
                  )}
                  aria-hidden={isVisible ? undefined : true}
                  inert={isVisible ? undefined : true}
                  data-native-browser-surface={
                    pane.kind === "browser" && isActive && runtimeMode === "live"
                      ? "true"
                      : undefined
                  }
                >
                  {props.renderPane(pane, { runtimeMode, isActive, isVisible })}
                </div>
              );
            })}
            {mcpAppEntries.map((entry) => {
              const isActive = entry.id === activeMcpAppId;
              const isVisible = isActive && props.state.open;
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "absolute inset-0 min-h-0 w-full",
                    isActive ? undefined : "invisible pointer-events-none",
                  )}
                  aria-hidden={isVisible ? undefined : true}
                  inert={isVisible ? undefined : true}
                  data-mcp-app-dock-entry={entry.id}
                >
                  <McpAppDockPane entryId={entry.id} visible={isVisible} />
                </div>
              );
            })}
          </div>
        </div>
        {chromeContract.showSidebarRail ? <SidebarRail /> : null}
      </Sidebar>
    </SidebarProvider>
  );
}

function RightDockWithWindowControlsGutter(props: RightDockProps) {
  const gutter = useDesktopTopBarWindowControlsGutterClassName();
  return <RightDockSurface {...props} windowControlsGutterClassName={gutter} />;
}

export function RightDock(props: RightDockProps) {
  if (props.windowControlsGutterClassName !== undefined) {
    return (
      <RightDockSurface
        {...props}
        windowControlsGutterClassName={props.windowControlsGutterClassName}
      />
    );
  }
  return <RightDockWithWindowControlsGutter {...props} />;
}

export default RightDock;
