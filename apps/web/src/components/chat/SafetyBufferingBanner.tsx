import { useRef, useState } from "react";
import { Schema } from "effect";
import type { TurnId } from "@synara/contracts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { ChevronDownIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { TranscriptNotice } from "./TranscriptNotice";
import type { SafetyBufferingState } from "./safetyBuffering";

export const SAFETY_BUFFERING_DISMISSED_KEY = "moss:safety-buffering-banner-dismissed-v1";

// THREAD ny -> app-initial qrr (skt): the reference information icon.
function SafetyBufferingIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-5 shrink-0"
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
    >
      <path
        d="M10.6 9.70459C11.0142 9.70461 11.35 10.0404 11.35 10.4546V13.7876C11.35 14.2018 11.0142 14.5376 10.6 14.5376C10.1858 14.5376 9.84998 14.2018 9.84998 13.7876V10.4546C9.84998 10.0404 10.1858 9.70459 10.6 9.70459Z"
        fill="currentColor"
      />
      <path
        d="M10.6 6.2876C11.1292 6.28762 11.558 6.71732 11.558 7.24658C11.5578 7.77569 11.1291 8.20457 10.6 8.20459C10.0708 8.20459 9.64215 7.7757 9.64197 7.24658C9.64197 6.71731 10.0707 6.2876 10.6 6.2876Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.6 2.53955C14.9713 2.53955 18.515 6.08326 18.515 10.4546C18.515 14.8259 14.9713 18.3696 10.6 18.3696C6.22864 18.3696 2.68494 14.8259 2.68494 10.4546C2.68494 6.08326 6.22864 2.53955 10.6 2.53955ZM10.6 3.86963C6.96318 3.86963 4.01501 6.81779 4.01501 10.4546C4.01501 14.0914 6.96318 17.0396 10.6 17.0396C14.2368 17.0396 17.1849 14.0914 17.1849 10.4546C17.1849 6.81779 14.2368 3.86963 10.6 3.86963Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SafetyBufferingBanner({
  threadId,
  state,
  canRetry,
  onRetry,
  fasterModelName,
}: {
  threadId: string;
  state: SafetyBufferingState | null;
  canRetry: boolean;
  onRetry: (turnId: TurnId) => Promise<void>;
  fasterModelName?: string | undefined;
}) {
  const { t, format } = useTranslation();
  const [permanentlyDismissed, setPermanentlyDismissed] = useLocalStorage(
    SAFETY_BUFFERING_DISMISSED_KEY,
    false,
    Schema.Boolean,
  );
  const [dismissedTurn, setDismissedTurn] = useState<string | null>(null);
  const [dialogTurnKey, setDialogTurnKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const retryInFlight = useRef(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  const turnKey = state === null ? null : `${threadId}:${state.turnId}`;
  const visible = state !== null && !permanentlyDismissed && dismissedTurn !== turnKey;
  const retryAvailable = canRetry && state?.fasterModel != null;
  const confirmRetry = async () => {
    if (!visible || !retryAvailable || state === null || retryInFlight.current) return;
    retryInFlight.current = true;
    setDialogTurnKey(null);
    setPending(true);
    try {
      await onRetry(state.turnId);
    } catch {
      toastManager.add({ type: "error", title: t("safetyBuffering.retryFailed") });
    } finally {
      retryInFlight.current = false;
      setPending(false);
    }
  };
  if (state === null) return null;

  return (
    <>
      <DisclosureRegion open={visible}>
        <div
          className="pb-2"
          data-testid="safety-buffering-banner"
          data-safety-buffering-turn-id={state.turnId}
        >
          <div aria-live="polite" role="status">
            <TranscriptNotice
              as="aside"
              density="default"
              tone="normal"
              className="@container items-start gap-4"
            >
              <div className="flex min-w-0 grow flex-col @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:justify-between @min-[560px]:gap-8">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex size-12 shrink-0 items-center justify-center self-center text-[var(--color-text-foreground-secondary)]">
                    <SafetyBufferingIcon />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-medium">{t("safetyBuffering.codexTitle")}</div>
                    {retryAvailable ? (
                      <div className="text-ui-lg text-pretty leading-tight text-[var(--color-text-foreground-secondary)]">
                        {t("safetyBuffering.codexDescription")}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 flex shrink-0 items-center justify-center gap-2 @min-[560px]:mt-0">
                  {retryAvailable ? (
                    <Button
                      ref={retryButton}
                      type="button"
                      size="sm"
                      className="rounded-full px-3"
                      disabled={pending}
                      onClick={() => setDialogTurnKey(turnKey)}
                    >
                      {t("safetyBuffering.retry")}
                    </Button>
                  ) : null}
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="rounded-full"
                        />
                      }
                    >
                      {t("safetyBuffering.dismiss")}
                      <ChevronDownIcon className="size-3" aria-hidden="true" />
                    </MenuTrigger>
                    <ComposerPickerMenuPopup
                      align="end"
                      side="top"
                      aria-label={t("safetyBuffering.dismiss")}
                    >
                      <MenuItem onClick={() => setDismissedTurn(turnKey)}>
                        {t("safetyBuffering.dismissThisTime")}
                      </MenuItem>
                      <MenuItem onClick={() => setPermanentlyDismissed(true)}>
                        {t("safetyBuffering.dismissPermanently")}
                      </MenuItem>
                    </ComposerPickerMenuPopup>
                  </Menu>
                </div>
              </div>
            </TranscriptNotice>
          </div>
        </div>
      </DisclosureRegion>
      <Dialog
        open={dialogTurnKey === turnKey && retryAvailable && visible}
        onOpenChange={(open) => setDialogTurnKey(open ? turnKey : null)}
      >
        <DialogPopup className="max-w-md" finalFocus={retryButton}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirmRetry();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("safetyBuffering.retryDialogTitle")}</DialogTitle>
              <DialogDescription render={<div className="flex flex-col gap-4" />}>
                <p>{t("safetyBuffering.retryDialogHistoryDescription")}</p>
                <p>
                  {fasterModelName
                    ? format("safetyBuffering.retryDialogNamedModelDescription", {
                        modelName: fasterModelName,
                      })
                    : t("safetyBuffering.retryDialogModelDescription")}
                </p>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogTurnKey(null)}>
                {t("safetyBuffering.retryDialogKeepWaiting")}
              </Button>
              <Button type="submit" disabled={pending}>
                {t("safetyBuffering.retryDialogConfirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
