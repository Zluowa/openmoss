// FILE: SecretRequestCard.tsx
// Purpose: The private card an agent opens with moss_request_secret. The typed value goes
//          straight to the server's owner-only file over secretRequest.answer; the transcript
//          only ever learns the outcome.
// Layer: Chat transcript UI

import type {
  SecretRequestActivityPayload,
  SecretRequestOutcome,
  ThreadId,
} from "@synara/contracts";
import { useId, useRef, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { CheckIcon, LockIcon, MinusIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { readNativeApi } from "~/nativeApi";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestServerMessage,
} from "./SecretRequestCard.logic";

// A password field makes browsers and password managers offer to save a login,
// which this is not; mask a text field instead wherever the engine can.
const CAN_MASK_TEXT =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("-webkit-text-security", "disc");

type SecretAnswer =
  | { readonly type: "save"; readonly secret: string }
  | { readonly type: "decline" };

export function SecretRequestCard(props: {
  readonly request: SecretRequestActivityPayload;
  /** Absent where the transcript cannot answer (no thread context): the card stays read-only. */
  readonly threadId: ThreadId | undefined;
  readonly textFontSizePx?: number | undefined;
  readonly metaFontSizePx?: number | undefined;
}) {
  const { t } = useTranslation();
  const [answered, setAnswered] = useState<SecretRequestOutcome | undefined>(undefined);
  const display = secretRequestDisplay(props.request, answered);
  const metaStyle = props.metaFontSizePx ? { fontSize: `${props.metaFontSizePx}px` } : undefined;
  if (display.kind === "settled" || props.threadId === undefined) {
    const Icon =
      display.kind === "pending" ? LockIcon : display.outcome === "saved" ? CheckIcon : MinusIcon;
    return (
      <div
        className="flex min-w-0 items-center gap-2 text-[var(--color-text-foreground-secondary)]"
        style={metaStyle}
        data-secret-request-state={display.kind === "pending" ? "pending" : display.outcome}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {props.request.label} ·{" "}
          {t(display.kind === "pending" ? "chat.secretRequest.waiting" : display.labelKey)}
        </span>
      </div>
    );
  }
  return (
    <PendingSecretRequestForm
      request={props.request}
      threadId={props.threadId}
      textFontSizePx={props.textFontSizePx}
      metaStyle={metaStyle}
      onAnswered={setAnswered}
    />
  );
}

function PendingSecretRequestForm(props: {
  readonly request: SecretRequestActivityPayload;
  readonly threadId: ThreadId;
  readonly textFontSizePx: number | undefined;
  readonly metaStyle: { readonly fontSize: string } | undefined;
  readonly onAnswered: (outcome: SecretRequestOutcome) => void;
}) {
  const { request } = props;
  const { t } = useTranslation();
  const inputId = useId();
  const reasonId = useId();
  const privacyId = useId();
  const errorId = useId();
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and a click can both submit before React re-renders.
  const inFlight = useRef(false);

  const send = async (answer: SecretAnswer) => {
    const input = secretRequestAnswerInput(props.threadId, request, answer);
    const api = readNativeApi();
    if (input === null || api === undefined || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await api.secretRequests.answer(input);
      setSecret("");
      props.onAnswered(answer.type === "save" ? "saved" : "declined");
    } catch (cause) {
      // Never logged: a failed request can carry the typed value.
      setError(secretRequestServerMessage(cause) ?? t("chat.secretRequest.failed"));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send({ type: "save", secret });
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-2.5 rounded-card border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] p-3"
      autoComplete="off"
      data-secret-request-state="pending"
      onSubmit={onSubmit}
    >
      <div className="min-w-0 space-y-0.5">
        <label
          htmlFor={inputId}
          className="block text-chat font-medium text-[var(--color-text-foreground)]"
          style={props.textFontSizePx ? { fontSize: `${props.textFontSizePx}px` } : undefined}
        >
          {request.label}
        </label>
        {/* Where to get the secret is the part the user acts on, so it reads at body size. */}
        <p
          id={reasonId}
          className="whitespace-pre-wrap text-chat text-[var(--color-text-foreground-secondary)]"
          style={props.textFontSizePx ? { fontSize: `${props.textFontSizePx}px` } : undefined}
        >
          {request.reason}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={inputId}
          type={CAN_MASK_TEXT ? "text" : "password"}
          className="min-w-0 flex-1 [-webkit-text-security:disc]"
          autoComplete={CAN_MASK_TEXT ? "off" : "new-password"}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          placeholder={request.placeholder ?? t("chat.secretRequest.placeholder")}
          value={secret}
          disabled={submitting}
          aria-invalid={error !== null || undefined}
          aria-describedby={[reasonId, privacyId, ...(error !== null ? [errorId] : [])].join(" ")}
          onChange={(event) => setSecret(event.currentTarget.value)}
        />
        <Button
          type="submit"
          size="sm"
          className="shrink-0"
          disabled={submitting || secret.trim().length === 0}
        >
          {t(submitting ? "chat.secretRequest.saving" : "chat.secretRequest.save")}
        </Button>
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="text-destructive" style={props.metaStyle}>
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-[var(--color-text-foreground-secondary)]"
          style={props.metaStyle}
        >
          <LockIcon className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0">{t("chat.secretRequest.privacyNote")}</span>
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="shrink-0"
          disabled={submitting}
          onClick={() => void send({ type: "decline" })}
        >
          {t("chat.secretRequest.decline")}
        </Button>
      </div>
    </form>
  );
}
