// FILE: ComposerPendingApprovalPanel.tsx
// Purpose: Detached card, floating just above the composer, that surfaces a pending
// tool approval — the command / file context plus approve / decline / cancel actions
// rendered as list-style choice rows. Mirrors ComposerPendingUserInputPanel (same
// surface, spacing, chips, and scoped keyboard shortcuts) so approvals and AskUserQuestion
// prompts read as one coherent decision surface instead of the old fused-banner look.
// Layer: Chat composer UI
// Exports: ComposerPendingApprovalPanel

import { type ApprovalRequestId, type ProviderApprovalDecision } from "@moss/contracts";
import {
  CODEX_MCP_APPROVAL_QUESTION,
  MOSS_CODEX_MCP_SERVER_NAME,
} from "@moss/shared/codexDiagnostics";
import { isMossAppsServer } from "@moss/shared/mossAppsPresentation";
import { mossToolApprovalAction } from "@moss/shared/mossToolPresentation";
import { pendingRequestInstanceKey } from "@moss/shared/threadSummary";
import { type KeyboardEvent, useState, useRef } from "react";
import { type PendingApproval } from "../../session-logic";
import { useTranslation } from "../../localization";
import { ChevronDownIcon, PencilIcon, TerminalIcon } from "~/lib/icons";
import { approvalParamLabel } from "~/lib/approvalParamLabels";
import { localizeMossAppsToolAction, resolveMcpApprovalTool } from "~/lib/toolCallLabel";
import { isWebMcpCallToolName } from "~/lib/webMcpToolPresentation";
import { Button } from "../ui/button";
import { ButtonKeycap } from "../ui/kbd";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
// Approval chrome, modeled on the Codex desktop app's approval card:
// - shell: 1.5rem radius with a glass fill
// - header: identity in `text-size-chat-sm text-secondary`, title in `text-size-chat font-medium`
// - exec body: `rounded-control bg-surface-tertiary font-mono`
//   (conversation token is white, so the well matches the card)
// - menu: Allow once, then scoped action. Not a second Always allow.
// i18n: approvalRequestCard.* , execApprovalRequest.shellLabel / .prompt

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  isResponding: boolean;
  onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    lifecycleGeneration?: string,
    requestKind?: PendingApproval["requestKind"],
  ) => Promise<void>;
}

// Moss-owned Computer consent stays off the session grant. Each scope names its
// own allow/deny copy; the card chrome is still Codex's Deny / Allow once row.
const COMPUTER_SCOPES: Record<
  NonNullable<PendingApproval["approvalScope"]>,
  {
    readonly prompt: string;
    readonly allowLabel: string;
    readonly allowDetail: string;
    readonly denyLabel: string;
    readonly denyDetail: string;
    readonly cancelLabel: string;
    readonly cancelDetail: string;
  }
> = {
  "computer-task": {
    prompt: "Allow Computer for this task?",
    allowLabel: "Allow Computer for this task",
    allowDetail:
      "Continue routine desktop actions until this response ends. Stop cancels access. Clipboard reads still ask separately.",
    denyLabel: "Deny",
    denyDetail: "Stop desktop for this turn, agent continues without tools",
    cancelLabel: "Cancel this request",
    cancelDetail: "Deny this request; use Stop to end the agent turn.",
  },
  "computer-foreground": {
    prompt: "Show this on your screen?",
    allowLabel: "Show on screen for this task",
    allowDetail: "Computer may bring windows to the front until this response ends.",
    denyLabel: "Keep it in the background",
    denyDetail: "No window is raised; the agent continues in the background",
    cancelLabel: "Cancel this request",
    cancelDetail: "Use Stop to end the agent turn.",
  },
  "device-task": {
    prompt: "Allow Device for this task?",
    allowLabel: "Allow Device for this task",
    allowDetail: "Continue routine device actions until this response ends. Stop cancels access.",
    denyLabel: "Deny",
    denyDetail: "Stop device control for this turn, agent continues without tools",
    cancelLabel: "Cancel this request",
    cancelDetail: "Use Stop to end the agent turn.",
  },
};

