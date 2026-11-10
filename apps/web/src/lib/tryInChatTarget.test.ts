import { describe, expect, it } from "vitest";

import type { ProjectId } from "@moss/contracts";

import type { ResourceDetail } from "~/components/PluginResourceDetailDialog";
import {
  buildCreatorPrompt,
  buildTryInChatSeed,
  createSingleFlight,
  planProjectResolution,
  resolveEnsuredProjectId,
  resolveCreatorTaskWorkspace,
  resolvePrefillCwd,
} from "./tryInChatTarget";

const pid = (value: string) => value as ProjectId;

// Minimal ResourceDetail fixtures — buildTryInChatSeed only reads name/path/
// marketplaceName/defaultPrompt, so the descriptors are cast rather than fully built.
const skillResource = (name: string, path = `/skills/${name}`): ResourceDetail =>
  ({ kind: "skill", skill: { name, path } }) as unknown as ResourceDetail;
const pluginResource = (
  name: string,
  marketplaceName: string,
  defaultPrompt?: string[],
): ResourceDetail =>
  ({
    kind: "plugin",
    plugin: { name, interface: defaultPrompt ? { defaultPrompt } : undefined },
    marketplaceName,
  }) as unknown as ResourceDetail;
const mcpResource = (name: string): ResourceDetail =>
  ({ kind: "mcp", server: { name } }) as unknown as ResourceDetail;

// Codex opens "Try in chat" with prefillCwd = workspaceRoots[0], unless that root
// is "/" or absent (then undefined). Ported from decode-codex plugins-page.tsx
// (prefillCwd = workspaceRoots[0] != null && workspaceRoots[0] !== "/" ? ... : undefined).
describe("resolvePrefillCwd", () => {
  it("uses the first workspace root", () => {
    expect(resolvePrefillCwd(["/Users/moss/proj", "/other"])).toBe("/Users/moss/proj");
  });

  it("returns undefined for the filesystem root", () => {
    expect(resolvePrefillCwd(["/"])).toBeUndefined();
  });

  it("returns undefined when there are no roots", () => {
    expect(resolvePrefillCwd([])).toBeUndefined();
    expect(resolvePrefillCwd([null, undefined])).toBeUndefined();
  });

  it("trims and ignores blank roots", () => {
    expect(resolvePrefillCwd(["  ", "/Users/moss/proj"])).toBeUndefined();
    expect(resolvePrefillCwd([" /Users/moss/proj "])).toBe("/Users/moss/proj");
  });
});

describe("planProjectResolution", () => {
  it("reuses the active project", () => {
    expect(planProjectResolution({ activeProjectId: pid("p1"), cwd: "/w" })).toEqual({
      kind: "use-existing",
      projectId: "p1",
    });
  });

  it("bootstraps from cwd when there is no project (the direct-open case)", () => {
    expect(planProjectResolution({ activeProjectId: null, cwd: "/work/dir" })).toEqual({
      kind: "create-from-cwd",
      workspaceRoot: "/work/dir",
    });
  });

  it("treats a filesystem-root or blank cwd as no cwd (never root a project at /)", () => {
    expect(planProjectResolution({ activeProjectId: null, cwd: "/" })).toEqual({
      kind: "abort",
      reason: "no-cwd",
    });
    expect(planProjectResolution({ activeProjectId: null, cwd: "   " })).toEqual({
      kind: "abort",
      reason: "no-cwd",
    });
  });

  it("aborts when there is neither project nor cwd", () => {
    expect(planProjectResolution({ activeProjectId: null, cwd: null })).toEqual({
      kind: "abort",
      reason: "no-cwd",
    });
  });
});

describe("resolveEnsuredProjectId", () => {
  it("returns the id only when a project row materialized", () => {
    expect(resolveEnsuredProjectId({ project: { id: pid("p9") } })).toBe("p9");
  });

  it("returns null when the project has not synced (duplicate-recovery race)", () => {
    expect(resolveEnsuredProjectId({ project: null })).toBeNull();
  });
});

