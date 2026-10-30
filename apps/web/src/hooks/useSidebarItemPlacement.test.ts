import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationSidebarOrderItem } from "@synara/contracts";

const reactHarness = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: Slot[] = [];
  let cursor = 0;
  const equal = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const next = () => (slots[cursor] ??= {}) as Slot;
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
  useSidebarItemPlacement,
  type SidebarItemPlacementDispatchResult,
} from "./useSidebarItemPlacement";
import type { SidebarItemPlacementRequest } from "../components/SidebarItemPlacementDnd";

const NOW = "2026-08-31T00:00:00.000Z";
const orderItems: OrchestrationSidebarOrderItem[] = [
  {
    key: "project:source" as OrchestrationSidebarOrderItem["key"],
    itemType: "project",
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
    destination: "default",
    sectionId: null,
    sectionCreatedAt: null,
    sortOrder: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function input(overrides: Partial<Parameters<typeof useSidebarItemPlacement>[0]> = {}) {
  return {
    orderItems,
    orderRevision: 4,
    migrationState: "ready" as const,
    dispatchPlacement: vi
      .fn<
        (
          request: SidebarItemPlacementRequest & { readonly expectedSidebarOrderRevision: number },
        ) => Promise<SidebarItemPlacementDispatchResult>
      >()
      .mockResolvedValue({ sequence: 5, sidebarOrderRevision: 5 }),
    rehydrate: vi.fn(),
    ...overrides,
  };
}

describe("useSidebarItemPlacement", () => {
  beforeEach(() => reactHarness.reset());

  it("promotes Undo when the authoritative push arrives before RPC continuation", async () => {
    let resolveDispatch!: (result: SidebarItemPlacementDispatchResult) => void;
    const props = input({
      dispatchPlacement: vi.fn(
        () =>
          new Promise<SidebarItemPlacementDispatchResult>((resolve) => {
            resolveDispatch = resolve;
          }),
      ),
    });
    reactHarness.begin();
    let hook = useSidebarItemPlacement(props);
    const placement = hook.place({
      itemKey: "project:source" as OrchestrationSidebarOrderItem["key"],
      itemType: "project",
      destination: "pinned",
      sectionId: null,
      sectionCreatedAt: null,
      beforeItemKey: null,
    });

    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    resolveDispatch({ sequence: 5, sidebarOrderRevision: 5 });
    await expect(placement).resolves.toBe(true);

    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    expect(hook.undoDescriptor).toMatchObject({
      itemKey: "project:source",
      destination: "default",
      beforeItemKey: "thread:anchor",
      resultingRevision: 5,
    });
    expect(props.dispatchPlacement).toHaveBeenCalledTimes(1);
  });

  it("retains the exact mixed successor in the inverse and dispatches it once", async () => {
    const props = input();
    reactHarness.begin();
    let hook = useSidebarItemPlacement(props);
    await hook.place({
      itemKey: "project:source" as OrchestrationSidebarOrderItem["key"],
      itemType: "project",
      destination: "pinned",
      sectionId: null,
      sectionCreatedAt: null,
      beforeItemKey: null,
    });
    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    expect(hook.undoDescriptor).toMatchObject({
      destination: "default",
      beforeItemKey: "thread:anchor",
    });
    await expect(hook.undo()).resolves.toBe(true);
    expect(props.dispatchPlacement).toHaveBeenLastCalledWith(
      expect.objectContaining({
        itemKey: "project:source",
        destination: "default",
        beforeItemKey: "thread:anchor",
        expectedSidebarOrderRevision: 5,
      }),
    );
    expect(props.dispatchPlacement).toHaveBeenCalledTimes(2);
  });

  it("rehydrates and exposes no success after a definite rejection", async () => {
    const rehydrate = vi.fn();
    const props = input({
      dispatchPlacement: vi.fn().mockRejectedValue(new Error("stale sidebar revision")),
      rehydrate,
    });
    reactHarness.begin();
    const hook = useSidebarItemPlacement(props);
    await expect(
      hook.place({
        itemKey: "project:source" as OrchestrationSidebarOrderItem["key"],
        itemType: "project",
        destination: "pinned",
        sectionId: null,
        sectionCreatedAt: null,
        beforeItemKey: null,
      }),
    ).resolves.toBe(false);
    expect(rehydrate).toHaveBeenCalledTimes(1);
  });

  it("rehydrates after an unknown outcome without showing a rejection", async () => {
    const rehydrate = vi.fn();
    const onRejected = vi.fn();
    const props = input({
      dispatchPlacement: vi.fn().mockRejectedValue(new Error("request timed out")),
      rehydrate,
      onRejected,
    });
    reactHarness.begin();
    let hook = useSidebarItemPlacement(props);
    await expect(
      hook.place({
        itemKey: "project:source" as OrchestrationSidebarOrderItem["key"],
        itemType: "project",
        destination: "pinned",
        sectionId: null,
        sectionCreatedAt: null,
        beforeItemKey: null,
      }),
    ).resolves.toBe(false);
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
    reactHarness.begin();
    hook = useSidebarItemPlacement(props);
    expect(hook.optimistic).toBe(false);
    expect(hook.displayItems).toBe(orderItems);
  });

  it("invalidates an inverse after a newer authoritative revision", async () => {
    const rehydrate = vi.fn();
    const props = input({ rehydrate });
    reactHarness.begin();
    let hook = useSidebarItemPlacement(props);
    await expect(
      hook.place({
        itemKey: "project:source" as OrchestrationSidebarOrderItem["key"],
        itemType: "project",
        destination: "pinned",
        sectionId: null,
        sectionCreatedAt: null,
        beforeItemKey: null,
      }),
    ).resolves.toBe(true);
    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    expect(hook.undoDescriptor).not.toBeNull();

    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 6 });
    await expect(hook.undo()).resolves.toBe(false);
    expect(props.dispatchPlacement).toHaveBeenCalledTimes(1);
    expect(rehydrate).toHaveBeenCalled();
  });

  it("releases the revision fence after Undo so a later placement can proceed", async () => {
    let resultingRevision = 5;
    const dispatchPlacement = vi.fn(async () => ({
      sequence: resultingRevision,
      sidebarOrderRevision: resultingRevision++,
    }));
    const props = input({ dispatchPlacement });
    reactHarness.begin();
    let hook = useSidebarItemPlacement(props);
    await expect(
      hook.place({
        itemKey: "project:source" as OrchestrationSidebarOrderItem["key"],
        itemType: "project",
        destination: "pinned",
        sectionId: null,
        sectionCreatedAt: null,
        beforeItemKey: null,
      }),
    ).resolves.toBe(true);

    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 5 });
    await expect(hook.undo()).resolves.toBe(true);

    reactHarness.begin();
    hook = useSidebarItemPlacement({ ...props, orderRevision: 6 });
    await expect(
      hook.place({
        itemKey: "project:source" as OrchestrationSidebarOrderItem["key"],
        itemType: "project",
        destination: "pinned",
        sectionId: null,
        sectionCreatedAt: null,
        beforeItemKey: null,
      }),
    ).resolves.toBe(true);
    expect(dispatchPlacement).toHaveBeenCalledTimes(3);
  });
});
