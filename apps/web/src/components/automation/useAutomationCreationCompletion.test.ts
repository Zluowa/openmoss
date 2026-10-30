import { AutomationId, type AutomationDefinition } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("../../test/reactHookHarness")).reactHookHarnessMock);

import { reactHookHarness } from "../../test/reactHookHarness";
import { useAutomationCreationCompletion } from "./useAutomationCreationCompletion";

const definition = {
  id: AutomationId.makeUnsafe("saved-page-schedule"),
  name: "Update this page",
  enabled: false,
} as AutomationDefinition;

describe("contextual automation completion", () => {
  const onComplete = vi.fn();
  const render = () => {
    reactHookHarness.beginRender();
    return useAutomationCreationCompletion(onComplete);
  };

  beforeEach(() => {
    reactHookHarness.reset();
    onComplete.mockReset();
  });
  afterEach(() => reactHookHarness.unmount());

  it("retries attachment with the saved paused ID after a failure", async () => {
    const attach = vi
      .fn<(value: AutomationDefinition) => Promise<void>>()
      .mockRejectedValueOnce(new Error("The page changed. Reload its revision and retry."))
      .mockResolvedValueOnce(undefined);

    await render().complete(definition, attach);
    let completion = render();
    expect(completion.saved).toBe(definition);
    expect(completion.saved?.enabled).toBe(false);
    expect(completion.error).toContain("The page changed");
    expect(onComplete).not.toHaveBeenCalled();

    await completion.retry();
    completion = render();
    expect(attach.mock.calls.map(([saved]) => saved.id)).toEqual([definition.id, definition.id]);
    expect(completion.saved).toBeNull();
    expect(completion.error).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("waits for attachment and ignores repeated submits while it is pending", async () => {
    let release!: () => void;
    const attach = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = render().complete(definition, attach);
    expect(render().finishing).toBe(true);
    await render().retry();
    await render().complete({ ...definition, id: AutomationId.makeUnsafe("another-id") }, vi.fn());
    expect(attach).toHaveBeenCalledTimes(1);
    expect(render().saved?.id).toBe(definition.id);
    expect(onComplete).not.toHaveBeenCalled();

    release();
    await first;
    expect(render().finishing).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("keeps the original page attachment callback when a saved setup is retried", async () => {
    const originalPage = vi.fn().mockRejectedValueOnce(new Error("Connection lost"));
    await render().complete(definition, originalPage);
    originalPage.mockResolvedValueOnce(undefined);
    const anotherPage = vi.fn();
    await render().complete(definition, anotherPage);
    expect(originalPage).toHaveBeenCalledTimes(2);
    expect(anotherPage).not.toHaveBeenCalled();
  });

  it("does not close a later surface after the original dialog unmounts", async () => {
    let release!: () => void;
    const completion = render().complete(
      definition,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    reactHookHarness.unmount();
    release();
    await completion;
    expect(onComplete).not.toHaveBeenCalled();
  });
});
