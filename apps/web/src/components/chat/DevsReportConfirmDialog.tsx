// Confirmation shown before a developer report leaves Moss, with exactly what will be sent.
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
import { settleDevsReportConfirmation, useDevsReportConfirmStore } from "./devsReportConfirmStore";

const SENT_TEXT_CLASS =
  "m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-foreground/5 px-3 py-2 font-mono text-ui-sm";

export function DevsReportConfirmDialog() {
  const { t, format } = useTranslation();
  const preview = useDevsReportConfirmStore((state) => state.pending?.preview ?? null);
  const local = useDevsReportConfirmStore((state) => state.pending?.local ?? null);
  const attachments = preview?.attachments ?? [];
  const texts = attachments.filter((attachment) => attachment.kind === "text");
  const skipped = local?.skipped ?? [];
  return (
    <AlertDialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) settleDevsReportConfirmation(false);
      }}
    >
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("devs.confirm.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("devs.confirm.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        {preview ? (
          <div className="space-y-3 px-4 py-2">
            <section className="space-y-1">
              <div className="text-ui-sm font-medium">{t("devs.confirm.problem")}</div>
              <pre className={SENT_TEXT_CLASS} data-testid="devs-report-description">
                {preview.description}
              </pre>
            </section>
            <section className="space-y-1">
              <div className="text-ui-sm font-medium">
                {preview.scope === "application"
                  ? t("feedback.appContext")
                  : t("devs.confirm.context")}
              </div>
              <pre className={SENT_TEXT_CLASS} data-testid="devs-report-context">
                {preview.context}
              </pre>
            </section>
            {attachments.length ? (
              <section className="space-y-1" data-testid="devs-report-attachments">
                <div className="text-ui-sm font-medium">
                  {format("devs.confirm.attachments", { count: attachments.length })}
                </div>
                {local?.imagePreviews.length ? (
                  <div className="flex flex-wrap gap-2">
                    {local.imagePreviews.map((url, index) => (
                      <img
                        // oxlint-disable-next-line react/no-array-index-key -- previews never reorder
                        key={index}
                        src={url}
                        alt=""
                        className="size-16 rounded-lg border border-border object-cover"
                      />
                    ))}
                  </div>
                ) : null}
                {texts.map((attachment) => (
                  <div key={attachment.name} className="space-y-1">
                    <div className="text-ui-sm text-muted-foreground">{attachment.name}</div>
                    <pre className={SENT_TEXT_CLASS}>{attachment.text}</pre>
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
            <p className="m-0 text-ui-sm text-muted-foreground">{t("devs.confirm.alsoSent")}</p>
            {preview.processedOutsideMainlandChina ? (
              <p className="m-0 text-ui-sm font-medium" data-testid="devs-report-outside-china">
                {t("devs.confirm.outsideMainlandChina")}
              </p>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => settleDevsReportConfirmation(false)}>
            {t("devs.confirm.cancel")}
          </Button>
          <Button onClick={() => settleDevsReportConfirmation(true)}>
            {t("devs.confirm.send")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
