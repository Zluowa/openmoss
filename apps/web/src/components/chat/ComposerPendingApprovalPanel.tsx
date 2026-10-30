// FILE: ComposerPendingApprovalPanel.tsx
// Purpose: Detached card, floating just above the composer, that surfaces a pending
// tool approval — the command / file context plus approve / decline / cancel actions
// rendered as list-style choice rows. Mirrors ComposerPendingUserInputPanel (same
// surface, spacing, chips, and scoped keyboard shortcuts) so approvals and AskUserQuestion
// prompts read as one coherent decision surface instead of the old fused-banner look.
// Layer: Chat composer UI
// Exports: ComposerPendingApprovalPanel

import { type ApprovalRequestId, type ProviderApprovalDecision } from "@synara/contracts";
import { isMossAppsServer } from "@synara/shared/mossAppsPresentation";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { type KeyboardEvent, useState, useRef } from "react";
import { type PendingApproval } from "../../session-logic";
import { useTranslation } from "../../localization";
import { ChevronDownIcon, PencilIcon, TerminalIcon } from "~/lib/icons";
import { localizeMossAppsToolAction, resolveMcpApprovalTool } from "~/lib/toolCallLabel";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ApprovalAppDock } from "./ApprovalAppDock";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
// Codex 26.1007 approval chrome:
// - desktop shell `rJc` variant `transcript-card` (app-initial `fJc` when `Fd()`):
//   radius `--radius-4xl-base` 1.5rem, glass fill from `._Material_9q659_2`
// - header `gJc`: identity `text-size-chat-sm text-secondary`, title `text-size-chat font-medium`
// - exec body: pending-request-item-panel `rounded-md bg-surface-tertiary font-mono`
//   (conversation token is white, so the well matches the card)
// - menu `Aml`: Allow once, then scoped action. Not a second Always allow.
// i18n: approvalRequestCard.* , execApprovalRequest.shellLabel / .prompt

/**
 * Codex 26.1007 `cJc`: `⏎` / `Esc` sit in a `bg-current/10` keycap.
 * Primary (Allow) uses the solid-button ink, so the cap reads dark gray on black.
 * Secondary (Deny) uses the default ink, so the cap is a gray chip on the outline.
 */
function ShortcutKeycap({
  variant,
  children,
}: {
  variant: "primary" | "secondary";
  children: string;
}) {
  return (
    <kbd
      aria-hidden="true"
      className={
        variant === "primary"
          ? "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-md border-0 bg-[color-mix(in_oklab,currentcolor_10%,transparent)] px-1.5 py-0 font-sans text-ui-sm leading-4 text-[var(--color-text-primary-solid)] shadow-none"
          : "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-md border-0 bg-[color-mix(in_oklab,currentcolor_10%,transparent)] px-1.5 py-0 font-sans text-ui-sm leading-4 text-[var(--color-text-foreground)] shadow-none"
      }
    >
      {children}
    </kbd>
  );
}

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

