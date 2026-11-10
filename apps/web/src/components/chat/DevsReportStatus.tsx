import { useEffect, useState } from "react";
import type { DevsReportState, ThreadId } from "@moss/contracts";
import { useTranslation } from "../../localization";
import { readNativeApi } from "../../nativeApi";
import { DEVS_REPORT_CHANGED } from "./handleDevsReportSend";

/**
 * The card says what is true now: still sending, received, Codex working, fix submitted, or a
 * developer needed. `delivered` is absent only from an older server.
 */
export function devsReportCardCopy(report: DevsReportState) {
  switch (report.status) {
    case "failed":
      return report.delivered === false
        ? ({ title: "devs.notDelivered", detail: "devs.notDeliveredDetail" } as const)
        : ({ title: "devs.failed", detail: "devs.failedDetail" } as const);
    case "pull-request":
      return { title: "devs.pull-request", detail: "devs.pull-requestDetail" } as const;
    case "running":
      return { title: "devs.running", detail: "devs.runningDetail" } as const;
    default:
      if (report.delivered === false)
        return { title: "devs.sending", detail: "devs.sendingDetail" } as const;
      if (report.delivered === true)
        return { title: "devs.received", detail: "devs.receivedDetail" } as const;
      return { title: "devs.queued", detail: "devs.queuedDetail" } as const;
  }
}

/** The original chat keeps durable report receipts after navigation and restart. */
export function DevsReportStatus({ threadId }: { threadId: ThreadId }) {
  const { t, format } = useTranslation();
  const [reports, setReports] = useState<readonly DevsReportState[]>([]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    setReports([]);
    const refresh = async () => {
      if (pending || disposed) return;
      const list = readNativeApi()?.server.listDevsReports;
      if (!list) return;
      pending = true;
      try {
        const result = await list({ threadId });
        if (!disposed) setReports(result.reports);
      } catch {
        /* Retain the last receipt while disconnected. */
      } finally {
        pending = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 15_000);
    const changed = () => {
      void refresh();
    };
    window.addEventListener(DEVS_REPORT_CHANGED, changed);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener(DEVS_REPORT_CHANGED, changed);
    };
  }, [threadId]);
  if (!reports.length) return null;
  return (
    <aside
      className="mx-auto mb-2 flex max-w-3xl flex-col gap-2 px-3 text-ui-sm"
      aria-label={t("devs.aria")}
      aria-live="polite"
    >
      {reports.slice(-3).map((report) => {
        const engine = report.engine === "claude" ? "Claude" : "Codex";
        const copy = devsReportCardCopy(report);
        const attachments = report.attachments;
        return (
          <div
            key={report.id}
            className="rounded-xl border border-border bg-muted/40 px-3 py-2"
            data-testid="devs-report-card"
            data-status={report.status}
          >
            <p className="font-medium">
              @devs · {engine} · {t(copy.title)}
            </p>
            <p className="line-clamp-2 text-muted-foreground">{report.description}</p>
            <p className="text-muted-foreground">{format(copy.detail, { engine })}</p>
            {attachments && attachments.count > 0 ? (
              <p className="text-muted-foreground" data-testid="devs-report-attachments-status">
                {attachments.missed
                  ? format("devs.attachmentsMissed", {
                      count: attachments.count - attachments.delivered,
                    })
                  : attachments.delivered >= attachments.count
                    ? format("devs.attachmentsDelivered", { count: attachments.count })
                    : format("devs.attachmentsPending", {
                        delivered: attachments.delivered,
                        count: attachments.count,
                      })}
              </p>
            ) : null}
            {report.pullRequestUrl ? (
              <a
                className="underline"
                href={report.pullRequestUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("devs.viewPr")}
              </a>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}
