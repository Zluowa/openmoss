// FILE: ProviderUpdateDialog.tsx
// Purpose: Confirms a rail-started agent update, adapted from T3 Code's UpdateEverythingDialog
//          (MIT): what changes, where it downloads from, then each agent's progress and result
//          in place, the way the update runs (agents keep working while they update).
// Layer: Web shell navigation.

import { useRef } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, CircleCheckIcon, CopyIcon } from "~/lib/icons";
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
import { Spinner } from "../ui/spinner";
import type { ProviderUpdateTarget } from "./providerUpdateRail.logic";
import { useProviderUpdateRunStore, type ProviderUpdateRowOutcome } from "./providerUpdateRunStore";

/** Agents whose running conversations move to the new version after their turn. */
const LIVE_SWITCH_DRIVERS = new Set(["codex", "claudeAgent"]);

type RowState =
  | { readonly kind: "idle"; readonly failureMessage: string | null }
  | { readonly kind: "waiting" }
  | { readonly kind: "updating" }
  | { readonly kind: "updated" }
  | { readonly kind: "failed"; readonly failureMessage: string | null };

function rowState(
  target: ProviderUpdateTarget,
  currentKey: string | null | undefined,
  running: boolean,
  outcome: ProviderUpdateRowOutcome | undefined,
): RowState {
  if (running && currentKey === target.key) return { kind: "updating" };
  if (outcome?.status === "succeeded") return { kind: "updated" };
  if (outcome?.status === "failed") {
    return { kind: "failed", failureMessage: outcome.message ?? target.failureMessage };
  }
  if (running) return { kind: "waiting" };
  return { kind: "idle", failureMessage: target.failureMessage };
}

