// FILE: AgentFeedbackSettingsSection.tsx
// Purpose: Notes agents left through `moss_report_friction`. Each note is one line led by the
//   agents who hit it, their marks overlapping like co-signatures, with a status dot on the
//   front mark for how badly it hurt. A note opens in place to show the details; Send goes
//   straight to the report preview. A sent note stays and shows its report's progress, the
//   same states the chat shows for @devs; a dismissed note folds away.
// Layer: Settings UI
// Exports: AgentFeedbackSettingsSection
// Why: Nothing to show is the common case, so the section stays out of the way until an
//   agent leaves a note, and reading one never costs more than its summary.

import type { AgentFeedbackEntry, AgentFeedbackListResult, DevsReportState } from "@moss/contracts";
import { DEVS_CONSENT_REQUIRED_MESSAGE } from "@moss/shared/devsReport";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ProviderIconStack } from "~/components/ProviderIconStack";
import { devsReportCardCopy } from "~/components/chat/DevsReportStatus";
import { requestDevsReportConfirmation } from "~/components/chat/devsReportConfirmStore";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Spinner } from "~/components/ui/spinner";
import { StatusDot } from "~/components/ui/status-chip";
import { toastManager } from "~/components/ui/toast";
import { buildFeedbackSubmission } from "~/feedback";
import { buildFeedbackDeveloperRequest, deliverFeedback } from "~/feedbackDeveloperDelivery";
import { CheckIcon, LockIcon } from "~/lib/icons";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { localizeMossToolName } from "~/lib/toolCallLabel";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME } from "~/settingsPanelStyles";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";

import {
  agentFeedbackAgents,
  agentFeedbackDraft,
  agentFeedbackReportId,
  agentFeedbackThreadContext,
  sortAgentFeedback,
} from "./AgentFeedbackSettingsSection.logic";
import { SettingsCard, SettingsSectionShell } from "./SettingsPanelPrimitives";

// Colour carries meaning only: red stopped the agent, amber slowed it, an idea stays ink.
const SEVERITY_DOT_CLASS: Record<AgentFeedbackEntry["severity"], string> = {
  blocker: "bg-destructive",
  friction: "bg-warning",
  idea: "bg-muted-foreground/50",
};

/** The chat's @devs card refreshes at the same pace. */
const REPORT_REFRESH_MS = 15_000;

type RowState = "idle" | "sending" | "sent" | "leaving";

export function AgentFeedbackSettingsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const feedback = useQuery({
    queryKey: serverQueryKeys.agentFeedback(),
    queryFn: () => ensureNativeApi().agentFeedback.list(),
    retry: false,
  });
  const notes = feedback.data?.entries ?? [];
  // A note's report ID comes from the note itself, so its progress needs no record of its own.
  const reportIds = notes.map(agentFeedbackReportId);
  const reportsKey = serverQueryKeys.agentFeedbackReports(reportIds);
  const reports = useQuery({
    queryKey: reportsKey,
    queryFn: async () =>
      (await ensureNativeApi().server.listDevsReports?.({ reportIds }))?.reports ?? [],
    enabled: reportIds.length > 0,
    refetchInterval: REPORT_REFRESH_MS,
    retry: false,
  });
  const reportById = new Map((reports.data ?? []).map((report) => [report.id, report]));
  const reportFor = (entry: AgentFeedbackEntry) => reportById.get(agentFeedbackReportId(entry));
  // Notes still waiting for the person come first; sent ones follow with their progress.
  const sorted = sortAgentFeedback(notes);
  const entries = [
    ...sorted.filter((entry) => !reportFor(entry)),
    ...sorted.filter((entry) => reportFor(entry)),
  ];

  const dropFromList = (id: AgentFeedbackEntry["id"]) =>
    queryClient.setQueryData<AgentFeedbackListResult>(serverQueryKeys.agentFeedback(), (current) =>
      current ? { entries: current.entries.filter((item) => item.id !== id) } : current,
    );

  // Quiet until there is something to read: no empty state, no loading flash.
  if (entries.length === 0) return null;

  return (
    <SettingsSectionShell
      title={t("agentFeedback.title")}
      action={
        <span className="flex items-center gap-1 text-ui-xs text-muted-foreground">
          <LockIcon className="size-3" aria-hidden />
          {t("agentFeedback.localOnly")}
        </span>
      }
    >
      <SettingsCard divided={false}>
        <div
          role="list"
          aria-label={t("agentFeedback.title")}
          className={SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME}
        >
          {entries.map((entry) => (
            <AgentFeedbackRow
              key={entry.id}
              entry={entry}
              report={reportFor(entry)}
              onSent={() => void queryClient.invalidateQueries({ queryKey: reportsKey })}
              onGone={() => dropFromList(entry.id)}
              onRestore={() =>
                void queryClient.invalidateQueries({ queryKey: serverQueryKeys.agentFeedback() })
              }
            />
          ))}
        </div>
      </SettingsCard>
    </SettingsSectionShell>
  );
}

