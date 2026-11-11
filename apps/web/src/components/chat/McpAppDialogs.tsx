// FILE: McpAppDialogs.tsx
// Purpose: The two confirm dialogs a widget can raise (SPEC §8): leaving Moss for a link
//          (web, email, text, call variants, look-alike and credential warnings, "don't ask
//          again"), and saving files to this computer. Cancel has the initial focus; the link
//          button arms 400 ms after the dialog shows.
// Layer: Chat transcript UI
// Exports: McpAppOpenLinkDialog, McpAppDownloadDialog

import { useEffect, useRef, useState } from "react";

import { useTranslation } from "~/localization";
import { MCP_APP_OPEN_LINK_ARM_MS } from "~/lib/mcpApps/constants";
import type { McpAppLinkPlan } from "~/lib/mcpApps/openLink";
import type { McpAppDownloadItem } from "~/lib/mcpApps/requestHandlers";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

type ConfirmPlan = Extract<McpAppLinkPlan, { action: "confirm" }>;

const LINK_BOX_CLASS_NAME =
  "mt-3 max-h-40 overflow-y-auto break-all rounded-row border border-border bg-[var(--color-background-panel)] px-4 py-3 text-ui text-foreground";

function useArmed(delayMs: number): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);
  return armed;
}

function DetailRows(props: { rows: ReadonlyArray<readonly [string, string | undefined]> }) {
  const rows = props.rows.filter((row): row is readonly [string, string] => Boolean(row[1]));
  if (rows.length === 0) return null;
  return (
    <dl className={`${LINK_BOX_CLASS_NAME} grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-normal`}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all whitespace-pre-wrap">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function McpAppOpenLinkDialog(props: {
  plan: ConfirmPlan;
  onAnswer: (answer: { dontAskAgain: boolean } | null) => void;
}) {
  const { t, format } = useTranslation();
  const { plan } = props;
  const armed = useArmed(MCP_APP_OPEN_LINK_ARM_MS);
  const [dontAsk, setDontAsk] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);
  const answer = (value: { dontAskAgain: boolean } | null) => {
    if (answered.current) return;
    answered.current = true;
    props.onAnswer(value);
  };
  const title =
    plan.kind === "mail"
      ? t("mcpApp.openLink.mailTitle")
      : plan.kind === "text"
        ? t("mcpApp.openLink.textTitle")
        : plan.kind === "call"
          ? t("mcpApp.openLink.callTitle")
          : t("mcpApp.openLink.title");
  const body =
    plan.kind === "mail"
      ? t("mcpApp.openLink.mailBody")
      : plan.kind === "text"
        ? t("mcpApp.openLink.textBody")
        : plan.kind === "call"
          ? t("mcpApp.openLink.callBody")
          : t("mcpApp.openLink.body");
  return (
    <Dialog open onOpenChange={(open) => !open && answer(null)}>
      <DialogPopup
        showCloseButton={false}
        className="max-w-md"
        initialFocus={cancelRef}
        data-mcp-app-dialog="open-link"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {plan.kind === "web" ? (
            <div className={LINK_BOX_CLASS_NAME} data-mcp-app-link-url="true">
              {plan.url}
            </div>
          ) : (
            <DetailRows
              rows={
                plan.kind === "mail"
                  ? [
                      [t("mcpApp.openLink.to"), plan.details.to],
                      [t("mcpApp.openLink.cc"), plan.details.cc],
                      [t("mcpApp.openLink.bcc"), plan.details.bcc],
                      [t("mcpApp.openLink.subject"), plan.details.subject],
                      [t("mcpApp.openLink.message"), plan.details.body],
                    ]
                  : plan.kind === "text"
                    ? [
                        [t("mcpApp.openLink.to"), plan.details.to],
                        [t("mcpApp.openLink.message"), plan.details.body],
                      ]
                    : [[t("mcpApp.openLink.to"), plan.details.to]]
              }
            />
          )}
          {plan.punycode || plan.credentials ? (
            <div
              className="mt-3 rounded-row border border-destructive/40 bg-destructive/8 p-3 text-ui text-destructive"
              role="alert"
              data-mcp-app-link-warning={plan.punycode ? "punycode" : "credentials"}
            >
              {plan.punycode
                ? t("mcpApp.openLink.punycodeWarning")
                : t("mcpApp.openLink.credentialsWarning")}
            </div>
          ) : null}
          {plan.kind === "web" ? (
            <label className="mt-3 flex items-center gap-2 text-ui text-foreground">
              <Checkbox checked={dontAsk} onCheckedChange={(next) => setDontAsk(next === true)} />
              <span className="min-w-0 break-all">
                {format("mcpApp.openLink.dontAsk", { domain: plan.displayDomain })}
              </span>
            </label>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={() => answer(null)}>
            {t("mcpApp.openLink.cancel")}
          </Button>
          <Button
            disabled={!armed}
            data-mcp-app-link-confirm="true"
            onClick={() => answer({ dontAskAgain: dontAsk })}
          >
            {plan.kind === "web" ? t("mcpApp.openLink.confirm") : t("mcpApp.openLink.continue")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function McpAppDownloadDialog(props: {
  items: readonly McpAppDownloadItem[];
  onAnswer: (confirmed: boolean) => void;
}) {
  const { t, format } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);
  const answer = (value: boolean) => {
    if (answered.current) return;
    answered.current = true;
    props.onAnswer(value);
  };
  const many = props.items.length > 1;
  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogPopup
        showCloseButton={false}
        className="max-w-md"
        initialFocus={cancelRef}
        data-mcp-app-dialog="download"
      >
        <DialogHeader>
          <DialogTitle>
            {many ? t("mcpApp.download.titleMany") : t("mcpApp.download.title")}
          </DialogTitle>
          <DialogDescription>
            {many
              ? format("mcpApp.download.many", { count: props.items.length })
              : t("mcpApp.download.one")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className={LINK_BOX_CLASS_NAME}>
            {props.items.map((item, index) => (
              <li key={`${item.fileName}-${index}`} className="break-all">
                {item.fileName}
              </li>
            ))}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={() => answer(false)}>
            {t("mcpApp.openLink.cancel")}
          </Button>
          <Button data-mcp-app-download-confirm="true" onClick={() => answer(true)}>
            {t("mcpApp.download.confirm")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