describe("createSingleFlight", () => {
  it("ignores a concurrent second call (returns true, does not invoke fn twice)", async () => {
    const guard = createSingleFlight();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = guard.run(async () => {
      calls += 1;
      await gate;
      return true;
    });
    const second = await guard.run(async () => {
      calls += 1;
      return true;
    });
    expect(second).toBe(true); // handled, not a failure → no error toast
    expect(calls).toBe(1); // the second fn never ran
    release();
    expect(await first).toBe(true);
  });

  it("runs again once the previous call settles", async () => {
    const guard = createSingleFlight();
    let calls = 0;
    expect(await guard.run(async () => ((calls += 1), false))).toBe(false);
    expect(await guard.run(async () => ((calls += 1), true))).toBe(true);
    expect(calls).toBe(2);
  });

  it("resets even when fn rejects", async () => {
    const guard = createSingleFlight();
    await expect(
      guard.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await guard.run(async () => true)).toBe(true);
  });
});

// The composer renders a chip only by re-tokenizing the prompt STRING and, on
// send, drops any skill/mention reference whose token is absent from the text.
// So the seed must carry BOTH the chip token and the reference. Codex parity:
// skills use the `$`/`/` sigil (skillMentionPrefix), plugins use an `@name`
// mention backed by a `plugin://` reference (which flips the chip to the plugin
// variant), followed by the plugin's defaultPrompt.
describe("buildTryInChatSeed", () => {
  it("seeds a skill as a skill token (not @) plus the skill reference", () => {
    const seed = buildTryInChatSeed(skillResource("check-code", "/s/check-code"), "codex");
    expect(seed.prompt).toBe("/check-code "); // skillMentionPrefix("codex") = "/"
    expect(seed.skills).toEqual([{ name: "check-code", path: "/s/check-code" }]);
    expect(seed.mentions).toEqual([]);
  });

  it("uses the provider-specific skill prefix (pi)", () => {
    expect(buildTryInChatSeed(skillResource("foo"), "pi").prompt).toBe("/skill:foo ");
  });

  it("seeds a plugin as an @mention token plus a plugin:// mention reference", () => {
    const seed = buildTryInChatSeed(pluginResource("gh", "openai"), "codex");
    expect(seed.prompt).toBe("@gh ");
    expect(seed.mentions).toEqual([{ name: "gh", path: "plugin://gh@openai" }]);
    expect(seed.skills).toEqual([]);
  });

  it("appends the plugin defaultPrompt after the chip (Codex Ft parity)", () => {
    const seed = buildTryInChatSeed(pluginResource("gh", "openai", ["Do a thing"]), "codex");
    expect(seed.prompt).toBe("@gh Do a thing");
    expect(seed.mentions).toEqual([{ name: "gh", path: "plugin://gh@openai" }]);
  });

  it("gives a Moss media plugin's example prompt in the UI language", () => {
    const imagegen = pluginResource("moss-imagegen", "moss-bundled", ["Generate an image: "]);
    expect(buildTryInChatSeed(imagegen, "codex", undefined, { locale: "zh-CN" }).prompt).toBe(
      "@moss-imagegen 生成一张图片：",
    );
    expect(buildTryInChatSeed(imagegen, "codex", undefined, { locale: "en" }).prompt).toBe(
      "@moss-imagegen Generate an image: ",
    );
    // The 1.0.3 manifest's English request, which made the agent answer in English.
    const legacy = pluginResource("moss-imagegen", "moss-bundled", [
      "Use Moss Images to create or edit an image.",
    ]);
    expect(buildTryInChatSeed(legacy, "codex", undefined, { locale: "zh-CN" }).prompt).toBe(
      "@moss-imagegen 用 Moss 生成或编辑一张图片：",
    );
    // Other plugins' prompts are left as their authors wrote them.
    expect(
      buildTryInChatSeed(pluginResource("gh", "openai", ["Do a thing"]), "codex", undefined, {
        locale: "zh-CN",
      }).prompt,
    ).toBe("@gh Do a thing");
  });

  it("uses the selected plugin starter prompt when one is provided", () => {
    const seed = buildTryInChatSeed(
      pluginResource("gh", "openai", ["Default prompt"]),
      "codex",
      "Selected prompt",
    );
    expect(seed.prompt).toBe("@gh Selected prompt");
  });

  it("quotes plugin names with spaces in the mention token", () => {
    expect(buildTryInChatSeed(pluginResource("my plugin", "mp"), "codex").prompt).toBe(
      '@"my plugin" ',
    );
  });

  it("attaches a service plugin's installed skill so every CLI can use it", () => {
    const serviceSkill = { name: "amap-maps", path: "/home/me/.moss/skills/amap-maps/SKILL.md" };
    const resource = pluginResource("amap", "moss-service-plugins");
    for (const provider of ["claudeAgent", "codex", "cursor"] as const) {
      const seed = buildTryInChatSeed(resource, provider, "Use 高德地图 to ", { serviceSkill });
      // The chip token and its reference, as the composer picker sets them.
      expect(seed.prompt).toBe("/amap-maps Use 高德地图 to ");
      expect(seed.skills).toEqual([serviceSkill]);
      expect(seed.mentions).toEqual([]);
    }
    expect(
      buildTryInChatSeed(resource, "pi", undefined, { serviceSkill }).prompt.startsWith(
        "/skill:amap-maps ",
      ),
    ).toBe(true);
    // Without an installed skill on disk the prompt only names the service.
    expect(buildTryInChatSeed(resource, "claudeAgent", "Use 高德地图 to ")).toEqual({
      prompt: "Use 高德地图 to ",
      skills: [],
      mentions: [],
    });
    // A hosted Moss app has no skill to attach.
    expect(
      buildTryInChatSeed(pluginResource("gmail", "moss-apps"), "claudeAgent", "Use Gmail to ", {
        serviceSkill,
      }).skills,
    ).toEqual([]);
  });

  it("seeds an MCP resource as a plain instruction with no chip references", () => {
    const seed = buildTryInChatSeed(mcpResource("sentry"), "codex");
    expect(seed.prompt).toBe("Use the sentry MCP server to ");
    expect(seed.skills).toEqual([]);
    expect(seed.mentions).toEqual([]);
  });
});

