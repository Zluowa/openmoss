import { describe, expect, it, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import type { McpAppBinding, McpAppRpcRequest, McpAppRpcResponse } from "./contracts";
import {
  createMcpAppRequestHandlers,
  stripMcpAppReservedMeta,
  validateMcpAppCallToolResult,
  type McpAppRequestHandlerDeps,
} from "./requestHandlers";

const binding: McpAppBinding = {
  server: "probe",
  serverKey: "probe",
  serverLabel: "Probe",
  toolName: "probe_widget",
  resourceUri: "ui://probe/widget",
  source: "toolDefinition",
  isFirstParty: false,
  visibility: [],
};

function setup(
  overrides: Partial<McpAppRequestHandlerDeps> = {},
  rpcAnswers: McpAppRpcResponse[] = [],
) {
  const rpcCalls: McpAppRpcRequest[] = [];
  const rpc = vi.fn(async (input: McpAppRpcRequest) => {
    rpcCalls.push(input);
    return rpcAnswers.shift() ?? { result: { content: [] } };
  });
  const deps: McpAppRequestHandlerDeps = {
    threadId: "thread-1",
    callId: "call-1",
    binding,
    api: {
      rpc,
      modelContext: vi.fn(async () => null),
      resourceDownload: vi.fn(async () => [{ uri: "res://a", mimeType: "text/csv", text: "a,b" }]),
    },
    desktop: {
      openExternal: vi.fn(async () => ({ opened: true })),
      saveDownload: vi.fn(async () => ({ saved: true })),
    },
    askApproval: vi.fn(async () => true),
    askSignIn: vi.fn(async () => true),
    confirmLink: vi.fn(async () => ({ dontAskAgain: false })),
    isLinkTrusted: () => false,
    trustLink: vi.fn(),
    openInApp: vi.fn(),
    appOrigin: "http://localhost:5733",
    confirmDownload: vi.fn(async () => true),
    displayMode: () => "inline",
    paneAvailable: () => true,
    setDisplayMode: vi.fn(async (mode: "inline" | "fullscreen") => mode),
    message: {
      readComposer: () => "",
      writeComposer: vi.fn(),
      askReplace: vi.fn(async () => false),
      sendNow: null,
      notifySent: vi.fn(),
    },
    log: vi.fn(),
    ...overrides,
  };
  return { deps, rpcCalls, handlers: createMcpAppRequestHandlers(deps) };
}

describe("widget tools/call", () => {
  it("strips host-reserved meta and sends through the Moss server", async () => {
    const { handlers, rpcCalls } = setup({}, [
      { result: { content: [{ type: "text", text: "ok" }], _meta: { "moss/x": 1, a: 1 } } },
    ]);
    const result = await handlers.callTool({
      name: "probe_echo",
      arguments: { v: 1 },
      _meta: { "anthropic/a": 1, "moss/b": 2, progressToken: 3 },
    } as never);
    expect(rpcCalls[0]).toEqual({
      threadId: "thread-1",
      callId: "call-1",
      server: "probe",
      method: "tools/call",
      params: { name: "probe_echo", arguments: { v: 1 }, _meta: { progressToken: 3 } },
    });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }], _meta: { a: 1 } });
  });

  it("asks Moss's approval step and repeats the call with the token", async () => {
    const askApproval = vi.fn(async () => true);
    const { handlers, rpcCalls } = setup({ askApproval }, [
      { needsApproval: { token: "tok-1", toolName: "probe_write", serverLabel: "Probe" } },
      { result: { content: [{ type: "text", text: "written" }] } },
    ]);
    await expect(handlers.callTool({ name: "probe_write" })).resolves.toEqual({
      content: [{ type: "text", text: "written" }],
    });
    expect(askApproval).toHaveBeenCalledWith({
      token: "tok-1",
      toolName: "probe_write",
      serverLabel: "Probe",
    });
    expect(rpcCalls.map((call) => call.approvalToken)).toEqual([undefined, "tok-1"]);
  });

  it("returns a declined error result when the person says no", async () => {
    const { handlers, rpcCalls } = setup({ askApproval: async () => false }, [
      { needsApproval: { token: "tok-1", toolName: "probe_write", serverLabel: "Probe" } },
    ]);
    await expect(handlers.callTool({ name: "probe_write" })).resolves.toMatchObject({
      isError: true,
    });
    expect(rpcCalls).toHaveLength(1);
  });

  it("passes the server's refusal through with its JSON-RPC code", async () => {
    const message =
      'The host refused this app\'s call to the tool "probe_model_echo" and did not send it, because the tool\'s _meta.ui.visibility does not list "app".';
    const { handlers } = setup({}, [{ error: { code: -32600, message } }]);
    const failure = handlers.callTool({ name: "probe_model_echo" });
    await expect(failure).rejects.toBeInstanceOf(McpError);
    await expect(failure).rejects.toMatchObject({ code: -32600 });
  });

  it("shows the sign-in card on an auth failure, then retries once", async () => {
    const askSignIn = vi.fn(async () => true);
    const { handlers, rpcCalls } = setup({ askSignIn }, [
      { error: { code: -32001, message: "auth", data: { authRequired: true, connectorId: "c1" } } },
      { error: { code: -32001, message: "auth", data: { authRequired: true, connectorId: "c1" } } },
    ]);
    await expect(handlers.callTool({ name: "probe_echo" })).rejects.toMatchObject({ code: -32001 });
    expect(askSignIn).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toHaveLength(2);
  });

  it("refuses a result whose structuredContent is not an object", async () => {
    const { handlers } = setup({}, [{ result: { content: [], structuredContent: "text" } }]);
    await expect(handlers.callTool({ name: "probe_echo" })).rejects.toBeInstanceOf(McpError);
    expect(validateMcpAppCallToolResult({ content: [], structuredContent: { a: 1 } })).toEqual({
      content: [],
      structuredContent: { a: 1 },
    });
    expect(stripMcpAppReservedMeta({ "anthropic/a": 1, ok: 2 })).toEqual({ ok: 2 });
  });

  it("proxies resources and prompts to the same server", async () => {
    const { handlers, rpcCalls } = setup({}, [
      { result: { contents: [] } },
      { result: { prompts: [] } },
    ]);
    await handlers.readResource({ uri: "ui://probe/x" });
    await handlers.listPrompts({});
    expect(rpcCalls.map((call) => call.method)).toEqual(["resources/read", "prompts/list"]);
  });
});

