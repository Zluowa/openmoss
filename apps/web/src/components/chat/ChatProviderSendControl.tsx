// FILE: ChatProviderSendControl.tsx
// Purpose: Owns the chat composer's provider-aware send affordance and bounded preflight seam.
// Layer: Chat composer presentation + admission orchestration
// Exports: ChatComposerSendButton, isChatComposerSubmitReady, runChatProviderSendPreflight

import type { ProviderInstanceId, ProviderKind, ServerProviderStatus } from "@synara/contracts";

import { ComposerSendArrowIcon, PlayIcon } from "~/lib/icons";
import { translateMoss, useTranslation } from "~/localization";
import type { MossLocaleCode } from "~/uiLocale";
import { localizeProviderSendBlockedReason } from "~/lib/providerUnavailablePresentation";
import {
  findProviderStatus,
  resolveProviderSendAdmission,
  resolveProviderSendAvailability,
  resolveProviderSendAvailabilityWithRefresh,
  type ProviderSendAdmission,
  type ProviderSendAvailability,
  type ProviderStatusRefresh,
} from "~/lib/providerAvailability";
import { Button } from "../ui/button";

export interface ChatComposerSendButtonProps {
  readonly locale?: MossLocaleCode;
  readonly provider: ProviderKind;
  readonly status: ServerProviderStatus | null;
  readonly admission: ProviderSendAdmission;
  readonly visibleSendState: string;
  readonly hasSendableContent: boolean;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly isSendPreflightInFlight: boolean;
  readonly isProjectPending: boolean;
  readonly isVoiceTranscribing: boolean;
  readonly isModelLoading: boolean;
  readonly isPreparingImages: boolean;
  readonly isPreparingWorktree: boolean;
  /** Resume replaces Send only for an eligible terminal Codex turn. */
  readonly showResume?: boolean;
  /** Keep the Resume slot mounted until a projected turn/session revision arrives. */
  readonly isResumePending?: boolean;
  /** Pending approvals/inputs still own the composer interaction surface. */
  readonly isInteractionUnavailable?: boolean;
  readonly onResume?: () => void | Promise<unknown>;
}

