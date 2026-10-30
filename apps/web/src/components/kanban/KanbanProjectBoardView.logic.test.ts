// FILE: KanbanProjectBoardView.logic.test.ts
// Purpose: Verifies localized Draft-to-In-Progress dispatch side effects.
// Layer: Kanban UI logic tests

import { readFileSync } from "node:fs";
import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { translateMoss, type TranslationKey } from "~/localization";
import { localizeProviderSendBlockedReason } from "~/lib/providerUnavailablePresentation";
import type { KanbanCard } from "./kanban.logic";
import {
  createKanbanDraftDispatchSingleFlight,
  presentKanbanDraftDispatchResult,
  routeKanbanDraftColumnDrop,
} from "./KanbanProjectBoardView.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const CARD = {
  cardId: "draft:thread-1",
  threadId: ThreadId.makeUnsafe("thread-1"),
  projectId: ProjectId.makeUnsafe("project-1"),
  column: "draft",
  title: "Ship localized dispatch",
} as KanbanCard;

const addToast = vi.fn();
const onOpenCard = vi.fn();
const t = (locale: "en" | "zh-CN") => (key: TranslationKey) => translateMoss(locale, key);

beforeEach(() => {
  addToast.mockReset();
  onOpenCard.mockReset();
});

describe("presentKanbanDraftDispatchResult", () => {
  it("wires BoardView provider blocks through the safe localized presentation helper", () => {
    const source = readFileSync(new URL("./KanbanProjectBoardView.tsx", import.meta.url), "utf8");

    expect(source).toContain(
      'import { localizeProviderSendBlockedReason } from "~/lib/providerUnavailablePresentation";',
    );
    expect(source).toContain("localizeProviderSendBlockedReason(locale, sendAvailability)");
    expect(source).not.toContain("title: sendAvailability.unavailableReason");
    expect(source).toContain(
      "const dispatchSingleFlight = useMemo(createKanbanDraftDispatchSingleFlight, []);",
    );
    expect(source).toContain("dispatchSingleFlight.run(card.threadId, async () => {");
  });

  it("localizes a managed blocked provider without exposing EPERM or user paths", () => {
    const blockedReason = localizeProviderSendBlockedReason("zh-CN", {
      provider: "codex",
      status: {
        provider: "codex",
        instanceId: "codex_moss",
        driver: "codex",
        displayName: "Moss",
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt: "2026-08-12T00:00:00.000Z",
        message: "EPERM: operation not permitted, open 'C:\\Users\\alice\\.codex\\state.json'",
      },
      unavailableReason:
        "EPERM: operation not permitted, open 'C:\\Users\\alice\\.codex\\state.json'",
    });

    expect(blockedReason).toBe("Moss 当前不可用。");
    expect(blockedReason).not.toContain("EPERM");
    expect(blockedReason).not.toContain("alice");
    expect(blockedReason).not.toContain("state.json");
  });

  it("presents a localized Draft-sent success without opening the card", () => {
    presentKanbanDraftDispatchResult({
      result: { kind: "dispatched" },
      card: CARD,
      t: t("zh-CN"),
      addToast,
      onOpenCard,
    });

    expect(addToast).toHaveBeenCalledWith({
      type: "success",
      title: "草稿已发送",
      description: CARD.title,
    });
    expect(onOpenCard).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", "还没有可发送的内容；请在消息输入框中编写提示词。"],
    ["worktree-pending", "打开对话，通过常规发送流程创建工作树。"],
    ["not-draft", "打开对话以继续此任务。"],
  ] as const)(
    "localizes the %s open-thread reason and opens exactly once",
    (reason, description) => {
      presentKanbanDraftDispatchResult({
        result: { kind: "open-thread", reason },
        card: CARD,
        t: t("zh-CN"),
        addToast,
        onOpenCard,
      });

      expect(addToast).toHaveBeenCalledWith({
        type: "info",
        title: "在对话中完成此草稿",
        description,
      });
      expect(onOpenCard).toHaveBeenCalledTimes(1);
      expect(onOpenCard).toHaveBeenCalledWith(CARD);
    },
  );

  it("localizes disconnected dispatch without opening the card", () => {
    presentKanbanDraftDispatchResult({
      result: { kind: "unavailable" },
      card: CARD,
      t: t("zh-CN"),
      addToast,
      onOpenCard,
    });

    expect(addToast).toHaveBeenCalledWith({
      type: "error",
      title: "未连接",
      description: "请重新连接服务器后再发送草稿。",
    });
    expect(onOpenCard).not.toHaveBeenCalled();
  });

  it("localizes dispatch failure without exposing paths or internal diagnostics", () => {
    presentKanbanDraftDispatchResult({
      result: {
        kind: "error",
        message: "EPERM: operation not permitted, open 'C:\\Users\\alice\\.codex\\state.json'",
      },
      card: CARD,
      t: t("zh-CN"),
      addToast,
      onOpenCard,
    });

    expect(addToast).toHaveBeenCalledWith({
      type: "error",
      title: "无法发送草稿",
      description: "请打开对话检查草稿，然后重试。",
    });
    const renderedToast = JSON.stringify(addToast.mock.calls);
    expect(renderedToast).not.toContain("EPERM");
    expect(renderedToast).not.toContain("alice");
    expect(renderedToast).not.toContain("state.json");
    expect(onOpenCard).not.toHaveBeenCalled();
  });
});

