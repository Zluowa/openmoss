// FILE: EnvironmentPanel.tsx
// Purpose: The chat's summary card, laid out like the upstream thread-details card:
//          a workspace group (where the chat runs + reveal folder, "Open in <editor>",
//          project scripts), a version-control group (branch, commit, changes), Moss's
//          own sections, and the context-window line. Right-click chooses the sections.
//          It consolidates the chat-header diff toggle,
//          the composer-footer env/branch pickers, the header git actions, and the
//          "Open in editor" controls into one vertical list of full-width rows. Always
//          rendered as the same rounded floating card; the only difference is whether it
//          overlays pinned top-right of the chat column (p-3 gutters). Full-width single
//          chat also reserves transcript/composer inset; split panes and an open right dock
//          use floating overlay only. The card surface and content are identical either way.
// Layer: Environment panel container

import { SidePanelOverlay } from "~/components/chat/SidePanelOverlay";
import type {
  AutomationDefinition,
  EditorId,
  MessageId,
  PinnedMessage,
  ProjectId,
  ProjectScript,
  ProviderInstanceId,
  ProviderKind,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@moss/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { useAppSettings } from "~/appSettings";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import BranchToolbar, { type BranchToolbarProps } from "~/components/BranchToolbar";
import ChatMarkdown from "~/components/ChatMarkdown";
import GitActionsControl from "~/components/GitActionsControl";
import { DiffStat } from "~/components/ui/diff-stat";
import { IconButton } from "~/components/ui/icon-button";
import { toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { basenameOfPath } from "~/file-icons";
import type { RepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { ChangesIcon, ExternalLinkIcon, GitHubIcon, FolderIcon } from "~/lib/icons";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { useTranslation } from "~/localization";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
} from "~/components/ProjectScriptsControl";
import { readNativeApi } from "~/nativeApi";
import { revealFolderInShell } from "~/lib/revealFolder";
import { deleteActiveThreadFromClient } from "~/lib/activeThreadDelete";
import { gitRemoveWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { waitForSidechatCreator } from "~/lib/sidechatCreatorRegistry";
import { useComposerDraftStore } from "~/composerDraftStore";
import { showConfirmDialogFallback } from "~/confirmDialogFallback";
import { usePinnedThreadsStore } from "~/pinnedThreadsStore";
import { useSplitViewStore } from "~/splitViewStore";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useTemporaryThreadStore } from "~/temporaryThreadStore";
import { useRightDockStore } from "~/rightDockStore";

import { EnvironmentEditorSection } from "./EnvironmentEditorSection";
import {
  EnvironmentAutomationsSection,
  type EnvironmentAutomationPanelItem,
} from "./EnvironmentAutomationsSection";
import { EnvironmentUsageSection } from "./EnvironmentUsageSection";
import { EnvironmentContextSection } from "./EnvironmentContextSection";
import { EnvironmentLocalServersSection } from "./EnvironmentLocalServersSection";
import { EnvironmentPullRequestSection } from "./EnvironmentPullRequestSection";
import { EnvironmentStudioOutputsSection } from "./EnvironmentStudioOutputsSection";
import {
  EnvironmentSidechatsSection,
  type EnvironmentSidechatPanelItem,
} from "./EnvironmentSidechatsSection";
import { EnvironmentSubagentsSection } from "./EnvironmentSubagentsSection";
import type { EnvironmentSubagentRoster } from "./EnvironmentSubagentsSection.logic";
import { EnvironmentNotesSection } from "./EnvironmentNotesSection";
import { EnvironmentPinnedSection } from "./EnvironmentPinnedSection";
import { EnvironmentProjectInstructionsSection } from "./EnvironmentProjectInstructionsSection";
import { ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME } from "./environmentPanelStyles";
import { shouldShowGroupFolderRow } from "./EnvironmentPanel.logic";
import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentCollapsibleSection,
  EnvironmentLabeledSection,
  EnvironmentRow,
  EnvironmentSectionDivider,
} from "./EnvironmentRow";
import { openSettings as openSettingsDialog } from "~/settingsDialogStore";

// Horizontal space (px) the docked card reserves on the right edge of the chat area.
// Mirrors the card footprint — w-72 (288px) plus the p-3 wrapper gutters — so insetting
// the chat content by this amount clears the overlay while leaving the transcript's
// scrollbar pinned to the viewport's far right.
export const ENVIRONMENT_DOCKED_CONTENT_INSET_PX = 312;

export interface EnvironmentPanelProps {
  /** Drives the slide-in/out transition; the panel stays mounted so CSS can interpolate. */
  open: boolean;
  /**
   * Both variants render the same top-right overlay card inside the chat column.
   * `docked` also reserves layout space via {@link ENVIRONMENT_DOCKED_CONTENT_INSET_PX};
   * `floating` is used when the column is narrow (split chat or right dock open) — overlay
   * only, no content inset.
   */
  variant: "docked" | "floating";
  gitCwd: string | null;
  openInTarget: string | null;
  githubRepository?: {
    readonly nameWithOwner: string;
    readonly url: string;
  } | null;
  githubRepositories?: ReadonlyArray<{ readonly nameWithOwner: string }>;
  isGitRepo: boolean;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  activeThreadId: ThreadId | null;
  /** Active provider for the usage row (same chip the header shows). */
  activeProvider: ProviderKind;
  /** The account the chat runs on; a Moss account shows the Moss quota, not local logins. */
  activeProviderInstanceId?: ProviderInstanceId | null;
  /**
   * Whether the active thread is a group chat. Group chats show the Output section:
   * the Outbox files THIS chat produced, so its output stays attached to the chat.
   */
  isGroupChat: boolean;
  /** Ordinary cwd selected for this group chat; this is not a Git worktree. */
  groupFolderPath?: string | null;
  /** Whether the active runtime exposes git actions (hides "Commit and Push" otherwise). */
  showGitActions: boolean;
  /** Current diff-panel open state, so the "Changes" row reflects/toggles it. */
  diffOpen: boolean;
  /** Heartbeat automations whose target is the active thread. */
  threadAutomations: readonly EnvironmentAutomationPanelItem[];
  /** Child side chats for a host thread. Null suppresses the section in embedded side chats. */
  sidechats: readonly EnvironmentSidechatPanelItem[] | null;
  /** Full subagent roster for this chat, including settled rows the composer strip retires. */
  subagentRoster?: EnvironmentSubagentRoster | null;
  /** Thread whose Task calls own the roster. A subagent view uses its parent. */
  subagentSourceThreadId?: ThreadId | null;
  /** Non-null when the diff panel cannot be opened (e.g. no repo / no changes yet). */
  diffDisabledReason?: string | null;
  /** Shared diff totals from ChatView so the mounted panel does not duplicate patch parsing. */
  diffTotals: RepoDiffTotals;
  /** Env/branch picker config; null for sidechats that keep their assigned workspace. */
  branchToolbar: Omit<BranchToolbarProps, "variant"> | null;
  /** Compact idle-generated chat memory for the top of the panel. */
  recap?: {
    readonly text: string | null;
    readonly status: "idle" | "pending" | "error";
    readonly updatedAt: string | null;
  } | null;
  /**
   * Rail content rendered below the env card inside the overlay wrapper
   * (the ambient computer preview). The wrapper is a flex column, so this
   * stacks under the card; see AmbientRailSlot for the closed-state slide.
   */
  railBottom?: ReactNode;
  /**
   * Closes the card. Beside an open side panel (the `floating` variant) the card behaves as a
   * popover, as Claude's do: a click outside it, or the window losing focus to the page in
   * the panel, closes it instead of leaving it over the narrow chat.
   */
  onDismiss?: () => void;
  /** Per-thread pinned-message checklist (server-synced). */
  pinnedMessages: readonly PinnedMessage[];
  /** Live text of pinned messages still present in the transcript (for labels/availability). */
  pinnedMessageTextById: ReadonlyMap<MessageId, string>;
  /** Per-thread freeform scratchpad notes (server-synced). */
  notes: string;
  /** Active project whose local instructions should be edited. */
  activeProjectId: ProjectId | null;
  /** Per-project freeform instructions, persisted locally and optionally copied into notes. */
  projectInstructions: string;
  /** Whether the current thread is server-backed enough to accept notepad updates. */
  canCopyProjectInstructionsToNotes: boolean;
  /** Persist local project instruction edits. */
  onProjectInstructionsChange: (projectId: ProjectId, instructions: string) => void;
  /** Copy/append current project instructions into the active thread's notepad. */
  onCopyProjectInstructionsToNotes: () => void;
  /** Toggle the Diff panel/route (same handler the header diff toggle used). */
  onToggleDiff: () => void;
  /** Open the shared automation editor for a thread-bound automation row. */
  onOpenAutomation: (definition: AutomationDefinition) => void;
  /** Open the repository URL in the in-app browser panel. */
  onOpenGithubRepository?: (url: string) => void;
  /** Open a local dev server's address in the in-app browser panel. */
  onOpenLocalServer?: (url: string) => void;
  /** Scroll the transcript to a pinned message. */
  onJumpToPinnedMessage: (messageId: MessageId) => void;
  /** Toggle a pinned message's done state (strikethrough; stays pinned). */
  onTogglePinnedMessageDone: (messageId: MessageId) => void;
  /** Remove a message from the pinned checklist. */
  onUnpinMessage: (messageId: MessageId) => void;
  /** Set (`null` clears to auto) a pinned message's label. */
  onRenamePinnedMessage: (messageId: MessageId, label: string | null) => void;
  /** Persist updated notes for the given thread (bound per section instance, not the active thread). */
  onNotesChange: (threadId: ThreadId, notes: string) => Promise<void>;
  /** Open the in-app editor workspace view (the Editor section's default first row). */
  onOpenEditorView?: (() => void) | null;
  /** Dismiss the panel overlay — invoked after actions that open the dock. */
  onClose: () => void;
  /** Registers the panel's "Commit and Push" row as the target for the global shortcut. */
  onRegisterCommitAndPushTrigger?: (trigger: (() => void) | null) => void;
  /**
   * Latest context-window report for this thread. Null when the provider has not
   * reported one, and the Context line is then left out rather than guessed.
   */
  contextWindow?: ContextWindowSnapshot | null;
  /** Project scripts for the workspace group ("Run <action> ▾" / "Add project script"). */
  projectScripts?: {
    readonly scripts: ProjectScript[];
    readonly preferredScriptId: string | null;
    readonly onRunScript: (script: ProjectScript) => void;
    readonly onAddScript: (input: NewProjectScriptInput) => Promise<void>;
    readonly onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
    readonly onDeleteScript: (scriptId: string) => Promise<void>;
  } | null;
}

// Revealing a folder opens the file manager on the machine running Moss, so offer it
// only in the desktop app or a page served from this machine.
function canRevealWorkspaceFolders(): boolean {
  if (isElectron) return true;
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

function EnvironmentRecapSection({
  recap,
  markdownCwd,
}: {
  recap: NonNullable<EnvironmentPanelProps["recap"]>;
  markdownCwd: string | undefined;
}) {
  return (
    <EnvironmentCollapsibleSection label="Recap">
      <div className="flex flex-col gap-1.5 pb-1.5">
        {recap.text ? (
          <div className="px-2">
            <ChatMarkdown
              text={recap.text}
              cwd={markdownCwd}
              isStreaming={false}
              className={ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 px-2" aria-hidden>
            <div className="h-2.5 w-full rounded bg-[var(--color-background-button-secondary-hover)]/45 motion-safe:animate-pulse" />
            <div className="h-2.5 w-4/5 rounded bg-[var(--color-background-button-secondary-hover)]/35 motion-safe:animate-pulse" />
          </div>
        )}
      </div>
    </EnvironmentCollapsibleSection>
  );
}

export function EnvironmentPanel({
  open,
  variant,
  gitCwd,
  openInTarget,
  githubRepository: githubRepositoryProp,
  githubRepositories: githubRepositoriesProp,
  isGitRepo,
  keybindings,
  availableEditors,
  activeThreadId,
  activeProvider,
  activeProviderInstanceId,
  isGroupChat,
  groupFolderPath: groupFolderPathProp,
  showGitActions,
  diffOpen,
  threadAutomations,
  sidechats,
  subagentRoster: subagentRosterProp,
  subagentSourceThreadId,
  diffDisabledReason: diffDisabledReasonProp,
  diffTotals,
  branchToolbar,
  recap: recapProp,
  pinnedMessages,
  pinnedMessageTextById,
  notes,
  activeProjectId,
  projectInstructions,
  canCopyProjectInstructionsToNotes,
  onProjectInstructionsChange,
  onCopyProjectInstructionsToNotes,
  onToggleDiff,
  onOpenAutomation,
  onOpenGithubRepository,
  onOpenLocalServer,
  onJumpToPinnedMessage,
  onTogglePinnedMessageDone,
  onUnpinMessage,
  onRenamePinnedMessage,
  onNotesChange,
  onOpenEditorView: onOpenEditorViewProp,
  onClose,
  onRegisterCommitAndPushTrigger,
  railBottom,
  onDismiss,
  contextWindow: contextWindowProp,
  projectScripts: projectScriptsProp,
}: EnvironmentPanelProps) {
  const cardContentRef = useRef<HTMLDivElement>(null);
  const contextWindow = contextWindowProp ?? null;
  const projectScripts = projectScriptsProp ?? null;
  const { t } = useTranslation();
  const workspaceFolderPath = openInTarget ?? gitCwd;
  const canRevealFolders = canRevealWorkspaceFolders();
  const githubRepository = githubRepositoryProp ?? null;
  const githubRepositories = githubRepositoriesProp ?? [];
  const groupFolderPath = groupFolderPathProp ?? null;
  const diffDisabledReason = diffDisabledReasonProp ?? null;
  const recap = recapProp ?? null;
  const subagentRoster = subagentRosterProp ?? null;
  const onOpenEditorView = onOpenEditorViewProp ?? null;
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const { settings } = useAppSettings();
  const openRightDockPane = useRightDockStore((store) => store.openPane);
  const { additions, deletions, hasChanges } = diffTotals;

  // Disable the Changes row only when the diff cannot be opened *and* is not already open
  // (so an open diff stays toggleable closed even when there are no pending changes).
  const changesDisabled = diffDisabledReason !== null && !diffOpen;
  const showRecap = Boolean(recap?.text) || recap?.status === "pending";
  const markdownCwd = openInTarget ?? gitCwd ?? undefined;
  const showGroupFolderRow = shouldShowGroupFolderRow({
    isGroupChat,
    groupFolderPath,
    nativeShellAvailable: isElectron,
  });

  const handleSectionsContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest("input, textarea, [contenteditable], a[href]")
    ) {
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const api = readNativeApi();
    if (!api) return;
    event.preventDefault();
    void api.contextMenu
      .show([{ id: "choose-sections", label: t("chat.environment.chooseSections") }], {
        x: event.clientX,
        y: event.clientY,
      })
      .then((clicked) => {
        if (clicked !== "choose-sections") return;
        openSettingsDialog({ section: "general", target: SETTINGS_TARGETS.environmentPanel });
      });
  };

  const content = (
    // Right-click anywhere on the card to choose its sections, as on the upstream card.
    <div className="flex flex-col p-2" onContextMenu={handleSectionsContextMenu}>
      {threadAutomations.length > 0 ? (
        <>
          <EnvironmentAutomationsSection
            automations={threadAutomations}
            onOpenAutomation={(definition) => {
              onOpenAutomation(definition);
              onClose();
            }}
          />
          <EnvironmentSectionDivider />
        </>
      ) : null}

      {/* Workspace: where the chat runs, the editor to open it in, project scripts. */}
      <div className="flex flex-col" data-environment-group="workspace">
        {showGroupFolderRow && groupFolderPath ? (
          <EnvironmentRow
            icon={<FolderIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
            label={
              <span className="truncate" title={groupFolderPath}>
                {basenameOfPath(groupFolderPath) || groupFolderPath}
              </span>
            }
            trailing={<ExternalLinkIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
            onClick={() => {
              revealFolderInShell({ path: groupFolderPath, onRevealed: onClose });
            }}
          />
        ) : branchToolbar ? (
          <div className="flex min-w-0 items-center">
            <div className="min-w-0 flex-1">
              <BranchToolbar {...branchToolbar} variant="panel" showBranchSelector={false} />
            </div>
            {workspaceFolderPath && canRevealFolders ? (
              <IconButton
                label={t("chat.environment.revealFolder")}
                tooltip={t("chat.environment.revealFolder")}
                className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => revealFolderInShell({ path: workspaceFolderPath })}
              >
                <FolderIcon className="size-4" />
              </IconButton>
            ) : null}
          </div>
        ) : null}
        {settings.showEnvironmentEditor ? (
          <EnvironmentEditorSection
            bare
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInTarget={openInTarget}
            {...(onOpenEditorView
              ? {
                  onOpenEditorView: () => {
                    onOpenEditorView();
                    onClose();
                  },
                }
              : {})}
          />
        ) : null}
        {projectScripts ? (
          <ProjectScriptsControl
            displayMode="panel"
            scripts={projectScripts.scripts}
            keybindings={keybindings}
            preferredScriptId={projectScripts.preferredScriptId}
            onRunScript={projectScripts.onRunScript}
            onAddScript={projectScripts.onAddScript}
            onUpdateScript={projectScripts.onUpdateScript}
            onDeleteScript={projectScripts.onDeleteScript}
          />
        ) : null}
      </div>

      {/* Version control: branch, commit, and this chat's changes. */}
      {isGitRepo || showGitActions ? (
        <>
          <EnvironmentSectionDivider />
          <div className="flex flex-col" data-environment-group="version-control">
            {isGitRepo && branchToolbar ? (
              <BranchToolbar {...branchToolbar} variant="panel" showEnvironmentPicker={false} />
            ) : null}
            {showGitActions ? (
              <GitActionsControl
                gitCwd={gitCwd}
                activeThreadId={activeThreadId}
                variant="panel"
                onRegisterCommitAndPushTrigger={onRegisterCommitAndPushTrigger}
              />
            ) : null}
            {isGitRepo ? (
              <EnvironmentRow
                icon={<ChangesIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
                label="Changes"
                trailing={
                  hasChanges ? <DiffStat insertions={additions} deletions={deletions} /> : null
                }
                disabled={changesDisabled}
                onClick={() => {
                  onToggleDiff();
                  onClose();
                }}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {/* Servers sit in their own group, as on the upstream card. */}
      <EnvironmentSectionDivider />
      <EnvironmentLocalServersSection
        enabled={open}
        workspaceRoot={gitCwd}
        projectId={activeProjectId}
        onOpenServer={
          onOpenLocalServer
            ? (url) => {
                onOpenLocalServer(url);
                onClose();
              }
            : undefined
        }
      />

      {sidechats && activeThreadId ? (
        <EnvironmentSidechatsSection
          sidechats={sidechats}
          onCreate={() => {
            void waitForSidechatCreator(activeThreadId)
              .then((createSidechat) => {
                if (!createSidechat) {
                  toastManager.add({
                    type: "warning",
                    title: "Side chat is unavailable",
                    description: "Open a server-backed main thread before starting a side chat.",
                  });
                  return;
                }
                return createSidechat();
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Could not start side chat",
                  description:
                    error instanceof Error
                      ? error.message
                      : "An error occurred while creating the side chat.",
                });
              });
          }}
          onOpen={(sidechatThreadId) => {
            openRightDockPane(activeThreadId, {
              kind: "sidechat",
              threadId: sidechatThreadId,
            });
            onClose();
          }}
          onDelete={(sidechat) => {
            void (async () => {
              if (settings.confirmThreadDelete) {
                const confirmationMessage = [
                  `Delete side chat "${sidechat.title}"?`,
                  "This permanently clears conversation history for this side chat and its subagents.",
                ].join("\n");
                const api = readNativeApi();
                const confirmed = api
                  ? await api.dialogs.confirm(confirmationMessage)
                  : await showConfirmDialogFallback(confirmationMessage);
                if (!confirmed) return;
              }
              // The host can change workspace after the side chat is created. The shared delete
              // helper prompts only if this side chat is now the last owner of its worktree.
              // An open dock pane is pruned once the thread disappears.
              await deleteActiveThreadFromClient({
                threadId: sidechat.id,
                includeSubagentDescendants: true,
                onDeleted: ({ thread }) => {
                  usePinnedThreadsStore.getState().unpinThread(thread.id);
                  const drafts = useComposerDraftStore.getState();
                  drafts.clearDraftThread(thread.id);
                  drafts.clearProjectDraftThreadById(thread.projectId, thread.id);
                  useTerminalStateStore.getState().clearTerminalState(thread.id);
                  useSplitViewStore.getState().removeThreadFromSplitViews(thread.id);
                  useTemporaryThreadStore.getState().clearTemporaryThread(thread.id);
                },
                removeWorktree: (worktree) => removeWorktreeMutation.mutateAsync(worktree),
              });
            })().catch((error) => {
              toastManager.add({
                type: "error",
                title: "Could not delete side chat",
                description:
                  error instanceof Error
                    ? error.message
                    : "An error occurred while deleting the side chat.",
              });
            });
          }}
        />
      ) : null}

      {/*
        Optional sections below the git block. Each renders its own leading divider only when it
        actually shows, so toggling any section via the header gear menu never leaves a doubled or
        dangling rule. Visibility is gated on the per-section AppSettings flags.
      */}
      {settings.showEnvironmentSubagents && subagentRoster && activeThreadId ? (
        <EnvironmentSubagentsSection
          roster={subagentRoster}
          onOpenList={() => {
            openRightDockPane(activeThreadId, {
              kind: "subagents",
              subagentsSourceThreadId: subagentSourceThreadId ?? activeThreadId,
            });
            onClose();
          }}
        />
      ) : null}

      {settings.showEnvironmentUsage ? (
        <EnvironmentUsageSection
          provider={activeProvider}
          activeInstanceId={activeProviderInstanceId ?? null}
        />
      ) : null}

      {settings.showEnvironmentRepository && githubRepository && onOpenGithubRepository ? (
        <EnvironmentLabeledSection label="Repository">
          <EnvironmentRow
            icon={<GitHubIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
            label={<span className="truncate">{githubRepository.nameWithOwner}</span>}
            trailing={<ExternalLinkIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
            onClick={() => {
              onOpenGithubRepository(githubRepository.url);
              onClose();
            }}
          />
        </EnvironmentLabeledSection>
      ) : null}

      {settings.showEnvironmentPullRequest && isGitRepo && onOpenGithubRepository ? (
        <EnvironmentPullRequestSection
          gitCwd={gitCwd}
          enabled={open}
          activeThreadId={activeThreadId}
          projectId={activeProjectId}
          configuredRepositories={githubRepositories}
          showDiffColors={settings.showPullRequestDiffColors}
          onOpenUrl={onOpenGithubRepository}
          onClose={onClose}
        />
      ) : null}

      {isGroupChat && activeThreadId ? (
        <EnvironmentStudioOutputsSection threadId={activeThreadId} enabled={open} />
      ) : null}

      {settings.showEnvironmentRecap && showRecap && recap ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentRecapSection recap={recap} markdownCwd={markdownCwd} />
        </>
      ) : null}

      {settings.showEnvironmentPinned && pinnedMessages.length > 0 ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentPinnedSection
            pins={pinnedMessages}
            messageTextById={pinnedMessageTextById}
            onJump={onJumpToPinnedMessage}
            onToggleDone={onTogglePinnedMessageDone}
            onUnpin={onUnpinMessage}
            onRename={onRenamePinnedMessage}
          />
        </>
      ) : null}

      {settings.showEnvironmentInstructions && activeProjectId ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentProjectInstructionsSection
            key={activeProjectId}
            projectId={activeProjectId}
            instructions={projectInstructions}
            threadNotes={notes}
            canCopyToThreadNotes={canCopyProjectInstructionsToNotes}
            onInstructionsChange={onProjectInstructionsChange}
            onCopyToThreadNotes={onCopyProjectInstructionsToNotes}
          />
        </>
      ) : null}

      {settings.showEnvironmentNotepad && activeThreadId ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentNotesSection
            key={activeThreadId}
            threadId={activeThreadId}
            notes={notes}
            onChange={onNotesChange}
          />
        </>
      ) : null}

      {contextWindow ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentContextSection usage={contextWindow} />
        </>
      ) : null}
    </div>
  );

  useDismissFloatingCard({
    active: open && variant === "floating" && onDismiss !== undefined,
    cardRef: cardContentRef,
    onDismiss,
  });

  // Top-right overlay pinned to the chat column with p-3 edge gutters (same footprint in
  // split panes and when the right dock is open). Docked mode additionally insets transcript
  // content; floating overlays only without stealing flex width from the narrow chat pane.
  return (
    <SidePanelOverlay
      open={open}
      variant={variant}
      className="items-end gap-3 overflow-y-auto"
      cardClassName="max-h-full w-72"
      trailing={railBottom}
    >
      <div className="min-h-0 overflow-y-auto" ref={cardContentRef}>
        {content}
      </div>
    </SidePanelOverlay>
  );
}

// Anything a card's own controls open lives in a portal (menus, their popups, dialogs); a
// click there belongs to the card. Its header toggle closes it on its own.
const FLOATING_CARD_KEEP_OPEN_SELECTOR = [
  "[data-slot$='-positioner']",
  "[data-slot$='-popup']",
  "[data-slot$='-backdrop']",
  "[role='menu']",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='listbox']",
  "[aria-pressed][aria-label]",
].join(", ");

function useDismissFloatingCard(input: {
  readonly active: boolean;
  readonly cardRef: { readonly current: HTMLElement | null };
  readonly onDismiss: (() => void) | undefined;
}) {
  const onDismissRef = useRef(input.onDismiss);
  onDismissRef.current = input.onDismiss;
  const { active, cardRef } = input;
  useEffect(() => {
    if (!active) return;
    const dismiss = () => onDismissRef.current?.();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (cardRef.current?.contains(target)) return;
      if (target.closest(FLOATING_CARD_KEEP_OPEN_SELECTOR)) return;
      dismiss();
    };
    // A click in the side panel's page moves focus out of this document.
    const onWindowBlur = () => dismiss();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [active, cardRef]);
}
