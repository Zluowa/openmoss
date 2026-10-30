import { describe, expect, it } from "vitest";
import {
  deriveFriendlyCommandTarget,
  deriveCommandReadTargets,
  deriveInlineCommandCall,
  deriveLiteralCommand,
  deriveReadableCommandDisplay,
  deriveReadableToolTitle,
  deriveMossMcpToolTitle,
  isHtmlPageToolCall,
  isHtmlRenderToolCall,
  humanizeToolCallIdentifier,
  localizeMossAppsToolAction,
  localizeToolHeading,
  extractMcpServerName,
  resolveMcpApprovalTool,
  extractWebFetchUrl,
  isMossBrowserToolCall,
  isMossUserAnswerToolCall,
  normalizeCompactToolLabel,
  resolveCommandVisualKind,
  sanitizeMossMcpToolPreview,
} from "./toolCallLabel";

describe("extractWebFetchUrl", () => {
  it("pulls the url out of a WebFetch argument summary", () => {
    expect(
      extractWebFetchUrl({
        toolName: "WebFetch",
        detail: 'WebFetch: {"url":"https://ui.shadcn.com/docs/components","prompt":"List EVER..."}',
      }),
    ).toBe("https://ui.shadcn.com/docs/components");
  });

  it("recognizes alternate fetch tool names and the uri field", () => {
    expect(
      extractWebFetchUrl({
        toolName: "web_fetch",
        detail: '{"uri":"https://example.com/path"}',
      }),
    ).toBe("https://example.com/path");
  });

  it("falls back to a bare URL token when there is no json field", () => {
    expect(extractWebFetchUrl({ toolName: "fetch", detail: "Fetching https://example.com." })).toBe(
      "https://example.com",
    );
  });

  it("ignores non-fetch tools", () => {
    expect(
      extractWebFetchUrl({ toolName: "Read", detail: '{"url":"https://example.com"}' }),
    ).toBeNull();
  });

  it("ignores non-http(s) and missing urls", () => {
    expect(
      extractWebFetchUrl({ toolName: "WebFetch", detail: '{"url":"ftp://example.com"}' }),
    ).toBeNull();
    expect(extractWebFetchUrl({ toolName: "WebFetch", detail: '{"prompt":"hi"}' })).toBeNull();
    expect(extractWebFetchUrl({ toolName: "WebFetch", detail: undefined })).toBeNull();
  });
});

