// FILE: ComposerExtrasPanel.tsx
// Purpose: Composer `+` panel — one flat "Add" list (files, frontmost app window, goal, and the
//   plan / debug / fast toggles) rendered with the shared command-menu panel chrome above the
//   composer. The window row captures the frontmost app directly; its trailing arrow (or
//   ArrowRight) opens the full window list as a second view.
// Layer: Chat composer presentation
// Depends on: ComposerMenuPanel chrome, the AppSnap window picker hook, caller-owned composer state.

import type { DesktopAppSnapWindowEntry, ProviderInteractionMode, ThreadId } from "@moss/contracts";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import {
  ArrowLeftIcon,
  BugIcon,
  CheckIcon,
  ChevronRightIcon,
  FastModeIcon,
  GoalIcon,
  ListTodoIcon,
  PaperclipIcon,
  PluginIcon,
  SparklesIcon,
  WindowIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import {
  COMPOSER_MENU_PANEL_GLYPH_CLASS_NAME,
  ComposerMenuPanel,
  type ComposerMenuPanelGroup,
  type ComposerMenuPanelRow,
} from "./ComposerMenuPanel";
import { useAppSnapWindows } from "./useAppSnapWindows";

/** Marks the `+` trigger so the panel's outside-press close does not fight the trigger's toggle. */
export const COMPOSER_EXTRAS_TRIGGER_ATTRIBUTE = "data-composer-extras-trigger";

const GLYPH = COMPOSER_MENU_PANEL_GLYPH_CLASS_NAME;

const ROW_FILES = "extras:files";
const ROW_WINDOW = "extras:window";
const ROW_GOAL = "extras:goal";
const ROW_PLUGINS = "extras:plugins";
const ROW_DISCOVER = "extras:discover";
const ROW_PLAN = "extras:mode:plan";
const ROW_DEBUG = "extras:mode:debug";
const ROW_FAST = "extras:fast";
const ROW_BACK = "extras:back";
const WINDOW_ROW_PREFIX = "extras:window:";
const STARTER_ROW_PREFIX = "extras:starter:";
const ROW_DISCOVER_PLUGINS = "extras:discover-plugins";

const CHECK = <CheckIcon className="size-4 text-foreground/70" />;

function windowGlyph(entry: DesktopAppSnapWindowEntry): ReactNode {
  const iconSrc = entry.appIconDataUrl ?? entry.iconDataUrl ?? null;
  return iconSrc ? (
    <img
      src={iconSrc}
      alt=""
      draggable={false}
      className="size-4 shrink-0 rounded-inline object-contain"
    />
  ) : (
    <WindowIcon className={GLYPH} />
  );
}

function formatComposerAppSnapName(entry: DesktopAppSnapWindowEntry): string | null {
  const raw = entry.appName?.trim();
  if (!raw || /^applicationframehost(?:\.exe)?$/iu.test(raw)) {
    const title = entry.windowTitle?.trim();
    return title && title.length > 0 ? title : null;
  }
  const stripped = raw.replace(/\.(?:exe|com)$/iu, "").trim();
  return stripped.length > 0 ? stripped : null;
}

export interface ComposerExtrasStarterItem {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

export function ComposerExtrasPanel(props: {
  interactionMode: ProviderInteractionMode;
  supportsFastMode: boolean;
  fastModeEnabled: boolean;
  threadId?: ThreadId;
  onAddAttachments: (files: File[]) => void;
  onToggleFastMode: () => void;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  /** Turns the draft into a `/goal` command so the goal chip flow is the same as typing it. */
  onInsertGoal: () => void;
  /** Opens Moss's unified Plugins & Apps marketplace. */
  onOpenPlugins?: (() => void) | undefined;
  /** Curated Moss Guide starter workflows exposed when `moss-guide` is installed. */
  mossGuideStarters?: ReadonlyArray<ComposerExtrasStarterItem> | undefined;
  /** Sends or prefills a chosen starter prompt. */
  onSelectStarterPrompt?: ((prompt: string) => void) | undefined;
  onClose: () => void;
  panelId: string;
}) {
  const { format, t } = useTranslation();
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<"root" | "windows" | "discover">("root");
  const [activeRowId, setActiveRowId] = useState<string | null>(ROW_FILES);

  // Listed while the panel is open (not only in the window view) so the root row can
  // name the frontmost app and capture it in one click.
  const appSnap = useAppSnapWindows({
    open: true,
    ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
  });
  const firstWindow = appSnap.windows?.[0] ?? null;
  // An app can place untitled auxiliary windows above its document. Stay within
  // the first app's public identity; without it, do not guess from the app name.
  const frontmostWindow =
    (firstWindow?.bundleIdentifier
      ? appSnap.windows?.find(
          (entry) => entry.bundleIdentifier === firstWindow.bundleIdentifier && entry.windowTitle,
        )
      : null) ?? firstWindow;
  const frontmostAppName = frontmostWindow ? formatComposerAppSnapName(frontmostWindow) : null;

  const openWindows = () => {
    setView("windows");
    setActiveRowId(ROW_BACK);
  };
  const openDiscover = () => {
    setView("discover");
    setActiveRowId(ROW_BACK);
  };
  const goBack = () => {
    const returnRowId =
      view === "discover" ? ROW_DISCOVER : appSnap.available ? ROW_WINDOW : ROW_FILES;
    setView("root");
    setActiveRowId(returnRowId);
  };

  const starterItems = props.mossGuideStarters ?? [];
  const groups: ComposerMenuPanelGroup[] =
    view === "windows"
      ? [
          {
            id: "windows",
            label: "Attach window",
            rows: [
              { id: ROW_BACK, icon: <ArrowLeftIcon className={GLYPH} />, title: "Back" },
              ...appSnapWindowRows(appSnap),
            ],
          },
        ]
      : view === "discover"
        ? [
            {
              id: "discover",
              label: t("composer.extras.discoverMoss"),
              rows: [
                { id: ROW_BACK, icon: <ArrowLeftIcon className={GLYPH} />, title: "Back" },
                ...starterItems.map((starter) => ({
                  id: `${STARTER_ROW_PREFIX}${starter.id}`,
                  icon: <SparklesIcon className={GLYPH} />,
                  title: starter.label,
                })),
                ...(props.onOpenPlugins
                  ? [
                      {
                        id: ROW_DISCOVER_PLUGINS,
                        icon: <PluginIcon className={GLYPH} />,
                        title: t("composer.extras.browsePlugins"),
                      },
                    ]
                  : []),
              ],
            },
          ]
        : [
            {
              id: "add",
              label: "Add",
              rows: [
                {
                  id: ROW_FILES,
                  icon: <PaperclipIcon className={GLYPH} />,
                  title: "Files and folders",
                },
                ...(appSnap.available
                  ? [
                      frontmostWindow
                        ? {
                            id: ROW_WINDOW,
                            icon: windowGlyph(frontmostWindow),
                            title: format("composer.extras.attachApp", {
                              app: frontmostAppName || t("composer.extras.windowFallback"),
                            }),
                            disabled: appSnap.busy,
                            trailing: (
                              <button
                                type="button"
                                aria-label="Choose another window"
                                className={cn(
                                  "-mr-1 flex size-5 items-center justify-center rounded-control text-muted-foreground/60 transition-colors",
                                  "hover:bg-[var(--color-background-button-secondary)] hover:text-foreground/80",
                                )}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openWindows();
                                }}
                              >
                                <ChevronRightIcon className="size-4" />
                              </button>
                            ),
                          }
                        : {
                            id: ROW_WINDOW,
                            icon: <WindowIcon className={GLYPH} />,
                            title: "Attach window",
                            trailing: <ChevronRightIcon className="size-4" />,
                          },
                    ]
                  : []),
                {
                  id: ROW_GOAL,
                  icon: <GoalIcon className={GLYPH} />,
                  title: "Goal",
                },
                ...(starterItems.length > 0
                  ? [
                      {
                        id: ROW_DISCOVER,
                        icon: <SparklesIcon className={GLYPH} />,
                        title: t("composer.extras.discoverMoss"),
                        trailing: <ChevronRightIcon className="size-4" />,
                      },
                    ]
                  : []),
                ...(props.onOpenPlugins
                  ? [
                      {
                        id: ROW_PLUGINS,
                        icon: <PluginIcon className={GLYPH} />,
                        title: t("composer.extras.appsAndPlugins"),
                      },
                    ]
                  : []),
                {
                  id: ROW_PLAN,
                  icon: <ListTodoIcon className={GLYPH} />,
                  title: "Plan mode",
                  trailing: props.interactionMode === "plan" ? CHECK : null,
                },
                {
                  id: ROW_DEBUG,
                  icon: <BugIcon className={GLYPH} />,
                  title: "Debug mode",
                  trailing: props.interactionMode === "debug" ? CHECK : null,
                },
                ...(props.supportsFastMode
                  ? [
                      {
                        id: ROW_FAST,
                        icon: <FastModeIcon className={GLYPH} />,
                        title: "Fast mode",
                        trailing: props.fastModeEnabled ? CHECK : null,
                      },
                    ]
                  : []),
              ],
            },
          ];

  const selectableRowIds = groups.flatMap((group) =>
    group.rows.filter((row) => !row.disabled).map((row) => row.id),
  );
  // Keep the highlight on a row that still exists after navigating between views.
  const highlightedRowId =
    activeRowId && selectableRowIds.includes(activeRowId)
      ? activeRowId
      : (selectableRowIds[0] ?? null);

  const selectRow = (rowId: string) => {
    if (rowId === ROW_FILES) {
      fileInputRef.current?.click();
      return;
    }
    if (rowId === ROW_WINDOW) {
      if (frontmostWindow) {
        appSnap.captureWindow(frontmostWindow.windowId);
        props.onClose();
      } else {
        openWindows();
      }
      return;
    }
    if (rowId === ROW_BACK) {
      goBack();
      return;
    }
    if (rowId === ROW_GOAL) {
      props.onInsertGoal();
      props.onClose();
      return;
    }
    if (rowId === ROW_DISCOVER) {
      openDiscover();
      return;
    }
    if (rowId === ROW_PLUGINS || rowId === ROW_DISCOVER_PLUGINS) {
      props.onOpenPlugins?.();
      props.onClose();
      return;
    }
    if (rowId.startsWith(STARTER_ROW_PREFIX)) {
      const starterId = rowId.slice(STARTER_ROW_PREFIX.length);
      const starter = starterItems.find((entry) => entry.id === starterId);
      if (starter) {
        props.onSelectStarterPrompt?.(starter.prompt);
      }
      props.onClose();
      return;
    }
    if (rowId === ROW_PLAN || rowId === ROW_DEBUG) {
      const mode: ProviderInteractionMode = rowId === ROW_PLAN ? "plan" : "debug";
      props.onInteractionModeChange(props.interactionMode === mode ? "default" : mode);
      props.onClose();
      return;
    }
    if (rowId === ROW_FAST) {
      props.onToggleFastMode();
      props.onClose();
      return;
    }
    if (rowId.startsWith(WINDOW_ROW_PREFIX)) {
      const windowId = Number.parseInt(rowId.slice(WINDOW_ROW_PREFIX.length), 10);
      if (Number.isFinite(windowId)) {
        appSnap.captureWindow(windowId);
        props.onClose();
      }
    }
  };

  // The composer editor keeps focus while the panel is open so the user can keep typing;
  // the panel therefore claims only its own navigation keys, in capture phase, so Enter
  // cannot reach the composer form and send the draft.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeComposingKeyEvent(event)) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "Enter" || event.key === "Tab") {
        if (!highlightedRowId) return;
        event.preventDefault();
        event.stopPropagation();
        selectRow(highlightedRowId);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (view === "windows" || view === "discover") {
          goBack();
        } else {
          props.onClose();
        }
        return;
      }

      if (event.key === "ArrowRight" && view === "root") {
        if (highlightedRowId === ROW_WINDOW) {
          event.preventDefault();
          event.stopPropagation();
          openWindows();
          return;
        }
        if (highlightedRowId === ROW_DISCOVER) {
          event.preventDefault();
          event.stopPropagation();
          openDiscover();
          return;
        }
      }
      if (event.key === "ArrowLeft" && (view === "windows" || view === "discover")) {
        event.preventDefault();
        event.stopPropagation();
        goBack();
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (selectableRowIds.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = highlightedRowId ? selectableRowIds.indexOf(highlightedRowId) : -1;
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          (currentIndex + offset + selectableRowIds.length) % selectableRowIds.length;
        setActiveRowId(selectableRowIds[nextIndex] ?? null);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest(`[${COMPOSER_EXTRAS_TRIGGER_ATTRIBUTE}]`) !== null
      ) {
        return;
      }
      props.onClose();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  });

  // Reset the hidden input so selecting the same file twice still emits a change event.
  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      props.onAddAttachments(files);
    }
    event.target.value = "";
    props.onClose();
  };

  return (
    // As wide as its rows, not the whole composer: a short menu reads as one (walk D-9).
    <div
      ref={containerRef}
      id={props.panelId}
      data-testid="composer-extras-panel"
      className="w-max min-w-56 max-w-full"
    >
      <input
        id={inputId}
        ref={fileInputRef}
        data-testid="composer-file-input"
        data-moss-visible-attachment-input="true"
        type="file"
        multiple
        className="sr-only"
        onChange={handleFileInputChange}
      />
      <ComposerMenuPanel
        groups={groups}
        activeRowId={highlightedRowId}
        onHighlightRow={setActiveRowId}
        onSelectRow={selectRow}
      />
    </div>
  );
}

function appSnapWindowRows(appSnap: ReturnType<typeof useAppSnapWindows>): ComposerMenuPanelRow[] {
  if (appSnap.unavailableMessage) {
    return [{ id: "extras:window-status", title: appSnap.unavailableMessage, disabled: true }];
  }
  if (appSnap.windows === null) {
    return [{ id: "extras:window-status", title: "Loading windows…", disabled: true }];
  }
  if (appSnap.windows.length === 0) {
    return [
      {
        id: "extras:window-status",
        title: "No other app windows are visible.",
        disabled: true,
      },
    ];
  }

  return appSnap.windows.map((entry) => {
    const title = formatComposerAppSnapName(entry) || "Captured app";
    const rawSecondary = entry.windowTitle?.trim() || null;
    const secondary =
      rawSecondary && rawSecondary.localeCompare(title, undefined, { sensitivity: "accent" }) !== 0
        ? rawSecondary
        : null;
    return {
      id: `${WINDOW_ROW_PREFIX}${entry.windowId}`,
      icon: windowGlyph(entry),
      title,
      secondary,
      disabled: appSnap.busy,
    };
  });
}
