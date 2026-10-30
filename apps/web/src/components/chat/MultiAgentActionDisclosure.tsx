import { ConversationShimmer } from "./ConversationShimmer";
// FILE: MultiAgentActionDisclosure.tsx
// Purpose: Codex-style timeline disclosure for provider multi-agent actions.

import { ThreadId } from "@synara/contracts";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import type { WorkLogEntry, WorkLogSubagent } from "../../workLog";
import {
  aggregateMultiAgentActionStatus,
  countMultiAgentActionAgents,
  normalizeMultiAgentAction,
  normalizeMultiAgentActionStatus,
  normalizeMultiAgentAgentState,
  type MultiAgentAction,
  type MultiAgentActionStatus,
} from "../../lib/multiAgentAction";
import {
  formatSubagentModelLabel,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";
import { WorkflowIcon } from "~/lib/icons";
import { useTranslation, type TranslationKey } from "~/localization";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ToolActivityDisclosure } from "./ToolActivityDisclosure";
import {
  multiAgentAgentStateKey,
  multiAgentCountLabelKey,
  multiAgentHeaderVerbKey,
  multiAgentRowVerbKey,
  multiAgentSendPromptVerbKey,
} from "./MultiAgentActionDisclosure.logic";

type TimelineMultiAgentAction = Exclude<MultiAgentAction, "waitAgent">;

type MultiAgentActionEntry = Pick<
  WorkLogEntry,
  "activityKind" | "id" | "subagentAction" | "subagents" | "toolStatus"
>;

function resolveEntryStatus(entry: MultiAgentActionEntry): MultiAgentActionStatus {
  return (
    normalizeMultiAgentActionStatus(entry.subagentAction?.status) ??
    normalizeMultiAgentActionStatus(entry.toolStatus) ??
    (entry.toolStatus === "running" || entry.activityKind === "tool.started"
      ? "inProgress"
      : "completed")
  );
}

function uniqueSubagents(subagents: ReadonlyArray<WorkLogSubagent>): WorkLogSubagent[] {
  const byId = new Map<string, WorkLogSubagent>();
  for (const subagent of subagents) {
    const id = subagent.providerThreadId ?? subagent.threadId;
    const previous = byId.get(id);
    byId.set(id, previous ? { ...previous, ...subagent } : subagent);
  }
  return [...byId.values()].toSorted((left, right) =>
    (left.providerThreadId ?? left.threadId).localeCompare(
      right.providerThreadId ?? right.threadId,
    ),
  );
}

function RichTranslation(props: { message: string; values: Readonly<Record<string, ReactNode>> }) {
  const parts = props.message.split(/(\{[a-zA-Z0-9_]+\})/gu);
  return parts.map((part) => {
    const match = /^\{([a-zA-Z0-9_]+)\}$/u.exec(part);
    if (!match) return part;
    return <Fragment key={match[1]}>{props.values[match[1]!] ?? part}</Fragment>;
  });
}

function OverflowPrompt(props: { prompt: string }) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const update = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.prompt]);

  const content = (
    <span
      ref={textRef}
      className="min-w-0 flex-1 truncate text-text/40"
      data-multi-agent-prompt="true"
    >
      {props.prompt}
    </span>
  );
  return (
    <Tooltip disabled={!overflowing}>
      <TooltipTrigger render={content} />
      <TooltipPopup side="top" align="start" className="max-w-96 whitespace-pre-wrap">
        {props.prompt}
      </TooltipPopup>
    </Tooltip>
  );
}

function agentPresentation(subagent: WorkLogSubagent) {
  const identities = new Set([
    subagent.threadId,
    subagent.providerThreadId,
    subagent.resolvedThreadId,
  ]);
  const readableName = (value: string | undefined) => {
    const name = value?.trim().replace(/^@/u, "");
    return name && !identities.has(name) ? name : undefined;
  };
  return resolveSubagentPresentation({
    nickname: readableName(subagent.nickname),
    role: subagent.role?.trim().toLowerCase() === "default" ? undefined : subagent.role,
    title: readableName(subagent.title),
  });
}

