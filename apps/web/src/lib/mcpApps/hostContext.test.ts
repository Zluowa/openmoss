import { describe, expect, it, vi } from "vitest";
import { McpUiHostStylesSchema } from "@modelcontextprotocol/ext-apps/app-bridge";

import { DEFAULT_THEME_STATE, resolveThemePack } from "../../theme/theme.logic";
import {
  buildMcpAppHostContext,
  diffMcpAppHostContext,
  McpAppHostContextChannel,
} from "./hostContext";
import {
  buildMcpAppFontCss,
  buildMcpAppStyleVariables,
  MCP_APP_COLOR_VARIABLE_SOURCES,
  mcpAppStylesForThemePacks,
} from "./hostStyles";

const tool = { name: "probe_widget", inputSchema: { type: "object" as const } };

function context(overrides: Partial<Parameters<typeof buildMcpAppHostContext>[0]> = {}) {
  return buildMcpAppHostContext({
    theme: "light",
    locale: "zh-CN",
    styles: { variables: {} as never },
    displayMode: "inline",
    paneAvailable: true,
    width: 549.4,
    height: 0,
    callId: "call-1",
    tool,
    environment: { timeZone: "Asia/Shanghai", userAgent: "UA", touch: false, hover: true },
    ...overrides,
  });
}

describe("buildMcpAppHostContext", () => {
  it("builds every key in the documented order with Moss's values", () => {
    const value = context();
    expect(Object.keys(value)).toEqual([
      "theme",
      "locale",
      "timeZone",
      "userAgent",
      "platform",
      "deviceCapabilities",
      "availableDisplayModes",
      "styles",
      "displayMode",
      "safeAreaInsets",
      "containerDimensions",
      "toolInfo",
    ]);
    expect(value).toMatchObject({
      platform: "desktop",
      availableDisplayModes: ["inline", "fullscreen"],
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      containerDimensions: { width: 549, maxHeight: 5_000 },
      toolInfo: { id: "call-1", tool },
      deviceCapabilities: { touch: false, hover: true },
    });
  });

  it("offers only inline without a side panel and sends the pane size when docked", () => {
    expect(context({ paneAvailable: false }).availableDisplayModes).toEqual(["inline"]);
    expect(
      context({ displayMode: "fullscreen", width: 480, height: 900 }).containerDimensions,
    ).toEqual({ width: 480, height: 900 });
  });
});

describe("McpAppHostContextChannel", () => {
  it("sends nothing before initialized, then one diff against what initialize answered", () => {
    const send = vi.fn();
    const channel = new McpAppHostContextChannel(context(), send);
    channel.update({ theme: "dark" });
    expect(send).not.toHaveBeenCalled();
    // ui/initialize answers with the latest context (dark) ...
    expect(channel.snapshot().theme).toBe("dark");
    channel.markInitializeAnswered();
    // ... and a change between that answer and `initialized` is still delivered.
    channel.update({ displayMode: "fullscreen" });
    expect(send).not.toHaveBeenCalled();
    channel.markInitialized();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ displayMode: "fullscreen" });
  });

  it("sends only keys whose JSON changed", () => {
    const send = vi.fn();
    const channel = new McpAppHostContextChannel(context(), send);
    channel.markInitializeAnswered();
    channel.markInitialized();
    expect(send).not.toHaveBeenCalled();
    channel.update({ theme: "light", containerDimensions: { maxHeight: 5_000, width: 549 } });
    expect(send).not.toHaveBeenCalled();
    channel.update({ theme: "dark", locale: "zh-CN" });
    expect(send).toHaveBeenLastCalledWith({ theme: "dark" });
    expect(diffMcpAppHostContext({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual({});
  });
});

describe("hostContext.styles", () => {
  it("values every widget color variable as a light-dark pair from Moss tokens", () => {
    const styles = mcpAppStylesForThemePacks(
      resolveThemePack(DEFAULT_THEME_STATE, "light"),
      resolveThemePack(DEFAULT_THEME_STATE, "dark"),
    );
    const variables = styles.variables as Record<string, string>;
    const colorNames = Object.keys(MCP_APP_COLOR_VARIABLE_SOURCES);
    expect(colorNames).toHaveLength(37);
    for (const name of colorNames) {
      expect(variables[name], name).toMatch(/^light-dark\(rgba\([^)]*\), rgba\([^)]*\)\)$/u);
    }
    // 37 colors + fonts, weights, sizes, line heights, radii, border, shadows: every SDK key.
    expect(Object.keys(variables)).toHaveLength(76);
    expect(McpUiHostStylesSchema.safeParse(styles).success).toBe(true);
    expect(variables["--font-sans"]).toContain("Inter");
    expect(variables["--border-radius-md"]).toBe("8px");
    expect(styles.css?.fonts).toContain("@font-face");
  });

  it("reads the mapped Moss token for each side", () => {
    const variables = buildMcpAppStyleVariables(
      { "--color-text-foreground": "#141413", "--codex-base-ink": "#141413" },
      { "--color-text-foreground": "rgb(240, 239, 236)", "--codex-base-ink": "#f0efec" },
    );
    expect(variables["--color-text-primary"]).toBe(
      "light-dark(rgba(20, 20, 19, 1), rgba(240, 239, 236, 1))",
    );
    expect(variables["--color-border-secondary"]).toBe(
      "light-dark(rgba(20, 20, 19, 0.1), rgba(240, 239, 236, 0.1))",
    );
  });

  it("points the Inter face at the sandbox asset origin", () => {
    expect(buildMcpAppFontCss()).toBe(
      '@font-face { font-family: "Inter"; src: url("moss-mcp-sandbox://assets/fonts/inter-latin.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }',
    );
  });
});
