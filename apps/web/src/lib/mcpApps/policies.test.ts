import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveMcpAppBinding } from "./binding";
import { createMcpAppMessageRouter } from "./messageRouting";
import { classifyMcpAppLink } from "./openLink";
import {
  hashMcpAppKey,
  isMcpAppConnectorHidden,
  isMcpAppToolClosed,
  resetMcpAppPreferencesForTests,
  setMcpAppConnectorHidden,
  setMcpAppToolClosed,
} from "./preferences";
import {
  MCP_APP_WIDGET_HEIGHTS_STORAGE_KEY,
  readRememberedMcpAppHeight,
  rememberMcpAppHeight,
  resolveMcpAppReportedHeight,
} from "./sizing";
import type { WorkLogMcpToolResult } from "../toolCallDetails";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: memoryStorage(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  resetMcpAppPreferencesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("widget size rules", () => {
  it("ceils, clamps to 5 000 px and ignores empty reports only while restoring", () => {
    expect(resolveMcpAppReportedHeight(151.2, false)).toBe(152);
    expect(resolveMcpAppReportedHeight(12_000, false)).toBe(5_000);
    expect(resolveMcpAppReportedHeight(6, true)).toBeNull();
    expect(resolveMcpAppReportedHeight(6, false)).toBe(6);
    expect(resolveMcpAppReportedHeight(undefined, false)).toBeNull();
    expect(resolveMcpAppReportedHeight(Number.NaN, false)).toBeNull();
    // Moss's old 200–720 clamp is gone.
    expect(resolveMcpAppReportedHeight(120, false)).toBe(120);
    expect(resolveMcpAppReportedHeight(900, false)).toBe(900);
  });

  it("remembers heights per widget in mcp-app-widget-heights and skips empty ones", () => {
    rememberMcpAppHeight("t:c1", 218.4);
    rememberMcpAppHeight("t:c2", 4);
    expect(readRememberedMcpAppHeight("t:c1")).toBe(219);
    expect(readRememberedMcpAppHeight("t:c2")).toBeNull();
    expect(window.localStorage.getItem(MCP_APP_WIDGET_HEIGHTS_STORAGE_KEY)).toBe('{"t:c1":219}');
  });
});

describe("per-device preferences", () => {
  it("hides a connector by its hash and keeps the last 100", () => {
    setMcpAppConnectorHidden("connector-a", true);
    expect(isMcpAppConnectorHidden("connector-a")).toBe(true);
    expect(window.localStorage.getItem("moss:mcp-app-preferences")).not.toContain("connector-a");
    expect(window.localStorage.getItem("moss:mcp-app-preferences")).toContain(
      hashMcpAppKey("connector-a"),
    );
    for (let index = 0; index < 100; index += 1) setMcpAppConnectorHidden(`c-${index}`, true);
    expect(isMcpAppConnectorHidden("connector-a")).toBe(false);
    expect(isMcpAppConnectorHidden("c-99")).toBe(true);
    setMcpAppConnectorHidden("c-99", false);
    expect(isMcpAppConnectorHidden("c-99")).toBe(false);
  });

  it("remembers tools whose widgets stay closed", () => {
    setMcpAppToolClosed("probe_widget", true);
    expect(isMcpAppToolClosed("probe_widget")).toBe(true);
    setMcpAppToolClosed("probe_widget", false);
    expect(isMcpAppToolClosed("probe_widget")).toBe(false);
  });
});

describe("classifyMcpAppLink", () => {
  const origin = "http://localhost:5733";

  it("opens Moss routes in place and refuses other schemes", () => {
    expect(classifyMcpAppLink("http://localhost:5733/plugins?x=1#y", origin)).toEqual({
      action: "in_app",
      path: "/plugins?x=1#y",
    });
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///c:/x",
      "ms-settings:",
      3,
    ]) {
      expect(classifyMcpAppLink(url, origin)).toEqual({ action: "refuse" });
    }
  });

  it("asks for web links and flags look-alike and credential links", () => {
    expect(classifyMcpAppLink("https://Example.com/a", origin)).toMatchObject({
      action: "confirm",
      kind: "web",
      trustKey: "example.com",
      punycode: false,
      credentials: false,
    });
    expect(classifyMcpAppLink("https://xn--80ak6aa92e.com/", origin)).toMatchObject({
      punycode: true,
    });
    expect(classifyMcpAppLink("https://user:pw@example.com/", origin)).toMatchObject({
      credentials: true,
    });
  });

  it("parses mail, text and call targets", () => {
    expect(
      classifyMcpAppLink("mailto:a@b.cn?cc=c@d.cn&subject=Hi%20there&body=Line", origin),
    ).toMatchObject({
      kind: "mail",
      trustKey: "mailto:",
      details: { to: "a@b.cn", cc: "c@d.cn", subject: "Hi there", body: "Line" },
    });
    expect(classifyMcpAppLink("sms:+8613800000000?body=ok", origin)).toMatchObject({
      kind: "text",
      details: { to: "+8613800000000", body: "ok" },
    });
    expect(classifyMcpAppLink("tel:+8613800000000", origin)).toMatchObject({ kind: "call" });
  });
});