describe("routeKanbanDraftColumnDrop", () => {
  it.each([
    ["en", "Done is derived automatically", "Cards move here when their runs complete."],
    ["zh-CN", "已完成状态会自动确定", "任务运行完成后，卡片会自动移到这里。"],
  ] as const)("presents the derived Done outcome in %s", (locale, title, description) => {
    const dispatchWithPreflight = vi.fn();

    routeKanbanDraftColumnDrop({
      targetColumn: "done",
      dispatchWithPreflight,
      t: t(locale),
      addToast,
    });

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith({
      type: "info",
      title,
      description,
    });
    expect(dispatchWithPreflight).not.toHaveBeenCalled();
  });

  it("routes In Progress to the preflight/dispatch pipeline without presenting Done", () => {
    const dispatchWithPreflight = vi.fn();

    routeKanbanDraftColumnDrop({
      targetColumn: "inProgress",
      dispatchWithPreflight,
      t: t("en"),
      addToast,
    });

    expect(dispatchWithPreflight).toHaveBeenCalledOnce();
    expect(addToast).not.toHaveBeenCalled();
  });

  it("wires the production branch to the runtime router without retaining literals", () => {
    const source = readFileSync(new URL("./KanbanProjectBoardView.tsx", import.meta.url), "utf8");

    expect(source).toContain("routeKanbanDraftColumnDrop({");
    expect(source).toContain("dispatchWithPreflight: () => {");
    expect(source).not.toContain('title: "Done is derived automatically"');
    expect(source).not.toContain('description: "Cards move here when their runs complete."');
  });
});

describe("Kanban Draft dispatch single-flight", () => {
  it("joins a slow same-thread success so refresh, dispatch, and presentation run once", async () => {
    const singleFlight = createKanbanDraftDispatchSingleFlight();
    const preflight = deferred<void>();
    const threadId = ThreadId.makeUnsafe("thread-success");
    const events: string[] = [];
    const operation = async () => {
      events.push("refresh");
      await preflight.promise;
      events.push("dispatch");
      events.push("presentation");
    };

    const first = singleFlight.run(threadId, operation);
    const second = singleFlight.run(threadId, operation);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(events).toEqual(["refresh"]));
    preflight.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(["refresh", "dispatch", "presentation"]);
  });

  it("joins a slow same-thread block so refresh and blocked toast run once", async () => {
    const singleFlight = createKanbanDraftDispatchSingleFlight();
    const preflight = deferred<void>();
    const threadId = ThreadId.makeUnsafe("thread-blocked");
    const refresh = vi.fn();
    const dispatch = vi.fn();
    const blockedToast = vi.fn();
    const operation = async () => {
      refresh();
      await preflight.promise;
      blockedToast();
    };

    const first = singleFlight.run(threadId, operation);
    const second = singleFlight.run(threadId, operation);

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    preflight.resolve();
    await Promise.all([first, second]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(blockedToast).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("allows different threads to remain in preflight concurrently", async () => {
    const singleFlight = createKanbanDraftDispatchSingleFlight();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const activeThreads = new Set<string>();
    const start = vi.fn();
    const operation = (threadId: ThreadId, gate: Promise<void>) => async () => {
      start(threadId);
      activeThreads.add(threadId);
      await gate;
      activeThreads.delete(threadId);
    };

    const first = singleFlight.run(
      ThreadId.makeUnsafe("thread-a"),
      operation(ThreadId.makeUnsafe("thread-a"), firstGate.promise),
    );
    const second = singleFlight.run(
      ThreadId.makeUnsafe("thread-b"),
      operation(ThreadId.makeUnsafe("thread-b"), secondGate.promise),
    );

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(activeThreads).toEqual(new Set(["thread-a", "thread-b"]));
    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([first, second]);
  });

  it("clears a rejected thread lock so a later retry can run", async () => {
    const singleFlight = createKanbanDraftDispatchSingleFlight();
    const threadId = ThreadId.makeUnsafe("thread-retry");
    const attempts = vi.fn();

    await expect(
      singleFlight.run(threadId, async () => {
        attempts();
        throw new Error("preflight failed");
      }),
    ).rejects.toThrow("preflight failed");
    await singleFlight.run(threadId, async () => {
      attempts();
    });

    expect(attempts).toHaveBeenCalledTimes(2);
  });
});
