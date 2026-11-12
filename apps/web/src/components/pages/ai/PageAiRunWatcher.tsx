// FILE: PageAiRunWatcher.tsx
// Purpose: Follows the conversation a page AI run started. A 生成 run streams the agent's reply
//          into the page as a draft and saves it as a reviewable draft when the turn ends; other
//          runs only need to know when the agent finished so the page re-reads its drafts.
// Layer: Page AI (web)

import type { PageDraftsMutateInput, SpaceId, ThreadId, TurnId } from "@moss/contracts";
import { useEffect } from "react";

import { generatedMarkdown } from "~/lib/pageAi/pageAiPrompts";
import { pageRunProgress } from "~/lib/pageAi/pageAssistantThread";
import { isActiveRun, pageAiSession, type PageAiRun } from "~/lib/pageAi/pageAiSession";
import { ensureNativeApi } from "~/nativeApi";
import { useMossAccountGatewayState } from "~/components/auth/useMossGatewayUnreachable";
import { pageAiErrorText, pageAiLocale, pageAiText } from "./pageAiText";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import { useStore } from "~/store";
import { getThreadFromState } from "~/threadDerivation";

function useRunProgress(threadId: ThreadId, baselineTurnId: TurnId | null, startedAt: number) {
  return useStore((state) => {
    const thread = getThreadFromState(state, threadId);
    if (!thread) return "missing|";
    const progress = pageRunProgress(thread, baselineTurnId, startedAt);
    return `${progress.state}|${progress.reply}`;
  });
}

function RunWatcher(props: {
  pageKey: string;
  run: PageAiRun & { threadId: ThreadId };
  scopeSpaceId: SpaceId | null;
  pageId: string;
  onDrafted: () => void;
}) {
  // A background chat's messages only stream into the store while someone holds its detail.
  useEffect(() => retainThreadDetailSubscription(props.run.threadId), [props.run.threadId]);
  const progress = useRunProgress(
    props.run.threadId,
    props.run.baselineTurnId ?? null,
    props.run.startedAt,
  );
  const failure = useStore(
    (state) => getThreadFromState(state, props.run.threadId)?.session?.lastError ?? undefined,
  );
  const mossSignedOut = useMossAccountGatewayState() === "signed-out";
  const split = progress.indexOf("|");
  const state = progress.slice(0, split);
  const reply = progress.slice(split + 1);
  const { pageKey, run } = props;
  useEffect(() => {
    const streamed = generatedMarkdown(reply);
    if (run.mode === "generate" && streamed !== (run.streamed ?? ""))
      pageAiSession.updateRun(pageKey, run.id, { streamed });
  }, [pageKey, reply, run.id, run.mode, run.streamed]);
  useEffect(() => {
    if (state !== "completed" && state !== "interrupted" && state !== "error") return;
    if (state !== "completed") {
      pageAiSession.updateRun(pageKey, run.id, {
        finishedAt: Date.now(),
        status: "failed",
        error: pageAiErrorText(failure, pageAiText(pageAiLocale()), {
          signedOut: mossSignedOut,
        }),
      });
      return;
    }
    if (run.mode !== "generate") {
      pageAiSession.updateRun(pageKey, run.id, { status: "done", finishedAt: Date.now() });
      props.onDrafted();
      return;
    }
    const markdown = generatedMarkdown(reply);
    if (!markdown) {
      pageAiSession.updateRun(pageKey, run.id, { status: "failed" });
      return;
    }
    pageAiSession.updateRun(pageKey, run.id, {
      status: "drafted",
      streamed: markdown,
      finishedAt: Date.now(),
    });
    const input: PageDraftsMutateInput = {
      op: "create",
      requestId: `generate:${run.id}`,
      scopeSpaceId: props.scopeSpaceId,
      pageId: props.pageId as PageDraftsMutateInput["pageId"],
      baseRevision: run.baseRevision,
      kind: "text",
      summary: run.prompt.slice(0, 200),
      authorThreadId: run.threadId,
      ops: [
        run.anchorBlockId
          ? { kind: "insert", afterBlockId: run.anchorBlockId, markdown }
          : { kind: "insert", markdown },
      ],
    };
    void ensureNativeApi()
      .pages.draftsMutate(input)
      .catch(() => pageAiSession.updateRun(pageKey, run.id, { status: "failed" }))
      .finally(props.onDrafted);
    // Runs once when the turn settles; later renders see a non-active run and unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return null;
}

export function PageAiRunWatchers(props: {
  pageKey: string;
  runs: readonly PageAiRun[];
  scopeSpaceId: SpaceId | null;
  pageId: string;
  onDrafted: () => void;
}) {
  return (
    <>
      {props.runs
        .filter(
          (run): run is PageAiRun & { threadId: ThreadId } => isActiveRun(run) && !!run.threadId,
        )
        .map((run) => (
          <RunWatcher
            key={run.id}
            pageKey={props.pageKey}
            run={run}
            scopeSpaceId={props.scopeSpaceId}
            pageId={props.pageId}
            onDrafted={props.onDrafted}
          />
        ))}
    </>
  );
}
