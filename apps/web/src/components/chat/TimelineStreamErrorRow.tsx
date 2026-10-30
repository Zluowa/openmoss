// FILE: TimelineStreamErrorRow.tsx
// Purpose: Renders the typed, transient Codex stream-reconnect transcript row.
// Layer: Web chat presentation component

import { useId, useState, type ReactNode } from "react";

import { motion } from "motion/react";
import { ChevronRightIcon, WifiIcon } from "~/lib/icons";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import type { WorkLogStreamRetry } from "../../workLog";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { useMeasuredElementHeight } from "./useMeasuredElementHeight";
import { disclosureChevronClassName, disclosureHeightTransition } from "~/lib/disclosureMotion";

const STREAM_ERROR_DIGIT_TRANSITION_MS = 300;

function isBusyStreamRetry(streamRetry: WorkLogStreamRetry): boolean {
  if (streamRetry.errorInfo === "serverOverloaded") {
    return true;
  }
  const errorInfo = streamRetry.errorInfo;
  if (!errorInfo || typeof errorInfo !== "object") {
    return false;
  }
  const disconnected =
    "responseStreamDisconnected" in errorInfo ? errorInfo.responseStreamDisconnected : undefined;
  return disconnected?.httpStatusCode === 429;
}

function streamRetryProgress(
  streamRetry: WorkLogStreamRetry,
): { readonly attempt: number; readonly maxAttempts: number } | undefined {
  const attempt = streamRetry.reconnectAttempt;
  const maxAttempts = streamRetry.reconnectMaxAttempts;
  if (
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    typeof maxAttempts !== "number" ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    attempt > maxAttempts
  ) {
    return undefined;
  }
  return { attempt, maxAttempts };
}

