// FILE: GuestNameForm.tsx
// Purpose: The one-time join step: a name, then the invite is spent.
// Layer: Guest page UI

import { GUEST_NAME_MAX_LENGTH } from "@synara/contracts";
import { useState, type FormEvent } from "react";

import { MossLogoMark } from "~/components/MossLogoMark";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

import { describeGuestFailure } from "../guestCopy";
import type { GuestTransport } from "../transport";
import { WhatIsMossLink } from "./GuestNotice";

// Control characters and line or direction overrides would let a name pose as another line
// of the agent's attribution; the server rejects them, the field just does not keep them.
const NAME_BREAKING_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]/gu;

export const cleanGuestName = (value: string): string =>
  value.replace(NAME_BREAKING_CHARACTERS, "").slice(0, GUEST_NAME_MAX_LENGTH);

export function GuestNameForm({
  invite,
  transport,
  onJoined,
}: {
  readonly invite: string;
  readonly transport: GuestTransport;
  readonly onJoined: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    const failure = await transport.redeem(invite, trimmed);
    setSubmitting(false);
    if (failure === null) onJoined();
    else setError(describeGuestFailure(failure, t));
  };

  return (
    <div
      className={cn(
        "flex h-dvh flex-col overflow-y-auto text-foreground",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      <form
        className="m-auto flex w-full max-w-sm flex-col gap-6 px-6 py-10"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex items-center gap-2">
          <MossLogoMark className="size-5" />
          <span className="text-ui font-medium">Moss</span>
        </div>
        <div className="flex flex-col gap-2">
          <h1 className={PAGE_TITLE_CLASS_NAME}>{t("guest.join.title")}</h1>
          <p className="text-ui-sm text-muted-foreground">{t("guest.join.lede")}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="guest-name" className="text-ui-sm font-medium">
            {t("guest.join.nameLabel")}
          </label>
          <Input
            id="guest-name"
            name="name"
            type="text"
            size="lg"
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="go"
            autoFocus
            required
            maxLength={GUEST_NAME_MAX_LENGTH}
            placeholder={t("guest.join.namePlaceholder")}
            value={name}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? "guest-name-error" : "guest-name-note"}
            // Phones zoom into fields set below 16px; the lg field keeps the app's text size
            // elsewhere.
            className="max-sm:text-[16px] max-sm:[&_input]:text-[16px]"
            onChange={(event) => {
              setName(cleanGuestName(event.target.value));
              if (error !== null) setError(null);
            }}
          />
          {error !== null ? (
            <p id="guest-name-error" role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" disabled={submitting || trimmed === ""}>
          {submitting ? t("guest.join.submitting") : t("guest.join.submit")}
        </Button>
        <p id="guest-name-note" className="text-ui-xs text-muted-foreground">
          {t("guest.join.note")}
        </p>
        <WhatIsMossLink />
      </form>
    </div>
  );
}
