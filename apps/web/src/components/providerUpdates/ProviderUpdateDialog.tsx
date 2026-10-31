// FILE: ProviderUpdateDialog.tsx
// Purpose: Confirms a rail-started agent update, adapted from T3 Code's UpdateEverythingDialog
//          (MIT): what changes, where it downloads from, and why the last attempt failed.
// Layer: Web shell navigation.

import { useRef } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { useStore } from "~/store";

import { ProviderIcon } from "../ProviderIcon";
import { isThreadRunningForActivity } from "../SidebarActivityView.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import type { ProviderUpdateTarget } from "./providerUpdateRail.logic";

export function ProviderUpdateDialog({
  open,
  onOpenChange,
  targets,
  appUpdateVersion,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly targets: ReadonlyArray<ProviderUpdateTarget>;
  /** A downloaded Moss version waiting for its restart. */
  readonly appUpdateVersion: string | null;
  readonly onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* Refocusing the trigger after a pointer close shows its focus ring and opens its tooltip. */}
      <AlertDialogPopup
        className="sm:max-w-lg"
        initialFocus={cancelRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <ProviderUpdateDialogContent
          targets={targets}
          appUpdateVersion={appUpdateVersion}
          onConfirm={onConfirm}
          cancelRef={cancelRef}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function ProviderUpdateDialogContent({
  targets,
  appUpdateVersion,
  onConfirm,
  cancelRef,
}: {
  readonly targets: ReadonlyArray<ProviderUpdateTarget>;
  readonly appUpdateVersion: string | null;
  readonly onConfirm: () => void;
  readonly cancelRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t, format } = useTranslation();
  const runningThreads = useStore(
    (state) =>
      Object.values(state.sidebarThreadSummaryById).filter(
        (thread) =>
          isThreadRunningForActivity(thread) &&
          targets.some((target) => target.driver === thread.modelSelection.provider),
      ).length,
  );
  const usesCnMirror = targets.some((target) => target.usesCnMirror);

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {targets.length === 1
            ? t("providerUpdate.dialog.title.one")
            : format("providerUpdate.dialog.title.many", { count: targets.length })}
        </AlertDialogTitle>
        <AlertDialogDescription>{t("providerUpdate.dialog.description")}</AlertDialogDescription>
      </AlertDialogHeader>
      <div className="flex flex-col gap-3 px-4 pt-1 pb-2">
        <div className="grid grid-cols-[minmax(0,1fr)_max-content_max-content] gap-x-4 text-ui">
          <div className="col-span-full grid grid-cols-subgrid border-b border-border pb-1.5 text-ui-sm text-muted-foreground">
            <span>{t("providerUpdate.dialog.agent")}</span>
            <span>{t("providerUpdate.dialog.installed")}</span>
            <span>{t("providerUpdate.dialog.latest")}</span>
          </div>
          {targets.map((target) => (
            <div
              key={target.key}
              data-provider-update-row={target.driver}
              className="col-span-full grid grid-cols-subgrid items-center border-b border-border/50 py-1.5 last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <ProviderIcon provider={target.driver} className="size-4 shrink-0" />
                <span className="truncate">{target.name}</span>
              </span>
              <span className="font-mono text-ui-sm text-muted-foreground">
                {target.currentVersion ?? "-"}
              </span>
              <span className="font-mono text-ui-sm">{target.latestVersion ?? "-"}</span>
              {target.failureMessage ? <ProviderUpdateFailure target={target} /> : null}
            </div>
          ))}
        </div>
        {usesCnMirror ? (
          <p className="text-ui-sm text-muted-foreground">{t("providerUpdate.dialog.cnMirror")}</p>
        ) : null}
        {appUpdateVersion ? (
          <p className="text-ui-sm text-muted-foreground">
            {format("providerUpdate.dialog.appWaiting", { version: appUpdateVersion })}
          </p>
        ) : null}
      </div>
      <AlertDialogFooter>
        {runningThreads > 0 ? (
          <p className="self-center text-ui-sm text-muted-foreground max-sm:order-1 max-sm:text-center sm:mr-auto">
            {runningThreads === 1
              ? t("providerUpdate.dialog.runningThreads.one")
              : format("providerUpdate.dialog.runningThreads.many", { count: runningThreads })}
          </p>
        ) : null}
        <AlertDialogClose ref={cancelRef} render={<Button variant="outline" />}>
          {t("providerUpdate.dialog.cancel")}
        </AlertDialogClose>
        <Button onClick={onConfirm}>{t("providerUpdate.dialog.confirm")}</Button>
      </AlertDialogFooter>
    </>
  );
}

function ProviderUpdateFailure({ target }: { readonly target: ProviderUpdateTarget }) {
  const { t } = useTranslation();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const command = target.updateCommand;
  return (
    <div className="col-span-full flex items-start justify-between gap-2 pt-1 text-ui-sm">
      <span className="min-w-0 wrap-anywhere text-destructive">{target.failureMessage}</span>
      {command ? (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={() => copyToClipboard(command, undefined)}
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {t("providerUpdate.dialog.copyCommand")}
        </Button>
      ) : null}
    </div>
  );
}
