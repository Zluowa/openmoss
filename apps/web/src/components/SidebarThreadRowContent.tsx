// FILE: SidebarThreadRowContent.tsx
// Purpose: Owns the shared identity and status content rendered by every Sidebar thread row.
// Exports: SidebarThreadRowContent and its terminal-status presentation type.

import { useMemo, type ReactNode } from "react";

import { isGenericChatThreadTitle } from "@synara/shared/chatThreads";
import { inferLegacyProviderKindFromModelSelection } from "@synara/shared/providerInstances";
import { pluralize } from "@synara/shared/text";

import { useThreadHasPendingDraft } from "../composerDraftStore";
import { useTranslation } from "../localization";
import { createSubagentSiblingSummariesSelector, createThreadSelector } from "../storeSelectors";
import { useStore } from "../store";
import {
  humanizeSubagentStatus,
  resolveSubagentPresentationForThread,
  resolveSubagentThreadStatusKind,
  subagentStatusDotClassName,
} from "../lib/subagentPresentation";
import { resolveThreadHandoffBadgeLabel } from "../lib/threadHandoff";
import { SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME } from "../sidebarRowStyles";
import type { SidebarThreadSummary } from "../types";
import { TerminalIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { ProviderIcon } from "./ProviderIcon";
import { SidebarGlyph } from "./sidebarGlyphs";
import { SidebarDraftGlyph } from "./SidebarStatusTrailingGlyph";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface SidebarThreadTerminalStatus {
  label: "Terminal input needed" | "Terminal task completed" | "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

function ProviderAvatarWithTerminal({
  thread,
  terminalStatus,
  terminalCount,
}: {
  thread: SidebarThreadSummary;
  terminalStatus: SidebarThreadTerminalStatus | null;
  terminalCount: number;
}) {
  const provider =
    thread.session?.provider ?? inferLegacyProviderKindFromModelSelection(thread.modelSelection);
  const handoffSourceProvider = thread.handoff?.sourceProvider ?? null;
  const handoffTooltip = resolveThreadHandoffBadgeLabel(thread);
  const showBadge = terminalCount > 1 || terminalStatus !== null;
  const badgeTooltip =
    terminalCount > 1
      ? `${terminalCount} ${pluralize(terminalCount, "terminal")} open`
      : (terminalStatus?.label ?? "Terminal open");
  const badgeColorClass = terminalStatus?.colorClass ?? "text-muted-foreground/55";

  const hasHandoff = Boolean(handoffSourceProvider);
  const containerClass = hasHandoff
    ? "relative inline-flex h-3 w-4.5 shrink-0 items-center"
    : "relative inline-flex size-3 shrink-0 items-center justify-center";

  const avatarNode = hasHandoff ? (
    <span className={containerClass}>
      <span className="sidebar-icon-chip absolute left-0 top-1/2 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={handoffSourceProvider!} className="size-2" />
      </span>
      <span className="sidebar-icon-chip absolute right-0 top-1/2 z-10 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={provider} className="size-2" />
      </span>
    </span>
  ) : (
    <span className={containerClass}>
      <ProviderIcon provider={provider} className="size-3" />
    </span>
  );

  const wrappedAvatar =
    hasHandoff && handoffTooltip ? (
      <Tooltip>
        <TooltipTrigger render={avatarNode} />
        <TooltipPopup side="top">{handoffTooltip}</TooltipPopup>
      </Tooltip>
    ) : (
      avatarNode
    );

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center",
        hasHandoff
          ? "h-3 w-4.5"
          : "size-3 justify-center [&_svg,&_[data-slot=central-icon]]:size-3",
      )}
      data-sidebar-provider={provider}
    >
      {wrappedAvatar}
      {showBadge ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={badgeTooltip}
                className="sidebar-icon-chip absolute -top-1.5 -right-1.5 inline-flex size-3 min-w-3 items-center justify-center rounded-full px-px"
              >
                {terminalCount > 1 ? (
                  <span
                    className={cn(
                      "text-[8px] font-semibold leading-none tabular-nums",
                      badgeColorClass,
                    )}
                  >
                    {terminalCount}
                  </span>
                ) : (
                  <TerminalIcon className={cn("size-2.5", badgeColorClass)} />
                )}
              </span>
            }
          />
          <TooltipPopup side="top">{badgeTooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

function renderSubagentLabel(input: {
  thread: SidebarThreadSummary;
  threads?: Parameters<typeof resolveSubagentPresentationForThread>[0]["threads"];
  roleClassName?: string | undefined;
}) {
  const presentation = resolveSubagentPresentationForThread({
    thread: {
      id: input.thread.id,
      parentThreadId: input.thread.parentThreadId,
      subagentAgentId: input.thread.subagentAgentId,
      subagentNickname: input.thread.subagentNickname,
      subagentRole: input.thread.subagentRole,
      title: input.thread.title,
    },
    threads: input.threads,
  });
  const supportingLabel =
    presentation.role ??
    (presentation.nickname && presentation.title && presentation.title !== presentation.nickname
      ? presentation.title
      : null);

  return (
    <span className="min-w-0 truncate">
      <span className="font-medium">{presentation.nickname ?? presentation.primaryLabel}</span>
      {supportingLabel ? (
        <span className={cn("ml-1 text-muted-foreground/48", input.roleClassName)}>
          {presentation.role ? `(${presentation.role})` : supportingLabel}
        </span>
      ) : null}
    </span>
  );
}

// Approval chip, modeled on the Codex desktop app's: green at 20% behind green text,
// fully rounded, at most 150px and half the row. The text is `text-ui` (13px);
// 12px still fitted "Awaiting app…". The thread title keeps `truncate-fade`.
const AWAITING_APPROVAL_CHIP_CLASS =
  "inline-flex min-w-0 max-w-[min(50%,150px)] items-center overflow-hidden rounded-full bg-[color-mix(in_oklab,#00a240_20%,transparent)] py-0.5 pe-2.5 ps-2 text-ui leading-[18px] text-[#00a240] dark:bg-[color-mix(in_oklab,#40c977_20%,transparent)] dark:text-[#40c977]";

function AwaitingApprovalChip({ label }: { label: string }) {
  return (
    <span aria-label={label} className={AWAITING_APPROVAL_CHIP_CLASS}>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

function SidebarSubagentLabel({
  thread,
  roleClassName,
}: {
  thread: SidebarThreadSummary;
  roleClassName?: string | undefined;
}) {
  const selectParentThread = useMemo(
    () => createThreadSelector(thread.parentThreadId ?? null),
    [thread.parentThreadId],
  );
  const parentThread = useStore(selectParentThread);
  // Only an unnamed child can fall back to its position ("Subagent N").
  const selectSiblings = useMemo(
    () =>
      createSubagentSiblingSummariesSelector(
        thread.subagentNickname ? null : (thread.parentThreadId ?? null),
      ),
    [thread.parentThreadId, thread.subagentNickname],
  );
  const siblings = useStore(selectSiblings);
  const threads = useMemo(
    () => (parentThread ? [parentThread, ...siblings] : undefined),
    [parentThread, siblings],
  );

  return renderSubagentLabel({
    thread,
    threads,
    roleClassName,
  });
}

export function SidebarThreadRowContent({
  thread,
  terminalEntryPoint,
  terminalStatus,
  terminalCount,
  isActive,
  variant,
  subagentIndentPx: subagentIndentPxProp,
  pendingStatusColorClass,
  suffix,
}: {
  thread: SidebarThreadSummary;
  terminalEntryPoint: boolean;
  terminalStatus: SidebarThreadTerminalStatus | null;
  terminalCount: number;
  isActive: boolean;
  variant: "pinned" | "standard";
  subagentIndentPx?: number;
  pendingStatusColorClass?: string | null | undefined;
  suffix?: ReactNode;
}) {
  const subagentIndentPx = subagentIndentPxProp ?? 0;
  const isSubagentThread = Boolean(thread.parentThreadId);
  // A child row's dot carries its state (running/done/failed/stopped), the
  // same hues as the transcript card; the name stays in the neutral row color.
  const subagentStatusKind =
    variant === "standard" && isSubagentThread ? resolveSubagentThreadStatusKind(thread) : null;
  // Moss is multi-CLI. Named thread rows, pinned and standard, lead with the
  // provider glyph so the row shows which CLI runs that thread. Generic
  // "New thread" titles stay unmarked, terminal entry points keep the terminal
  // glyph, and a terminal badge still draws on this avatar.
  const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
  const hasPendingDraft = useThreadHasPendingDraft(thread.id);
  const { t } = useTranslation();

  const clusterGap = variant === "standard" && isSubagentThread ? "gap-[5px]" : "gap-1.5";
  const leading =
    variant === "standard" && isSubagentThread ? (
      <span
        className="relative inline-flex h-3.5 w-[18px] shrink-0 items-center"
        style={{ marginLeft: `${subagentIndentPx}px` }}
        title={humanizeSubagentStatus(subagentStatusKind) ?? undefined}
      >
        <span
          aria-hidden="true"
          className="absolute left-1.5 top-0 bottom-0 w-px rounded-full bg-border/35"
        />
        <span
          aria-hidden="true"
          className="absolute left-1.5 top-1/2 h-px w-2.5 -translate-y-1/2 bg-border/35"
        />
        <span
          data-testid="sidebar-subagent-status-dot"
          data-status={subagentStatusKind ?? "none"}
          className={cn(
            "absolute left-1.5 top-1/2 size-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full",
            subagentStatusDotClassName(subagentStatusKind),
          )}
        />
      </span>
    ) : terminalEntryPoint ? (
      <SidebarGlyph icon={TerminalIcon} variant="chrome" className="shrink-0" />
    ) : showThreadProviderAvatar ? (
      <ProviderAvatarWithTerminal
        thread={thread}
        terminalStatus={terminalStatus}
        terminalCount={terminalCount}
      />
    ) : null;

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-auto flex-nowrap items-center overflow-hidden",
        clusterGap,
      )}
      data-sidebar-thread-line
    >
      {leading}
      <div className={cn("flex min-w-0 flex-1 flex-nowrap items-center", clusterGap)}>
        <span
          className={cn(
            // Pinned rows size the title from its text so the suffix yields width first.
            "min-w-0 truncate-fade text-ui",
            variant === "pinned" ? "flex-auto" : "flex-1",
            isActive ? "text-foreground" : SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
            variant === "standard" && isSubagentThread
              ? "leading-[18px] text-foreground/80"
              : "leading-5",
          )}
          data-sidebar-thread-title=""
          data-testid={variant === "pinned" ? `thread-title-${thread.id}` : undefined}
        >
          {isSubagentThread ? (
            <SidebarSubagentLabel
              thread={thread}
              roleClassName={variant === "standard" ? "text-muted-foreground/42" : undefined}
            />
          ) : (
            thread.title
          )}
        </span>
        {hasPendingDraft ? <SidebarDraftGlyph /> : null}
        {!isSubagentThread && pendingStatusColorClass ? (
          <AwaitingApprovalChip label={t("chat.timeline.awaitingApproval")} />
        ) : null}
        {variant === "pinned" ? suffix : null}
      </div>
      {variant === "pinned" ? null : suffix}
    </div>
  );
}
