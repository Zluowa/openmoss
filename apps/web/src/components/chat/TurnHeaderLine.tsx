// Compact work labels share localized clocks and the existing disclosure motion.
import type { CSSProperties, ReactNode } from "react";

import type { TimestampFormat } from "../../appSettings";
import { useTranslation } from "../../localization";
import { localizeCodexDurationUnits } from "../../session-logic";
import { formatProviderModelOptionName } from "../../providerModelOptions";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { ProviderIcon } from "../ProviderIcon";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import {
  formatTurnHeaderLabel,
  formatTurnResumedBy,
  type TurnHeader,
  type TurnModel,
  type TurnResumedBy,
} from "./MessagesTimeline.logic";
import { LiveElapsedTimer } from "./LiveElapsedTimer";

export function TurnModelChip({ model }: { model: TurnModel }) {
  const label = formatProviderModelOptionName({ provider: model.provider, slug: model.model });
  return (
    <span
      className="inline-flex max-w-[14rem] items-center gap-1 rounded-md bg-[var(--app-user-message-background)] px-1.5 py-px"
      data-turn-model-chip="true"
    >
      <ProviderIcon provider={model.provider} className="size-3 shrink-0" />
      <span className="truncate">{label || model.model}</span>
    </span>
  );
}

function splitAroundTime(template: string, time: ReactNode) {
  const [before, after] = template.split("\u0000");
  return (
    <>
      {before}
      <span className="tabular-nums">{time}</span>
      {after}
    </>
  );
}

export function TurnHeaderLine(
  props: {
    fontSize: CSSProperties["fontSize"];
    timestampFormat?: TimestampFormat;
    labelOverride?: string | null | undefined;
  } & (
    | {
        kind: "settled";
        header: TurnHeader;
        // Present when the turn has folded work: the header toggles it.
        disclosure?: {
          open: boolean;
          renderTrigger: (content: ReactNode) => ReactNode;
        };
      }
    | {
        kind: "live";
        startedAt: string;
        // Server-rendered/static surfaces pass a fixed clock.
        nowLabel?: string | null;
        modelChange?: TurnModel | null;
        resumedBy?: ReadonlyArray<TurnResumedBy> | null;
      }
  ),
) {
  const { format, locale } = useTranslation();
  if (props.kind === "live") {
    const resumedBy = props.resumedBy && props.resumedBy.length > 0 ? props.resumedBy : null;
    const elapsed = props.nowLabel ?? <LiveElapsedTimer startedAt={props.startedAt} />;
    return (
      <div data-turn-header="live">
        <div
          className={cn(
            // Codex sites-end `_activeCommentary` on `.loading-shimmer`: the live
            // "Working for" line, not the faint generic description shimmer.
            "codex-loading-shimmer codex-loading-shimmer-working -ml-0.5 pb-1 text-size-chat leading-5",
          )}
          style={{ fontSize: props.fontSize }}
        >
          {resumedBy ? (
            <>
              {`Resumed: ${formatTurnResumedBy(resumedBy)} · `}
              <span className="tabular-nums">{elapsed}</span>
            </>
          ) : (
            splitAroundTime(format("localConversation.workingFor", { time: "\u0000" }), elapsed)
          )}
          {props.modelChange ? <TurnModelChip model={props.modelChange} /> : null}
        </div>
        <div aria-hidden className="h-px w-full bg-border" />
      </div>
    );
  }

  const { header, disclosure } = props;
  const elapsedText = header.elapsed
    ? localizeCodexDurationUnits(header.elapsed, locale)
    : header.elapsed;
  const settledLabel =
    props.labelOverride ??
    (header.outcome === "completed" && elapsedText && (header.resumedBy?.length ?? 0) === 0
      ? format("localConversation.workedFor", { time: elapsedText })
      : formatTurnHeaderLabel({ ...header, elapsed: elapsedText }));
  const content = (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span>{settledLabel}</span>
      {header.modelChange ? <TurnModelChip model={header.modelChange} /> : null}
      {disclosure ? (
        <DisclosureChevron open={disclosure.open} className="text-muted-foreground/70" />
      ) : null}
    </span>
  );
  return (
    <div
      className={cn("-ml-0.5 pb-1 text-size-chat leading-5", MUTED_LABEL_TEXT_CLASS_NAME)}
      style={{ fontSize: props.fontSize }}
      data-turn-header={header.outcome}
    >
      {disclosure ? disclosure.renderTrigger(content) : content}
    </div>
  );
}