export function ChatComposerSendButton(props: ChatComposerSendButtonProps) {
  const { locale: contextLocale } = useTranslation();
  const locale = props.locale ?? contextLocale;
  const isResumePending = props.isResumePending === true;
  const showResume = props.showResume === true || isResumePending;
  if (showResume) {
    const ariaLabel = translateMoss(locale, "chat.composer.send.resume");
    const resumeUnavailable =
      props.admission.state !== "ready" ||
      props.isConnecting ||
      props.isSendPreflightInFlight ||
      props.isProjectPending ||
      props.isVoiceTranscribing ||
      props.isModelLoading ||
      props.isPreparingImages ||
      props.isPreparingWorktree ||
      props.isSendBusy ||
      props.isInteractionUnavailable === true;
    return (
      <Button
        type="button"
        variant="prominent"
        size="icon-xs"
        className="size-7 rounded-full sm:size-7"
        disabled={isResumePending || resumeUnavailable}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => {
          if (!isResumePending) {
            try {
              const result = props.onResume?.();
              void Promise.resolve(result).catch(() => undefined);
            } catch {
              // The owning composer reports synchronous failures through its existing error path.
            }
          }
        }}
        data-moss-visible-resume-control="true"
        data-moss-visible-resume-state={isResumePending ? "pending" : "ready"}
      >
        {isResumePending ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            fill="none"
            className="animate-spin"
            aria-hidden="true"
          >
            <circle
              cx="7"
              cy="7"
              r="5.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray="20 12"
            />
          </svg>
        ) : (
          <PlayIcon aria-hidden="true" className="size-5 shrink-0" />
        )}
      </Button>
    );
  }
  const providerBlocked = props.admission.state === "blocked";
  const providerBlockedReason = localizeProviderSendBlockedReason(locale, {
    provider: props.provider,
    status: props.status,
    unavailableReason: props.admission.unavailableReason ?? "",
  });
  const showSpinner =
    !providerBlocked &&
    (props.isConnecting ||
      props.isSendPreflightInFlight ||
      props.isProjectPending ||
      props.isSendBusy ||
      props.isModelLoading ||
      props.isPreparingImages ||
      props.isPreparingWorktree);
  const disabled =
    showSpinner || providerBlocked || props.isVoiceTranscribing || !props.hasSendableContent;
  const ariaLabel = providerBlocked
    ? providerBlockedReason
    : props.isConnecting || props.isSendPreflightInFlight || props.isProjectPending
      ? translateMoss(locale, "chat.composer.send.connecting")
      : props.isVoiceTranscribing
        ? translateMoss(locale, "chat.composer.send.transcribingVoice")
        : props.isModelLoading
          ? translateMoss(locale, "chat.composer.send.loadingModels")
          : props.isPreparingImages
            ? translateMoss(locale, "chat.composer.send.optimizingImage")
            : props.isPreparingWorktree
              ? translateMoss(locale, "chat.composer.send.preparingWorktree")
              : props.isSendBusy
                ? translateMoss(locale, "chat.composer.send.sending")
                : translateMoss(locale, "chat.composer.send.message");

  return (
    <Button
      type="submit"
      variant="prominent"
      size="icon-xs"
      className="size-7 rounded-full sm:size-7"
      disabled={disabled}
      aria-label={ariaLabel}
      data-moss-visible-send-control="true"
      data-moss-visible-send-state={props.visibleSendState}
      title={providerBlocked || props.isPreparingWorktree ? ariaLabel : undefined}
    >
      {showSpinner ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 14 14"
          fill="none"
          className="animate-spin"
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="20 12"
          />
        </svg>
      ) : (
        <ComposerSendArrowIcon aria-hidden="true" className="size-5 shrink-0 translate-y-px" />
      )}
    </Button>
  );
}

/**
 * Owns the final form-submit admission decision. ChatView calls this immediately
 * after preventing the native submit, before provider refresh, draft promotion,
 * worktree creation, or turn dispatch.
 */
export function isChatComposerSubmitReady(input: {
  readonly isPreparingWorktree: boolean;
}): boolean {
  return !input.isPreparingWorktree;
}

export async function runChatProviderSendPreflight(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | null | undefined;
  readonly statuses: readonly ServerProviderStatus[];
  readonly managedInstanceConfigured?: boolean | undefined;
  readonly refreshStatuses: ProviderStatusRefresh;
  readonly refreshTimeoutMs?: number;
  readonly onPreflightStart: () => void;
  readonly onPreflightEnd: () => void;
  readonly onBlocked: (availability: ProviderSendAvailability) => void;
}): Promise<ProviderSendAvailability> {
  const status = findProviderStatus(input.statuses, input.provider, input.instanceId);
  const admission = resolveProviderSendAdmission(
    status,
    input.instanceId,
    input.managedInstanceConfigured,
  );
  if (admission.state !== "preflight") {
    const availability = resolveProviderSendAvailability({
      provider: input.provider,
      instanceId: input.instanceId,
      statuses: input.statuses,
      managedInstanceConfigured: input.managedInstanceConfigured,
    });
    if (!availability.usable) {
      input.onBlocked(availability);
    }
    return availability;
  }

  input.onPreflightStart();
  let availability: ProviderSendAvailability;
  try {
    availability = await resolveProviderSendAvailabilityWithRefresh({
      provider: input.provider,
      instanceId: input.instanceId,
      statuses: input.statuses,
      managedInstanceConfigured: input.managedInstanceConfigured,
      refreshStatuses: input.refreshStatuses,
      ...(input.refreshTimeoutMs === undefined ? {} : { refreshTimeoutMs: input.refreshTimeoutMs }),
    });
  } finally {
    input.onPreflightEnd();
  }
  if (!availability.usable) {
    input.onBlocked(availability);
  }
  return availability;
}
