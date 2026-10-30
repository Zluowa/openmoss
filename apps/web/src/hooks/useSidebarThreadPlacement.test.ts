import { ThreadId, type OrchestrationSidebarOrderItem } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: Slot[] = [];
  let cursor = 0;
  const next = () => (slots[cursor] ??= {}) as Slot;
  const equal = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  return {
    begin() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useCallback<T>(value: T, deps: readonly unknown[]): T {
      const slot = next();
      cursor += 1;
      if (!equal(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = value;
      }
      return slot.value as T;
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
      const slot = next();
      cursor += 1;
      if (!equal(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = factory();
      }
      return slot.value as T;
    },
    useRef<T>(value: T) {
      const slot = next();
      cursor += 1;
      if (!("value" in slot)) slot.value = { current: value };
      return slot.value as { current: T };
    },
    useState<T>(initial: T | (() => T)) {
      const slot = next();
      cursor += 1;
      if (!("value" in slot)) {
        slot.value = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const set = (nextValue: T | ((current: T) => T)) => {
        slot.value =
          typeof nextValue === "function"
            ? (nextValue as (current: T) => T)(slot.value as T)
            : nextValue;
      };
      return [slot.value as T, set] as const;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = next();
      cursor += 1;
      if (equal(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
  };
});

vi.mock("react", () => ({
  useCallback: reactHarness.useCallback,
  useEffect: reactHarness.useEffect,
  useMemo: reactHarness.useMemo,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

import {
  useSidebarThreadPlacement,
  type SidebarThreadPlacementDispatchResult,
} from "./useSidebarThreadPlacement";
import type { SidebarThreadPlacementRequest } from "../components/SidebarThreadPlacementDnd";

const NOW = "2026-08-31T00:00:00.000Z";
const orderItems: OrchestrationSidebarOrderItem[] = [
  {
    key: "thread:source" as OrchestrationSidebarOrderItem["key"],
    itemType: "thread",
    destination: "default",
    sectionId: null,
    sectionCreatedAt: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    key: "thread:anchor" as OrchestrationSidebarOrderItem["key"],
    itemType: "thread",
    destination: "custom",
    sectionId: "section-test" as OrchestrationSidebarOrderItem["sectionId"],
    sectionCreatedAt: NOW,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function input(overrides: Partial<Parameters<typeof useSidebarThreadPlacement>[0]> = {}) {
  return {
    orderItems,
    orderRevision: 4,
    migrationState: "ready" as const,
    dispatchPlacement: vi
      .fn<
        (
          request: SidebarThreadPlacementRequest & { expectedSidebarOrderRevision: number },
        ) => Promise<SidebarThreadPlacementDispatchResult>
      >()
      .mockResolvedValue({ sequence: 5, sidebarOrderRevision: 5 }),
    rehydrate: vi.fn(),
    ...overrides,
  };
}

function renderHookValue<T extends ReturnType<typeof useSidebarThreadPlacement>>(value: T) {
  return value;
}

describe("useSidebarThreadPlacement", () => {
  beforeEach(() => reactHarness.reset());

  it("dispatches one revision-guarded positioned move and exposes an exact inverse", async () => {
    const props = input();
    reactHarness.begin();
    let hook = renderHookValue(useSidebarThreadPlacement(props));
    const sourceId = ThreadId.makeUnsafe("source");
    const anchorId = ThreadId.makeUnsafe("anchor");

    await hook.place({
      threadId: sourceId,
      destination: "custom",
      sectionId: "section-test",
      sectionCreatedAt: NOW,
      beforeThreadId: anchorId,
    });
    expect(props.dispatchPlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: sourceId,
        beforeThreadId: anchorId,
        expectedSidebarOrderRevision: 4,
      }),
    );

    reactHarness.begin();
    hook = renderHookValue(useSidebarThreadPlacement({ ...props, orderRevision: 5 }));
    reactHarness.begin();
    hook = renderHookValue(useSidebarThreadPlacement({ ...props, orderRevision: 5 }));
    expect(hook.undoDescriptor).toMatchObject({
      threadId: sourceId,
      destination: "default",
      sectionId: null,
      beforeThreadId: null,
      resultingRevision: 5,
    });

    await hook.undo();
    expect(props.dispatchPlacement).toHaveBeenLastCalledWith(
      expect.objectContaining({
        threadId: sourceId,
        destination: "default",
        beforeThreadId: null,
        expectedSidebarOrderRevision: 5,
      }),
    );
  });

  it("discards the overlay and rehydrates after a definite rejection", async () => {
    const rehydrate = vi.fn();
    const dispatchPlacement = vi.fn().mockRejectedValue(new Error("stale"));
    const props = input({ dispatchPlacement, rehydrate });
    reactHarness.begin();
    const hook = renderHookValue(useSidebarThreadPlacement(props));

    await expect(
      hook.place({
        threadId: ThreadId.makeUnsafe("source"),
        destination: "custom",
        sectionId: "section-test",
        sectionCreatedAt: NOW,
        beforeThreadId: ThreadId.makeUnsafe("anchor"),
      }),
    ).resolves.toBe(false);
    expect(rehydrate).toHaveBeenCalledTimes(1);
  });

  it("rehydrates after an unknown outcome without showing a rejection", async () => {
    const rehydrate = vi.fn();
    const onRejected = vi.fn();
    const props = input({
      dispatchPlacement: vi.fn().mockRejectedValue(new Error("network timeout")),
      rehydrate,
      onRejected,
    });
    reactHarness.begin();
    let hook = renderHookValue(useSidebarThreadPlacement(props));
    await expect(
      hook.place({
        threadId: ThreadId.makeUnsafe("source"),
        destination: "custom",
        sectionId: "section-test",
        sectionCreatedAt: NOW,
        beforeThreadId: ThreadId.makeUnsafe("anchor"),
      }),
    ).resolves.toBe(false);
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
    reactHarness.begin();
    hook = renderHookValue(useSidebarThreadPlacement(props));
    expect(hook.optimistic).toBe(false);
    expect(hook.displayItems).toBe(orderItems);
  });

  it("keeps a second placement from racing the in-flight command", async () => {
    let resolveDispatch!: (value: SidebarThreadPlacementDispatchResult) => void;
    const dispatchPlacement = vi.fn(
      () =>
        new Promise<SidebarThreadPlacementDispatchResult>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const props = input({ dispatchPlacement });
    reactHarness.begin();
    const hook = renderHookValue(useSidebarThreadPlacement(props));
    const first = hook.place({
      threadId: ThreadId.makeUnsafe("source"),
      destination: "custom",
      sectionId: "section-test",
      sectionCreatedAt: NOW,
      beforeThreadId: ThreadId.makeUnsafe("anchor"),
    });
    await expect(
      hook.place({
        threadId: ThreadId.makeUnsafe("source"),
        destination: "custom",
        sectionId: "section-test",
        sectionCreatedAt: NOW,
        beforeThreadId: ThreadId.makeUnsafe("anchor"),
      }),
    ).resolves.toBe(false);
    resolveDispatch({ sequence: 5, sidebarOrderRevision: 5 });
    await expect(first).resolves.toBe(true);
    expect(dispatchPlacement).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the successful revision is no longer current", async () => {
    const props = input();
    reactHarness.begin();
    let hook = renderHookValue(useSidebarThreadPlacement(props));
    await hook.place({
      threadId: ThreadId.makeUnsafe("source"),
      destination: "custom",
      sectionId: "section-test",
      sectionCreatedAt: NOW,
      beforeThreadId: ThreadId.makeUnsafe("anchor"),
    });
    const rehydrate = vi.fn();
    reactHarness.begin();
    hook = renderHookValue(useSidebarThreadPlacement({ ...props, orderRevision: 6, rehydrate }));
    await expect(hook.undo()).resolves.toBe(false);
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(props.dispatchPlacement).toHaveBeenCalledTimes(1);
  });

  it("releases the revision fence after Undo so a later placement can proceed", async () => {
    let resultingRevision = 5;
    const dispatchPlacement = vi.fn(async () => ({
      sequence: resultingRevision,
      sidebarOrderRevision: resultingRevision++,
    }));
    const props = input({ dispatchPlacement });
    reactHarness.begin();
    let hook = renderHookValue(useSidebarThreadPlacement(props));
    await expect(
      hook.place({
        threadId: ThreadId.makeUnsafe("source"),
        destination: "custom",
        sectionId: "section-test",
        sectionCreatedAt: NOW,
        beforeThreadId: ThreadId.makeUnsafe("anchor"),
      }),
    ).resolves.toBe(true);

    reactHarness.begin();
    hook = renderHookValue(useSidebarThreadPlacement({ ...props, orderRevision: 5 }));
    reactHarness.begin();
    hook = renderHookValue(useSidebarThreadPlacement({ ...props, orderRevision: 5 }));
    await expect(hook.undo()).resolves.toBe(true);

    reactHarness.begin();
    hook = renderHookValue(useSidebarThreadPlacement({ ...props, orderRevision: 6 }));
    await expect(
      hook.place({
        threadId: ThreadId.makeUnsafe("source"),
        destination: "custom",
        sectionId: "section-test",
        sectionCreatedAt: NOW,
        beforeThreadId: ThreadId.makeUnsafe("anchor"),
      }),
    ).resolves.toBe(true);
    expect(dispatchPlacement).toHaveBeenCalledTimes(3);
  });
});
