// FILE: grokHtmlToolActivities.fixture.ts
// Purpose: Sanitized real Grok visual-tool activities for work-log regression coverage.
// Source: ACCEPT-241-r2 exported activities and reverted-thread orchestration events.

/**
 * These are minimal copies of persisted Grok payloads, not synthesized provider
 * shapes. Large page bodies, PNG base64, long search output, attachment IDs, and
 * home-directory paths are redacted while preserving the envelopes and fields
 * that reach the work-log projection.
 */
export const grokHtmlToolActivitiesFixture = [
  {
    id: "search-tools",
    createdAt: "2026-10-09T04:55:15.687Z",
    tone: "tool",
    kind: "tool.completed",
    summary: 'Search tools: "html_render html_preview browser_screenshot moss"',
    sequence: 38,
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      title: 'Search tools: "html_render html_preview browser_screenshot moss"',
      detail: '{\n  "results": [\n    { "server": "moss" }\n  ]\n}',
      data: {
        toolCallId: "call-search-tools",
        rawInput: {
          limit: 15,
          query: "html_render html_preview browser_screenshot moss",
          variant: "SearchTool",
        },
        rawOutput: {
          type: "SearchTool",
          result_count: 15,
          content: '{"results":["<search output omitted>"]}',
        },
        kind: "other",
        locations: [],
        providerToolCallId: "call-search-tools",
      },
    },
  },
  {
    id: "list-directory",
    createdAt: "2026-10-09T04:55:15.690Z",
    tone: "tool",
    kind: "tool.completed",
    summary: "List `/workspace/fixtureProject`",
    sequence: 39,
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "List `/workspace/fixtureProject`",
      detail: "/workspace/fixtureProject",
      data: {
        toolCallId: "call-list-directory",
        rawInput: {
          target_directory: "/workspace/fixtureProject",
          variant: "ListDir",
        },
        kind: "other",
        command: "/workspace/fixtureProject",
        locations: [{ path: "/workspace/fixtureProject" }],
        rawOutput: {
          type: "ListDir",
          Content: {
            content: "- /workspace/fixtureProject/\n  - data/",
            absolute_root_path: "/workspace/fixtureProject",
          },
        },
        providerToolCallId: "call-list-directory",
      },
    },
  },
  {
    id: "preview-with-document-title",
    createdAt: "2026-10-09T05:10:16.622Z",
    tone: "tool",
    kind: "tool.completed",
    summary: "moss__html_preview — source file: /tmp/preview-dark.json",
    sequence: 1374,
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "moss__html_preview — source file: /tmp/preview-dark.json",
      detail: "moss__html_preview — source file: /tmp/preview-dark.json",
      data: {
        toolCallId: "call-preview-with-document-title",
        rawInput: {
          tool_input: {
            appearance: "dark",
            html: '<!doctype html><html lang="zh-CN"><head><title>2026 经营看板</title></head><body><!-- page body omitted --></body></html>',
            width: 728,
          },
          tool_name: "moss__html_preview",
          variant: "UseTool",
        },
        rawOutput: {
          output: {
            OkayOutput:
              '[image content will be provided separately]\\n{"png":"<base64 omitted>","contentHeight":1320,"captureHeight":1320,"console":[]}',
          },
          server_name: "moss",
          tool_name: "html_preview",
          type: "MCP",
        },
        kind: "other",
        locations: [],
        providerToolCallId: "call-preview-with-document-title",
        __mossTruncated: true,
        originalJsonChars: 76432,
      },
    },
  },
  {
    id: "preview-without-document-title",
    createdAt: "2026-10-09T05:10:16.626Z",
    tone: "tool",
    kind: "tool.completed",
    summary: "moss__html_preview — source file: /tmp/preview-empty.json",
    sequence: 1375,
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "moss__html_preview — source file: /tmp/preview-empty.json",
      detail: "moss__html_preview — source file: /tmp/preview-empty.json",
      data: {
        toolCallId: "call-preview-without-document-title",
        rawInput: {
          tool_input: {
            appearance: "dark",
            html: "<!doctype html><html><head></head><body><!-- page body omitted --></body></html>",
            width: 728,
          },
          tool_name: "moss__html_preview",
          variant: "UseTool",
        },
        rawOutput: {
          output: {
            OkayOutput:
              '[image content will be provided separately]\\n{"png":"<base64 omitted>","contentHeight":600,"captureHeight":600,"console":[]}',
          },
          server_name: "moss",
          tool_name: "html_preview",
          type: "MCP",
        },
        kind: "other",
        locations: [],
        providerToolCallId: "call-preview-without-document-title",
        __mossTruncated: true,
        originalJsonChars: 76210,
      },
    },
  },
  {
    id: "file-argument-render",
    createdAt: "2026-10-09T05:14:40.000Z",
    tone: "tool",
    kind: "tool.completed",
    summary: "moss__html_render — source file: /tmp/mcp-call.json",
    sequence: 1522,
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "moss__html_render — source file: /tmp/mcp-call.json",
      detail: "moss__html_render — source file: /tmp/mcp-call.json",
      data: {
        toolCallId: "call-file-argument-render",
        rawInput: {
          tool_input: {
            title: "2026 经营看板",
            height: 1320,
            html: "<!doctype html><html><head><title>2026 经营看板</title></head><body><!-- page body omitted --></body></html>",
          },
          tool_input_file: "/tmp/mcp-call.json",
          tool_name: "moss__html_render",
          variant: "UseTool",
        },
        rawOutput: {
          output: {
            OkayOutput:
              '{"htmlRender":{"attachmentId":"<attachment-id>","title":"2026 经营看板","height":1320}}',
          },
          server_name: "moss",
          tool_name: "html_render",
          type: "MCP",
        },
        kind: "other",
        locations: [],
        providerToolCallId: "call-file-argument-render",
      },
    },
  },
  {
    id: "inline-argument-render",
    createdAt: "2026-10-09T05:22:14.075Z",
    tone: "tool",
    kind: "tool.completed",
    summary: "moss__html_render",
    sequence: 1935,
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "moss__html_render",
      detail: "moss__html_render",
      data: {
        toolCallId: "call-inline-argument-render",
        rawInput: {
          tool_input: {
            title: "撤销测试",
            height: 200,
            html: "<!doctype html><html><head><title>撤销测试</title></head><body><!-- page body omitted --></body></html>",
          },
          tool_name: "moss__html_render",
          variant: "UseTool",
        },
        rawOutput: {
          output: {
            OkayOutput:
              '{"htmlRender":{"attachmentId":"<attachment-id>","title":"撤销测试","height":200}}',
          },
          server_name: "moss",
          tool_name: "html_render",
          type: "MCP",
        },
        kind: "other",
        locations: [],
        providerToolCallId: "call-inline-argument-render",
      },
    },
  },
] as const;
