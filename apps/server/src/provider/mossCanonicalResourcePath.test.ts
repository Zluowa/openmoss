import { describe, expect, it } from "vitest";

import { validateCanonicalResourcePathHint } from "./mossCanonicalResourcePath.ts";

describe("canonical resource path boundary", () => {
  it("accepts only a server-derived relative artifact hint", () => {
    expect(() =>
      validateCanonicalResourcePathHint({
        kind: "plugin",
        cwd: "/workspace",
        name: "My Plugin",
        path: ".moss/plugins/my-plugin/plugin.json",
      }),
    ).not.toThrow();
    expect(() =>
      validateCanonicalResourcePathHint({
        kind: "plugin",
        cwd: "/workspace",
        name: "My Plugin",
        path: ".moss/plugins/other/plugin.json",
      }),
    ).toThrow(/server-derived/);
  });

  it.each(["/workspace/.moss/plugins/my-plugin/plugin.json", "~/outside", "../outside", ".", ""])(
    "rejects unsafe client path %j",
    (path) => {
      expect(() =>
        validateCanonicalResourcePathHint({
          kind: "plugin",
          cwd: "/workspace",
          name: "My Plugin",
          path,
        }),
      ).toThrow();
    },
  );

  it("derives MCP and skill paths from kind and name", () => {
    expect(() =>
      validateCanonicalResourcePathHint({
        kind: "skill",
        cwd: "/workspace",
        name: "Build Skill",
        path: ".moss/skills/build-skill/SKILL.md",
      }),
    ).not.toThrow();
    expect(() =>
      validateCanonicalResourcePathHint({
        kind: "mcp",
        cwd: "/workspace",
        name: "server",
        path: ".moss/mcp/config.json",
      }),
    ).not.toThrow();
  });
});