describe("extractMcpServerName", () => {
  it("names Moss Apps tools by what they do, not by the app backend's brand", () => {
    expect(
      deriveReadableToolTitle({
        fallbackLabel: "Tool call",
        payload: {
          data: {
            item: { type: "mcpToolCall", server: "moss_apps", tool: "COMPOSIO_SEARCH_TOOLS" },
          },
        },
      }),
    ).toBe("Moss Apps: Find app actions");
    expect(
      deriveReadableToolTitle({
        fallbackLabel: "Tool call",
        payload: { toolName: "mcp__moss_apps__COMPOSIO_MULTI_EXECUTE_TOOL" },
      }),
    ).toBe("Moss Apps: Run app actions");
    expect(localizeToolHeading("Moss Apps: Find app actions", "zh-CN")).toBe(
      "Moss 应用：查找可用操作",
    );
    // Its server name starts with "moss_" but these are not Moss gateway actions.
    expect(
      deriveMossMcpToolTitle({
        toolName: "mcp__moss_apps__COMPOSIO_SEARCH_TOOLS",
        title: "Moss Apps: Find app actions",
        status: "completed",
      }),
    ).toBeNull();
    expect(deriveMossMcpToolTitle({ toolName: "moss_apps.COMPOSIO_SEARCH_TOOLS" })).toBeNull();
  });

  it("names the server and tool behind an MCP approval for either provider", () => {
    expect(
      resolveMcpApprovalTool({ serverName: "moss_apps", toolName: "COMPOSIO_SEARCH_TOOLS" }),
    ).toEqual({ server: "moss_apps", tool: "COMPOSIO_SEARCH_TOOLS" });
    expect(resolveMcpApprovalTool({ toolName: "mcp__github__list_issues" })).toEqual({
      server: "github",
      tool: "list_issues",
    });
    expect(resolveMcpApprovalTool({ toolName: "WebFetch" })).toEqual({
      server: null,
      tool: "WebFetch",
    });
    expect(resolveMcpApprovalTool({})).toEqual({ server: null, tool: null });
    expect(localizeMossAppsToolAction("COMPOSIO_MULTI_EXECUTE_TOOL", "zh-CN")).toBe("执行操作");
    expect(localizeMossAppsToolAction("COMPOSIO_MULTI_EXECUTE_TOOL", "en")).toBe("Run app actions");
  });

  it("reads the server from Claude's mcp__server__tool names", () => {
    expect(extractMcpServerName("mcp__superx_so_connector__get_me", null)).toBe(
      "superx_so_connector",
    );
  });

  it("reads Codex's nested { server, tool } pair", () => {
    expect(
      extractMcpServerName("get_me", {
        data: { item: { type: "mcpToolCall", server: "stripe", tool: "list_customers" } },
      }),
    ).toBe("stripe");
  });

  it("is null for tools that are not MCP calls", () => {
    expect(extractMcpServerName("Bash", { data: { item: { command: "ls" } } })).toBeNull();
    expect(extractMcpServerName(undefined, null)).toBeNull();
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording", () => {
    expect(normalizeCompactToolLabel("Tool call completed")).toBe("Tool call");
    expect(normalizeCompactToolLabel("Ran command done")).toBe("Ran command");
    expect(normalizeCompactToolLabel("Ran command started")).toBe("Ran command");
  });

  it.each([
    ["  Tool\r\n\tCOMPLETED\n", "Tool"],
    ["completed", "completed"],
    [" completed ", ""],
    ["Toolcompleted", "Toolcompleted"],
    ["Tool completed later", "Tool completed later"],
    ["Tool\u00a0done\u2028", "Tool"],
  ])("preserves status-word boundaries in %j", (value, expected) => {
    expect(normalizeCompactToolLabel(value)).toBe(expected);
  });
});

