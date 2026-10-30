// FILE: fixtures.ts
// Purpose: A believable shared Moss thread, in the owner's own stream shapes, for the dev
//          harness, screenshots, and the stream logic tests.
// Layer: Guest page dev harness (never bundled for production)

import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type GuestShareView,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
} from "@synara/contracts";

export const FIXTURE_THREAD_ID = ThreadId.makeUnsafe("thread-guest-fixture");
const PROJECT_ID = ProjectId.makeUnsafe("project-guest-fixture");
export const FIXTURE_SNAPSHOT_SEQUENCE = 100;

export interface GuestFixture {
  readonly view: GuestShareView;
  readonly snapshot: OrchestrationThreadDetailSnapshot;
  /** The reply still streaming when the snapshot was taken, and its full text. */
  readonly streaming: { readonly messageId: MessageId; readonly turnId: TurnId };
  readonly streamingText: string;
}

const at = (minutesAgo: number, seconds = 0) =>
  new Date(Date.now() - minutesAgo * 60_000 - seconds * 1000).toISOString();

type FixtureMessage = OrchestrationThread["messages"][number];

const message = (
  id: string,
  role: FixtureMessage["role"],
  text: string,
  createdAt: string,
  turnId: TurnId | null,
  extra: Partial<FixtureMessage> = {},
): FixtureMessage => ({
  id: MessageId.makeUnsafe(id),
  role,
  text,
  turnId,
  streaming: false,
  source: "native",
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

let activitySequence = 0;
const activity = (
  id: string,
  kind: string,
  summary: string,
  createdAt: string,
  turnId: TurnId,
  payload: OrchestrationThreadActivity["payload"],
  tone: OrchestrationThreadActivity["tone"] = "tool",
): OrchestrationThreadActivity => ({
  id: EventId.makeUnsafe(id),
  tone,
  kind,
  summary,
  payload,
  turnId,
  sequence: (activitySequence += 1),
  createdAt,
});

const command = (
  idBase: string,
  turnId: TurnId,
  startedAt: string,
  commandLine: string,
  stdout: string,
  exitCode = 0,
): OrchestrationThreadActivity[] => [
  activity(`${idBase}-start`, "tool.started", commandLine, startedAt, turnId, {
    itemType: "command_execution",
    title: commandLine,
    data: { toolCallId: idBase, item: { command: commandLine } },
  }),
  activity(`${idBase}-done`, "tool.completed", commandLine, startedAt, turnId, {
    itemType: "command_execution",
    title: commandLine,
    data: {
      toolCallId: idBase,
      item: { command: commandLine },
      rawOutput: { stdout, stderr: "", exitCode },
    },
  }),
];

const fileChange = (
  id: string,
  turnId: TurnId,
  createdAt: string,
  paths: ReadonlyArray<string>,
): OrchestrationThreadActivity =>
  activity(id, "tool.completed", `Edited ${paths.length} files`, createdAt, turnId, {
    itemType: "file_change",
    title: "File change",
    data: { item: { changes: paths.map((path) => ({ path, kind: "modified" })) } },
  });

interface Copy {
  readonly title: string;
  readonly u1: string;
  readonly a1: string;
  readonly guestQuestion: string;
  readonly a2: string;
  readonly plan: string;
  readonly u3: string;
  readonly streaming: string;
  readonly own: { readonly sent: string; readonly dismissed: string; readonly pending: string };
}

const ZH: Copy = {
  title: "修复登录页在微信里白屏",
  u1: "微信内置浏览器打开登录页是白屏，iOS 和 Android 都有。帮我查一下原因并修掉，顺便补个回归测试。",
  a1: "先看一下登录页的入口和构建配置，确认是运行时报错还是资源没加载。",
  guestQuestion: "能顺便看看 Android 微信的表现吗？",
  a2: "找到原因了：登录页用了 `structuredClone`，微信 X5 内核（Chromium 86）不支持，脚本在初始化时就抛错，所以整页白屏。下面是修复方案。",
  plan: [
    "# 修复微信登录页白屏",
    "",
    "1. `apps/web/src/login/session.ts` 改用 JSON 深拷贝，避免依赖 `structuredClone`。",
    "2. 构建目标降到 `chrome86`，让 Vite 自动补齐语法降级。",
    "3. 新增回归测试 `login.weixin.test.ts`，在模拟的 X5 UA 下断言页面能渲染。",
    "",
    "| 环境 | 修复前 | 修复后 |",
    "| --- | --- | --- |",
    "| iOS 微信 | 白屏 | 正常 |",
    "| Android 微信 | 白屏 | 正常 |",
  ].join("\n"),
  u3: "好，按这个方案改，跑一下全部测试，然后把改动整理成一个提交。",
  streaming:
    '测试全部通过（12 个）。提交前 pre-commit 钩子要求先格式化，已经跑过 `bun fmt`，现在重新提交：\n\n```sh\ngit commit -m "fix(login): render in WeChat X5 by dropping structuredClone"\n```',
  own: {
    sent: "能顺便看看 Android 微信的表现吗？",
    dismissed: "这个先别改了，产品说下周再说",
    pending: "登录成功后的跳转也要带上 redirect 参数，之前有用户反馈丢了。",
  },
};

const EN: Copy = {
  title: "Fix blank login page in WeChat",
  u1: "The login page is blank inside WeChat's browser on both iOS and Android. Find the cause, fix it, and add a regression test.",
  a1: "Looking at the login entry and the build config first, to tell a runtime error from a missing asset.",
  guestQuestion: "Can you check Android WeChat as well?",
  a2: "Found it: the login page calls `structuredClone`, which WeChat's X5 engine (Chromium 86) lacks, so the script throws during init and nothing renders. Here is the plan.",
  plan: [
    "# Fix the blank WeChat login page",
    "",
    "1. `apps/web/src/login/session.ts` deep-copies through JSON instead of `structuredClone`.",
    "2. The build target drops to `chrome86` so Vite downlevels syntax.",
    "3. A regression test, `login.weixin.test.ts`, renders the page under a simulated X5 UA.",
    "",
    "| Environment | Before | After |",
    "| --- | --- | --- |",
    "| iOS WeChat | blank | renders |",
    "| Android WeChat | blank | renders |",
  ].join("\n"),
  u3: "Good, go with that. Run the whole suite, then put it all in one commit.",
  streaming:
    'All 12 tests pass. The pre-commit hook asked for formatting first; `bun fmt` is done, committing again:\n\n```sh\ngit commit -m "fix(login): render in WeChat X5 by dropping structuredClone"\n```',
  own: {
    sent: "Can you check Android WeChat as well?",
    dismissed: "Leave this one, product wants to revisit next week",
    pending:
      "The redirect after login should keep the `redirect` param too, users reported losing it.",
  },
};

export function guestFixture(input: {
  readonly locale: "zh-CN" | "en";
  readonly shareId: string;
  readonly guestName: string;
  /** `running`: the last reply is still streaming. `idle`: the thread is settled. */
  readonly phase: "running" | "idle";
}): GuestFixture {
  const copy = input.locale === "zh-CN" ? ZH : EN;
  const turn1 = TurnId.makeUnsafe("turn-1");
  const turn2 = TurnId.makeUnsafe("turn-2");
  const turn3 = TurnId.makeUnsafe("turn-3");
  const streamingId = MessageId.makeUnsafe("m-6");
  const running = input.phase === "running";
  const attribution = `Message from guest ${input.guestName}, sent by the owner:\n\n`;
  activitySequence = 0;

  const messages: FixtureMessage[] = [
    message("m-1", "user", copy.u1, at(14), null, {
      attachments: [
        {
          type: "image",
          id: "att-screenshot-1" as never,
          name: "login-blank.png",
          mimeType: "image/png",
          sizeBytes: 182_400,
        },
      ],
    }),
    message("m-2", "assistant", copy.a1, at(13, 50), turn1),
    message("m-3", "user", `${attribution}${copy.guestQuestion}`, at(9), null),
    message("m-4", "assistant", copy.a2, at(7), turn2),
    message("m-5", "user", copy.u3, at(3), null),
    message("m-6", "assistant", running ? "" : copy.streaming, at(0, 30), turn3, {
      streaming: running,
    }),
  ];

  const activities: OrchestrationThreadActivity[] = [
    ...command(
      "cmd-rg",
      turn1,
      at(13, 40),
      "rg -n structuredClone apps/web/src",
      "apps/web/src/login/session.ts:18:  return structuredClone(session);\napps/web/src/login/session.ts:41:  const draft = structuredClone(defaults);",
    ),
    ...command(
      "cmd-cat",
      turn1,
      at(13, 20),
      "cat apps/web/vite.config.ts",
      "export default defineConfig({ build: { target: 'es2022' } })",
    ),
    fileChange("edit-1", turn2, at(8, 30), [
      "apps/web/src/login/session.ts",
      "apps/web/vite.config.ts",
    ]),
    fileChange("edit-2", turn2, at(7, 50), ["apps/web/src/login/login.weixin.test.ts"]),
    ...command(
      "cmd-test",
      turn3,
      at(2, 40),
      "bun run test",
      "✓ login.weixin.test.ts (3 tests) 412ms\n✓ session.test.ts (9 tests) 88ms\n\nTest Files  2 passed (2)\n     Tests  12 passed (12)",
    ),
    ...command(
      "cmd-commit",
      turn3,
      at(1, 20),
      "git commit -m 'fix(login): render in WeChat X5'",
      "husky - pre-commit hook exited with code 1 (error)\n  oxfmt --check\n  apps/web/src/login/session.ts: formatting differs",
      1,
    ),
    ...command("cmd-fmt", turn3, at(1, 5), "bun fmt", "Formatted 1 file"),
  ];

  const thread: OrchestrationThread = {
    id: FIXTURE_THREAD_ID,
    projectId: PROJECT_ID,
    title: copy.title,
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.3-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: "fix/wechat-login",
    worktreePath: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    latestTurn: {
      turnId: turn3,
      state: running ? "running" : "completed",
      requestedAt: at(3),
      startedAt: at(2, 55),
      completedAt: running ? null : at(0, 10),
      assistantMessageId: running ? null : streamingId,
    },
    createdAt: at(15),
    updatedAt: at(0, 30),
    deletedAt: null,
    handoff: null,
    messages,
    proposedPlans: [
      {
        id: "plan-1",
        turnId: turn2,
        planMarkdown: copy.plan,
        implementedAt: null,
        implementationThreadId: null,
        createdAt: at(7),
        updatedAt: at(7),
      },
    ],
    activities,
    checkpoints: [],
    session: {
      threadId: FIXTURE_THREAD_ID,
      status: running ? "running" : "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: running ? turn3 : null,
      lastError: null,
      updatedAt: at(0, 30),
    },
  };

  const view: GuestShareView = {
    shareId: input.shareId as GuestShareView["shareId"],
    guestName: input.guestName,
    expiresAt: new Date(Date.now() + 22.5 * 3_600_000).toISOString(),
    model: { provider: "codex", name: "gpt-5.3-codex" },
    messages: [
      {
        id: "g-1" as never,
        text: copy.own.sent,
        status: "sent",
        submittedAt: at(9, 5),
        attachments: [],
      },
      {
        id: "g-2" as never,
        text: copy.own.dismissed,
        status: "dismissed",
        submittedAt: at(5),
        attachments: [],
      },
      {
        id: "g-3" as never,
        text: copy.own.pending,
        status: "pending",
        submittedAt: at(1),
        attachments: [
          {
            type: "image",
            id: "att-pending-1" as never,
            name: "feedback.png",
            mimeType: "image/png",
            sizeBytes: 182_400,
          },
        ],
      },
    ],
  };

  return {
    view,
    snapshot: {
      snapshotSequence: FIXTURE_SNAPSHOT_SEQUENCE,
      thread,
      history: { totalMessageCount: messages.length + 4, olderCursor: null },
    },
    streaming: { messageId: streamingId, turnId: turn3 },
    streamingText: copy.streaming,
  };
}

/** An owner-side event with the envelope fields the store reducer expects. */
export function guestThreadEvent<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
  sequence: number,
  occurredAt: string = new Date().toISOString(),
): OrchestrationEvent {
  return {
    type,
    payload,
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: FIXTURE_THREAD_ID,
    occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as Extract<OrchestrationEvent, { type: TType }>;
}

/** A streamed slice of the fixture's live reply. */
export function streamingReplyEvent(
  fixture: GuestFixture,
  text: string,
  streaming: boolean,
  sequence: number,
): OrchestrationEvent {
  const now = new Date().toISOString();
  return guestThreadEvent(
    "thread.message-sent",
    {
      threadId: FIXTURE_THREAD_ID,
      messageId: fixture.streaming.messageId,
      role: "assistant",
      text,
      turnId: fixture.streaming.turnId,
      streaming,
      source: "native",
      createdAt: at(0, 30),
      updatedAt: now,
    },
    sequence,
    now,
  );
}