describe("widget tools/call auth signal", () => {
  it("shows the sign-in card only for A's authRequired error", async () => {
    const askSignIn = vi.fn(async () => true);
    const { handlers } = setup({ askSignIn }, [{ error: { code: 401, message: "nope" } }]);
    await expect(handlers.callTool({ name: "probe_echo" })).rejects.toMatchObject({ code: 401 });
    expect(askSignIn).not.toHaveBeenCalled();
  });
});

describe("widget ui/open-link", () => {
  it("opens Moss routes in place without a dialog", async () => {
    const { handlers, deps } = setup();
    await expect(
      handlers.openLink({ url: "http://localhost:5733/plugins" }, false),
    ).resolves.toEqual({});
    expect(deps.openInApp).toHaveBeenCalledWith("/plugins");
    expect(deps.confirmLink).not.toHaveBeenCalled();
  });

  it("asks before leaving Moss and remembers don't-ask-again per host", async () => {
    const { handlers, deps } = setup({
      confirmLink: vi.fn(async () => ({ dontAskAgain: true })),
    });
    await expect(handlers.openLink({ url: "https://example.com/a" }, false)).resolves.toEqual({});
    expect(deps.trustLink).toHaveBeenCalledWith("example.com");
    expect(deps.desktop?.openExternal).toHaveBeenCalledWith("https://example.com/a");
  });

  it("skips the dialog for trusted hosts only after a real click", async () => {
    const trusted = setup({ isLinkTrusted: () => true });
    await trusted.handlers.openLink({ url: "https://example.com/a" }, true);
    expect(trusted.deps.confirmLink).not.toHaveBeenCalled();
    await trusted.handlers.openLink({ url: "https://example.com/a" }, false);
    expect(trusted.deps.confirmLink).toHaveBeenCalledTimes(1);
  });

  it("answers isError when cancelled, busy or for a blocked scheme", async () => {
    const { handlers, deps } = setup({ confirmLink: vi.fn(async () => null) });
    await expect(handlers.openLink({ url: "https://example.com" }, true)).resolves.toEqual({
      isError: true,
    });
    await expect(handlers.openLink({ url: "javascript:alert(1)" }, true)).resolves.toEqual({
      isError: true,
    });
    expect(deps.desktop?.openExternal).not.toHaveBeenCalled();
  });
});

