import {
  DEFAULT_SERVER_SETTINGS,
  THEME_CSS_MAX_LENGTH,
  type RuntimeMode,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@moss/contracts";
import { applyServerSettingsPatch } from "@moss/shared/serverSettings";
import { MOSS_THEME_GUIDE } from "@moss/shared/themeCss";
import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry.ts";
import { filterToolsByCapability, GatewayToolError, type ToolContext } from "./toolRuntime.ts";
import {
  MOSS_THEME_READ_DESCRIPTION,
  MOSS_THEME_SET_DESCRIPTION,
  makeAgentGatewayThemeTools,
} from "./themeTools.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await FS.mkdtemp(path.join(os.tmpdir(), "moss-theme-tool-"));
  tempDirs.push(dir);
  return dir;
}

/** A PNG header with an IHDR chunk: enough for the type and size check. */
function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function harness(options?: {
  runtimeMode?: RuntimeMode;
  turnActive?: () => boolean;
  themeImagesDir?: string;
}) {
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
    themeImagesDir: options?.themeImagesDir ?? path.join(os.tmpdir(), "moss-theme-tool-unused"),
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
    expect(result.json()).toMatchObject({ saved: true, packs: ["light", "dark"] });
    // Saving is not seeing: the agent is told to ask, and nothing reads as "it shows".
    expect(result.json()).not.toHaveProperty("applied");
    expect(result.json().note).toContain("does not mean every rule shows");
    expect(result.json()).not.toHaveProperty("unstableSelectors");
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

  // Evaluation case from 2026-11-17: "put a picture behind the chat". The rule goes on the
  // chat-background hook; a selector outside the stable list is named back to the agent.
  it("puts a picture behind the chat, and names selectors outside the stable list", async () => {
    const { call, settings } = harness();
    const picture = "data:image/png;base64,iVBORw0KGgo=";
    const css = [
      `[data-workspace-area="conversation"] { background: url(${picture}) right bottom / auto 80% no-repeat !important; }`,
      ".dark [data-messages-timeline-root]:not(:empty) { opacity: 1; }",
      ".flex-1 > div, [data-state=open] { color: red; }",
      '[data-slot="toast-title"] { color: red; }',
    ].join("\n");
    const result = await call("moss_theme_set", { css });
    expect(result.isError).toBe(false);
    expect(settings().agentTheme?.light?.css).toBe(css);
    expect(result.json().unstableSelectors).toEqual([
      ".flex-1 > div",
      "[data-state=open]",
      '[data-slot="toast-title"]',
    ]);
    expect(result.json().note).toContain("unstableSelectors");
    expect(MOSS_THEME_GUIDE).toContain(
      'A picture or color behind the chat goes on [data-workspace-area="conversation"]',
    );
  });

  // Evaluation case from 2026-11-17: the agent made a 1024x1536 picture and had to shrink it
  // to fit 50,000 characters of CSS. A file is stored at full quality instead.
  it("puts a picture file behind the chat at full quality", async () => {
    const store = await tempDir();
    const sources = await tempDir();
    const picture = pngBytes(1024, 1536, 2_000_000);
    const file = path.join(sources, "moss-anime-girl-transparent.png");
    await FS.writeFile(file, picture);
    const { call, settings } = harness({ themeImagesDir: store });
    const css =
      '[data-workspace-area="conversation"] { background: url(moss-theme-image:girl) right bottom / auto 88vh no-repeat !important; }';
    const result = await call("moss_theme_set", { css, images: { girl: file } });
    expect(result.isError).toBe(false);
    const id = `${createHash("sha256").update(picture).digest("hex")}.png`;
    expect(result.json().images).toEqual({
      girl: {
        reference: `moss-theme-image:${id}`,
        width: 1024,
        height: 1536,
        bytes: picture.length,
      },
    });
    const stored = settings().agentTheme!;
    expect(stored.light?.css).toBe(css.replace("moss-theme-image:girl", `moss-theme-image:${id}`));
    expect(stored.dark?.css).toBe(stored.light?.css);
    // The settings carry the reference, never the picture.
    expect(JSON.stringify(stored).length).toBeLessThan(1_000);
    expect(new Uint8Array(await FS.readFile(path.join(store, id)))).toEqual(picture);

    // A later change keeps the stored reference as it is.
    const again = await call("moss_theme_set", { dark: { css: stored.light!.css! } });
    expect(again.isError).toBe(false);
  });

  it.each([
    [{ css: "x { background: url(moss-theme-image:girl) }" }, "not a stored picture"],
    [{ css: "x { background: url(moss-theme-image:constructor) }" }, "not a stored picture"],
    [{ css: "x { background: url(moss-theme-image:__proto__) }" }, "not a stored picture"],
    [{ images: { girl: "\\\\host\\share\\girl.png" } }, "network or device path"],
    [{ images: { girl: "//host/share/girl.png" } }, "network or device path"],
    [{ images: { girl: "\\\\.\\PhysicalDrive0" } }, "network or device path"],
    [
      { css: `x { background: url(moss-theme-image:${"a".repeat(64)}.png) }` },
      "is not stored on this computer",
    ],
    [{ images: { girl: "pictures/girl.png" } }, "not an absolute path"],
    [{ images: { Girl: "C:/girl.png" } }, "not a usable name"],
    [{ images: ["C:/girl.png"] }, "images: expected an object"],
    [
      { images: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, "C:/a.png"])) },
      "at most 8 pictures",
    ],
  ])("refuses pictures %j", async (args, message) => {
    const { call, patches } = harness({ themeImagesDir: await tempDir() });
    const result = await call("moss_theme_set", { appearance: "dark", ...args });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(patches).toEqual([]);
  });

  it("refuses an SVG or an oversized file with a clear reason", async () => {
    const sources = await tempDir();
    const svg = path.join(sources, "girl.png");
    await FS.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const large = path.join(sources, "large.png");
    await FS.writeFile(large, pngBytes(10, 10, 10 * 1024 * 1024));
    const { call } = harness({ themeImagesDir: await tempDir() });
    const svgResult = await call("moss_theme_set", { appearance: "dark", images: { girl: svg } });
    expect(svgResult.text).toContain("SVG is not accepted");
    const largeResult = await call("moss_theme_set", {
      appearance: "dark",
      images: { big: large },
    });
    expect(largeResult.text).toContain("at most 10 MB");
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
    // Raised from 1,600 for the `images` argument (2026-11-17).
    expect(bytes).toBeLessThan(1_900);
  });
});
