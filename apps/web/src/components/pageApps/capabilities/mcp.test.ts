import {
  PageAppCapabilityError,
  type PageAppShellContext,
} from "@moss/shared/pageAppCapabilityPlugin";
import { describe, expect, it, vi } from "vitest";

import { mcpShellPlugin } from "./mcp";

const serverInfo = (state: string) => ({
  server: {
    server: "notes",
    label: "Notes",
    kind: "local",
    state,
    reason: null,
    tools: [{ name: "delete_note", title: "删除笔记" }],
  },
  tool: {
    name: "delete_note",
    title: "删除笔记",
    description: "Deletes",
    readOnly: false,
    destructive: true,
    available: true,
  },
});

function context(
  server: (method: string, args: any) => Promise<unknown>,
  answers: { confirm?: boolean; remember?: boolean } = {},
) {
  const confirm = vi.fn(async (_request: unknown) => answers.confirm ?? true);
  const confirmChoice = vi.fn(async (_request: unknown) => ({
    confirmed: answers.confirm ?? true,
    remember: answers.remember ?? false,
  }));
  const serverCall = vi.fn(server);
  const ctx = {
    appId: `app-${Math.random()}`,
    title: "Tracker",
    serverCall,
    confirm,
    confirmChoice,
    signal: new AbortController().signal,
  } as unknown as PageAppShellContext;
  return { ctx, serverCall, confirm, confirmChoice };
}

describe("mcp shell plugin", () => {
  it("asks for the server once, then confirms a destructive call and passes the answer", async () => {
    let granted = false;
    let approved: unknown = null;
    const { ctx, confirm, confirmChoice, serverCall } = context(
      async (method, args) => {
        if (method === "describe") return serverInfo(granted ? "granted" : "prompt");
        if (method === "grant") {
          granted = args.state === "granted";
          return { state: args.state };
        }
        if (method === "call") {
          if (!granted) throw new PageAppCapabilityError("consent_required", "ask");
          if (!args.approval) throw new PageAppCapabilityError("confirmation_required", "confirm");
          approved = args.approval;
          return { content: [], isError: false };
        }
        throw new Error(method);
      },
      { remember: true },
    );
    await mcpShellPlugin.call!(ctx, "call", {
      server: "notes",
      tool: "delete_note",
      args: {},
      approval: "remember",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirmChoice).toHaveBeenCalledTimes(1);
    expect(confirmChoice.mock.calls[0]![0]).toMatchObject({
      tone: "danger",
      rememberLabel: expect.any(String),
    });
    expect(approved).toBe("remember");
    // The page's own `approval` never reaches the first server call.
    expect(serverCall.mock.calls.find(([method]) => method === "call")![1]).not.toHaveProperty(
      "approval",
    );
  });

  it("reports declined and not_granted with their own codes", async () => {
    const declined = context(
      async (method) => {
        if (method === "describe") return serverInfo("granted");
        throw new PageAppCapabilityError("confirmation_required", "confirm");
      },
      { confirm: false },
    );
    await expect(
      mcpShellPlugin.call!(declined.ctx, "call", { server: "notes", tool: "delete_note" }),
    ).rejects.toMatchObject({
      code: "declined",
    });
    const refused = context(
      async (method) => {
        if (method === "describe") return serverInfo("prompt");
        if (method === "grant") return {};
        throw new PageAppCapabilityError("consent_required", "ask");
      },
      { confirm: false },
    );
    await expect(
      mcpShellPlugin.call!(refused.ctx, "call", { server: "notes", tool: "delete_note" }),
    ).rejects.toMatchObject({
      code: "not_granted",
    });
    expect(refused.serverCall).toHaveBeenCalledWith("grant", { server: "notes", state: "denied" });
  });

  it("is not served to shared (guest) views", () => {
    expect(mcpShellPlugin.modes).not.toContain("guest");
  });
});
