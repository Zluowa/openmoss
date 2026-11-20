// FILE: DevsReportConfirmDialog.tsx
// Purpose: The one question before a developer report leaves Moss: the report as it will be
//   sent, one line on what is not, and Send. The app or chat facts that ride along, where the
//   report goes and the installation ID wait under Details, so nothing sent is hidden and
//   nothing is in the way.
// Layer: Chat UI
// Exports: DevsReportConfirmDialog

import { useState } from "react";

import { useTranslation } from "~/localization";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { settleDevsReportConfirmation, useDevsReportConfirmStore } from "./devsReportConfirmStore";

// The person's words read as prose; the machine facts under Details stay monospaced.
const REPORT_TEXT_CLASS =
  "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-card bg-foreground/4 px-3 py-2.5 text-ui text-foreground";
const FACTS_TEXT_CLASS =
  "m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-card bg-foreground/4 px-3 py-2 font-mono text-ui-xs text-muted-foreground";

export function DevsReportConfirmDialog() {
  const { t, format } = useTranslation();
  const preview = useDevsReportConfirmStore((state) => state.pending?.preview ?? null);
  const local = useDevsReportConfirmStore((state) => state.pending?.local ?? null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const attachments = preview?.attachments ?? [];
  const texts = attachments.filter((attachment) => attachment.kind === "text");
  const skipped = local?.skipped ?? [];
  const settle = (confirmed: boolean) => {
    setDetailsOpen(false);
    settleDevsReportConfirmation(confirmed);
  };
  return (
    <AlertDialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("devs.confirm.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("devs.confirm.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        {preview ? (
          <div className="space-y-3 px-4 py-2">
            <div className={REPORT_TEXT_CLASS} data-testid="devs-report-description">
              {preview.description}
            </div>
            {attachments.length ? (
              <section
                className="space-y-2"
                data-testid="devs-report-attachments"
                aria-label={format("devs.confirm.attachments", { count: attachments.length })}
              >
                {local?.imagePreviews.length ? (
                  <div className="flex flex-wrap gap-2">
                    {local.imagePreviews.map((url, index) => (
                      <img
                        // oxlint-disable-next-line react/no-array-index-key -- previews never reorder
                        key={index}
                        src={url}
                        alt=""
                        className="size-14 rounded-card border border-border object-cover"
                      />
                    ))}
                  </div>
                ) : null}
                {texts.map((attachment) => (
                  <div key={attachment.name} className="space-y-1">
                    <div className="text-ui-xs text-muted-foreground">{attachment.name}</div>
                    <pre className={FACTS_TEXT_CLASS}>{attachment.text}</pre>
                  </div>
                ))}
              </section>
            ) : null}
            {skipped.length ? (
              <p className="m-0 text-ui-sm text-muted-foreground" data-testid="devs-report-skipped">
                {format("devs.confirm.notSent", {
                  names: skipped.map((item) => item.name).join("、"),
                })}
              </p>
            ) : null}
            {/* A legal notice for mainland China numbers: always in view, never under Details. */}
            {preview.processedOutsideMainlandChina ? (
              <p className="m-0 text-ui-sm text-foreground" data-testid="devs-report-outside-china">
                {t("devs.confirm.outsideMainlandChina")}
              </p>
            ) : null}
            <div>
              <Button
                size="xs"
                variant="ghost"
                className="-ml-2 text-muted-foreground"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <DisclosureChevron open={detailsOpen} className="size-3.5" />
                {t("devs.confirm.details")}
              </Button>
              <DisclosureRegion open={detailsOpen}>
                <div className="space-y-2 pt-2">
                  <div className="space-y-1">
                    <div className="text-ui-xs text-muted-foreground">
                      {preview.scope === "application"
                        ? t("feedback.appContext")
                        : t("devs.confirm.context")}
                    </div>
                    <pre className={FACTS_TEXT_CLASS} data-testid="devs-report-context">
                      {preview.context}
                    </pre>
                  </div>
                  <p className="m-0 text-ui-xs text-muted-foreground">
                    {t("devs.confirm.routing")}
                  </p>
                  <p className="m-0 text-ui-xs text-muted-foreground">
                    {t("devs.confirm.alsoSent")}
                  </p>
                </div>
              </DisclosureRegion>
            </div>
          </div>
        ) : null}
        <AlertDialogFooter>
          <Button variant="ghost" onClick={() => settle(false)}>
            {t("devs.confirm.cancel")}
          </Button>
          <Button onClick={() => settle(true)}>{t("devs.confirm.send")}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