function AgentLabel(props: {
  subagent: WorkLogSubagent;
  parentModel: string | undefined;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const { format } = useTranslation();
  const presentation = agentPresentation(props.subagent);
  const role =
    presentation.role &&
    presentation.role.toLocaleLowerCase() !== presentation.primaryLabel.toLocaleLowerCase()
      ? ` (${presentation.role})`
      : null;
  const openThreadId = props.subagent.resolvedThreadId?.trim();
  const canOpen = Boolean(openThreadId && props.onOpenThread);
  const name = canOpen ? (
    <button
      type="button"
      className="cursor-interaction bg-transparent p-0 align-baseline font-medium"
      data-multi-agent-open-agent="true"
      onClick={() => props.onOpenThread?.(ThreadId.makeUnsafe(openThreadId!))}
    >
      {presentation.primaryLabel}
    </button>
  ) : (
    <span className="font-medium">{presentation.primaryLabel}</span>
  );
  const label = (
    <span>
      {name}
      {role ? <span>{role}</span> : null}
    </span>
  );
  const model = formatSubagentModelLabel(props.subagent.model ?? props.parentModel);
  if (!model) return label;
  return (
    <Tooltip>
      <TooltipTrigger render={label} />
      <TooltipPopup>
        {format("localConversation.multiAgentAction.agent.usesModel", { model })}
      </TooltipPopup>
    </Tooltip>
  );
}

function stateSuffix(
  action: TimelineMultiAgentAction,
  subagent: WorkLogSubagent,
  t: (key: TranslationKey) => string,
): string {
  if (action === "closeAgent" || action === "resumeAgent") return "";
  const state = normalizeMultiAgentAgentState(subagent.rawStatus ?? subagent.statusLabel);
  if (!state) return "";
  const stateLabel = t(multiAgentAgentStateKey(state));
  const message = subagent.latestUpdate?.trim();
  return message ? ` (${stateLabel}: ${message})` : ` (${stateLabel})`;
}

function MultiAgentActionRows(props: {
  items: ReadonlyArray<MultiAgentActionEntry>;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const { t } = useTranslation();
  const rows: ReactNode[] = [];

  for (const item of props.items) {
    const action = normalizeMultiAgentAction(item.subagentAction?.tool);
    if (!action || action === "waitAgent") continue;
    const status = resolveEntryStatus(item);
    const prompt = item.subagentAction?.prompt?.trim() ?? "";
    // Reference rows wait for readable identity metadata; raw routing ids only
    // contribute to the header count, never to the user-facing agent name.
    const subagents = uniqueSubagents(item.subagents ?? []).filter(
      (subagent) => agentPresentation(subagent).primaryLabel !== "Subagent",
    );
    const createdWithInstructions =
      action === "spawnAgent" && status === "completed" && prompt.length > 0;
    const sentWithPrompt =
      (action === "sendInput" || action === "sendMessage" || action === "followupTask") &&
      prompt.length > 0;

    if (subagents.length === 0) {
      rows.push(
        <div
          key={`row-generic-${item.id}`}
          className="text-size-chat min-w-0 text-text/60 [&_*]:text-text/50"
        >
          <RichTranslation
            message={t("localConversation.multiAgentAction.row.generic")}
            values={{ action: t(multiAgentRowVerbKey(action, status)) }}
          />
        </div>,
      );
    } else {
      for (const subagent of subagents) {
        const agent = (
          <AgentLabel
            subagent={subagent}
            parentModel={item.subagentAction?.model}
            {...(props.onOpenThread ? { onOpenThread: props.onOpenThread } : {})}
          />
        );
        let node: ReactNode;
        if (createdWithInstructions) {
          node = (
            <RichTranslation
              message={t("localConversation.multiAgentAction.row.spawn.createdWithInstructions")}
              values={{ agent, instructions: <OverflowPrompt prompt={prompt} /> }}
            />
          );
        } else if (sentWithPrompt) {
          node = (
            <RichTranslation
              message={t("localConversation.multiAgentAction.row.sendInput.messagedWithPrompt")}
              values={{
                action: t(multiAgentSendPromptVerbKey(status)),
                agent,
                prompt: <OverflowPrompt prompt={prompt} />,
              }}
            />
          );
        } else {
          node = (
            <RichTranslation
              message={t("localConversation.multiAgentAction.row.agent")}
              values={{
                action: t(multiAgentRowVerbKey(action, status)),
                agent,
                stateSuffix: stateSuffix(action, subagent, t),
              }}
            />
          );
        }
        rows.push(
          <div
            key={`row-${item.id}-${subagent.providerThreadId ?? subagent.threadId}`}
            className="text-size-chat min-w-0 text-text/60 [&_*]:text-text/50"
          >
            {createdWithInstructions || sentWithPrompt ? (
              <span className="flex min-w-0 items-baseline gap-1 overflow-hidden whitespace-nowrap">
                {node}
              </span>
            ) : (
              node
            )}
          </div>,
        );
      }
    }

    if (!createdWithInstructions && !sentWithPrompt && prompt.length > 0) {
      rows.push(
        <div
          key={`meta-prompt-${item.id}`}
          className="text-size-chat min-w-0 text-text/60 [&_*]:text-text/50"
        >
          <RichTranslation
            message={t("localConversation.multiAgentAction.meta.prompt")}
            values={{
              prompt: <span className="break-words whitespace-pre-wrap">{prompt}</span>,
            }}
          />
        </div>,
      );
    }
  }

  return <>{rows}</>;
}

export function MultiAgentActionDisclosure(props: {
  items: ReadonlyArray<MultiAgentActionEntry>;
  fontSizePx: number;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const { format, t } = useTranslation();
  const firstAction = normalizeMultiAgentAction(props.items[0]?.subagentAction?.tool);
  if (!firstAction || firstAction === "waitAgent") return null;

  const status = aggregateMultiAgentActionStatus(
    props.items.map((item) => resolveEntryStatus(item)),
  );
  const count = countMultiAgentActionAgents(props.items);
  const countLabel = format(multiAgentCountLabelKey(count), { count });
  const label = (
    <span className="truncate text-size-chat text-text/40">
      <RichTranslation
        message={t("localConversation.multiAgentAction.header")}
        values={{
          action: (
            <ConversationShimmer
              active={status === "inProgress"}
              className="text-text-tertiary/90 group-hover/activity-header:text-default"
            >
              {t(multiAgentHeaderVerbKey(firstAction, status))}
            </ConversationShimmer>
          ),
          countLabel,
        }}
      />
    </span>
  );

  return (
    <div data-multi-agent-action-disclosure="true">
      <ToolActivityDisclosure
        indentContent={false}
        bodyVariant="grouped"
        label={label}
        shimmerLabel={false}
        leadingIcon={<WorkflowIcon className="size-4 shrink-0" />}
        fontSizePx={props.fontSizePx}
        status={status === "inProgress" ? "running" : status}
        expandWhileRunning={false}
        renderChildren={() => (
          <div
            className="flex min-w-0 flex-col gap-[var(--conversation-grouped-item-gap,4px)]"
            data-testid="multi-agent-action-rows"
          >
            <MultiAgentActionRows
              items={props.items}
              {...(props.onOpenThread ? { onOpenThread: props.onOpenThread } : {})}
            />
          </div>
        )}
      />
    </div>
  );
}