type ParsedApproval = {
  tool: string | null;
  fileName: string | null;
  fileDir: string | null;
  command: string | null;
  fallback: string | null;
};

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
  const [paramsOpen, setParamsOpen] = useState(false);
  const parsed = parseApprovalDetail(approval.detail);
  const requestId = approval.requestId;
  const requestKey = pendingRequestInstanceKey(requestId, approval.lifecycleGeneration);
  const submissionKey = JSON.stringify([requestKey, approval.responseAttemptKey ?? null]);
  const submittedRequestKeyRef = useRef<string | null>(null);
  const computerScope = approval.approvalScope
    ? COMPUTER_SCOPES[approval.approvalScope]
    : undefined;
  const sessionAvailable = !computerScope && approval.sessionApprovalAvailable !== false;
  const fileCount = parsed.fileName ? 1 : 0;
  const mcpTool = resolveMcpApprovalTool({
    serverName: approval.toolServerName,
    toolName: approval.toolName ?? parsed.tool ?? undefined,
  });
  const mossAppsAction =
    mcpTool.tool && isMossAppsServer(mcpTool.server)
      ? localizeMossAppsToolAction(mcpTool.tool, locale)
      : null;
  const connectorName = mossAppsAction
    ? t("composer.mcpToolCallApproval.mossAppsName")
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
    if (event.key === "Enter" && !(target instanceof HTMLButtonElement)) {
      event.preventDefault();
      respondOnce("accept");
    }
  };

  const allowLabel = computerScope?.allowLabel ?? t("approvalRequestCard.allowOnce");
  const denyLabel = computerScope?.denyLabel ?? t("approvalRequestCard.deny");
  // Codex `Aml` dropdown (`app-initial` approval card): item 1 is Allow once
  // (`onApprove` → `accept`). Item 2 is the scoped action. Exec with a prefix
  // (`Yr` / `Qr`) is "Allow similar commands" → `acceptWithExecpolicyAmendment`.
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

  const identity =
    computerScope !== undefined
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
  const title = computerScope
    ? computerScope.prompt
    : reasonTitle && (variant === "terminal" || variant === "edit")
      ? reasonTitle
      : variant === "terminal"
        ? t("execApprovalRequest.prompt")
        : variant === "edit"
          ? format(
              fileCount === 1
                ? "patchApprovalRequest.prompt.one"
                : "patchApprovalRequest.prompt.many",
              {},
            )
          : variant === "mcp"
            ? mcpApprovalTitle()
            : approval.requestKind === "file-read" && parsed.fileName
              ? format("permissionRequest.view", { paths: parsed.fileName })
              : t("execApprovalRequest.prompt");

  const subtitle = computerScope
    ? `${computerScope.allowDetail} ${computerScope.denyDetail} ${computerScope.cancelDetail}`
    : null;
  const hasParams = (approval.toolParamsDisplay?.length ?? 0) > 0;

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
          {hasParams ? (
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
      {paramsOpen || !hasParams ? (
        <ApprovalDetail
          parsed={parsed}
          suppressText={reasonTitle}
          // The provider's own sentence repeats the title (Codex) or the rows (Claude's input).
          hideFallback={variant === "mcp" && hasParams}
          {...(approval.permissionProfile ? { permissionProfile: approval.permissionProfile } : {})}
          {...(approval.toolName && !hasParams ? { toolName: approval.toolName } : {})}
          {...(hasParams && paramsOpen && approval.toolParamsDisplay
            ? { toolParamsDisplay: approval.toolParamsDisplay }
            : {})}
        />
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-3 pt-1 pb-3">
        {variant === "terminal" ? <ApprovalAppDock /> : null}
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
            <ShortcutKeycap variant="secondary">Esc</ShortcutKeycap>
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
                <ShortcutKeycap variant="primary">⏎</ShortcutKeycap>
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
                  <ChevronDownIcon className="size-3.5" />
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
              <ShortcutKeycap variant="primary">⏎</ShortcutKeycap>
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

function ApprovalDetail({
  parsed,
  permissionProfile,
  toolName,
  toolParamsDisplay,
  suppressText,
  hideFallback = false,
}: {
  parsed: ParsedApproval;
  permissionProfile?: Record<string, unknown>;
  toolName?: string;
  toolParamsDisplay?: PendingApproval["toolParamsDisplay"];
  suppressText?: string | null;
  hideFallback?: boolean;
}) {
  if (permissionProfile) {
    return (
      <div className="mt-2">
        {parsed.fallback ? (
          <p className="mb-1.5 text-ui-sm leading-snug text-muted-foreground/70">
            {parsed.fallback}
          </p>
        ) : null}
        <pre
          className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-background-elevated-secondary)] px-2.5 py-2 font-mono text-ui-sm leading-relaxed text-foreground/85"
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
        {parsed.fallback && !hideFallback ? (
          <p className="text-ui-sm leading-snug text-muted-foreground/70">{parsed.fallback}</p>
        ) : null}
        {toolParamsDisplay && toolParamsDisplay.length > 0 ? (
          <dl className="mt-2 space-y-1 rounded-md bg-[var(--color-background-elevated-secondary)] px-2.5 py-2 text-ui-xs leading-snug">
            {toolParamsDisplay.map((parameter) => (
              <div className="grid grid-cols-[auto_1fr] gap-x-2" key={parameter.name}>
                <dt className="font-medium text-muted-foreground/65">
                  {parameter.displayName ?? parameter.name}
                </dt>
                <dd className="min-w-0 break-words font-mono text-foreground/80">
                  {formatToolParameterValue(parameter.value)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    );
  }

  if (parsed.fileName) {
    return (
      <div className="mt-2">
        <p
          className="truncate text-ui-lg font-medium leading-tight text-foreground/85"
          title={parsed.fileDir ? `${parsed.fileDir}/${parsed.fileName}` : parsed.fileName}
        >
          {parsed.fileName}
        </p>
        {parsed.fileDir ? (
          <p
            className="mt-0.5 truncate font-mono text-ui-xs leading-tight text-muted-foreground/55"
            title={parsed.fileDir}
          >
            {shortenPath(parsed.fileDir)}
          </p>
        ) : null}
      </div>
    );
  }

  const code = parsed.command ?? parsed.fallback;
  if (code && code !== suppressText) {
    return (
      <div className="px-3 pb-1">
        <div className="flex max-h-80 w-full flex-col overflow-hidden rounded-md bg-surface-tertiary text-size-code text-tertiary">
          <div className="min-h-0 overflow-y-auto px-2 pt-2 pb-2 font-mono font-medium">
            <Tooltip>
              <TooltipTrigger
                delay={200}
                render={
                  <span
                    className="block break-words whitespace-pre-wrap"
                    data-approval-command="true"
                  >
                    {code}
                  </span>
                }
              />
              <TooltipPopup variant="command" side="top" align="start" className="max-w-96">
                <span className="whitespace-pre-wrap">{code}</span>
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
      </div>
    );
  }

  if (suppressText) return null;
  return (
    <p className="px-4 pb-2 text-ui text-muted-foreground/65">Review the request to continue.</p>
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
 * Parses the approval `detail` string into structured fields.
 *
 * Detail is produced server-side by `summarizeToolRequest` as
 * `"${toolName}: ${JSON.stringify(input)}"` and is clamped to ~400 characters.
 * That means JSON.parse often fails on truncated payloads like
 * `{"file_path":"/long/path","old_string":" .fo...`. We therefore try JSON
 * first and fall back to targeted regex extraction so we can still surface the
 * file path / command even from a chopped-off string.
 */
function parseApprovalDetail(detail: string | undefined): ParsedApproval {
  const empty: ParsedApproval = {
    tool: null,
    fileName: null,
    fileDir: null,
    command: null,
    fallback: null,
  };
  if (!detail || detail.length === 0) return empty;

  const colonIdx = detail.indexOf(": ");
  const tool = colonIdx === -1 ? null : detail.slice(0, colonIdx).trim() || null;
  const rawPayload = colonIdx === -1 ? detail : detail.slice(colonIdx + 2);
  const payload = stripTrailingEllipsis(rawPayload);

  const filePath =
    extractJsonString(payload, ["file_path", "path", "notebook_path", "filepath"]) ?? null;
  if (filePath) {
    const { name, parent } = splitPath(filePath);
    return { tool, fileName: name, fileDir: parent, command: null, fallback: null };
  }

  const command = extractJsonString(payload, ["command", "cmd"]) ?? null;
  if (command) {
    return {
      tool,
      fileName: null,
      fileDir: null,
      command: collapseWhitespace(command),
      fallback: null,
    };
  }

  const pattern = extractJsonString(payload, ["pattern", "query"]);
  if (pattern) {
    return {
      tool,
      fileName: null,
      fileDir: null,
      command: pattern,
      fallback: null,
    };
  }

  const url = extractJsonString(payload, ["url"]);
  if (url) {
    return { tool, fileName: null, fileDir: null, command: url, fallback: null };
  }

  // Payload is not a recognized JSON shape — treat it as a raw command/text.
  const fallback = collapseWhitespace(payload);
  return {
    tool,
    fileName: null,
    fileDir: null,
    command: null,
    fallback: fallback.length > 0 ? fallback : null,
  };
}

/**
 * Extracts the first matching string field from a (possibly truncated) JSON
 * object. Prefers a real JSON.parse when it succeeds, otherwise falls back to
 * a permissive regex that tolerates truncation mid-value.
 */
function extractJsonString(payload: string, keys: ReadonlyArray<string>): string | null {
  const parsed = tryParseJson(payload);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }

  for (const key of keys) {
    const value = regexExtractString(payload, key);
    if (value && value.length > 0) {
      return value;
    }
  }
  return null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Pulls a JSON string value for `key` out of a possibly truncated JSON-ish
 * payload. Handles the common `\"` and `\\` escapes inside the string body.
 * If the value is unterminated (truncation), returns whatever was captured.
 */
function regexExtractString(payload: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchored to `"key"` followed by a colon and an opening quote.
  const pattern = new RegExp(`"${escapedKey}"\\s*:\\s*"`, "g");
  const match = pattern.exec(payload);
  if (!match) return null;

  const start = match.index + match[0].length;
  let out = "";
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === "\\") {
      const next = payload[i + 1];
      if (next === undefined) break;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else out += next;
      i += 1;
      continue;
    }
    if (ch === '"') {
      return out;
    }
    out += ch;
  }
  // Truncated before closing quote — return partial value if we got anything.
  return out.length > 0 ? out : null;
}

function stripTrailingEllipsis(value: string): string {
  return value.replace(/\.{3}$/u, "").replace(/…$/u, "");
}

function splitPath(path: string): { name: string; parent: string | null } {
  const normalized = path.replace(/\\/g, "/");
  const trimmed = normalized.replace(/\/+$/, "");
  const lastSep = trimmed.lastIndexOf("/");
  if (lastSep === -1) {
    return { name: trimmed, parent: null };
  }
  return {
    name: trimmed.slice(lastSep + 1) || trimmed,
    parent: trimmed.slice(0, lastSep) || null,
  };
}

function shortenPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const homeMatch = normalized.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/);
  const withoutHome = homeMatch ? `~${normalized.slice(homeMatch[0].length)}` : normalized;
  const segments = withoutHome.split("/").filter((s) => s.length > 0);
  if (segments.length <= 3) {
    return withoutHome;
  }
  const leading = withoutHome.startsWith("~") ? "~" : "";
  const tail = segments.slice(-2).join("/");
  return `${leading}/…/${tail}`.replace(/^\/…/, "…");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
