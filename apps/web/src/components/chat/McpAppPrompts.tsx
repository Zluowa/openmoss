// FILE: McpAppPrompts.tsx
// Purpose: The questions a widget can make Moss ask in its row: allow one of its tool calls
//          (same card as Moss's tool approvals), allow device access once per connector, and
//          sign in to its connector before a retry.
// Layer: Chat transcript UI
// Exports: McpAppPromptCard

import { useEffect, useRef } from "react";

import { useTranslation } from "~/localization";
import type { McpAppHostPrompt } from "~/lib/mcpAppHost";
import { Button } from "../ui/button";

export function McpAppPromptCard(props: {
  prompt: McpAppHostPrompt;
  serverLabel: string;
  onAnswer: (answer: boolean) => void;
  onConnect?: () => void;
}) {
  const { t, format } = useTranslation();
  const { prompt } = props;
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
  }, [prompt]);

  const title =
    prompt.kind === "approval"
      ? format("mcpApp.approval.title", {
          server: prompt.serverLabel || props.serverLabel,
          tool: prompt.toolName,
        })
      : prompt.kind === "permission"
        ? format("mcpApp.permission.title", {
            server: props.serverLabel,
            permissions: prompt.permissions
              .map((name) => t(`mcpApp.permission.${name}`))
              .join(t("mcpApp.permission.separator")),
          })
        : format("mcpApp.signIn.title", { serverName: props.serverLabel });
  // The server's `reason` is the same ready-made line as the title, so only permission has detail.
  const detail = prompt.kind === "permission" ? t("mcpApp.permission.detail") : null;
  const denyLabel =
    prompt.kind === "approval"
      ? t("mcpApp.approval.deny")
      : prompt.kind === "permission"
        ? t("mcpApp.permission.deny")
        : t("mcpApp.signIn.dismiss");
  const allowLabel =
    prompt.kind === "approval"
      ? t("mcpApp.approval.allow")
      : prompt.kind === "permission"
        ? t("mcpApp.permission.allow")
        : t("mcpApp.signIn.connect");

  return (
    <div
      className="codex-approval-surface my-2 flex flex-col gap-3 px-4 pt-4 pb-3 text-foreground"
      data-mcp-app-prompt={prompt.kind}
      role="alertdialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onAnswer(false);
        }
      }}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="min-w-0 text-ui leading-5 font-medium wrap-anywhere">{title}</p>
        {detail ? <p className="text-ui-sm leading-5 text-muted-foreground">{detail}</p> : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => props.onAnswer(false)}>
          {denyLabel}
        </Button>
        <Button
          ref={primaryRef}
          type="button"
          size="sm"
          onClick={() => {
            if (prompt.kind === "sign_in") props.onConnect?.();
            else props.onAnswer(true);
          }}
        >
          {allowLabel}
        </Button>
      </div>
    </div>
  );
}