describe("buildCreatorPrompt", () => {
  it("prepends the creator skill chip token before the first-use prompt", () => {
    expect(
      buildCreatorPrompt({
        provider: "codex",
        skillName: "skill-creator",
        firstUsePrompt: "help me create a skill",
      }),
    ).toBe("/skill-creator help me create a skill");
  });

  it("seeds just the chip token after the first open", () => {
    expect(
      buildCreatorPrompt({
        provider: "codex",
        skillName: "plugin-creator",
        firstUsePrompt: null,
      }),
    ).toBe("/plugin-creator ");
  });
});

describe("resolveCreatorTaskWorkspace", () => {
  it.each([null, undefined, "", "   ", "/", "\\", "relative/workspace", "C:\\"])(
    "rejects an unsafe workspace boundary: %s",
    (workspace) => {
      expect(resolveCreatorTaskWorkspace(workspace)).toBeNull();
    },
  );

  it.each(["/tmp/moss-creator-task", "C:\\Temp\\moss-creator-task", "\\\\server\\share\\moss"])(
    "keeps an absolute task-owned workspace: %s",
    (workspace) => {
      expect(resolveCreatorTaskWorkspace(workspace)).toBe(workspace);
    },
  );

  it("rejects traversal segments before the path reaches thread.create", () => {
    expect(resolveCreatorTaskWorkspace("/tmp/moss-creator-task/../project")).toBeNull();
    expect(resolveCreatorTaskWorkspace("C:\\Temp\\..\\project")).toBeNull();
  });
});
