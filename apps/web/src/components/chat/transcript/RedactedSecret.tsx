// FILE: RedactedSecret.tsx
// Purpose: A credential found in a message, drawn as the desktop chat draws one: the
//          first eight characters stay readable and the rest become dots (all dots when
//          the value is twelve characters or shorter; a private key keeps its BEGIN
//          line), with a small eye button that shows or hides the full value. Screen
//          readers hear "Redacted <kind>" until the reader reveals it.
// Layer: Chat transcript primitive
// Exports: RedactedSecret, maskSecretValue, secretKindTranslationKey

import { useState } from "react";

import { EyeIcon, EyeSlashIcon } from "~/lib/icons";
import { type TranslationKey, useTranslation } from "~/localization";
import type { SecretKind } from "~/lib/transcriptSecrets";

const VISIBLE_PREFIX_CHARS = 8;
const FULLY_MASKED_MAX_CHARS = 12;
const MASK = "•";

/** The value as the desktop chat shows it before reveal. */
export function maskSecretValue(value: string): string {
  if (value.startsWith("-----BEGIN")) {
    const headerEnd = value.indexOf("-----", "-----BEGIN".length);
    const keep = headerEnd >= 0 ? headerEnd + 5 : value.length;
    const footer = value.lastIndexOf("-----END");
    const end = footer > keep ? footer : value.length;
    return value.slice(0, keep) + value.slice(keep, end).replace(/\S/gu, MASK) + value.slice(end);
  }
  const chars = Array.from(value);
  if (chars.length <= FULLY_MASKED_MAX_CHARS) return MASK.repeat(chars.length);
  return (
    chars.slice(0, VISIBLE_PREFIX_CHARS).join("") + MASK.repeat(chars.length - VISIBLE_PREFIX_CHARS)
  );
}

export function secretKindTranslationKey(kind: string): TranslationKey {
  switch (kind as SecretKind) {
    case "moss":
      return "transcript.secret.kind.moss";
    case "anthropic":
      return "transcript.secret.kind.anthropic";
    case "openai":
      return "transcript.secret.kind.openai";
    case "github":
      return "transcript.secret.kind.github";
    case "aws":
      return "transcript.secret.kind.aws";
    case "slack":
      return "transcript.secret.kind.slack";
    case "google":
      return "transcript.secret.kind.google";
    case "stripe":
      return "transcript.secret.kind.stripe";
    case "stripe-webhook":
      return "transcript.secret.kind.stripeWebhook";
    case "age":
      return "transcript.secret.kind.age";
    case "jwt":
      return "transcript.secret.kind.jwt";
    case "private-key":
      return "transcript.secret.kind.privateKey";
    default:
      return "transcript.secret.kind.secret";
  }
}

export function RedactedSecret(props: { kind: string; value: string }) {
  const { t, format } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const label = t(secretKindTranslationKey(props.kind));
  return (
    <span
      data-redacted-secret={revealed ? "revealed" : "hidden"}
      className="inline-flex max-w-full items-baseline gap-[2px] align-baseline"
    >
      <span className="break-all">
        {revealed ? (
          props.value
        ) : (
          <>
            <span data-find-omitted="" className="sr-only select-none">
              {format("transcript.secret.redacted", { label })}
            </span>
            <span aria-hidden>{maskSecretValue(props.value)}</span>
          </>
        )}
      </span>
      <button
        type="button"
        aria-pressed={revealed}
        aria-label={format(revealed ? "transcript.secret.hide" : "transcript.secret.reveal", {
          label,
        })}
        onClick={(event) => {
          event.stopPropagation();
          setRevealed((value) => !value);
        }}
        className="inline-flex shrink-0 translate-y-[1px] cursor-interaction items-center justify-center rounded-[3px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {revealed ? (
          <EyeSlashIcon aria-hidden className="size-3" />
        ) : (
          <EyeIcon aria-hidden className="size-3" />
        )}
      </button>
    </span>
  );
}
