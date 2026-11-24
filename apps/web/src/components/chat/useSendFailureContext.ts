// FILE: useSendFailureContext.ts
// Purpose: What the row of a message that did not start needs (the name and sign-in state of
//          the agent that failed, 登录 for it, and 重试 for the latest failed message), and
//          whether the latest row already says "signed out", so the provider status card does
//          not repeat it (WALK-4 N4-1).
// Layer: Chat view hook
// Exports: useSendFailureContext, SendFailureContext

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@moss/contracts";
import { useMemo } from "react";

import type { MossLocaleCode } from "~/appSettings";
import { findProviderStatus } from "~/lib/providerAvailability";
import { isProviderKind } from "~/providerOrdering";
import { openSettings as openSettingsDialog } from "~/settingsDialogStore";
import type { ChatMessage } from "~/types";
import type { WorkLogEntry } from "~/workLog";
import { resolveSendFailurePresentation } from "./threadErrorPresentation";

export interface SendFailureContext {
  /** The agent's name; a row without a recorded agent uses the thread's. */
  readonly labelFor: (provider: string | undefined) => string;
  readonly isSignedOut: (provider: string | undefined) => boolean;
  readonly onSignIn: (provider: string | undefined) => void;
  /** Sends the latest message again; offered only on the latest failed message's row. */
  readonly onRetry?: () => void;
}

export function useSendFailureContext(input: {
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId | null | undefined;
  readonly providerStatuses: readonly ServerProviderStatus[];
  readonly workLogEntries: ReadonlyArray<WorkLogEntry>;
  readonly messages: ReadonlyArray<ChatMessage> | undefined;
  readonly locale: MossLocaleCode;
  /** Sends the latest message again; absent when it cannot be sent again from here. */
  readonly onRetry: (() => void) | undefined;
}) {
  const { provider, providerInstanceId, providerStatuses, workLogEntries, messages, locale } =
    input;
  const onRetry = input.onRetry;
  const context = useMemo((): SendFailureContext => {
    const agentOf = (failed: string | undefined): ProviderKind =>
      failed !== undefined && isProviderKind(failed) ? failed : provider;
    return {
      labelFor: (failed) => PROVIDER_DISPLAY_NAMES[agentOf(failed)] ?? agentOf(failed),
      isSignedOut: (failed) => {
        const agent = agentOf(failed);
        return (
          findProviderStatus(
            providerStatuses,
            agent,
            agent === provider ? (providerInstanceId ?? agent) : agent,
          )?.authStatus === "unauthenticated"
        );
      },
      onSignIn: (failed) => openSettingsDialog({ section: "providers", provider: agentOf(failed) }),
      ...(onRetry ? { onRetry } : {}),
    };
  }, [onRetry, provider, providerInstanceId, providerStatuses]);
  // The status card (about this thread's agent) never repeats what the latest failed
  // message's row already says.
  const latestFailureSaysSignedOut = useMemo(() => {
    const latest = workLogEntries.findLast((entry) => entry.sendFailure !== undefined);
    if (!latest?.sendFailure) return false;
    const failedAgent = latest.sendFailure.provider;
    if (failedAgent !== undefined && failedAgent !== provider) return false;
    const answeredAfter = messages?.some(
      (message) => message.role === "assistant" && message.createdAt > latest.createdAt,
    );
    return (
      answeredAfter !== true &&
      resolveSendFailurePresentation({
        cause: latest.sendFailure.cause,
        detail: latest.sendFailure.detail,
        providerLabel: "",
        providerSignedOut: context.isSignedOut(failedAgent),
        locale,
      }).action === "sign-in"
    );
  }, [context, locale, messages, provider, workLogEntries]);
  return { context, latestFailureSaysSignedOut };
}