describe("ui/message routing", () => {
  function router(overrides: Partial<Parameters<typeof createMcpAppMessageRouter>[0]> = {}) {
    let composer = "";
    let now = 0;
    const deps = {
      isFirstParty: false,
      serverLabel: "Probe",
      readComposer: () => composer,
      writeComposer: vi.fn((text: string) => {
        composer = text;
      }),
      askReplace: vi.fn(async () => true),
      sendNow: vi.fn(async () => true),
      notifySent: vi.fn(),
      now: () => now,
      ...overrides,
    };
    return {
      deps,
      route: createMcpAppMessageRouter(deps),
      setComposer: (value: string) => {
        composer = value;
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  const message = (text: string) => ({
    role: "user" as const,
    content: [
      { type: "text" as const, text },
      { type: "text" as const, text: "second" },
    ],
  });

  it("fills an empty composer without sending, joining text blocks with a newline", async () => {
    const { deps, route } = router();
    await expect(route(message("first"), true)).resolves.toEqual({});
    expect(deps.writeComposer).toHaveBeenCalledWith("first\nsecond");
    expect(deps.sendNow).not.toHaveBeenCalled();
  });

  it("asks before replacing a draft and reports a timeout as an error", async () => {
    const askReplace = vi.fn(async () => false);
    const { deps, route, setComposer } = router({ askReplace });
    setComposer("my draft");
    await expect(route(message("x"), false)).resolves.toEqual({ isError: true });
    expect(askReplace).toHaveBeenCalledWith("Probe", 6_500);
    expect(deps.writeComposer).not.toHaveBeenCalled();
  });

  it("ignores the same text inside 5.25 s", async () => {
    const { deps, route, advance } = router();
    await route(message("x"), false);
    advance(5_000);
    await expect(route(message("x"), false)).resolves.toEqual({});
    expect(deps.writeComposer).toHaveBeenCalledTimes(1);
    advance(300);
    await route(message("x"), false);
    expect(deps.askReplace).toHaveBeenCalledTimes(1);
  });

  it("sends on its own only for Moss's first-party tools after a real click", async () => {
    const firstParty = router({ isFirstParty: true });
    await firstParty.route(message("a"), false);
    expect(firstParty.deps.sendNow).not.toHaveBeenCalled();
    await firstParty.route(message("b"), true);
    expect(firstParty.deps.sendNow).toHaveBeenCalledWith("b\nsecond");
    expect(firstParty.deps.notifySent).toHaveBeenCalledWith("Probe");

    const thirdParty = router({ isFirstParty: false });
    await thirdParty.route(message("c"), true);
    expect(thirdParty.deps.sendNow).not.toHaveBeenCalled();
  });
});

describe("resolveMcpAppBinding", () => {
  const base = {
    kind: "codex.mcp_tool_call",
    version: 1,
    callId: "call-1",
    server: "codex_apps",
    tool: "probe_widget",
    status: "completed",
    arguments: {},
    truncation: { truncated: false, deferredBinary: false },
  };

  it("maps the Codex-only descriptor onto the provider-neutral binding", () => {
    const binding = resolveMcpAppBinding({
      ...base,
      app: {
        resourceUri: "ui://probe/widget",
        source: "appContext",
        connectorId: "conn-1",
        appName: "Probe",
        actionName: "Probe widget",
      },
      // A journal row written before the binding fields existed: deliberately partial.
    } as unknown as WorkLogMcpToolResult);
    expect(binding).toEqual({
      server: "codex_apps",
      serverKey: "conn-1",
      serverLabel: "Probe",
      toolName: "probe_widget",
      toolTitle: "Probe widget",
      resourceUri: "ui://probe/widget",
      source: "appContext",
      connectorId: "conn-1",
      isFirstParty: false,
      visibility: [],
    });
  });

  it("reads A's binding fields when present", () => {
    const binding = resolveMcpAppBinding({
      ...base,
      server: "moss",
      app: {
        resourceUri: "ui://moss/map",
        source: "toolDefinition",
        server: "moss",
        serverKey: "moss",
        serverLabel: "Moss",
        toolName: "map_show",
        isFirstParty: true,
        visibility: ["model", "app", "bogus"],
      },
    } as unknown as WorkLogMcpToolResult);
    expect(binding).toMatchObject({
      source: "toolDefinition",
      isFirstParty: true,
      toolName: "map_show",
      visibility: ["model", "app"],
    });
    expect(resolveMcpAppBinding({ ...base } as WorkLogMcpToolResult)).toBeNull();
  });
});