export const ComposerPendingApprovalPanel = function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  isResponding,
  onRespond,
}: ComposerPendingApprovalPanelProps) {
  const { t, format, locale } = useTranslation();
  // A page tool's card: the site, the page's tool and the arguments are what a person
  // decides on, so its rows are open from the start.
  const webMcpCall = readWebMcpApprovalRows(approval);
  const [paramsOpen, setParamsOpen] = useState(webMcpCall !== null);
  // What the provider sent is shown exactly as it arrived (REVIEW-RULES rule 9).
  const detail = approval.detail && approval.detail.length > 0 ? approval.detail : null;
  const filePath = requestedFilePath(detail);
  // Every file an edit will touch, whole (WALK-12 N12-1: Codex names only its item, so the
  // card said 「允许 Moss 编辑以下文件？」 over no file).
  const editedFiles = approval.requestKind === "file-change" ? (approval.filePaths ?? []) : [];
  const fileChanges = approval.requestKind === "file-change" ? (approval.fileChanges ?? []) : [];
  const requestId = approval.requestId;
  const requestKey = pendingRequestInstanceKey(requestId, approval.lifecycleGeneration);
  const submissionKey = JSON.stringify([requestKey, approval.responseAttemptKey ?? null]);
  const submittedRequestKeyRef = useRef<string | null>(null);
  const computerScope = approval.approvalScope
    ? COMPUTER_SCOPES[approval.approvalScope]
    : undefined;
  const sessionAvailable = !computerScope && approval.sessionApprovalAvailable !== false;
  const mcpTool = resolveMcpApprovalTool({
    serverName: approval.toolServerName,
    toolName: approval.toolName,
  });
  const mossAppsAction =
    mcpTool.tool && isMossAppsServer(mcpTool.server)
      ? localizeMossAppsToolAction(mcpTool.tool, locale)
      : null;
  // Moss's own tools say what they will do, in the person's language (WALK-7 N7-2: the card
  // showed 「允许 moss 运行 moss_canvas_open 工具？」 and Codex's English question under it).
  const mossOwnTool = mcpTool.server === MOSS_CODEX_MCP_SERVER_NAME && mcpTool.tool !== null;
  const mossOwnAction =
    mossOwnTool && mcpTool.tool
      ? mossToolApprovalAction(mcpTool.tool, locale === "zh-CN" ? "zh-CN" : "en")
      : null;
  const connectorName = mossAppsAction
    ? t("composer.mcpToolCallApproval.mossAppsName")
    : mossOwnTool
      ? "Moss"
      : (mcpTool.server ?? mcpTool.tool);
  const variant =
    computerScope !== undefined
      ? "computer"
      : approval.requestKind === "command"
        ? "terminal"
        : approval.requestKind === "file-change"
          ? "edit"
          : approval.requestKind === "tool" || (approval.toolParamsDisplay?.length ?? 0) > 0
            ? "mcp"
            : approval.requestKind;

  const respondOnce = (decision: ProviderApprovalDecision) => {
    if (isResponding || submittedRequestKeyRef.current === submissionKey) return;
    submittedRequestKeyRef.current = submissionKey;
    void onRespond(requestId, decision, approval.lifecycleGeneration, approval.requestKind).catch(
      () => {
        if (submittedRequestKeyRef.current === submissionKey) {
          submittedRequestKeyRef.current = null;
        }
      },
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isResponding || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (
      target instanceof HTMLElement &&
      target.closest('[contenteditable]:not([contenteditable="false"])')
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      respondOnce("decline");
      return;
    }
  };

  const allowLabel = computerScope?.allowLabel ?? t("approvalRequestCard.allowOnce");
  const denyLabel = computerScope?.denyLabel ?? t("approvalRequestCard.deny");
  // Approval dropdown: item 1 is Allow once (→ `accept`). Item 2 is the scoped
  // action. Exec with a prefix is "Allow similar commands" → `acceptWithExecpolicyAmendment`.
  // Patch is "Allow all edits" → `acceptForSession`. Otherwise "Allow this
  // conversation" → `acceptForSession`. "Always allow" is the network
  // leading button, not a second copy of the session grant.
  const execpolicyAmendment =
    approval.requestKind === "command" && (approval.execpolicyAmendment?.length ?? 0) > 0
      ? approval.execpolicyAmendment
      : null;
  const scopedDecision: ProviderApprovalDecision = execpolicyAmendment
    ? "acceptWithExecpolicyAmendment"
    : "acceptForSession";
  const scopedLabel = execpolicyAmendment
    ? t("execApprovalRequest.allowSimilarCommands")
    : approval.requestKind === "file-change"
      ? t("patchApprovalRequest.allowAllEdits")
      : t("approvalRequestCard.allowConversation");

  const identity = webMcpCall
    ? t("composer.webMcpApproval.identity")
    : computerScope !== undefined
      ? null
      : variant === "terminal"
        ? t("execApprovalRequest.shellLabel")
        : variant === "edit"
          ? t("patchApprovalRequest.fileEditsLabel")
          : variant === "mcp"
            ? connectorName
            : approval.requestKind === "permissions" || approval.requestKind === "file-read"
              ? t("permissionRequest.permissionsLabel")
              : null;

  // Moss Apps says what the action does; another server names itself and its
  // tool the way Codex does. Never a placeholder when the provider named neither.
  const mcpApprovalTitle = () => {
    if (mossAppsAction) {
      return format("composer.mcpToolCallApproval.mossAppsTitle", {
        action: `${mossAppsAction.charAt(0).toLowerCase()}${mossAppsAction.slice(1)}`,
      });
    }
    if (mossOwnTool && mossOwnAction) {
      return format("composer.mcpToolCallApproval.mossToolTitle", { action: mossOwnAction });
    }
    if (mossOwnTool && mcpTool.tool) {
      return format("composer.mcpToolCallApproval.toolTitle", { toolName: mcpTool.tool });
    }
    if (mcpTool.server && mcpTool.tool) {
      return format("composer.mcpToolCallApproval.title", {
        connectorName: mcpTool.server,
        toolName: mcpTool.tool,
      });
    }
    return mcpTool.tool
      ? format("composer.mcpToolCallApproval.toolTitle", { toolName: mcpTool.tool })
      : t("composer.mcpToolCallApproval.genericTitle");
  };

  const reasonTitle = approval.approvalReason?.trim() || null;
  const reasonIsTitle = reasonTitle !== null && (variant === "terminal" || variant === "edit");
  const title = webMcpCall
    ? format("composer.webMcpApproval.title", {
        site: webMcpCall.site,
        pageTool: webMcpCall.pageTool,
      })
    : computerScope
      ? computerScope.prompt
      : reasonIsTitle
        ? reasonTitle
        : variant === "terminal"
          ? t("execApprovalRequest.prompt")
          : variant === "edit"
            ? // Without the request's file list (a clamped `Edit:` input no longer parses) the
              // card never claims more than one.
              editedFiles.length > 1
              ? t("patchApprovalRequest.prompt.many")
              : t("patchApprovalRequest.prompt.one")
            : variant === "mcp"
              ? mcpApprovalTitle()
              : approval.requestKind === "file-read" && filePath
                ? format("permissionRequest.view", { paths: filePath })
                : t("execApprovalRequest.prompt");

  const subtitle = webMcpCall
    ? t("composer.webMcpApproval.subtitle")
    : computerScope
      ? `${computerScope.allowDetail} ${computerScope.denyDetail} ${computerScope.cancelDetail}`
      : mossOwnTool && mossOwnAction
        ? mcpTool.tool
        : null;
  // Codex's generated question only repeats the server and tool the card already names; every
  // other text a provider sends (a path, a URL, a command, raw input) is the request itself.
  const providerQuestionOnly = CODEX_MCP_APPROVAL_QUESTION.test(approval.detail?.trim() ?? "");
  const hasParams = (approval.toolParamsDisplay?.length ?? 0) > 0;
  const hasDetails = hasParams || fileChanges.length > 0;

  return (
    <div
      onKeyDown={handleKeyDown}
      data-codex-approval-surface="true"
      data-approval-variant={variant}
      className="@container/approval-card codex-approval-surface flex flex-col overflow-hidden text-foreground focus:outline-none"
    >
      <div className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain px-4 pt-4 pb-3">
        <div role="alert" aria-atomic="true" className="flex min-w-0 flex-col gap-2">
          {identity ? (
            <div className="flex items-center gap-2 font-normal text-size-chat-sm leading-5 text-codex-secondary">
              {variant === "terminal" ? (
                <TerminalIcon aria-hidden className="size-4 shrink-0" />
              ) : variant === "edit" ? (
                <PencilIcon aria-hidden className="size-4 shrink-0" />
              ) : null}
              <span>{identity}</span>
              {pendingCount > 1 ? (
                <span className="ms-auto tabular-nums">1/{pendingCount}</span>
              ) : null}
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="min-w-0 text-size-chat leading-5 font-medium wrap-anywhere text-foreground">
              {title}
            </p>
            {subtitle ? (
              <p className="text-size-chat-sm leading-5 text-codex-description">{subtitle}</p>
            ) : null}
          </div>
          {editedFiles.length > 0 ? (
            <ul className="flex min-w-0 flex-col gap-0.5" data-approval-files="true">
              {editedFiles.map((path) => (
                <li
                  key={path}
                  className="min-w-0 font-mono text-size-code leading-5 wrap-anywhere text-foreground"
                >
                  {path}
                </li>
              ))}
            </ul>
          ) : null}
          {hasDetails ? (
            <button
              type="button"
              className="self-start text-size-chat-sm text-codex-secondary underline-offset-2 hover:underline"
              aria-expanded={paramsOpen}
              onClick={() => setParamsOpen((open) => !open)}
            >
              {paramsOpen
                ? t("composer.mcpToolCallApproval.hideDetails")
                : t("composer.mcpToolCallApproval.showDetails")}
            </button>
          ) : null}
        </div>
      </div>
      {paramsOpen && fileChanges.length > 0 ? <FileChangeDetails changes={fileChanges} /> : null}
      {paramsOpen || !hasParams ? (
        <ApprovalDetail
          detail={detail}
          // The detail repeats the reason only where the reason is the title (terminal and edit).
          suppressText={reasonIsTitle ? reasonTitle : null}
          // Hidden only where it repeats what the card shows: Codex's generated question, or the
          // provider's sentence over a tool's argument rows (WALK-7 N7-2, REVIEW-RULES rule 9).
          hideFallback={providerQuestionOnly || (variant === "mcp" && hasParams)}
          // The files named above are the request; no line asks to review nothing.
          namesRequest={editedFiles.length > 0}
          {...(approval.permissionProfile ? { permissionProfile: approval.permissionProfile } : {})}
          {...(approval.toolName && !hasParams ? { toolName: approval.toolName } : {})}
          {...(hasParams && paramsOpen && approval.toolParamsDisplay
            ? {
                toolParamsDisplay: webMcpCall
                  ? approval.toolParamsDisplay.map((row) => ({
                      ...row,
                      displayName:
                        row.name === "site"
                          ? t("composer.webMcpApproval.site")
                          : row.name === "pageTool"
                            ? t("composer.webMcpApproval.pageTool")
                            : row.name === "arguments"
                              ? t("composer.webMcpApproval.arguments")
                              : row.name,
                    }))
                  : approval.toolParamsDisplay,
              }
            : {})}
        />
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-3 pt-1 pb-3">
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isResponding}
            data-moss-visible-permission-action="decline"
            onClick={() => respondOnce("decline")}
          >
            {denyLabel}
            {/* 允许 has no key: approving is a click, or the person's own Tab to it and Enter or
                Space (walk H-4: a stray Enter must never approve a command). */}
            <ButtonKeycap>Esc</ButtonKeycap>
          </Button>
          {sessionAvailable && !computerScope ? (
            <div className="inline-flex min-w-0">
              <Button
                type="button"
                size="sm"
                disabled={isResponding}
                className="rounded-r-none"
                data-moss-visible-permission-action="accept"
                onClick={() => respondOnce("accept")}
              >
                <span className="truncate">{allowLabel}</span>
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      disabled={isResponding}
                      className="rounded-l-none px-1.5"
                      aria-label={t("approvalRequestCard.approvalOptions")}
                    />
                  }
                >
                  <ChevronDownIcon className="size-3" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="end" side="top">
                  <MenuItem onClick={() => respondOnce("accept")}>{allowLabel}</MenuItem>
                  <MenuItem
                    data-moss-visible-permission-action={scopedDecision}
                    onClick={() => respondOnce(scopedDecision)}
                  >
                    {scopedLabel}
                  </MenuItem>
                </ComposerPickerMenuPopup>
              </Menu>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={isResponding}
              data-moss-visible-permission-action="accept"
              onClick={() => respondOnce("accept")}
            >
              {allowLabel}
            </Button>
          )}
          {computerScope ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isResponding}
              data-moss-visible-permission-action="cancel"
              onClick={() => respondOnce("cancel")}
            >
              {computerScope.cancelLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/**
 * The site and the page's tool of a WebMCP call's card (rows the agent gateway sends as
 * `site`, `pageTool`, `arguments`); null for every other approval.
 */
function readWebMcpApprovalRows(
  approval: PendingApproval,
): { readonly site: string; readonly pageTool: string } | null {
  if (!isWebMcpCallToolName(approval.toolName)) return null;
  const rows = approval.toolParamsDisplay ?? [];
  const text = (name: string) => {
    const value = rows.find((row) => row.name === name)?.value;
    return typeof value === "string" ? value : null;
  };
  const site = text("site");
  const pageTool = text("pageTool");
  return site !== null && pageTool !== null ? { site, pageTool } : null;
}

function ApprovalDetail({
  detail,
  permissionProfile,
  toolName,
  toolParamsDisplay,
  suppressText,
  hideFallback = false,
  namesRequest = false,
}: {
  detail: string | null;
  permissionProfile?: Record<string, unknown>;
  toolName?: string;
  toolParamsDisplay?: PendingApproval["toolParamsDisplay"];
  suppressText?: string | null;
  hideFallback?: boolean;
  namesRequest?: boolean;
}) {
  const { locale } = useTranslation();
  const shownDetail = detail && !hideFallback && detail !== suppressText ? detail : null;
  if (permissionProfile) {
    return (
      <div className="mt-2">
        {shownDetail ? <VerbatimDetail detail={shownDetail} /> : null}
        <pre
          className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-control bg-[var(--color-background-elevated-secondary)] px-2.5 py-2 font-mono text-ui-sm leading-relaxed text-foreground/85"
          title="Requested permission profile"
        >
          <code>{JSON.stringify(permissionProfile, null, 2)}</code>
        </pre>
      </div>
    );
  }

  if (toolName || (toolParamsDisplay?.length ?? 0) > 0) {
    return (
      <div className="mt-2">
        {shownDetail ? <VerbatimDetail detail={shownDetail} /> : null}
        {toolParamsDisplay && toolParamsDisplay.length > 0 ? (
          <dl className="mt-2 space-y-1 rounded-control bg-[var(--color-background-elevated-secondary)] px-2.5 py-2 text-ui-xs leading-snug">
            {toolParamsDisplay.map((parameter) => (
              <div className="grid grid-cols-[auto_1fr] gap-x-2" key={parameter.name}>
                <dt className="font-medium text-muted-foreground/65">
                  {approvalParamLabel(parameter, locale)}
                </dt>
                <dd className="min-w-0 break-words whitespace-pre-wrap font-mono text-foreground/80">
                  {formatToolParameterValue(parameter.value)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    );
  }

  if (shownDetail) return <VerbatimDetail detail={shownDetail} />;

  if (suppressText || hideFallback || namesRequest) return null;
  return (
    <p className="px-4 pb-2 text-ui text-muted-foreground/65">Review the request to continue.</p>
  );
}

/** Each file's change as the provider sent it, under its path. */
function FileChangeDetails({ changes }: { changes: NonNullable<PendingApproval["fileChanges"]> }) {
  return (
    <div className="flex max-h-80 min-h-0 flex-col gap-1 overflow-y-auto pb-1">
      {changes.map((change) => (
        <div key={change.path} className="flex min-w-0 flex-col gap-1">
          <p className="px-4 font-mono text-size-code leading-5 wrap-anywhere text-codex-secondary">
            {change.path}
          </p>
          <VerbatimDetail detail={change.diff} />
        </div>
      ))}
    </div>
  );
}

/**
 * The request exactly as the provider sent it: every character, space and line, its `...`
 * included. Says so in one line when the server cut it before it reached the card.
 */
function VerbatimDetail({ detail }: { detail: string }) {
  const { t } = useTranslation();
  return (
    <div className="px-3 pb-1">
      <div className="flex max-h-80 w-full flex-col overflow-hidden rounded-control bg-surface-tertiary text-size-code text-tertiary">
        <div className="min-h-0 overflow-y-auto px-2 pt-2 pb-2 font-mono font-medium">
          <Tooltip>
            <TooltipTrigger
              delay={200}
              render={
                <span
                  className="block break-words whitespace-pre-wrap"
                  data-approval-command="true"
                >
                  {detail}
                </span>
              }
            />
            <TooltipPopup variant="command" side="top" align="start" className="max-w-96">
              <span className="whitespace-pre-wrap">{detail}</span>
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {isServerClampedDetail(detail) ? (
        <p className="px-1 pt-1 text-ui-sm text-muted-foreground" data-approval-truncated="true">
          {t("approvalRequestCard.detailTruncated")}
        </p>
      ) : null}
    </div>
  );
}

function formatToolParameterValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The projection clamps a request's detail at 2,000 characters
 * (`MAX_ACTIVITY_DATA_STRING_CHARS` in providerRuntimeActivityProjection.ts): it keeps the first
 * 1,997 and adds `...`. Only text of exactly that shape was cut before it reached the card.
 */
const SERVER_DETAIL_LIMIT = 2_000;

function isServerClampedDetail(detail: string): boolean {
  return detail.length === SERVER_DETAIL_LIMIT && detail.endsWith("...");
}

/**
 * The path a file request names, for the title only (the body shows the detail whole). Read only
 * from a complete `Tool: {json}` detail that parses as an object; anything else names no file.
 */
function requestedFilePath(detail: string | null): string | null {
  const match = detail?.match(/^[A-Za-z][\w-]*: (\{[\s\S]*\})$/u);
  if (!match?.[1]) return null;
  let input: unknown;
  try {
    input = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
