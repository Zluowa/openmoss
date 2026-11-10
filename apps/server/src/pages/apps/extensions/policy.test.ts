import { describe, expect, it } from "vitest";

import { stableJson } from "../capabilities/mcp";
import {
  classifyMcpTool,
  evaluateManagedPolicy,
  parseManagedPolicy,
  parsePageAppMcpConfig,
} from "./mcpPolicy";
import { parseLocalMcpConfig } from "./mcpSources";
import { sanitizeSvg } from "./svgSanitize";

describe("classifyMcpTool", () => {
  const tool = (annotations: Record<string, boolean>) => ({
    name: "x",
    title: null,
    description: null,
    annotations,
  });
  it("lets annotations decide", () => {
    expect(classifyMcpTool("delete_all", tool({ readOnlyHint: true }))).toEqual({
      readOnly: true,
      destructive: false,
    });
    expect(classifyMcpTool("get_thing", tool({ destructiveHint: true }))).toEqual({
      readOnly: false,
      destructive: true,
    });
    expect(classifyMcpTool("remove_x", tool({ destructiveHint: false }))).toEqual({
      readOnly: false,
      destructive: false,
    });
  });
  it("falls back to the name, and treats unknown tools as destructive", () => {
    expect(classifyMcpTool("GITHUB_LIST_REPOS", tool({}))).toEqual({
      readOnly: true,
      destructive: false,
    });
    expect(classifyMcpTool("GITHUB_DELETE_A_REPOSITORY", tool({}))).toEqual({
      readOnly: false,
      destructive: true,
    });
    expect(classifyMcpTool("slack_send_message", tool({}))).toEqual({
      readOnly: false,
      destructive: true,
    });
    expect(classifyMcpTool("create_issue", tool({}))).toEqual({
      readOnly: false,
      destructive: false,
    });
    expect(classifyMcpTool("list_notes", null)).toEqual({ readOnly: false, destructive: true });
  });
});

describe("managed policy", () => {
  it("blocks, allows and asks by pattern", () => {
    const policy = parseManagedPolicy(
      JSON.stringify({
        mcp: {
          allowServers: ["notes", "Git*"],
          blockTools: ["*/delete_*"],
          confirmTools: ["notes/add_note"],
        },
      }),
    );
    expect(evaluateManagedPolicy(policy, { name: "notes", label: "notes" }, "list").kind).toBe(
      "allow",
    );
    expect(evaluateManagedPolicy(policy, { name: "slack", label: "Slack" }, "list").kind).toBe(
      "block",
    );
    expect(
      evaluateManagedPolicy(policy, { name: "github", label: "GitHub" }, "delete_repo").kind,
    ).toBe("block");
    expect(evaluateManagedPolicy(policy, { name: "notes", label: "notes" }, "add_note")).toEqual({
      kind: "allow",
      confirm: true,
    });
  });
  it("closes everything when the file is broken", () => {
    expect(parseManagedPolicy("{not json").disabled).toBe(true);
    expect(parseManagedPolicy(null).disabled).toBe(false);
  });
});

describe("parsePageAppMcpConfig", () => {
  it("accepts declared servers with tools and refuses the rest", () => {
    expect(
      parsePageAppMcpConfig({ servers: [{ server: "moss_apps", tools: ["GITHUB_GET_USER"] }] }),
    ).toEqual({
      config: { servers: [{ server: "moss_apps", tools: ["GITHUB_GET_USER"] }] },
    });
    expect("problem" in parsePageAppMcpConfig({ servers: [{ server: "a", tools: [] }] })).toBe(
      true,
    );
    expect(
      "problem" in
        parsePageAppMcpConfig({
          servers: [
            { server: "a", tools: ["x"] },
            { server: "A", tools: ["y"] },
          ],
        }),
    ).toBe(true);
    expect("problem" in parsePageAppMcpConfig(null)).toBe(true);
  });
});

describe("parseLocalMcpConfig", () => {
  it("reads stdio and http servers, keeping env values for launch only", () => {
    const servers = parseLocalMcpConfig(
      JSON.stringify({
        mcpServers: {
          notes: { command: "node", args: ["notes.mjs"], env: { TOKEN: "t" } },
          web: { url: "http://127.0.0.1:9/mcp", enabled: false },
          bad: { url: "file:///etc/passwd" },
        },
      }),
    );
    expect(servers.get("notes")).toMatchObject({
      command: "node",
      args: ["notes.mjs"],
      env: { TOKEN: "t" },
      enabled: true,
    });
    expect(servers.get("web")).toMatchObject({ url: "http://127.0.0.1:9/mcp", enabled: false });
    expect(servers.get("bad")?.url).toBeUndefined();
  });
});

describe("stableJson", () => {
  it("ignores key order", () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      stableJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });
});

describe("sanitizeSvg", () => {
  it("keeps drawing and drops anything that can run or reach out", () => {
    const out = sanitizeSvg(
      [
        '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]>',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">',
        "<script>alert(1)</script>",
        '<foreignObject><iframe src="https://x"></iframe></foreignObject>',
        '<a href="javascript:alert(1)"><rect width="9" height="9"/></a>',
        '<rect width="5" height="5" fill="url(#g)"/>',
        '<image href="https://evil.example/x.png"/>',
        '<use href="#shape"/>',
        '<rect style="background:url(https://x)" width="1" height="1"/>',
        '<linearGradient id="g"><stop offset="0"/></linearGradient>',
        "</svg>",
      ].join(""),
    );
    expect(out).not.toBeNull();
    expect(out).not.toMatch(
      /script|onload|foreignObject|iframe|javascript|ENTITY|evil|https:\/\/x/u,
    );
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('<use href="#shape"/>');
    expect(out).toContain("<linearGradient");
  });
  it("refuses files without an svg root", () => {
    expect(sanitizeSvg("<html><body>hi</body></html>")).toBeNull();
  });
});