export function ProviderUpdateDialog({
  open,
  onOpenChange,
  targets,
  appUpdateVersion,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The agents shown when the dialog opened; they stay listed while and after they update. */
  readonly targets: ReadonlyArray<ProviderUpdateTarget>;
  /** A downloaded Moss version waiting for its restart. */
  readonly appUpdateVersion: string | null;
  /** Runs the given agents' updates; the dialog stays open and follows them. */
  readonly onConfirm: (targets: ReadonlyArray<ProviderUpdateTarget>) => void;
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
  readonly onConfirm: (targets: ReadonlyArray<ProviderUpdateTarget>) => void;
  readonly cancelRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t, format } = useTranslation();
  const run = useProviderUpdateRunStore((state) => state.run);
  const outcomes = useProviderUpdateRunStore((state) => state.outcomes);
  const runningThreads = useStore(
    (state) =>
      Object.values(state.sidebarThreadSummaryById).filter(
        (thread) =>
          isThreadRunningForActivity(thread) &&
          LIVE_SWITCH_DRIVERS.has(thread.modelSelection.provider) &&
          targets.some((target) => target.driver === thread.modelSelection.provider),
      ).length,
  );
  const usesCnMirror = targets.some((target) => target.usesCnMirror);
  const running = run !== null;
  const rows = targets.map((target) => ({
    target,
    state: rowState(target, run?.currentKey, running, outcomes[target.key]),
  }));
  const finished = !running && targets.length > 0 && targets.every((t) => outcomes[t.key]);
  const failedTargets = rows.filter((row) => row.state.kind === "failed").map((row) => row.target);
  const allUpdated = finished && failedTargets.length === 0;
  const liveSwitch = targets.some((target) => LIVE_SWITCH_DRIVERS.has(target.driver));

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {allUpdated
            ? t("providerUpdate.dialog.title.done")
            : targets.length === 1
              ? t("providerUpdate.dialog.title.one")
              : format("providerUpdate.dialog.title.many", { count: targets.length })}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {allUpdated && liveSwitch
            ? t("providerUpdate.dialog.updatedNote")
            : allUpdated
              ? t("providerUpdate.pill.updatedDescription")
              : liveSwitch
                ? t("providerUpdate.dialog.descriptionLive")
                : t("providerUpdate.dialog.description")}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="flex flex-col gap-3 px-4 pt-1 pb-2">
        <div className="grid grid-cols-[minmax(0,1fr)_max-content_max-content] gap-x-4 text-ui">
          <div className="col-span-full grid grid-cols-subgrid border-b border-border pb-1.5 text-ui-sm text-muted-foreground">
            <span>{t("providerUpdate.dialog.agent")}</span>
            <span>{t("providerUpdate.dialog.installed")}</span>
            <span>{t("providerUpdate.dialog.latest")}</span>
          </div>
          {rows.map(({ target, state }) => (
            <div
              key={target.key}
              data-provider-update-row={target.driver}
              data-provider-update-row-state={state.kind}
              className="col-span-full grid grid-cols-subgrid items-center border-b border-border/50 py-1.5 last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <ProviderIcon provider={target.driver} className="size-4 shrink-0" />
                <span className="truncate">{target.name}</span>
                <ProviderUpdateRowStatus state={state} />
              </span>
              <span className="font-mono text-ui-sm text-muted-foreground">
                {target.currentVersion ?? "-"}
              </span>
              <span className="font-mono text-ui-sm">{target.latestVersion ?? "-"}</span>
              {(state.kind === "idle" || state.kind === "failed") && state.failureMessage ? (
                <ProviderUpdateFailure target={target} message={state.failureMessage} />
              ) : null}
            </div>
          ))}
        </div>
        {usesCnMirror && !finished ? (
          <p className="text-ui-sm text-muted-foreground">{t("providerUpdate.dialog.cnMirror")}</p>
        ) : null}
        {appUpdateVersion ? (
          <p className="text-ui-sm text-muted-foreground">
            {format("providerUpdate.dialog.appWaiting", { version: appUpdateVersion })}
          </p>
        ) : null}
      </div>
      <AlertDialogFooter>
        {runningThreads > 0 && !finished ? (
          <p className="self-center text-ui-sm text-muted-foreground max-sm:order-1 max-sm:text-center sm:mr-auto">
            {runningThreads === 1
              ? t("providerUpdate.dialog.runningThreads.one")
              : format("providerUpdate.dialog.runningThreads.many", { count: runningThreads })}
          </p>
        ) : null}
        {allUpdated ? (
          <AlertDialogClose ref={cancelRef} render={<Button />}>
            {t("providerUpdate.dialog.done")}
          </AlertDialogClose>
        ) : (
          <>
            <AlertDialogClose ref={cancelRef} render={<Button variant="outline" />}>
              {running || finished
                ? t("providerUpdate.dialog.close")
                : t("providerUpdate.dialog.cancel")}
            </AlertDialogClose>
            {running ? (
              <Button disabled>
                <Spinner className="size-3.5" />
                {t("providerUpdate.dialog.updating")}
              </Button>
            ) : finished ? (
              <Button onClick={() => onConfirm(failedTargets)}>
                {t("providerUpdate.dialog.retry")}
              </Button>
            ) : (
              <Button onClick={() => onConfirm(targets)}>
                {t("providerUpdate.dialog.confirm")}
              </Button>
            )}
          </>
        )}
      </AlertDialogFooter>
    </>
  );
}

function ProviderUpdateRowStatus({ state }: { readonly state: RowState }) {
  const { t } = useTranslation();
  if (state.kind === "updating") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-ui-sm text-muted-foreground">
        <Spinner className="size-3" />
        {t("providerUpdate.dialog.updating")}
      </span>
    );
  }
  if (state.kind === "waiting") {
    return (
      <span className="shrink-0 text-ui-sm text-muted-foreground">
        {t("providerUpdate.dialog.waiting")}
      </span>
    );
  }
  if (state.kind === "updated") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-ui-sm text-muted-foreground">
        <CircleCheckIcon className="size-3" />
        {t("providerUpdate.dialog.updated")}
      </span>
    );
  }
  return null;
}

function ProviderUpdateFailure({
  target,
  message,
}: {
  readonly target: ProviderUpdateTarget;
  readonly message: string;
}) {
  const { t } = useTranslation();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const command = target.updateCommand;
  return (
    <div className="col-span-full flex items-start justify-between gap-2 pt-1 text-ui-sm">
      <span className="min-w-0 wrap-anywhere text-destructive">{message}</span>
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
