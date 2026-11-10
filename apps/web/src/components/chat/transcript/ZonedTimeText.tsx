// FILE: ZonedTimeText.tsx
// Purpose: A time written with a zone that is not the reader's: dotted underline, and a
//          tooltip with the same moment in the reader's local time ("a day ahead of PST"
//          when it crosses midnight). A time already in the reader's zone stays plain.
// Layer: Chat transcript UI
// Exports: ZonedTimeText

import { useMemo, useState, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { describeZonedTime, isForeignZonedTime, parseZonedTime } from "~/lib/zonedTimes";
import { useTranslation } from "../../../localization";

export function ZonedTimeText(props: { original: string; children: ReactNode }) {
  const parsed = useMemo(() => parseZonedTime(props.original), [props.original]);
  const foreign = useMemo(() => (parsed ? isForeignZonedTime(parsed) : false), [parsed]);
  if (!parsed || !foreign) return <>{props.children}</>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-zoned-time=""
            className="underline decoration-muted-foreground/70 decoration-dotted decoration-1 underline-offset-[3px]"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80">
        <ZonedTimeTooltipBody original={props.original} />
      </TooltipPopup>
    </Tooltip>
  );
}

// Mounted only while the tooltip is open, so the conversion runs on hover.
function ZonedTimeTooltipBody(props: { original: string }) {
  const { t, format, locale } = useTranslation();
  const [now] = useState(() => new Date());
  const parsed = parseZonedTime(props.original);
  const description = parsed ? describeZonedTime(parsed, { now, locale }) : null;
  if (!parsed || !description) return <span>{props.original}</span>;
  const heading =
    description.dayDelta === 0
      ? t("transcript.time.local")
      : format(
          description.dayDelta > 0
            ? "transcript.time.localDayAhead"
            : "transcript.time.localDayBehind",
          { zone: parsed.zoneLabel },
        );
  return (
    <span className="flex flex-col gap-0.5 text-start" data-testid="time-tooltip-body">
      <span className="opacity-70">{heading}</span>
      <span>
        {description.zoneText
          ? `${description.timeText} ${description.zoneText}`
          : description.timeText}
      </span>
    </span>
  );
}
