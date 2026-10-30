import { ProjectId, WsRpcError, type AutomationCreateInput } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationCreateIntent, isAutomationCreateRejected } from "./automationCreateIntent";

const input: AutomationCreateInput = {
  requestId: "original-request",
  projectId: ProjectId.makeUnsafe("project-a"),
  name: "Update page",
  prompt: "Update the existing page",
  enabled: false,
  schedule: { type: "manual" },
  modelSelection: { provider: "codex", model: "gpt-5-codex", instanceId: "codex-personal" },
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("durable automation creation intents", () => {
  it("reconstructs the same paused request after an unknown response and close/reopen", async () => {
    const first = new AutomationCreateIntent("owner-a:page-a");
    const create = vi.fn().mockRejectedValue(new Error("Response lost"));
    await expect(first.submit(input, create)).rejects.toThrow("Response lost");
    const reopened = new AutomationCreateIntent("owner-a:page-a");
    const retry = vi.fn().mockResolvedValue("real-definition");
    await reopened.submit({ ...input, requestId: "must-not-replace" }, retry);
    expect(retry.mock.calls[0]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    expect(reopened.pending?.requestId).toBe("original-request");
    expect(reopened.pending?.enabled).toBe(false);
    expect(new AutomationCreateIntent("owner-b:page-a").pending).toBeNull();
  });

  it("does not replace an unresolved creation with changed settings", () => {
    const journal = new AutomationCreateIntent("creation");
    const original = journal.remember(input);
    expect(() => journal.remember({ ...input, name: "Another task", requestId: "new-id" })).toThrow(
      "previous creation",
    );
    expect(new AutomationCreateIntent("creation").pending).toEqual(original);
  });

  it("retains exact instance selection without persisting provider launch credentials", async () => {
    const journal = new AutomationCreateIntent("creation");
    const create = vi.fn().mockResolvedValue("definition");
    await journal.submit(
      {
        ...input,
        providerOptions: { codex: { environment: { SECRET_FOR_TEST: "never-store-this" } } },
      },
      create,
    );
    expect(create.mock.calls[0]?.[0].modelSelection.instanceId).toBe("codex-personal");
    expect(create.mock.calls[0]?.[0].providerOptions).toBeUndefined();
    expect(localStorage.getItem("creation")).not.toContain("never-store-this");
  });

  it("refuses a create when reconciliation identity cannot be stored", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const journal = new AutomationCreateIntent("creation");
    const create = vi.fn();
    await expect(journal.submit(input, create)).rejects.toThrow("Storage unavailable");
    expect(create).not.toHaveBeenCalled();
    expect(journal.pending).toBeNull();
  });

  it("does not let a late acknowledgement erase a newer request", () => {
    const old = new AutomationCreateIntent("creation");
    old.remember(input);
    const current = new AutomationCreateIntent("creation");
    current.clear();
    const next = current.remember({ ...input, requestId: "next-request", name: "Next task" });
    old.clear();
    expect(new AutomationCreateIntent("creation").pending).toEqual(next);
  });

  it("requires a committed server rejection code before returning to an editable draft", () => {
    expect(
      isAutomationCreateRejected(
        new WsRpcError({
          message: "Choose a provider",
          code: "AUTOMATION_CREATE_REJECTED",
          retryable: false,
        }),
      ),
    ).toBe(true);
    expect(
      isAutomationCreateRejected({
        cause: new WsRpcError({ message: "Rejected", code: "AUTOMATION_CREATE_REJECTED" }),
      }),
    ).toBe(true);
    expect(isAutomationCreateRejected(new Error("AUTOMATION_CREATE_REJECTED"))).toBe(false);
    expect(isAutomationCreateRejected(new WsRpcError({ message: "Storage failed" }))).toBe(false);
  });

  it("keeps a corrupt saved intent blocked instead of overwriting its identity", () => {
    localStorage.setItem("creation", "broken");
    const journal = new AutomationCreateIntent("creation");
    expect(journal.error).not.toBeNull();
    expect(() => journal.remember(input)).toThrow("cannot be read");
    expect(localStorage.getItem("creation")).toBe("broken");
  });
});