describe("deriveMossMcpToolTitle", () => {
  it.each([["browser_run", "Run browser actions"]])(
    "keeps current and historical %s messages readable",
    (toolName, title) => {
      expect(deriveMossMcpToolTitle({ toolName, status: "completed" })).toBe(title);
      expect(isMossBrowserToolCall({ title })).toBe(true);
    },
  );

  it("uses stable action-first names for Moss browser tools", () => {
    for (const status of ["running", "completed", "failed"] as const) {
      expect(
        deriveMossMcpToolTitle({
          toolName: "mcp__moss__browser_open",
          status,
        }),
      ).toBe("Open browser tab");
    }

    expect(
      deriveMossMcpToolTitle({
        title: "Moss: Browser Snapshot",
        status: "completed",
      }),
    ).toBe("Snapshot browser page");
  });

  it("recognizes bare and already-humanized Moss tool names", () => {
    expect(deriveMossMcpToolTitle({ toolName: "moss_send_message", status: "running" })).toBe(
      "Moss is sending a message",
    );
    expect(deriveMossMcpToolTitle({ title: "Moss: Moss List Threads", status: "completed" })).toBe(
      "Moss listed threads",
    );
    expect(deriveMossMcpToolTitle({ toolName: "moss_create_thread", status: "cancelled" })).toBe(
      "Moss stopped creating a thread",
    );
  });

  it("ignores tools from other MCP servers", () => {
    expect(
      deriveMossMcpToolTitle({
        toolName: "mcp__codex_apps__github_fetch_pr",
        status: "running",
      }),
    ).toBeNull();
  });

  it("keeps future Moss actions branded without exposing raw identifiers", () => {
    expect(
      deriveMossMcpToolTitle({
        toolName: "mcp__moss__moss_delete_project",
        status: "running",
      }),
    ).toBe("Moss is handling delete project");
    expect(
      deriveMossMcpToolTitle({
        toolName: "Moss__moss_delete_project",
        status: "completed",
      }),
    ).toBe("Moss handled delete project");
    expect(
      deriveMossMcpToolTitle({
        toolName: "moss_is_handling_delete_project",
        status: "completed",
      }),
    ).toBe("Moss handled delete project");
  });

  it("does not reinterpret free text beginning with fallback status copy", () => {
    expect(
      deriveMossMcpToolTitle({
        title: "Moss is handling delete project after recovery",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      deriveMossMcpToolTitle({
        title: "Moss handled delete project after recovery",
        status: "running",
      }),
    ).toBeNull();
    expect(
      deriveMossMcpToolTitle({
        title: "Moss couldn't handle delete project after recovery",
        status: "failed",
      }),
    ).toBeNull();
  });

  it("removes transport identifiers without hiding meaningful Moss details", () => {
    expect(
      sanitizeMossMcpToolPreview({
        preview: "Moss__moss_create_threads",
        heading: "Moss created threads",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      sanitizeMossMcpToolPreview({
        preview: 'Unexpected key "reasoningEffort" for Claude Agent',
        heading: "Moss couldn't create threads",
        status: "failed",
      }),
    ).toBe('Unexpected key "reasoningEffort" for Claude Agent');
  });
});

describe("isMossBrowserToolCall", () => {
  it("recognizes canonical presentation titles without a tool identifier", () => {
    expect(isMossBrowserToolCall({ title: "Open browser tab" })).toBe(true);
    expect(isMossBrowserToolCall({ fallbackLabel: "Snapshot browser page" })).toBe(true);
    expect(isMossBrowserToolCall({ title: "Moss listed threads" })).toBe(false);
  });
});

describe("deriveReadableToolTitle", () => {
  it.each([["mcp__moss__computer_activate_window", "Activate a window"]])(
    "uses the curated Computer label for %s",
    (toolName, expected) => {
      expect(
        deriveReadableToolTitle({
          title: "Tool",
          fallbackLabel: "Tool",
          itemType: "mcp_tool_call",
          payload: { data: { item: { tool: toolName } } },
        }),
      ).toBe(expected);
    },
  );

  it("humanizes git status commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "git status --short",
      }),
    ).toBe("Checked");
  });

  it("keeps explicit non-generic titles", () => {
    expect(
      deriveReadableToolTitle({
        title: "Bash",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "echo hello",
      }),
    ).toBe("Bash");
  });

  it("treats Cursor placeholder titles as generic", () => {
    expect(
      deriveReadableToolTitle({
        title: "Find",
        fallbackLabel: "Find",
        itemType: "dynamic_tool_call",
        payload: { data: { kind: "search" } },
      }),
    ).toBe("Search");

    expect(
      deriveReadableToolTitle({
        title: "Read File",
        fallbackLabel: "Read File",
        itemType: "dynamic_tool_call",
        payload: { data: { kind: "read" } },
      }),
    ).toBe("Read");
  });

  it("humanizes provider tool identifiers used as lifecycle titles", () => {
    expect(
      deriveReadableToolTitle({
        title: "get_app_state",
        fallbackLabel: "get_app_state",
        itemType: "mcp_tool_call",
      }),
    ).toBe("Get App State");
  });
});