describe("widget ui/download-file", () => {
  it("confirms, then saves embedded files and fetches resource links through the server", async () => {
    const { handlers, deps } = setup();
    await expect(
      handlers.downloadFile({
        contents: [
          {
            type: "resource",
            resource: { uri: "file:///r/report.txt", mimeType: "text/plain", text: "hi" },
          },
          {
            type: "resource_link",
            uri: "res://data/rows.csv",
            name: "rows.csv",
            mimeType: "text/csv",
          },
        ],
      }),
    ).resolves.toEqual({});
    expect(deps.confirmDownload).toHaveBeenCalledWith([
      expect.objectContaining({ fileName: "report.txt" }),
      expect.objectContaining({ fileName: "rows.csv" }),
    ]);
    expect(deps.api.resourceDownload).toHaveBeenCalledWith({
      threadId: "thread-1",
      callId: "call-1",
      server: "probe",
      uri: "res://data/rows.csv",
    });
    expect(deps.desktop?.saveDownload).toHaveBeenCalledWith({
      fileName: "report.txt",
      mimeType: "text/plain",
      text: "hi",
    });
    expect(deps.desktop?.saveDownload).toHaveBeenCalledTimes(2);
  });

  it("answers isError when the person cancels", async () => {
    const { handlers, deps } = setup({ confirmDownload: async () => false });
    await expect(
      handlers.downloadFile({
        contents: [{ type: "resource", resource: { uri: "file:///a.txt", text: "x" } }],
      }),
    ).resolves.toEqual({ isError: true });
    expect(deps.desktop?.saveDownload).not.toHaveBeenCalled();
  });
});

describe("widget ui/request-display-mode", () => {
  it("opens the side panel only with a fresh user gesture and a panel to open", async () => {
    const { handlers, deps } = setup();
    await expect(handlers.requestDisplayMode({ mode: "fullscreen" }, false)).resolves.toEqual({
      mode: "inline",
    });
    expect(deps.setDisplayMode).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledTimes(1);
    await expect(handlers.requestDisplayMode({ mode: "fullscreen" }, true)).resolves.toEqual({
      mode: "fullscreen",
    });
    const noPane = setup({ paneAvailable: () => false });
    await expect(noPane.handlers.requestDisplayMode({ mode: "fullscreen" }, true)).resolves.toEqual(
      {
        mode: "inline",
      },
    );
  });

  it("never grants pip", async () => {
    const { handlers, deps } = setup();
    await expect(handlers.requestDisplayMode({ mode: "pip" }, true)).resolves.toEqual({
      mode: "inline",
    });
    expect(deps.setDisplayMode).not.toHaveBeenCalled();
  });
});

describe("widget ui/update-model-context and logging", () => {
  it("stores the context by tool name and passes the server's limit text back", async () => {
    const modelContext = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        "ui/update-model-context content is ~17000 tokens; host limit is 16000 tokens.",
      );
    const { handlers } = setup({
      api: {
        rpc: vi.fn(),
        modelContext,
        resourceDownload: vi.fn(),
      },
    });
    await expect(
      handlers.updateModelContext({ content: [{ type: "text", text: "state" }] }),
    ).resolves.toEqual({});
    expect(modelContext).toHaveBeenCalledWith({
      threadId: "thread-1",
      callId: "call-1",
      toolName: "probe_widget",
      content: [{ type: "text", text: "state" }],
    });
    await expect(handlers.updateModelContext({ content: [] })).rejects.toThrow("16000 tokens");
  });

  it("logs widget messages with the server name", () => {
    const { handlers, deps } = setup();
    handlers.logging({ level: "warning", logger: "probe", data: { a: 1 } });
    expect(deps.log).toHaveBeenCalledWith("[Probe] probe", "warning", { a: 1 });
  });
});
