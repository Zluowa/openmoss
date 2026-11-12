// FILE: transcriptCards.tsx
// Purpose: The card registry every transcript row renders through, after the desktop
//          chat's `code.*` cards: one entry per row kind with a stable card id, its
//          spacing and its body. Each card renders inside its own error boundary, so a
//          row that fails shows "Couldn't show this section." with Retry instead of
//          taking the whole chat down.
// Layer: Chat transcript UI
// Exports: TranscriptCardEnv, TRANSCRIPT_CARDS, renderTranscriptCard,
//          transcriptCardSpacingClassName, TranscriptCardBoundary

import { ThreadId } from "@moss/contracts";
import React, {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import { TriangleAlertIcon } from "~/lib/icons";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { cn } from "~/lib/utils";
import { syncAnimationsToTimelineOrigin } from "~/lib/animationTimelineSync";
import { useTranslation } from "../../../../localization";
import { formatClockElapsed } from "../../../../session-logic";
import { MossLogoMark } from "../../../MossLogoMark";
import { DisclosureRegion } from "../../../ui/DisclosureRegion";
import { Alert, AlertAction, AlertDescription } from "../../../ui/alert";
import { Button } from "../../../ui/button";
import { GeneratedImageGallery } from "../../GeneratedImageGallery";
import { InlineVisual } from "../../InlineVisual";
import { MESSAGE_ACTION_ICON_CLASS_NAME } from "../../MessageActionButton";
import type { MessagesTimelineRow } from "../../MessagesTimeline.logic";
import { ProposedPlanCard } from "../../ProposedPlanCard";
import { TimelineReasoningRow } from "../../TimelineReasoningRow";
import { TimelineSystemErrorRow } from "../../TimelineSystemErrorRow";
import { TimelineTodoPlanRow } from "../../TimelineTodoPlanRow";
import type { TimelineWorkEntryRow } from "../../TimelineWorkEntryRow";
import { TurnHeaderLine } from "../../TurnHeaderLine";
import {
  SLOW_PROVIDER_START_NOTICE_MS,
  startingProviderName,
  workingStatusKey,
} from "../workingStatus";
import { WorkingMarkContext } from "../workingMarkContext";
import {
  ContextCompactionLine,
  ModelChangedTimelineRow,
  ModelReroutedTimelineRow,
  TurnErrorTimelineRow,
  UserStoppedTimelineRow,
} from "./noticeCards";
import { UserInputExchange } from "./UserInputExchangeCard";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

type RowKind = MessagesTimelineRow["kind"];
type RowOf<K extends RowKind> = Extract<MessagesTimelineRow, { kind: K }>;
type WorkEntryRowProps = ComponentProps<typeof TimelineWorkEntryRow>;
type SystemErrorRowProps = ComponentProps<typeof TimelineSystemErrorRow>;
type InlineVisualProps = ComponentProps<typeof InlineVisual>;
type WorktreeSetupProps = ComponentProps<typeof WorktreeSetupCard>;

/** What card bodies read from the timeline that draws them. */
export interface TranscriptCardEnv {
  threadId: string | undefined;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  onImageExpand: WorkEntryRowProps["onImageExpand"];
  /** 重试 on a failed Moss image or video card; absent where no new turn can be sent. */
  onRetryMedia?: ((media: "image" | "video") => void) | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: WorkEntryRowProps["timestampFormat"];
  nowIso: string | undefined;
  conversationOnly: boolean;
  typography: {
    chatMetaPx: number;
    chatPx: number;
    uiSmPx: number;
    /** The chat's body text size. */
    chatFontSizePx: number;
    chatStyle: CSSProperties;
    userMessageStyle: CSSProperties;
    footerStyle: CSSProperties;
  };
  onOpenAgentActivity: ((activityId: string) => void) | undefined;
  onOpenThread: WorkEntryRowProps["onOpenThread"];
  onOpenAutomation: ((automationId: string) => void) | undefined;
  capacityRetryState: SystemErrorRowProps["capacityRetryState"];
  capacityRetryInFlightTurnId: SystemErrorRowProps["capacityRetryInFlightTurnId"];
  onCapacityRetry: SystemErrorRowProps["onCapacityRetry"];
  renderHtmlRender: (row: RowOf<"html-render">) => ReactNode;
  inlineVisualActions: InlineVisualProps["actions"];
  onEmbeddedScrollIntent: InlineVisualProps["onScrollIntent"];
  workingLabel: string;
  worktreeSetupPendingAction: WorktreeSetupProps["pendingAction"];
  onResolveWorktreeSetup: WorktreeSetupProps["onResolve"];
  /** Messages and tool runs: drawn by the timeline, which owns their many inputs. */
  renderConversationBody: (row: MessagesTimelineRow) => ReactNode;
}

type CardSpacing = "pb-1" | "pb-2" | "pb-4";

interface TranscriptCardDefinition<K extends RowKind> {
  /** Stable card id, like the desktop chat's `code.tool`. */
  id: `moss.${string}`;
  spacing: CardSpacing | ((row: RowOf<K>) => CardSpacing);
  Body: (props: { row: RowOf<K>; env: TranscriptCardEnv }) => ReactNode;
}

type TranscriptCardRegistry = { [K in RowKind]: TranscriptCardDefinition<K> };

function ConversationBody(props: { row: MessagesTimelineRow; env: TranscriptCardEnv }) {
  return <>{props.env.renderConversationBody(props.row)}</>;
}

/** True once `key` has stayed the same, non-null value for `ms`. */
function useUnchangedFor(key: string | null, ms: number): boolean {
  const [settledKey, setSettledKey] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => setSettledKey(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return key !== null && settledKey === key;
}

function WorkingBody(props: { row: RowOf<"working">; env: TranscriptCardEnv }) {
  const { t, format } = useTranslation();
  const { row, env } = props;
  const startingProvider = startingProviderName(env.workingLabel);
  // A start the person is waiting on gets words within seconds, not only after it fails.
  const startingSlowly = useUnchangedFor(startingProvider, SLOW_PROVIDER_START_NOTICE_MS);
  const elapsedSeconds =
    row.createdAt && env.nowIso
      ? Math.max(0, (Date.parse(env.nowIso) - Date.parse(row.createdAt)) / 1000)
      : 0;
  const key = workingStatusKey(env.workingLabel, elapsedSeconds);
  // The mark keeps its own colour and motion; only the words shimmer. A finished turn keeps
  // just the mark while it comes to rest.
  // Read from context, not env: the signal changes on every streamed character.
  const workingMark = useContext(WorkingMarkContext);
  const finished = workingMark.activity === "done";
  return (
    <div
      className={cn(
        "flex w-fit items-center gap-1.5 pt-0.5 font-system-ui",
        MUTED_LABEL_TEXT_CLASS_NAME,
      )}
      style={{ fontSize: `${env.typography.chatPx}px` }}
    >
      <MossLogoMark
        activity={workingMark.activity}
        progress={workingMark.progress}
        className={MESSAGE_ACTION_ICON_CLASS_NAME}
      />
      {finished ? null : (
        <span ref={syncAnimationsToTimelineOrigin} className="shimmer-group">
          {startingProvider
            ? format(
                startingSlowly
                  ? "transcript.working.startingSlowly"
                  : "transcript.working.starting",
                { provider: startingProvider },
              )
            : key
              ? t(key)
              : env.workingLabel}
        </span>
      )}
    </div>
  );
}

function GeneratedImageGalleryBody(props: {
  row: RowOf<"generated-image-gallery">;
  env: TranscriptCardEnv;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="mt-0.5 flex w-full flex-col gap-1.5"
      data-generated-image-gallery-placement="standalone-assistant"
    >
      <h4 className="sr-only select-none">{t("chat.generatedImage.assistant")}</h4>
      <GeneratedImageGallery
        gallery={props.row.gallery}
        cwd={props.env.markdownCwd}
        onImageExpand={props.env.onImageExpand}
        onRetry={props.env.onRetryMedia}
      />
    </div>
  );
}

function ModelChangedBody(props: { row: RowOf<"model-changed">; env: TranscriptCardEnv }) {
  const { t } = useTranslation();
  const { row } = props;
  return (
    <ModelChangedTimelineRow
      fromModel={row.fromModel}
      toModel={row.toModel}
      {...(row.fromModelDisplayName ? { fromModelDisplayName: row.fromModelDisplayName } : {})}
      {...(row.toModelDisplayName ? { toModelDisplayName: row.toModelDisplayName } : {})}
      customModelLabel={t("localConversation.modelChanged.custom")}
      fontSizePx={props.env.typography.uiSmPx}
      {...(row.status ? { status: row.status } : {})}
    />
  );
}

function ModelReroutedBody(props: { row: RowOf<"model-rerouted">; env: TranscriptCardEnv }) {
  const { t } = useTranslation();
  return (
    <ModelReroutedTimelineRow
      toModel={props.row.toModel}
      customModelLabel={t("localConversation.modelChanged.custom")}
      fontSizePx={props.env.typography.uiSmPx}
    />
  );
}

export const TRANSCRIPT_CARDS: TranscriptCardRegistry = {
  message: {
    id: "moss.message",
    spacing: (row) =>
      row.message.role !== "assistant" ? "pb-4" : row.assistantTurnInProgress ? "pb-1" : "pb-2",
    Body: ConversationBody,
  },
  "message-segment": { id: "moss.message_segment", spacing: "pb-2", Body: ConversationBody },
  work: { id: "moss.tool", spacing: "pb-2", Body: ConversationBody },
  "generated-image-gallery": {
    id: "moss.assistant_media",
    spacing: "pb-2",
    Body: GeneratedImageGalleryBody,
  },
  "context-compaction": {
    id: "moss.context",
    spacing: "pb-4",
    Body: ({ row }) => <ContextCompactionLine entry={row.entry} />,
  },
  reasoning: {
    id: "moss.thinking",
    spacing: "pb-2",
    Body: ({ row, env }) => (
      <TimelineReasoningRow
        entry={row.entry}
        active={row.active}
        chatMetaFontSizePx={env.typography.chatMetaPx}
        textFontSizePx={env.typography.chatFontSizePx}
        markdownCwd={env.markdownCwd}
        onImageExpand={env.onImageExpand}
      />
    ),
  },
  "todo-plan": {
    id: "moss.task_list",
    spacing: "pb-2",
    Body: ({ row, env }) => (
      <TimelineTodoPlanRow tasks={row.tasks} fontSizePx={env.typography.chatFontSizePx} />
    ),
  },
  "model-changed": { id: "moss.model_changed", spacing: "pb-4", Body: ModelChangedBody },
  "model-rerouted": { id: "moss.model_rerouted", spacing: "pb-2", Body: ModelReroutedBody },
  "user-stopped": {
    id: "moss.user_stopped",
    spacing: "pb-2",
    Body: ({ row }) => (
      <UserStoppedTimelineRow startedAt={row.startedAt} completedAt={row.completedAt} />
    ),
  },
  "turn-error": {
    id: "moss.turn_error",
    spacing: "pb-4",
    Body: ({ row }) => <TurnErrorTimelineRow message={row.message} />,
  },
  "system-error": {
    id: "moss.system_error",
    spacing: "pb-2",
    Body: ({ row, env }) => (
      <TimelineSystemErrorRow
        entry={row.entry}
        fontSizePx={env.typography.chatFontSizePx}
        {...(env.capacityRetryState !== undefined
          ? { capacityRetryState: env.capacityRetryState }
          : {})}
        {...(env.capacityRetryInFlightTurnId !== undefined
          ? { capacityRetryInFlightTurnId: env.capacityRetryInFlightTurnId }
          : {})}
        {...(env.onCapacityRetry ? { onCapacityRetry: env.onCapacityRetry } : {})}
      />
    ),
  },
  "proposed-plan": {
    id: "moss.plan",
    spacing: "pb-4",
    // Moss keeps a proposed plan inline (its plan panel opens once a plan runs), where
    // the desktop chat shows a "Proposed plan" line beside an auto-opened panel.
    Body: ({ row, env }) => (
      <div className="min-w-0 py-0.5">
        <ProposedPlanCard
          planMarkdown={row.proposedPlan.planMarkdown}
          cwd={env.markdownCwd}
          workspaceRoot={env.workspaceRoot}
          chatTypographyStyle={env.typography.chatStyle}
        />
      </div>
    ),
  },
  "html-render": {
    id: "moss.preview",
    spacing: "pb-2",
    Body: ({ row, env }) => (
      // Keyed by the row, not the page: a surface's newer page loads into the same frame.
      <div key={row.id} className="min-w-0 scroll-mt-24 px-1" data-html-render-entry-id={row.id}>
        {env.renderHtmlRender(row)}
      </div>
    ),
  },
  "inline-visual": {
    id: "moss.inline_visual",
    spacing: "pb-2",
    Body: ({ row, env }) =>
      env.threadId ? (
        <div className="min-w-0 px-1">
          <InlineVisual
            key={row.visual.visualId}
            threadId={ThreadId.makeUnsafe(env.threadId)}
            visual={row.visual}
            actions={env.inlineVisualActions}
            onScrollIntent={env.onEmbeddedScrollIntent}
          />
        </div>
      ) : null,
  },
  "user-input": {
    id: "moss.user_input",
    spacing: "pb-4",
    Body: ({ row, env }) => (
      <UserInputExchange
        items={row.entry.userInputExchange}
        chatTypographyStyle={env.typography.chatStyle}
        answerTypographyStyle={env.typography.userMessageStyle}
        labelStyle={env.typography.footerStyle}
      />
    ),
  },
  "working-header": {
    id: "moss.turn_header",
    spacing: "pb-2",
    // Non-collapsible twin of the settled turn header: same tone, size and hairline,
    // but counting up live.
    Body: ({ row, env }) =>
      env.conversationOnly ? null : (
        <TurnHeaderLine
          kind="live"
          startedAt={row.createdAt}
          nowLabel={env.nowIso ? (formatClockElapsed(row.createdAt, env.nowIso) ?? "0s") : null}
          modelChange={row.modelChange ?? null}
          resumedBy={row.resumedBy ?? null}
          fontSize={env.typography.chatStyle.fontSize}
          timestampFormat={env.timestampFormat}
        />
      ),
  },
  working: { id: "moss.status", spacing: "pb-1", Body: WorkingBody },
  "worktree-setup": {
    id: "moss.worktree_setup",
    spacing: "pb-4",
    Body: ({ row, env }) => (
      <DisclosureRegion open={row.open}>
        <div className="pt-0.5 pb-1">
          <WorktreeSetupCard
            steps={row.steps}
            pendingAction={env.worktreeSetupPendingAction}
            onResolve={env.onResolveWorktreeSetup}
          />
        </div>
      </DisclosureRegion>
    ),
  },
};

function cardFor<K extends RowKind>(row: RowOf<K>): TranscriptCardDefinition<K> {
  return TRANSCRIPT_CARDS[row.kind as K];
}

export function transcriptCardSpacingClassName(row: MessagesTimelineRow): CardSpacing {
  const { spacing } = cardFor(row);
  return typeof spacing === "function" ? spacing(row as never) : spacing;
}

type BoundaryProps = { cardId: string; children: ReactNode };

/** Keeps one failed card from taking the transcript down; Retry renders it again. */
export class TranscriptCardBoundary extends React.Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <TranscriptCardFallback
        cardId={this.props.cardId}
        onRetry={() => this.setState({ failed: false })}
      />
    );
  }
}

// The desktop chat's danger notice: warning glyph, message in the danger tone, and a
// secondary Retry, drawn with Moss's Alert.
function TranscriptCardFallback(props: { cardId: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert
      variant="error"
      data-transcript-card-fallback={props.cardId}
      className="items-center text-size-chat text-destructive"
    >
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="text-destructive">
        {t("transcript.card.failed")}
      </AlertDescription>
      <AlertAction>
        <Button type="button" size="xs" variant="secondary" onClick={props.onRetry}>
          {t("transcript.card.retry")}
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** Draws a row through its card: the registered body inside the card's error boundary. */
export function renderTranscriptCard(row: MessagesTimelineRow, env: TranscriptCardEnv): ReactNode {
  const card = cardFor(row);
  const Body = card.Body as (props: {
    row: MessagesTimelineRow;
    env: TranscriptCardEnv;
  }) => ReactNode;
  return (
    <TranscriptCardBoundary key={card.id} cardId={card.id}>
      <Body row={row} env={env} />
    </TranscriptCardBoundary>
  );
}