describe("deriveReadableCommandDisplay", () => {
  it.each(["|", "\t\r\n|\t"])("keeps the first command before a pipe: %j", (pipe) => {
    const command = `cat src/result.ts${pipe}head -n 1`;
    expect(deriveReadableCommandDisplay(command)).toEqual({
      verb: "Read",
      target: "src/result.ts",
      fullCommand: command,
    });
  });

  it("extracts search targets without leaking the full shell wrapper inline", () => {
    expect(deriveReadableCommandDisplay(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toEqual({
      verb: "Searched",
      target: "for tool call in web/src",
      fullCommand: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
    });
  });

  it("unwraps zsh shell wrappers around read commands", () => {
    expect(
      deriveReadableCommandDisplay(
        `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
      ),
    ).toEqual({
      verb: "Read",
      target: "components/provider-card.tsx",
      fullCommand: `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
    });
  });

  it("keeps quoted paths intact when shell wrappers include cd chaining", () => {
    expect(
      deriveReadableCommandDisplay(
        `zsh -lc "cd '/tmp/my app' && sed -n '1,260p' src/pages/overview.tsx"`,
      ),
    ).toEqual({
      verb: "Read",
      target: "pages/overview.tsx",
      fullCommand: `zsh -lc "cd '/tmp/my app' && sed -n '1,260p' src/pages/overview.tsx"`,
    });
  });

  it("does not discard real chained commands after a shell wrapper", () => {
    expect(
      deriveReadableCommandDisplay(
        `/bin/zsh -lc 'rm -f /tmp/test.log && bun run --cwd apps/server test'`,
      ),
    ).toEqual({
      verb: "Removed",
      target: "/tmp/test.log",
      fullCommand: `/bin/zsh -lc 'rm -f /tmp/test.log && bun run --cwd apps/server test'`,
    });
  });

  it("removes env and timeout wrappers from inline command summaries", () => {
    expect(
      deriveReadableCommandDisplay(
        "env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 timeout 180s bun run dev",
        true,
      ),
    ).toEqual({
      verb: "Running",
      target: "bun run dev",
      fullCommand: "env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 timeout 180s bun run dev",
    });
  });

  it("summarizes inline script commands without leaking the script body", () => {
    expect(
      deriveReadableCommandDisplay(`node -e "const fs = require('fs'); console.log(fs.cwd)"`, true),
    ).toEqual({
      verb: "Running",
      target: "node script",
      fullCommand: `node -e "const fs = require('fs'); console.log(fs.cwd)"`,
    });

    expect(deriveReadableCommandDisplay("python3 - <<'PY'\nprint('hi')\nPY", true)).toEqual({
      verb: "Running",
      target: "python script",
      fullCommand: "python3 - <<'PY'\nprint('hi')\nPY",
    });
  });

  it("humanizes current-directory searches without leaking placeholder dots", () => {
    expect(deriveReadableCommandDisplay(`rg -n "model(s)?" .`)).toEqual({
      verb: "Searched",
      target: "for model(s)? in current directory",
      fullCommand: `rg -n "model(s)?" .`,
    });
  });

  it("falls back to a directory summary when the search token is only punctuation", () => {
    expect(deriveReadableCommandDisplay(`rg -n . src/lib`)).toEqual({
      verb: "Searched",
      target: "in src/lib",
      fullCommand: `rg -n . src/lib`,
    });
  });
});

describe("deriveFriendlyCommandTarget", () => {
  it("uses a friendly shell name instead of leaking the full wrapper command", () => {
    expect(
      deriveFriendlyCommandTarget(
        '"C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command "powershell -NoProfile -Command \\"1..8\\""',
      ),
    ).toBe("PowerShell");
  });

  it("keeps long targets short enough to sit inline", () => {
    const target = deriveFriendlyCommandTarget(`echo ${"a".repeat(200)}`);
    expect(target.length).toBeLessThanOrEqual(72);
    expect(target.endsWith("…")).toBe(true);
  });
});

describe("deriveLiteralCommand", () => {
  it("drops the shell wrapper and cd preamble but keeps pipes and quotes", () => {
    expect(deriveLiteralCommand(`/bin/zsh -lc 'cd /repo && rg -n "a b" src | head -5'`)).toBe(
      `rg -n "a b" src | head -5`,
    );
    expect(deriveLiteralCommand(`find . -name "*.md" -not -path "./.git/*"`)).toBe(
      `find . -name "*.md" -not -path "./.git/*"`,
    );
  });
});

describe("deriveCommandReadTargets", () => {
  it("names the files of a plain read", () => {
    expect(deriveCommandReadTargets("cat calc.py")).toEqual(["calc.py"]);
    expect(deriveCommandReadTargets("head -n 20 README.md")).toEqual(["README.md"]);
    expect(deriveCommandReadTargets("sed -n '1,40p' apps/web/src/app.ts")).toEqual(["src/app.ts"]);
    expect(deriveCommandReadTargets("cat a.txt b.txt")).toEqual(["a.txt", "b.txt"]);
  });

  it("refuses anything that is not only a read", () => {
    expect(deriveCommandReadTargets("cat a.txt | grep foo")).toBeNull();
    expect(deriveCommandReadTargets("cat a.txt && rm b")).toBeNull();
    expect(deriveCommandReadTargets("cat a.txt > b.txt")).toBeNull();
    expect(deriveCommandReadTargets("sed -i 's/a/b/' a.txt")).toBeNull();
    expect(deriveCommandReadTargets("sed 's/a/b/' a.txt")).toBeNull();
    expect(deriveCommandReadTargets("cat")).toBeNull();
    expect(deriveCommandReadTargets("ls")).toBeNull();
    expect(deriveCommandReadTargets("find . -name '*.md'")).toBeNull();
  });
});

describe("deriveInlineCommandCall", () => {
  it("shows the actual command call without the shell wrapper", () => {
    expect(deriveInlineCommandCall(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toBe(
      `rg -n "tool call" apps/web/src`,
    );
  });
});

describe("resolveCommandVisualKind", () => {
  it("separates file reads from searches", () => {
    expect(resolveCommandVisualKind("cat package.json")).toBe("read");
    expect(resolveCommandVisualKind("sed -n 1,40p src/app.ts")).toBe("read");
    expect(resolveCommandVisualKind("head -n 20 README.md")).toBe("read");
    expect(resolveCommandVisualKind(`rg -n "tool call" apps/web/src`)).toBe("search");
    expect(resolveCommandVisualKind("grep -R foo .")).toBe("search");
    expect(resolveCommandVisualKind("find . -name '*.ts'")).toBe("search");
    expect(resolveCommandVisualKind(`/bin/zsh -lc 'rg -n "x" src'`)).toBe("search");
  });

  it("keeps listings, in-place edits and piped reads on the terminal glyph", () => {
    expect(resolveCommandVisualKind("ls -la src")).toBe("terminal");
    expect(resolveCommandVisualKind("ls")).toBe("terminal");
    expect(resolveCommandVisualKind("sed -i 's/a/b/' src/app.ts")).toBe("terminal");
    expect(resolveCommandVisualKind("cat a.txt && rm -rf dist")).toBe("terminal");
  });

  it("does not treat mutating or executing commands as inspections", () => {
    expect(resolveCommandVisualKind("git status")).toBe("git");
    expect(resolveCommandVisualKind("node build.js")).toBe("terminal");
    expect(resolveCommandVisualKind("rm -rf dist")).toBe("terminal");
    expect(resolveCommandVisualKind("mkdir foo")).toBe("terminal");
  });

  it("classifies git commands through shell and global-option wrappers", () => {
    expect(resolveCommandVisualKind("git status --short")).toBe("git");
    expect(resolveCommandVisualKind("git -C apps/web status --short")).toBe("git");
    expect(resolveCommandVisualKind(`/bin/zsh -lc "cd repo && git branch -vv"`)).toBe("git");
  });

  it("classifies GitHub CLI commands through env wrappers", () => {
    expect(resolveCommandVisualKind("gh pr view 274 --repo owner/repo")).toBe("github");
    expect(resolveCommandVisualKind("env -u GH_TOKEN gh pr status")).toBe("github");
    expect(resolveCommandVisualKind("hub pull-request -m test")).toBe("github");
  });

  it("keeps inspections and ordinary commands distinct", () => {
    expect(resolveCommandVisualKind(`rg -n "tool call" apps/web/src`)).toBe("search");
    expect(resolveCommandVisualKind("bun run build")).toBe("terminal");
  });
});

describe("file-change lifecycle titles", () => {
  it.each([
    [{ requestKind: "file-change" as const, title: "File change", isRunning: true }, "Editing"],
    [{ requestKind: "file-change" as const, title: "Edited", isRunning: true }, "Editing"],
    [{ itemType: "file_change" as const, title: "File change", isRunning: false }, "Edited"],
    [{ itemType: "file_change" as const, title: "Created", isRunning: false }, "Created"],
  ])("uses activity state for %j", (input, expected) => {
    expect(deriveReadableToolTitle({ fallbackLabel: "", ...input })).toBe(expected);
  });

  it("preserves a provider-specific non-lifecycle title", () => {
    expect(
      deriveReadableToolTitle({
        fallbackLabel: "",
        requestKind: "file-change",
        title: "Apply patch",
        isRunning: true,
      }),
    ).toBe("Apply patch");
  });
});

describe("humanizeToolCallIdentifier", () => {
  it("uses sentence-style casing for snake_case and camelCase identifiers", () => {
    expect(humanizeToolCallIdentifier("get_weather_forecast")).toBe("Get weather forecast");
    expect(humanizeToolCallIdentifier("readAPIStatus")).toBe("Read API status");
  });
});

describe("deriveMossMcpToolTitle", () => {
  it("localizes browser action names without changing their action-first meaning", () => {
    expect(localizeToolHeading("Open browser tab", "zh-CN")).toBe("打开浏览器标签页");
    expect(localizeToolHeading("Capture browser screenshot", "zh-CN")).toBe("截取浏览器屏幕");
    expect(localizeToolHeading("Wait for browser condition", "zh-CN")).toBe("等待浏览器条件");
    expect(localizeToolHeading("Open browser tab", "en")).toBe("Open browser tab");
  });

  it("has intentional running and completed copy for every Moss gateway action", () => {
    const cases = [
      ["moss_context", "Moss is checking its context", "Moss checked its context"],
      ["moss_capabilities", "Moss is checking available agents", "Moss checked available agents"],
      ["moss_list_projects", "Moss is listing projects", "Moss listed projects"],
      ["moss_list_threads", "Moss is listing threads", "Moss listed threads"],
      ["moss_read_thread", "Moss is reading a thread", "Moss read a thread"],
      ["moss_read_thread_activity", "Moss is reading thread activity", "Moss read thread activity"],
      ["moss_read_thread_events", "Moss is reading thread events", "Moss read thread events"],
      [
        "moss_read_thread_runtime_events",
        "Moss is reading thread runtime events",
        "Moss read thread runtime events",
      ],
      ["moss_diagnose_thread", "Moss is diagnosing a thread", "Moss diagnosed a thread"],
      ["moss_create_thread", "Moss is creating a thread", "Moss created a thread"],
      ["moss_create_threads", "Moss is creating threads", "Moss created threads"],
      ["moss_wait_for_threads", "Moss is waiting for threads", "Moss finished waiting for threads"],
      ["moss_send_message", "Moss is sending a message", "Moss sent a message"],
      ["moss_interrupt_thread", "Moss is interrupting a thread", "Moss interrupted a thread"],
      ["moss_set_thread_title", "Moss is renaming a thread", "Moss renamed a thread"],
      ["moss_set_thread_archived", "Moss is updating a thread", "Moss updated a thread"],
      ["moss_create_automation", "Moss is creating an automation", "Moss created an automation"],
      ["moss_list_automations", "Moss is listing automations", "Moss listed automations"],
      ["moss_cancel_automation", "Moss is stopping an automation", "Moss stopped an automation"],
      ["moss_overview", "Moss is gathering an overview", "Moss gathered an overview"],
      [
        "moss_list_allowed_projects",
        "Moss is listing allowed projects",
        "Moss listed allowed projects",
      ],
      ["moss_create_task", "Moss is creating a task", "Moss created a task"],
      ["moss_wait_for_task", "Moss is waiting for a task", "Moss finished waiting for a task"],
      ["moss_read_task", "Moss is reading a task", "Moss read a task"],
    ] as const;

    for (const [toolName, running, completed] of cases) {
      expect(deriveMossMcpToolTitle({ toolName, status: "running" })).toBe(running);
      expect(deriveMossMcpToolTitle({ toolName, status: "completed" })).toBe(completed);
    }

    expect(deriveMossMcpToolTitle({ toolName: "html_render", status: "running" })).toBe(
      "Rendering an HTML page",
    );
    expect(
      deriveMossMcpToolTitle({ toolName: "mcp__moss__html_render", status: "completed" }),
    ).toBe("Rendered an HTML page");
    expect(deriveMossMcpToolTitle({ toolName: "html_render", status: "failed" })).toBe(
      "Couldn't render an HTML page",
    );
    expect(
      deriveMossMcpToolTitle({
        toolName: "Moss__html_render — source file: /tmp/page.json",
        status: "completed",
      }),
    ).toBe("Rendered an HTML page");
    expect(deriveMossMcpToolTitle({ toolName: "html_preview", status: "completed" })).toBe(
      "Previewed an HTML page",
    );
    expect(isHtmlRenderToolCall({ toolName: "html_render" })).toBe(true);
    expect(isHtmlRenderToolCall({ toolName: "mcp__moss__html_render" })).toBe(true);
    expect(
      isHtmlPageToolCall({ toolName: "Moss__html_preview — source file: mcp-preview.json" }),
    ).toBe(true);
    expect(isHtmlRenderToolCall({ title: "Rendered an HTML page" })).toBe(true);
    expect(isHtmlRenderToolCall({ toolName: "moss_create_thread" })).toBe(false);
    expect(localizeToolHeading("Rendering an HTML page", "zh-CN")).toBe("正在渲染 HTML 页面");
    expect(localizeToolHeading("Rendered an HTML page", "zh-CN")).toBe("已渲染 HTML 页面");
    expect(localizeToolHeading("Couldn't render an HTML page", "zh-CN")).toBe("无法渲染 HTML 页面");
    expect(localizeToolHeading("Previewed an HTML page", "zh-CN")).toBe("已预览 HTML 页面");
    expect(localizeToolHeading("Search tools:", "zh-CN")).toBe("搜索工具：");
    expect(localizeToolHeading("Search tools:", "en")).toBe("Search tools:");
    expect(
      deriveMossMcpToolTitle({
        toolName: "search_tool",
        title: "Search tools: moss html_render",
        fallbackLabel: "moss html_render",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      isHtmlPageToolCall({
        toolName: "search_tool",
        title: "Search tools: moss html_preview",
      }),
    ).toBe(false);
    expect(
      deriveMossMcpToolTitle({
        toolName: "moss_create_threads",
        status: "failed",
      }),
    ).toBe("Moss couldn't create threads");
    expect(
      deriveMossMcpToolTitle({
        toolName: "moss_create_thread",
        status: "cancelled",
      }),
    ).toBe("Moss stopped creating a thread");
  });

  it("turns provider-specific create-thread identifiers into activity sentences", () => {
    expect(
      deriveMossMcpToolTitle({
        toolName: "Moss__moss_create_thread",
        status: "running",
      }),
    ).toBe("Moss is creating a thread");
    expect(
      deriveMossMcpToolTitle({
        toolName: "mcp__moss__moss_create_thread",
        status: "completed",
      }),
    ).toBe("Moss created a thread");
  });

  it("renders cached legacy gateway identifiers with Moss branding", () => {
    expect(
      deriveMossMcpToolTitle({
        toolName: "mcp__moss__moss_send_message",
        status: "completed",
      }),
    ).toBe("Moss sent a message");
  });

  it("leaves free-text activity summaries starting with Moss untouched", () => {
    expect(
      deriveMossMcpToolTitle({
        title: "Moss recovered a stale running state",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      deriveMossMcpToolTitle({
        fallbackLabel: "Moss restarted the provider session",
        status: "running",
      }),
    ).toBeNull();
  });
});

describe("deriveReadableToolTitle", () => {
  it("humanizes search commands even when wrapped in shell -lc", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        requestKind: "command",
        command: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
      }),
    ).toBe("Searched");
  });

  it("humanizes file read commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "sed -n '520,550p' apps/web/src/session-logic.ts",
      }),
    ).toBe("Read");
  });

  it("extracts a descriptor from payload when the title is generic", () => {
    expect(
      deriveReadableToolTitle({
        title: "Tool call",
        fallbackLabel: "Tool call",
        itemType: "dynamic_tool_call",
        payload: {
          data: {
            item: {
              toolName: "mcp__xcodebuildmcp__list_sims",
            },
          },
        },
      }),
    ).toBe("Xcodebuildmcp: List Sims");
  });

  it("formats MCP identifiers into readable tool names", () => {
    expect(
      deriveReadableToolTitle({
        title: "MCP tool call",
        fallbackLabel: "MCP tool call",
        itemType: "mcp_tool_call",
        payload: {
          data: {
            toolName: "mcp__codex_apps__github_fetch_pr",
          },
        },
      }),
    ).toBe("Codex Apps: Github Fetch Pr");
  });

  it("formats structured MCP server/tool payloads into readable tool names", () => {
    expect(
      deriveReadableToolTitle({
        title: "MCP tool call",
        fallbackLabel: "MCP tool call",
        itemType: "mcp_tool_call",
        payload: {
          data: {
            item: {
              type: "mcpToolCall",
              server: "computer-use",
              tool: "get_app_state",
            },
          },
        },
      }),
    ).toBe("Computer Use: Get App State");
  });
});

