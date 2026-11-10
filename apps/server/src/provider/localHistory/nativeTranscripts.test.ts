import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readClaudeSessionMessages, readCodexRolloutMessages } from "./nativeTranscripts";
import { titleFromText } from "./shared";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeJsonl(rows: ReadonlyArray<Record<string, unknown>>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-native-transcript-"));
  tempDirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n"));
  return file;
}

describe("Codex rollout transcripts", () => {
  it("reads what the person saw from completed items, never the injected model input", async () => {
    const file = await writeJsonl([
      { type: "session_meta", payload: { id: "t1", cwd: "/repo" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>…" }],
        },
      },
      {
        timestamp: "2026-11-01T08:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "UserMessage",
            id: "u1",
            content: [{ type: "text", text: "Fix the tests" }],
          },
        },
      },
      {
        timestamp: "2026-11-01T08:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "Fixed." }] },
        },
      },
      {
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "Reasoning", id: "r1" } },
      },
    ]);
    expect(await readCodexRolloutMessages(file)).toEqual([
      { id: "u1", role: "user", text: "Fix the tests", createdAt: "2026-11-01T08:00:00.000Z" },
      { id: "a1", role: "assistant", text: "Fixed.", createdAt: "2026-11-01T08:00:05.000Z" },
    ]);
  });

  it("falls back to the user/agent message events older Codex releases wrote", async () => {
    const file = await writeJsonl([
      { type: "event_msg", payload: { type: "user_message", message: "Hello" } },
      { type: "event_msg", payload: { type: "agent_message", message: "Hi there" } },
    ]);
    expect((await readCodexRolloutMessages(file)).map(({ role, text }) => [role, text])).toEqual([
      ["user", "Hello"],
      ["assistant", "Hi there"],
    ]);
  });
});

describe("Claude Code session transcripts", () => {
  it("follows the latest branch, joins split replies, and leaves out tool results and meta", async () => {
    const file = await writeJsonl([
      { type: "summary", summary: "Refactor parser" },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        message: { role: "user", content: "Refactor the parser" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "First part." }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        message: { id: "msg-1", role: "assistant", content: [{ type: "tool_use", name: "Edit" }] },
      },
      {
        type: "user",
        uuid: "t1",
        parentUuid: "a2",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "t1",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "Second part." }],
        },
      },
      // An abandoned branch from the first prompt.
      {
        type: "assistant",
        uuid: "x1",
        parentUuid: "u1",
        message: { id: "msg-x", role: "assistant", content: [{ type: "text", text: "Abandoned" }] },
      },
      {
        type: "user",
        uuid: "m1",
        parentUuid: "a3",
        isMeta: true,
        message: { role: "user", content: "Caveat: local command output" },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "m1",
        message: { role: "user", content: "<command-name>/clear</command-name>" },
      },
      {
        type: "user",
        uuid: "u3",
        parentUuid: "u2",
        isSidechain: false,
        message: { role: "user", content: [{ type: "text", text: "Thanks" }] },
      },
    ]);
    expect((await readClaudeSessionMessages(file)).map(({ role, text }) => [role, text])).toEqual([
      ["user", "Refactor the parser"],
      ["assistant", "First part.\n\nSecond part."],
      ["user", "Thanks"],
    ]);
  });
});

describe("conversation titles", () => {
  it("keeps one short line of the person's words", () => {
    expect(
      titleFromText(
        "以下是一次会话(session_id: 8c61690d-1234-4bcd-9abc-0123456789ab)的会话摘要与段摘要，请据此给出一个简短的总结并说明下一步",
      ),
    ).toBe("以下是一次会话的会话摘要与段摘要，请据此给出一个简短的总结并说明下一步");
    expect(
      titleFromText(
        "只回复 ROUTE_OK。这是一条合成连通性测试，用来确认路由是否正常工作，不需要做别的事情",
      ),
    ).toBe("只回复 ROUTE_OK。这是一条合成连通性测试，用来确认路由是否正常工作，不…");
    expect(titleFromText("## Fix the login bug\nmore details")).toBe("Fix the login bug");
    expect(titleFromText('<system-reminder>\nctx\n</system-reminder>\n"Quoted ask"')).toBe(
      "Quoted ask",
    );
    expect(titleFromText("   \n  ")).toBeUndefined();
    expect([...(titleFromText("x".repeat(100)) ?? "")]).toHaveLength(40);
  });
});
