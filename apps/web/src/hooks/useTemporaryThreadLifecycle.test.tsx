import { SidebarSectionId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: HookSlot[] = [];
  let cursor = 0;
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const nextSlot = () => (slots[cursor++] ??= {});
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
    useRef<T>(value: T) {
      const slot = nextSlot();
      if (!("value" in slot)) slot.value = { current: value };
      return slot.value as { current: T };
    },
  };
});

const harness = vi.hoisted(() => {
  const composerState = {
    draftThreadsByThreadId: {} as Record<string, { isTemporary?: boolean }>,
    clearDraftThread: vi.fn(),
  };
  const useComposerDraftStore = Object.assign(
    (selector: (state: typeof composerState) => unknown) => selector(composerState),
    { getState: () => composerState },
  );
  const temporaryState = {
    temporaryThreadIds: {} as Record<string, boolean>,
    clearTemporaryThread: vi.fn(),
  };
  const useTemporaryThreadStore = (selector: (state: typeof temporaryState) => unknown) =>
    selector(temporaryState);
  const terminalState = { clearTerminalState: vi.fn() };
  const useTerminalStateStore = (selector: (state: typeof terminalState) => unknown) =>
    selector(terminalState);
  const splitState = { removeThreadFromSplitViews: vi.fn() };
  const useSplitViewStore = (selector: (state: typeof splitState) => unknown) =>
    selector(splitState);
  const useStore = Object.assign(() => undefined, {
    getState: () => ({ sidebarOrderRevision: 0 }),
  });
  return {
    composerState,
    splitState,
    terminalState,
    temporaryState,
    useComposerDraftStore,
    useSplitViewStore,
    useStore,
    useTemporaryThreadStore,
    useTerminalStateStore,
  };
});

vi.mock("react", () => ({
  useEffect: reactHarness.useEffect,
  useRef: reactHarness.useRef,
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: harness.useComposerDraftStore,
}));
vi.mock("../nativeApi", () => ({ readNativeApi: () => undefined }));
vi.mock("../splitViewStore", () => ({ useSplitViewStore: harness.useSplitViewStore }));
vi.mock("../store", () => ({ useStore: harness.useStore }));
vi.mock("../temporaryThreadStore", () => ({
  useTemporaryThreadStore: harness.useTemporaryThreadStore,
}));
vi.mock("../terminalStateStore", () => ({
  useTerminalStateStore: harness.useTerminalStateStore,
}));

import {
  clearPendingSidebarPlacement,
  getPendingSidebarPlacement,
  setPendingSidebarPlacement,
} from "../pendingSidebarPlacement";
import { useTemporaryThreadLifecycle } from "./useTemporaryThreadLifecycle";

const TEMPORARY_THREAD_ID = ThreadId.makeUnsafe("temporary-thread-disposal");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("other-thread-retained");
const NEXT_THREAD_ID = ThreadId.makeUnsafe("next-thread");
const SECTION_ID = SidebarSectionId.makeUnsafe("section-temporary-disposal");
const SECTION_CREATED_AT = "2026-08-31T00:00:00.000Z";

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
}

describe("useTemporaryThreadLifecycle pending placement cleanup", () => {
  beforeEach(() => {
    reactHarness.reset();
    installLocalStorage();
    harness.composerState.draftThreadsByThreadId = {
      [TEMPORARY_THREAD_ID]: { isTemporary: true },
      [OTHER_THREAD_ID]: { isTemporary: true },
    };
    harness.temporaryState.temporaryThreadIds = {
      [TEMPORARY_THREAD_ID]: true,
      [OTHER_THREAD_ID]: true,
    };
    for (const mock of [
      harness.composerState.clearDraftThread,
      harness.terminalState.clearTerminalState,
      harness.splitState.removeThreadFromSplitViews,
      harness.temporaryState.clearTemporaryThread,
    ]) {
      mock.mockReset();
    }
  });

  afterEach(() => {
    clearPendingSidebarPlacement(TEMPORARY_THREAD_ID);
    clearPendingSidebarPlacement(OTHER_THREAD_ID);
    vi.unstubAllGlobals();
  });

  it("clears only the disposed temporary thread placement at the real route cleanup call site", async () => {
    setPendingSidebarPlacement({
      threadId: TEMPORARY_THREAD_ID,
      sectionId: SECTION_ID,
      sectionCreatedAt: SECTION_CREATED_AT,
    });
    setPendingSidebarPlacement({
      threadId: OTHER_THREAD_ID,
      sectionId: SECTION_ID,
      sectionCreatedAt: SECTION_CREATED_AT,
    });

    reactHarness.beginRender();
    useTemporaryThreadLifecycle(TEMPORARY_THREAD_ID);
    reactHarness.beginRender();
    useTemporaryThreadLifecycle(NEXT_THREAD_ID);
    await Promise.resolve();

    expect(getPendingSidebarPlacement(TEMPORARY_THREAD_ID)).toBeNull();
    expect(getPendingSidebarPlacement(OTHER_THREAD_ID)).toEqual({
      threadId: OTHER_THREAD_ID,
      sectionId: SECTION_ID,
      sectionCreatedAt: SECTION_CREATED_AT,
    });
    expect(harness.composerState.clearDraftThread).toHaveBeenCalledTimes(1);
    expect(harness.composerState.clearDraftThread).toHaveBeenCalledWith(TEMPORARY_THREAD_ID);
    expect(harness.terminalState.clearTerminalState).toHaveBeenCalledWith(TEMPORARY_THREAD_ID);
    expect(harness.splitState.removeThreadFromSplitViews).toHaveBeenCalledWith(TEMPORARY_THREAD_ID);
    expect(harness.temporaryState.clearTemporaryThread).toHaveBeenCalledWith(TEMPORARY_THREAD_ID);
  });
});