describe("deriveReadableCommandDisplay", () => {
  it("compacts file paths for read commands", () => {
    expect(
      deriveReadableCommandDisplay(
        "sed -n '520,550p' apps/web/src/components/chat/MessagesTimeline.tsx",
      ),
    ).toEqual({
      verb: "Read",
      target: "chat/MessagesTimeline.tsx",
      fullCommand: "sed -n '520,550p' apps/web/src/components/chat/MessagesTimeline.tsx",
    });
  });

  it("localizes fixed Chinese command headings and targets at their generation sites", () => {
    const verb = (command: string, isRunning = false) =>
      deriveReadableCommandDisplay(command, isRunning, "zh-CN").verb;
    const target = (command: string) =>
      deriveReadableCommandDisplay(command, false, "zh-CN").target;

    expect(verb("cat file")).toBe("已读取");
    expect(verb("rg word .", true)).toBe("正在搜索");
    expect(verb("git diff")).toBe("已比较");
    expect(verb("git push", true)).toBe("正在推送");
    expect(verb("node script")).toBe("已运行");
    expect(target("cat")).toBe("文件");
    expect(target("ls")).toBe("目录");
    expect(target("find")).toBe("文件");
    expect(target("git diff")).toBe("更改");
    expect(target("git show")).toBe("提交");
    expect(target("git log")).toBe("Git 历史");
    expect(target("git push")).toBe("到远程仓库");
    expect(target("git pull")).toBe("从远程仓库");
    expect(target("git switch")).toBe("分支");
    expect(target("ls .")).toBe("当前目录");
    expect(target("ls ..")).toBe("上级目录");
  });

  it("localizes the fixed inline-script wrapper while preserving the runtime name", () => {
    expect(deriveReadableCommandDisplay(`node -e "console.log('hi')"`, false, "zh-CN").target).toBe(
      "node 脚本",
    );
    expect(
      deriveReadableCommandDisplay("python3 - <<'PY'\nprint('hi')\nPY", true, "zh-CN").target,
    ).toBe("python 脚本");
  });

  it("does not translate user paths, branch names, or ordinary command arguments", () => {
    const target = (command: string) =>
      deriveReadableCommandDisplay(command, false, "zh-CN").target;

    expect(target("cat file")).toBe("file");
    expect(target("ls directory")).toBe("directory");
    expect(target("git switch branch")).toBe("branch");
    expect(target("git switch changes")).toBe("changes");
    expect(target("node script")).toBe("node script");
    expect(target(`cat '/tmp/current directory'`)).toBe("/tmp/current directory");
  });

  it("keeps user search patterns intact while localizing the dot path token", () => {
    expect(deriveReadableCommandDisplay(`rg -n "model(s)?" .`, false, "zh-CN")).toMatchObject({
      verb: "已搜索",
      target: "model(s)?（当前目录）",
    });
  });

  it("keeps dynamic tool headings unchanged while translating the fixed allowlist", () => {
    expect(localizeToolHeading("Read", "zh-CN")).toBe("已读取");
    expect(localizeToolHeading("Custom database migration", "zh-CN")).toBe(
      "Custom database migration",
    );
    expect(localizeToolHeading("Read", "en")).toBe("Read");
  });
});

describe("deriveFriendlyCommandTarget", () => {
  it("reads as the object of the row's sentence", () => {
    expect(deriveFriendlyCommandTarget(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toBe(
      "for tool call in web/src",
    );
  });
});

describe("isMossUserAnswerToolCall", () => {
  it("recognizes the secret request tool under every provider's naming", () => {
    for (const name of [
      "moss_request_secret",
      "mcp__moss__moss_request_secret",
      "mcp__moss__request_secret",
    ]) {
      expect(isMossUserAnswerToolCall(name), name).toBe(true);
    }
    for (const name of [
      "moss_create_todo",
      "request_secret",
      "mcp__moss_apps__request_secret",
      null,
    ]) {
      expect(isMossUserAnswerToolCall(name), String(name)).toBe(false);
    }
  });
});
