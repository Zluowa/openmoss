// FILE: WrapUpBox.tsx
// Purpose: The desktop chat's turn-end box from `moss_wrap_up`. Live, it holds the
//          recap, the agent's question and its 1-2 answer buttons (the recommended one
//          first, drawn secondary); a click sends that answer as a message. Settled, the
//          same card stays in the transcript above the answer: recap, question, and
//          the button picked, or the choices when the person wrote something else.
// Layer: Chat transcript card
// Exports: WrapUpLiveBox, WrapUpSettledCard

import type { WrapUp } from "@moss/shared/wrapUp";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { Button } from "../../ui/button";

const CARD_CLASS_NAME =
  "flex w-full max-w-[min(100%,46rem)] flex-col gap-2 rounded-card border border-[color:var(--color-border-light)] px-4 py-3 text-size-chat";

function searchTextOf(box: WrapUp, answer: string | null): string {
  return [box.recap, box.ask ?? "", answer ?? "", ...box.actions].filter(Boolean).join("\n");
}

export function WrapUpLiveBox(props: {
  box: WrapUp;
  onAnswer?: ((label: string) => Promise<boolean>) | undefined;
}) {
  const { box, onAnswer } = props;
  const { t } = useTranslation();
  const [sending, setSending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <section
      data-wrap-up-box="live"
      data-find-text={searchTextOf(box, null)}
      aria-label={box.ask ?? box.recap}
      className={cn(CARD_CLASS_NAME, "bg-[var(--color-background-elevated-primary)]")}
    >
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{box.recap}</p>
      {box.ask ? <p className="break-words text-foreground">{box.ask}</p> : null}
      {box.actions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {box.actions.map((label, index) => (
            <Button
              key={label}
              size="xs"
              variant={index === 0 ? "secondary" : "ghost"}
              disabled={!onAnswer || sending !== null}
              data-wrap-up-action={index === 0 ? "primary" : "secondary"}
              onClick={() => {
                if (!onAnswer) return;
                setSending(label);
                setFailed(false);
                void onAnswer(label)
                  .then((sent) => setFailed(!sent))
                  .catch(() => setFailed(true))
                  .finally(() => setSending(null));
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}
      {failed ? <p role="alert">{t("transcript.reply.sendFailed")}</p> : null}
    </section>
  );
}

export function WrapUpSettledCard(props: { box: WrapUp; answer: string | null }) {
  const { t } = useTranslation();
  const { box, answer } = props;
  return (
    <section
      data-wrap-up-box="settled"
      data-find-text={searchTextOf(box, answer)}
      className={cn(CARD_CLASS_NAME, "max-w-[min(100%,30rem)]")}
    >
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{box.recap}</p>
      {box.ask ? (
        <div className="flex flex-col gap-0.5">
          <p className="break-words text-foreground">{box.ask}</p>
          {answer !== null ? (
            <p data-wrap-up-answer="" className="break-words text-muted-foreground">
              {answer}
            </p>
          ) : box.actions.length > 0 ? (
            // Unanswered, the desktop chat lists the answers it offered as muted bullets.
            <ul
              data-wrap-up-choices=""
              aria-label={t("transcript.wrapUp.choices")}
              className="list-disc ps-6 text-muted-foreground marker:text-muted-foreground"
            >
              {box.actions.map((label) => (
                <li key={label} className="break-words">
                  {label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