function RollingAttempt(props: { attempt: number; reducedMotion: boolean }) {
  const digits = String(props.attempt);
  return (
    <span
      aria-hidden="true"
      className="inline-flex align-baseline"
      data-stream-retry-attempt={String(props.attempt)}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {digits.split("").map((digit, index) => {
        const numericDigit = Number(digit);
        return (
          <span
            key={`digit-${digits.length - index}`}
            className="relative inline-block overflow-hidden align-baseline"
            data-stream-retry-digit-column="true"
            style={{
              width: "1ch",
              height: "1lh",
              lineHeight: "1lh",
            }}
          >
            <span
              className="absolute inset-x-0 top-0 flex flex-col"
              data-stream-retry-digit-stack="true"
              style={{
                transform: `translateY(-${numericDigit}lh)`,
                transitionProperty: props.reducedMotion ? "none" : "transform",
                transitionDuration: props.reducedMotion
                  ? "0s"
                  : `${STREAM_ERROR_DIGIT_TRANSITION_MS}ms`,
                transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
              }}
            >
              {Array.from({ length: 10 }, (_, value) => (
                <span
                  key={value}
                  aria-hidden="true"
                  className="block"
                  style={{
                    width: "1ch",
                    height: "1lh",
                    lineHeight: "1lh",
                    flex: "0 0 1lh",
                  }}
                >
                  {value}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function StreamErrorCopy(props: {
  copy: string;
  progress: { readonly attempt: number; readonly maxAttempts: number } | undefined;
  reducedMotion: boolean;
  ariaHidden?: boolean;
}) {
  return (
    <span
      aria-hidden={props.ariaHidden}
      className="min-w-0 whitespace-pre-wrap break-words leading-5"
      data-stream-error-copy="true"
    >
      {props.copy}
      {props.progress ? " " : null}
      {props.progress ? (
        <span data-stream-retry-progress="true">
          <RollingAttempt attempt={props.progress.attempt} reducedMotion={props.reducedMotion} />
          <span aria-hidden="true">/</span>
          <span data-stream-retry-denominator="true">{props.progress.maxAttempts}</span>
        </span>
      ) : null}
    </span>
  );
}

function StreamErrorDetails(props: {
  details: string;
  compact: boolean;
  textFontSizePx: number;
  reducedMotion: boolean;
  accessibleCopy: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const reducedMotion = props.reducedMotion;
  const bodyId = `stream-error-details-body-${useId().replace(/:/gu, "")}`;
  const [open, setOpen] = useState(false);
  const { measuredHeight, measuredElementRef: bodyContentRef } =
    useMeasuredElementHeight<HTMLDivElement>();
  const bodyStyle = { pointerEvents: open ? "auto" : "none" } as const;

  const toggleLabel = open
    ? t("localConversation.streamError.details.hide")
    : t("localConversation.streamError.details.show");

  return (
    <div className="group/stream-error-details min-w-0" data-stream-error-details="true">
      <div
        className={cn(
          "relative inline-flex min-w-0 max-w-full items-start",
          props.compact ? "gap-1.5" : "gap-2",
        )}
      >
        <div
          className={cn(
            "relative z-10 inline-flex min-w-0 max-w-full items-start",
            props.compact ? "gap-1.5" : "gap-2",
            "pointer-events-none",
          )}
          style={{ fontSize: `${props.textFontSizePx}px`, fontVariantNumeric: "tabular-nums" }}
        >
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground/60"
            data-stream-error-icon="wifi"
          >
            <WifiIcon className="size-4" />
          </span>
          <span className="min-w-0">{props.children}</span>
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              disclosureChevronClassName(
                open,
                "translate-y-1 opacity-0 transition-[opacity,transform]",
              ),
              "[@media(hover:hover)]:group-hover/stream-error-details:opacity-100",
              "group-focus-within/stream-error-details:opacity-100",
              open && "rotate-90 opacity-100",
              reducedMotion && "transition-none duration-0",
            )}
            data-stream-error-details-chevron="true"
          />
        </div>
        <button
          type="button"
          aria-controls={bodyId}
          aria-expanded={open}
          aria-label={`${toggleLabel}: ${props.accessibleCopy}`}
          className="absolute inset-0 z-0 cursor-pointer rounded-sm bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
          data-stream-error-details-button="true"
          onClick={() => setOpen((current) => !current)}
        />
      </div>
      <motion.div
        id={bodyId}
        initial={false}
        animate={{ height: open ? measuredHeight : 0, opacity: Number(open) }}
        transition={disclosureHeightTransition(reducedMotion)}
        aria-hidden={!open}
        data-thread-find-skip={!open ? "true" : undefined}
        data-stream-error-details-body="true"
        inert={!open}
        className={cn(
          "min-w-0 max-w-full",
          props.compact ? "ml-6" : "ml-7",
          open ? "overflow-visible" : "overflow-hidden",
        )}
        style={bodyStyle}
      >
        {open ? (
          <div
            ref={bodyContentRef}
            data-stream-error-details-content="true"
            className={cn(
              "mt-1 flex min-w-0 max-w-full flex-col gap-1 whitespace-pre-wrap break-words",
              MUTED_LABEL_TEXT_CLASS_NAME,
            )}
            style={{ fontSize: `${Math.max(11, props.textFontSizePx - 1)}px` }}
          >
            {props.details}
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}

export function TimelineStreamErrorRow(props: {
  streamRetry: WorkLogStreamRetry;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  density?: "default" | "compact";
}) {
  const { t } = useTranslation();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const compact = props.density === "compact";
  const textFontSizePx = props.textFontSizePx ?? props.chatMetaFontSizePx;
  const progress = streamRetryProgress(props.streamRetry);
  const busy = isBusyStreamRetry(props.streamRetry);
  const copy = busy
    ? t("localConversation.streamError.busy")
    : progress
      ? t("localConversation.streamError.reconnecting")
      : props.streamRetry.content;
  const accessibleCopy = progress ? `${copy} ${progress.attempt}/${progress.maxAttempts}` : copy;
  const copyElement = (
    <StreamErrorCopy copy={copy} progress={progress} reducedMotion={reducedMotion} ariaHidden />
  );

  if (props.streamRetry.additionalDetails) {
    return (
      <div
        className={cn("min-w-0 max-w-full", compact ? "py-0.5" : "py-1")}
        data-stream-error-row="true"
      >
        <StreamErrorDetails
          details={props.streamRetry.additionalDetails}
          compact={compact}
          textFontSizePx={textFontSizePx}
          reducedMotion={reducedMotion}
          accessibleCopy={accessibleCopy}
        >
          {copyElement}
        </StreamErrorDetails>
      </div>
    );
  }

  return (
    <div
      className={cn("min-w-0 max-w-full", compact ? "py-0.5" : "py-1")}
      data-stream-error-row="true"
    >
      <div
        className={cn(
          "relative inline-flex min-w-0 max-w-full items-start",
          compact ? "gap-1.5" : "gap-2",
        )}
        style={{ fontSize: `${textFontSizePx}px`, fontVariantNumeric: "tabular-nums" }}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground/60"
          data-stream-error-icon="wifi"
        >
          <WifiIcon className="size-4" />
        </span>
        <p
          className={cn(
            "pointer-events-none min-w-0 whitespace-pre-wrap break-words leading-5",
            MUTED_LABEL_TEXT_CLASS_NAME,
          )}
        >
          <span className="sr-only">{accessibleCopy}</span>
          {copyElement}
        </p>
      </div>
    </div>
  );
}