function AgentFeedbackRow(props: {
  readonly entry: AgentFeedbackEntry;
  /** The report this note was sent as, once it has been. */
  readonly report: DevsReportState | undefined;
  /** Refreshes the reports right after a send, rather than at the next interval. */
  readonly onSent: () => void;
  /** Takes the note out of the list once it has folded shut. */
  readonly onGone: () => void;
  /** Reloads the list after a dismissal the server refused. */
  readonly onRestore: () => void;
}) {
  const { t, format, locale } = useTranslation();
  const { entry, report, onGone } = props;
  const reportCopy = report ? devsReportCardCopy(report) : null;
  const engine = report?.engine === "claude" ? "Claude" : "Codex";
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RowState>("idle");
  const severity = t(`agentFeedback.severity.${entry.severity}`);
  const agents = agentFeedbackAgents(entry, locale) || "Moss";
  const toolLabel = entry.tool ? localizeMossToolName(entry.tool, locale) : null;
  const meta = [
    toolLabel,
    new Date(entry.lastReportedAt).toLocaleDateString(locale, { month: "short", day: "numeric" }),
  ]
    .filter(Boolean)
    .join(" · ");

  // Keep the latest removal callback in a ref so parent re-renders never reset the fold timer.
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  // A dismissed note folds shut, then leaves the list.
  useEffect(() => {
    if (state === "leaving") {
      const timer = window.setTimeout(
        () => onGoneRef.current(),
        DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
      );
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [state]);

  const dismiss = async () => {
    setState("leaving");
    try {
      await ensureNativeApi().agentFeedback.dismiss({ id: entry.id });
    } catch {
      setState("idle");
      props.onRestore();
      toastManager.add({ type: "error", title: t("agentFeedback.dismissFailed") });
    }
  };

  const send = async () => {
    setState("sending");
    const report = agentFeedbackDraft(entry, t, format, locale);
    const submission = buildFeedbackSubmission({
      ...report,
      context: agentFeedbackThreadContext(entry),
    });
    try {
      const delivery = await deliverFeedback({
        submission,
        // One ID per note, so a retry after a failure never reaches the outbox twice.
        developerRequest: () =>
          buildFeedbackDeveloperRequest(submission, agentFeedbackReportId(entry)),
        confirm: requestDevsReportConfirmation,
        // Agent-authored notes always show preview, consent and any mainland-China transfer notice.
        requireConfirmation: true,
      });
      if (delivery === "cancelled") {
        setState("idle");
        return;
      }
      // The note stays: from here on its row shows the report's progress.
      setState("sent");
      props.onSent();
    } catch (error) {
      setState("idle");
      toastManager.add({
        type: "error",
        title: t("feedback.failedTitle"),
        description:
          error instanceof Error && error.message.includes(DEVS_CONSENT_REQUIRED_MESSAGE)
            ? t("devs.consentRequired")
            : t("devs.sendFailedDetail"),
      });
    }
  };

  return (
    <div role="listitem">
      <DisclosureRegion open={state !== "leaving"}>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className={cn(
              "flex min-h-control-lg w-full items-center gap-ui-gap-sm px-3 py-2 text-left outline-hidden",
              "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              ELEVATED_HOVER_SURFACE_CLASS_NAME,
            )}
          >
            {/* The agents who hit it, with the severity as a presence dot on the front mark.
                A fixed column (two marks wide) keeps every summary on one text edge. */}
            <span className="inline-flex w-10 shrink-0">
              <span className="relative inline-flex">
                {entry.providers.length > 0 ? (
                  <ProviderIconStack
                    providers={entry.providers.slice(0, 2)}
                    size="md"
                    label={format("agentFeedback.reportedBy", { agents })}
                  />
                ) : null}
                <StatusDot
                  className={cn(
                    entry.providers.length > 0 &&
                      "absolute -right-0.5 -bottom-0.5 ring-2 ring-card",
                    "size-2",
                    SEVERITY_DOT_CLASS[entry.severity],
                  )}
                  role="img"
                  aria-label={severity}
                  title={severity}
                />
              </span>
            </span>
            <span className={cn("min-w-0 flex-1 text-ui text-foreground", !open && "truncate")}>
              {entry.summary}
            </span>
            {reportCopy ? (
              <span
                className="shrink-0 text-ui-xs text-muted-foreground"
                data-testid="agent-feedback-progress"
              >
                {t(reportCopy.title)}
              </span>
            ) : state === "sent" ? (
              <span className="flex shrink-0 items-center gap-1 text-ui-xs text-muted-foreground">
                <CheckIcon className="size-3.5 text-success" aria-hidden />
                {t("agentFeedback.sent")}
              </span>
            ) : entry.occurrences > 1 ? (
              <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
                {format("agentFeedback.occurrences", { count: entry.occurrences })}
              </span>
            ) : null}
            <DisclosureChevron open={open} className="size-4 shrink-0 text-muted-foreground" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {/* Indented to the summary: row padding 12 + mark column 40 + gap 12. */}
            <div className="space-y-1 pr-3 pb-3 pl-16">
              {entry.details ? (
                <p className="text-ui-sm whitespace-pre-wrap text-muted-foreground">
                  {entry.details}
                </p>
              ) : null}
              {entry.proposedFix ? (
                <p className="text-ui-sm whitespace-pre-wrap text-muted-foreground">
                  {format("agentFeedback.proposedFix", { fix: entry.proposedFix })}
                </p>
              ) : null}
              {reportCopy ? (
                <p className="text-ui-sm text-foreground" role="status">
                  {format(reportCopy.detail, { engine })}
                </p>
              ) : null}
              <div className="flex min-h-control-xs items-center gap-ui-gap-xs pt-1">
                <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground/80">
                  {meta}
                </span>
                {report || state === "sent" ? (
                  <>
                    {report?.pullRequestUrl ? (
                      <a
                        className="text-ui-sm text-foreground underline-offset-4 hover:underline"
                        href={report.pullRequestUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("devs.viewPr")}
                      </a>
                    ) : null}
                    <Button size="xs" variant="ghost" onClick={() => void dismiss()}>
                      {t("agentFeedback.dismiss")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={state === "sending"}
                      onClick={() => void dismiss()}
                    >
                      {t("agentFeedback.dismiss")}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={state === "sending"}
                      onClick={() => void send()}
                    >
                      {state === "sending" ? <Spinner className="size-3" /> : null}
                      {t("agentFeedback.send")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </DisclosureRegion>
    </div>
  );
}
