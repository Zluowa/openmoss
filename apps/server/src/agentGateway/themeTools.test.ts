import {
  DEFAULT_SERVER_SETTINGS,
  THEME_CSS_MAX_LENGTH,
  type RuntimeMode,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@moss/contracts";
import { applyServerSettingsPatch } from "@moss/shared/serverSettings";
import { MOSS_THEME_GUIDE } from "@moss/shared/themeCss";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry.ts";
import { filterToolsByCapability, GatewayToolError, type ToolContext } from "./toolRuntime.ts";
import {
  MOSS_THEME_READ_DESCRIPTION,
  MOSS_THEME_SET_DESCRIPTION,
  makeAgentGatewayThemeTools,
} from "./themeTools.ts";

function harness(options?: { runtimeMode?: RuntimeMode; turnActive?: () => boolean }) {
  let current: ServerSettings = DEFAULT_SERVER_SETTINGS;
  const patches: ServerSettingsPatch[] = [];
  const tools = makeAgentGatewayThemeTools({
    settings: {
      getSettings: Effect.sync(() => current),
      updateSettings: (patch) =>
        Effect.sync(() => {
          patches.push(patch);
          current = applyServerSettingsPatch(current, patch);
          return current;
        }),
    },
    requireThreadShell: () =>
      Effect.succeed({ runtimeMode: options?.runtimeMode ?? "full-access" }),
  });
  const context = {
    callerThreadId: "thread-1",
    assertCallerTurnActive: () =>
      options?.turnActive === undefined || options.turnActive()
        ? Effect.void
        : Effect.fail(new GatewayToolError("turn_inactive", "The calling turn has ended.")),
  } as unknown as ToolContext;
  const byName = (name: string) => tools.find((tool) => tool.definition.name === name)!;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await Effect.runPromise(byName(name).handler(args, context));
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
  return { tools, byName, call, patches, settings: () => current };
}

describe("moss_theme_read / moss_theme_set", () => {
  it("are offered as a read tool and a write tool that needs a live turn", () => {
    const { byName, tools } = harness();
    expect(byName("moss_theme_read").requiredCapability).toBe("thread:read");
    expect(byName("moss_theme_read").definition.annotations?.readOnlyHint).toBe(true);
    expect(byName("moss_theme_set").requiredCapability).toBe("thread:write");
    expect(byName("moss_theme_set").requiresActiveTurn).toBe(true);
    // A read-only caller sees only the guide.
    expect(
      filterToolsByCapability(tools, new Set<AgentGatewayCapability>(["thread:read"])).map(
        (tool) => tool.definition.name,
      ),
    ).toEqual(["moss_theme_read"]);
  });

  it("describe themselves without naming another product", () => {
    for (const text of [
      MOSS_THEME_READ_DESCRIPTION,
      MOSS_THEME_SET_DESCRIPTION,
      MOSS_THEME_GUIDE,
    ]) {
      expect(text).not.toMatch(/T3|Synara/);
    }
    expect(MOSS_THEME_SET_DESCRIPTION).toContain("not remote desktops");
  });

  it("read returns the guide, the presets and the theme an agent last set", async () => {
    const { call } = harness();
    const result = (await call("moss_theme_read", {})).json();
    expect(result.guide).toBe(MOSS_THEME_GUIDE);
    expect(result.presets).toContainEqual({ id: "moss", variants: ["light", "dark"] });
    expect(result.lastSetByAgent).toBeUndefined();
  });

  it("publishes a theme every client applies once, with shared CSS in both packs", async () => {
    const { call, settings, patches } = harness();
    const result = await call("moss_theme_set", {
      name: "Ink",
      appearance: "light",
      css: "[data-chat-header] { font-family: monospace; }",
      light: { preset: "notion", accent: "#111111" },
      dark: { css: "[data-chat-header] { letter-spacing: 0.02em; }" },
    });
    expect(result.isError).toBe(false);
    expect(result.json()).toMatchObject({ applied: true, packs: ["light", "dark"] });
    const theme = settings().agentTheme!;
    expect(theme.name).toBe("Ink");
    expect(theme.appearance).toBe("light");
    expect(theme.light).toEqual({
      preset: "notion",
      accent: "#111111",
      css: "[data-chat-header] { font-family: monospace; }",
    });
    // A pack's own CSS wins over the shared CSS.
    expect(theme.dark?.css).toContain("letter-spacing");
    expect(theme.revision.length).toBeGreaterThan(0);

    // A second theme replaces the first; nothing merges into it.
    await call("moss_theme_set", { appearance: "dark" });
    expect(settings().agentTheme?.light).toBeUndefined();
    expect(settings().agentTheme?.revision).not.toBe(theme.revision);
    expect(patches).toHaveLength(2);
  });

  it("switches appearance alone, and undoes a theme with reset alone", async () => {
    const { call, settings } = harness();
    expect((await call("moss_theme_set", { appearance: "system" })).isError).toBe(false);
    expect((await call("moss_theme_set", { reset: true })).isError).toBe(false);
    expect(settings().agentTheme).toMatchObject({ reset: true });
    expect(settings().agentTheme?.light).toBeUndefined();
  });

  it.each([
    [{}, "Give `light`"],
    [{ colour: "#fff" }, "Unknown field"],
    [{ light: { accent: "blue" } }, "light"],
    [{ dark: { contrast: 101 } }, "dark"],
    [{ light: { preset: "nord" } }, 'light.preset "nord" has no light pack'],
    [{ light: { preset: "constructor" } }, "has no light pack"],
    [{ appearance: "sepia" }, "appearance"],
    [{ dark: { background: "#000000" } }, "dark: unknown field background"],
    [{ dark: "#000000" }, "dark: expected an object"],
    [{ css: "body { background: url(https://example.com/a.png) }" }, "loads files"],
    [{ css: '@import "https://example.com/a.css";' }, "loads files"],
    [{ dark: { css: "x".repeat(THEME_CSS_MAX_LENGTH + 1) } }, "dark"],
  ])("refuses %j", async (args, message) => {
    const { call, patches } = harness();
    const result = await call("moss_theme_set", args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(patches).toEqual([]);
  });

  it("allows a data: image and a url() inside one", async () => {
    const { call } = harness();
    const svg =
      "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3Crect fill=%22url(%23g)%22/%3E%3C/svg%3E";
    const result = await call("moss_theme_set", {
      css: `[data-messages-timeline-root] { background-image: url("${svg}"); }`,
    });
    expect(result.isError).toBe(false);
  });

  it.each(["approval-required", "auto"] as const)(
    "refuses a %s caller, like other app-wide changes",
    async (runtimeMode) => {
      const { call, patches } = harness({ runtimeMode });
      const result = await call("moss_theme_set", { appearance: "dark" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("full-access thread");
      expect(patches).toEqual([]);
    },
  );

  it("writes nothing once the calling turn has ended", async () => {
    let active = true;
    const { call, patches } = harness({ turnActive: () => active });
    active = false;
    const result = await call("moss_theme_set", { appearance: "dark" });
    expect(result.isError).toBe(true);
    expect(patches).toEqual([]);
  });

  it("reports how many bytes the two definitions add to the agent context", () => {
    const { tools } = harness();
    const bytes = Buffer.byteLength(JSON.stringify(tools.map((tool) => tool.definition)), "utf8");
    // Measured when the tools were added; a large jump should be a deliberate change.
    expect(bytes).toBeLessThan(1_600);
  });
});
