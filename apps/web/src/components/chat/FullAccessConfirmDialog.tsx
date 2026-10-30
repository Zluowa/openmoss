// Codex permissions-mode-dropdown full-access confirmation surface.
import { RUNTIME_PERMISSIONS_LEARN_MORE_URL } from "~/lib/runtimeMode";
import { useTranslation } from "~/localization";
import { CentralIcon } from "~/lib/central-icons";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";

export function FullAccessConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Only set from an authoritative model capability; never guess from a model name. */
  isCyberModel?: boolean | undefined;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader className="gap-4">
          <AlertDialogTitle className="flex items-center gap-2">
            <CentralIcon name="shield-access" className="size-4 shrink-0" />
            {t(
              props.isCyberModel
                ? "chat.permissions.confirm.cyberTitle"
                : "chat.permissions.confirm.title",
            )}
          </AlertDialogTitle>
          {props.isCyberModel ? (
            <p className="text-ui-lg font-semibold text-destructive">
              {t("chat.permissions.confirm.cyberWarning")}
            </p>
          ) : null}
          <AlertDialogDescription>
            {t("chat.permissions.confirm.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4 px-4 py-2">
          <ul className="space-y-3 rounded-2xl bg-foreground/5 px-4 py-3">
            {(["files", "terminal", "internet"] as const).map((capability) => (
              <li key={capability}>
                <div className="text-ui-lg font-semibold">
                  {t(`chat.permissions.confirm.${capability}.title`)}
                </div>
                <div className="text-ui-sm text-muted-foreground">
                  {t(`chat.permissions.confirm.${capability}.description`)}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-ui-lg text-muted-foreground">
            {t("chat.permissions.confirm.risk")}{" "}
            {t(
              props.isCyberModel
                ? "chat.permissions.confirm.cyberRecommendation"
                : "chat.permissions.confirm.reversible",
            )}{" "}
            <a
              className="underline"
              href={
                props.isCyberModel
                  ? "https://learn.chatgpt.com/docs/sandboxing/auto-review#configuration"
                  : RUNTIME_PERMISSIONS_LEARN_MORE_URL
              }
              target="_blank"
              rel="noreferrer"
            >
              {t("chat.permissions.learnMore")}
            </a>
          </p>
        </div>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("chat.permissions.confirm.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              props.onOpenChange(false);
              props.onConfirm();
            }}
          >
            {t("chat.permissions.confirm.enable")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
