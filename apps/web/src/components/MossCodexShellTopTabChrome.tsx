// FILE: MossCodexShellTopTabChrome.tsx
// Purpose: Codex Desktop 26.924.22138 shell top Tab chrome 1:1 (Helios red-box):
//          back/forward/refresh · multi-tabs · + · Share · … · trailing actions.
//          Brand strings = Moss. Layout/IA matches official Codex Images shot.
// Layer: Web shell chrome (Images destination primary host; reusable)

import { useMemo, useState } from "react";

import { goBackInAppHistory, goForwardInAppHistory, useAppNavigationState } from "~/appNavigation";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChatBubbleIcon,
  ClockIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  PanelLeftIcon,
  PanelRightCloseIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  ShareIcon,
  SparklesIcon,
  XIcon,
} from "~/lib/icons";
import {
  ArchiveTrayIcon,
  ArrowUpRightLineIcon,
  CirclePlusIcon,
  CompassLineIcon,
  ExpandArrowsIcon,
  LayoutWindowIcon,
  ListBulletsIcon,
} from "./auth/mossIcons";
import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { usePinnedThreadsStore } from "~/pinnedThreadsStore";

import { AppNavigationButtons } from "./AppNavigationButtons";
import { Button } from "./ui/button";
import {
  Menu,
  MenuItem,
  MenuPopupBase,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { TAB_IDLE_SURFACE_CLASS_NAME, TAB_SELECTED_SURFACE_CLASS_NAME } from "~/surfaceStyles";

export interface MossShellTab {
  readonly id: string;
  readonly title: string;
  readonly active?: boolean;
  /** Optional glyph hint: "image" | "chat" | "prompt" */
  readonly kind?: "image" | "chat" | "prompt" | "draft";
}

export interface MossCodexShellTopTabChromeProps {
  readonly tabs: readonly MossShellTab[];
  readonly onSelectTab?: (tabId: string) => void;
  readonly onCloseTab?: (tabId: string) => void;
  readonly onNewTab?: () => void;
  readonly onShare?: () => void;
  readonly onMore?: () => void;
  /** Opens the shell feature action represented by the trailing sparkle. */
  readonly onFeatures?: () => void;
  /** Called by the active tab's trailing ellipsis menu. */
  readonly onTabMenuAction?: (action: MossShellTabMenuAction, value?: string) => void;
  /** Toggles the secondary sidebar, matching the Codex split-panel control. */
  readonly onToggleSidebar?: () => void;
  /** Toggles a distinct right-side panel when the destination owns one. */
  readonly onToggleRightSidebar?: () => void;
  /** Keeps the official trailing split-panel slot visible while unavailable. */
  readonly showRightSidebarControl?: boolean;
  /** Installed editors for the 打开方式 submenu (id + display label). */
  readonly editorOptions?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** Active-tab split affordance (Codex ≡ on the active chat tab → right pane). */
  readonly onSplitRight?: () => void;
  /** Pop the active tab's surface into a new window (Codex multi-tab ⤢ control). */
  readonly onPopOutTab?: () => void;
  /** Codex multi-tab ⊟: hides the tab pills row, keeping the nav cluster + restore. */
  readonly stripCollapsed?: boolean;
  readonly onToggleStripCollapsed?: () => void;
  /**
   * Codex default new-chat state: only the leading [← → ▤] cluster renders —
   * no tab strip, no +, no trailing actions. Tabs and actions appear once a
   * conversation exists.
   */
  readonly bare?: boolean;
  readonly className?: string;
  /** When true, reserve leading gutter for macOS traffic lights (Electron). */
  readonly trafficLightGutter?: boolean;
  /**
   * Prefer always-visible ← → (Codex) over AppNavigationButtons Electron-gate.
   * Default true for Images destination parity with dest-images / shot 01.
   */
  readonly forceNavButtons?: boolean;
  /** When true, the leading cluster reserves the rail + open sidebar column
   * so the first tab starts at the main surface edge, like Codex. */
  readonly continuousShell?: boolean;
}

/** Stable action ids for the tab menu. Keeping these ids separate from labels lets
 * destinations reuse the shell without coupling presentation to their copy. */
export type MossShellTabMenuAction =
  | "rename"
  | "pin"
  | "archive"
  | "copy-link"
  | "copy-markdown"
  | "copy-cwd"
  | "new-child"
  | "branch-local"
  | "branch-worktree"
  | "schedule"
  | "move-right-panel"
  | "open-with"
  | "open-new-window"
  | "toggle-summary";

// Codex's application titlebar is the same 46px token used by the chat-surface
// headers and native caption controls. Keeping the global strip on that token
// prevents a one- or two-pixel seam when it overlays route-owned headers.
const SHELL_TOPBAR_HEIGHT_CLASS = "h-[46px]";
const SHELL_NAV_CLUSTER_CLASS = "w-[15.8125rem]";
const SHELL_TAB_ACTIVE_CLASS = "w-auto max-w-[14.75rem]";
/** Icon buttons on the shell band: muted at rest, full ink on a faint tint when hovered. */
const SHELL_ICON_BUTTON_TONE_CLASS =
  "text-muted-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] hover:text-foreground";
const SHELL_TAB_INACTIVE_CLASS = "w-auto max-w-[15.5rem]";

function TabGlyph({ kind }: { kind?: MossShellTab["kind"] }) {
  if (kind === "draft") {
    return <CompassLineIcon aria-hidden className="size-3.5 shrink-0 text-current/70" />;
  }
  if (kind === "chat") {
    return <ChatBubbleIcon aria-hidden className="size-3.5 shrink-0 text-current/70" />;
  }
  if (kind === "image" || kind === "prompt") {
    return (
      <span
        aria-hidden
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-foreground/25"
      >
        <span className="size-1.5 rounded-full bg-foreground/50" />
      </span>
    );
  }
  return <span aria-hidden className="size-3.5 shrink-0 rounded-sm bg-foreground/20" />;
}

/**
 * Codex-matching window top chrome. Observed on
 * `helios-ui-gap-20260928/01-codex-top-tabs-images.png` and empty dest-images frames.
 */
export function MossCodexShellTopTabChrome({
  tabs,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onShare,
  onMore,
  onFeatures,
  onTabMenuAction,
  onToggleSidebar,
  onToggleRightSidebar,
  showRightSidebarControl = false,
  editorOptions,
  onPopOutTab,
  stripCollapsed = false,
  onToggleStripCollapsed,
  bare = false,
  className,
  trafficLightGutter = true,
  forceNavButtons = true,
  continuousShell = false,
}: MossCodexShellTopTabChromeProps) {
  const { resolvedTheme } = useTheme();
  const { canGoBack, canGoForward } = useAppNavigationState();
  const [rightSidebarActive, setRightSidebarActive] = useState(false);
  const activeTitle = useMemo(
    () => tabs.find((tab) => tab.active)?.title ?? tabs[0]?.title ?? "图像",
    [tabs],
  );
  const activeTabId = tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id;
  const conversationTab = tabs.find((tab) => (tab.kind ?? "chat") === "chat");
  const extraTabs = tabs.filter((tab) => tab !== conversationTab);
  // Codex: a lone conversation tab pins its actions to the strip's right edge;
  // once a second tab exists everything packs left and the multi-tab controls
  // (pop-out / hide-tabs) take the right edge.
  const multiTab = tabs.length >= 2;
  const activeTabPinned = usePinnedThreadsStore((store) =>
    activeTabId ? (store.pinnedThreadIds as readonly string[]).includes(activeTabId) : false,
  );

  // Chat-tab actions (menu + conversation-sidebar toggle). Rendered inline after the
  // conversation tab in multi-tab mode, or in the right-pinned cluster for a lone tab.
  const chatActionsCluster = (
    <>
      {onTabMenuAction && activeTabId ? (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-current/65 hover:bg-black/[0.08] hover:text-current dark:hover:bg-white/10",
                )}
                aria-label={`More actions for ${activeTitle}`}
                data-moss-tab-action="more"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopupBase
            align="start"
            side="bottom"
            sideOffset={4}
            className="w-[220px] min-w-[220px]"
          >
            <MenuItem onClick={() => onTabMenuAction("rename")}>
              <PencilIcon className="size-4" />
              <span>重命名</span>
              <MenuShortcut>⌥⌘R</MenuShortcut>
            </MenuItem>
            <MenuItem onClick={() => onTabMenuAction("pin")}>
              <PinIcon className="size-4" />
              <span>{activeTabPinned ? "取消置顶" : "置顶"}</span>
              <MenuShortcut>⌥⌘P</MenuShortcut>
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => onTabMenuAction("new-child")}>
              <CirclePlusIcon className="size-4" />
              <span>新建侧边聊天</span>
              <MenuShortcut>⌥⌘S</MenuShortcut>
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <GitBranchIcon className="size-4" />
                <span>分叉</span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-56 min-w-56">
                <MenuItem onClick={() => onTabMenuAction("branch-local")}>创建聊天分支</MenuItem>
                <MenuItem onClick={() => onTabMenuAction("branch-worktree")}>
                  在新工作树中创建聊天分支
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
            <MenuItem onClick={() => onTabMenuAction("schedule")}>
              <ClockIcon className="size-4" />
              <span>添加计划任务…</span>
            </MenuItem>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>
                <CopyIcon className="size-4" />
                <span>复制</span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-52 min-w-52">
                <MenuItem onClick={() => onTabMenuAction("copy-link")}>
                  <CopyIcon className="size-4" />
                  <span>复制深度链接</span>
                  <MenuShortcut>⌥⌘L</MenuShortcut>
                </MenuItem>
                <MenuItem onClick={() => onTabMenuAction("copy-markdown")}>
                  <CopyIcon className="size-4" />
                  <span>复制为 Markdown</span>
                </MenuItem>
                <MenuItem onClick={() => onTabMenuAction("copy-cwd")}>
                  <CopyIcon className="size-4" />
                  <span>复制工作目录</span>
                  <MenuShortcut>⌥⇧C</MenuShortcut>
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
            <MenuSeparator />
            <MenuItem onClick={() => onTabMenuAction("move-right-panel")}>
              <ArrowRightIcon className="size-4" />
              <span>移至右侧面板</span>
            </MenuItem>
            <MenuItem onClick={() => onTabMenuAction("open-new-window")}>
              <ExternalLinkIcon className="size-4" />
              <span>在新窗口中打开</span>
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <ArrowUpRightLineIcon className="size-4" />
                <span>打开方式</span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-48 min-w-48">
                {(editorOptions ?? []).length > 0 ? (
                  (editorOptions ?? []).map((editor) => (
                    <MenuItem
                      key={editor.id}
                      onClick={() => onTabMenuAction("open-with", editor.id)}
                    >
                      {editor.label}
                    </MenuItem>
                  ))
                ) : (
                  <MenuItem disabled>未检测到可用编辑器</MenuItem>
                )}
              </MenuSubPopup>
            </MenuSub>
            <MenuSeparator />
            <MenuItem onClick={() => onTabMenuAction("archive")}>
              <ArchiveTrayIcon className="size-4" />
              <span>归档</span>
              <MenuShortcut>⌥⇧⌘A</MenuShortcut>
            </MenuItem>
          </MenuPopupBase>
        </Menu>
      ) : null}
      {onToggleSidebar ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("size-7 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                aria-label="切换对话侧边栏"
                data-moss-tab-action="toggle-thread-list"
                onClick={() => onToggleSidebar()}
              />
            }
          >
            <ListBulletsIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">切换对话侧边栏</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );

  const stripSeparator = (
    <span aria-hidden className="mx-0.5 h-4 w-px bg-[var(--app-chrome-divider-color)]" />
  );

  return (
    <header
      data-moss-codex-top-tab-chrome
      data-active-tab-title={activeTitle}
      data-moss-theme={resolvedTheme}
      className={cn(
        `flex ${SHELL_TOPBAR_HEIGHT_CLASS} shrink-0 items-center border-b-0 border-transparent bg-[var(--app-rail-shell-background,var(--background))] px-2 text-foreground [-webkit-app-region:drag]`,
        trafficLightGutter && "ps-[max(0.5rem,var(--desktop-top-bar-traffic-light-gutter,5.5rem))]",
        className,
      )}
      aria-label="Moss window tabs"
    >
      <div
        className={cn(
          `flex h-full shrink-0 items-center gap-1.5 border-e-0 pe-2 [-webkit-app-region:no-drag]`,
          continuousShell ? "w-[var(--moss-shell-leading-cluster-width)]" : SHELL_NAV_CLUSTER_CLASS,
          "border-[color:var(--app-chrome-divider-color)]",
        )}
      >
        {forceNavButtons ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-6 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                    aria-label="Back"
                    data-moss-top-action="back"
                    disabled={!canGoBack}
                    onClick={() => goBackInAppHistory()}
                  />
                }
              >
                <ArrowLeftIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Back</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-6 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                    aria-label="Forward"
                    data-moss-top-action="forward"
                    disabled={!canGoForward}
                    onClick={() => goForwardInAppHistory()}
                  />
                }
              >
                <ArrowRightIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Forward</TooltipPopup>
            </Tooltip>
          </>
        ) : (
          <AppNavigationButtons />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("size-6 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                aria-label="Toggle sidebar"
                data-moss-top-action="toggle-sidebar"
                disabled={!onToggleSidebar}
                onClick={() => onToggleSidebar?.()}
              />
            }
          >
            <PanelLeftIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Sidebar</TooltipPopup>
        </Tooltip>
      </div>

      {!bare && !stripCollapsed ? (
        <div
          role="tablist"
          aria-label="聊天标签"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-px overflow-x-auto [scrollbar-width:none] [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden",
            // The official controller gives a populated tab strip one `ps-1.5`
            // leading inset. Keep the tab bubble just inside the main surface
            // seam when this strip owns the whole shell.
            continuousShell && "ps-1.5",
          )}
        >
          {[...(conversationTab ? [conversationTab] : []), ...extraTabs].map((tab) => {
            const active = Boolean(tab.active);
            const isConversation = tab === conversationTab;
            return (
              <div key={tab.id} className="contents">
                <div
                  role="presentation"
                  data-moss-shell-tab={tab.id}
                  data-active={active ? "true" : "false"}
                  className={cn(
                    "group/moss-tab flex h-8 shrink-0 items-center gap-1.5 rounded-control px-3 text-ui-sm",
                    active
                      ? `${SHELL_TAB_ACTIVE_CLASS} ${TAB_SELECTED_SURFACE_CLASS_NAME} font-medium shadow-none`
                      : `${SHELL_TAB_INACTIVE_CLASS} ${TAB_IDLE_SURFACE_CLASS_NAME}`,
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    title={tab.title}
                    onClick={() => onSelectTab?.(tab.id)}
                  >
                    <TabGlyph kind={tab.kind} />
                    <span className="min-w-0 truncate">{tab.title}</span>
                  </button>
                  {tab !== conversationTab && onCloseTab ? (
                    <button
                      type="button"
                      className={cn(
                        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm transition-opacity",
                        active
                          ? "opacity-100 hover:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
                          : "opacity-0 group-hover/moss-tab:opacity-100",
                      )}
                      aria-label={`Close ${tab.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                    >
                      <XIcon className="size-3" />
                    </button>
                  ) : null}
                </div>
                {isConversation && multiTab && onTabMenuAction ? (
                  <span
                    key="chat-actions"
                    className="flex shrink-0 items-center gap-0.5 ps-1 [-webkit-app-region:no-drag]"
                  >
                    {chatActionsCluster}
                    {stripSeparator}
                  </span>
                ) : null}
              </div>
            );
          })}

          {onNewTab && (multiTab || !conversationTab) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "ms-1 size-7 shrink-0 rounded-control",
                      SHELL_ICON_BUTTON_TONE_CLASS,
                    )}
                    aria-label="New tab"
                    data-moss-top-action="new-tab"
                    onClick={() => onNewTab?.()}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">New tab</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {!bare && !stripCollapsed && !multiTab && conversationTab ? (
        <div className="ms-auto flex shrink-0 items-center gap-1 ps-1 [-webkit-app-region:no-drag]">
          {chatActionsCluster}
          {stripSeparator}
          {onNewTab ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-7 shrink-0 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                    aria-label="New tab"
                    data-moss-top-action="new-tab"
                    onClick={() => onNewTab?.()}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">New tab</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {!bare && !stripCollapsed && multiTab ? (
        <div className="ms-auto flex shrink-0 items-center gap-1 ps-1 [-webkit-app-region:no-drag]">
          {onPopOutTab ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-7 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                    aria-label="在新窗口中打开标签页"
                    data-moss-tab-action="pop-out-tab"
                    onClick={() => onPopOutTab()}
                  />
                }
              >
                <ExpandArrowsIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">在新窗口中打开标签页</TooltipPopup>
            </Tooltip>
          ) : null}
          {onToggleStripCollapsed ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-7 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                    aria-label="隐藏标签页"
                    data-moss-tab-action="collapse-strip"
                    onClick={() => onToggleStripCollapsed()}
                  />
                }
              >
                <LayoutWindowIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">隐藏标签页</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {!bare && stripCollapsed ? (
        <div className="ms-auto flex shrink-0 items-center gap-1 ps-1 [-webkit-app-region:no-drag]">
          {onToggleStripCollapsed ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-7 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                    aria-label="显示标签页"
                    data-moss-tab-action="expand-strip"
                    onClick={() => onToggleStripCollapsed()}
                  />
                }
              >
                <LayoutWindowIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">显示标签页</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {!bare ? (
        <div className="flex shrink-0 items-center gap-1.5 px-1 [-webkit-app-region:no-drag]">
          {onShare ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-7 gap-1 rounded-control px-2 text-ui-sm",
                      SHELL_ICON_BUTTON_TONE_CLASS,
                    )}
                    aria-label="分享"
                    data-moss-top-action="share"
                    onClick={() => onShare()}
                  />
                }
              >
                <ShareIcon className="size-3.5" />
                <span>分享</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">分享</TooltipPopup>
            </Tooltip>
          ) : null}
          {onMore ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-7 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                    aria-label="More"
                    data-moss-top-action="more"
                    onClick={() => onMore()}
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">More</TooltipPopup>
            </Tooltip>
          ) : null}
          {onFeatures ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-7 rounded-control", SHELL_ICON_BUTTON_TONE_CLASS)}
                    aria-label="Moss features"
                    data-moss-top-action="features"
                    onClick={() => onFeatures?.()}
                  />
                }
              >
                <SparklesIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Features</TooltipPopup>
            </Tooltip>
          ) : null}
          {onToggleRightSidebar || showRightSidebarControl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "size-7 rounded-control",
                      SHELL_ICON_BUTTON_TONE_CLASS,
                      rightSidebarActive && TAB_SELECTED_SURFACE_CLASS_NAME,
                    )}
                    aria-label={
                      onToggleRightSidebar ? "Toggle right sidebar" : "Right sidebar unavailable"
                    }
                    aria-pressed={rightSidebarActive}
                    data-moss-top-action="toggle-right-sidebar"
                    disabled={!onToggleRightSidebar}
                    onClick={() => {
                      setRightSidebarActive((current) => !current);
                      onToggleRightSidebar?.();
                    }}
                  />
                }
              >
                <PanelRightCloseIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {onToggleRightSidebar ? "Right sidebar" : "Right sidebar unavailable"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
