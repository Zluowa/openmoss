// FILE: mossbotKidClips.ts
// Purpose: The pinwheel kid's animation clips, which clip each companion state plays, and the sampler that turns a
//          clip and a time into a pose — stepped like classic pixel art, or smooth (the pinwheel's turn and the body's
//          movement interpolated between keyframes while the drawing itself stays on whole pixels). Also which scene
//          the live turn calls for, and the transition from one scene into the next.
// Layer: Pure animation data and math (no DOM). Labels and names are for the mascot studio; the app never shows them.
// Exports: MOSSBOT_KID_CLIPS, MOSSBOT_KID_CLIP_GROUPS, MOSSBOT_KID_TICKS_PER_SECOND, mossbotKidClipFor,
//          mossbotKidClip, mossbotKidSceneFor, mossbotKidBridge, mossbotKidClipAfter, mossbotKidClipTicks,
//          sampleMossbotKidClip, and their types.
import type { MossbotCompanionState } from "../MossbotCompanion";
import { mossbotKidPose, type MossbotKidPose } from "./mossbotKidSprite";

/** Clips are authored in ticks of 1/12 s, the pace of classic sprite animation. */
export const MOSSBOT_KID_TICKS_PER_SECOND = 12;

export interface MossbotKidKeyframe {
  readonly ticks: number;
  readonly label: string;
  readonly pose: MossbotKidPose;
}

export interface MossbotKidClip {
  readonly id: string;
  readonly name: string;
  readonly group: "state" | "activity" | "scene";
  /** Where Moss would play it, in the studio's words. */
  readonly use: string;
  /** Played once, then `loop` repeats. */
  readonly enter: readonly MossbotKidKeyframe[];
  readonly loop: readonly MossbotKidKeyframe[];
}

const key = (
  ticks: number,
  fields: Partial<MossbotKidPose>,
  label: string,
): MossbotKidKeyframe => ({
  ticks,
  label,
  pose: mossbotKidPose(fields),
});

/** `count` keyframes turning the pinwheel 30° each, `every` ticks apiece. */
function spin(
  count: number,
  fields: Partial<MossbotKidPose>,
  label: string,
  every = 1,
  start = 0,
): MossbotKidKeyframe[] {
  return Array.from({ length: count }, (_, i) =>
    key(every, { ...fields, pin: ((start + i) % 3) * 30 }, label),
  );
}

function idleLoop(): MossbotKidKeyframe[] {
  return [
    key(30, {}, "站立"),
    key(1, { eyes: "blink" }, "眨眼"),
    key(26, {}, "站立"),
    key(1, { eyes: "blink" }, "眨眼"),
    key(2, {}, "站立"),
    key(1, { eyes: "blink" }, "眨眼"),
    key(18, { eyes: "look-l" }, "看左边"),
    key(10, { eyes: "look-r" }, "看右边"),
    key(12, {}, "站立"),
    key(2, { pin: 30 }, "风吹过"),
    key(2, { pin: 60 }, "风吹过"),
    key(3, { pin: 0 }, "风吹过"),
    key(4, { pin: 30 }, "风车变慢"),
    key(6, { pin: 60 }, "风车变慢"),
    key(10, { pin: 0 }, "风车停下"),
  ];
}

function typingRun(count: number): MossbotKidKeyframe[] {
  return Array.from({ length: count }, (_, i) =>
    key(2, { pin: (i % 3) * 30, props: [["laptop", i % 2]] }, "打字"),
  );
}

function writingRun(): MossbotKidKeyframe[] {
  return Array.from({ length: 5 }, (_, i) => key(3, { props: [["notebook", i]] }, "写字"));
}

function celebrateLoop(): MossbotKidKeyframe[] {
  const bounce = [0, -1, -2, -2, -1, 0, 0, 0, 0, -1, -2, -2, -1, 0, 0, 0];
  return bounce.map((dy, i) =>
    key(
      1,
      {
        dy,
        feet: dy < 0 ? "tuck" : "stand",
        eyes: "happy",
        arms: i % 8 < 5 ? "both-up" : "none",
        pin: (i % 3) * 30,
        props: [["confetti", i]],
      },
      dy < 0 ? "蹦起来" : "撒花",
    ),
  );
}

function workingLoop(): MossbotKidKeyframe[] {
  return Array.from({ length: 24 }, (_, i) =>
    key(
      1,
      { eyes: i >= 18 && i < 20 ? "blink" : "open", pin: (i % 3) * 30, dy: i % 12 < 6 ? 0 : -1 },
      "风车转",
    ),
  );
}

export const MOSSBOT_KID_CLIPS: readonly MossbotKidClip[] = [
  {
    id: "startup",
    name: "破壳",
    group: "state",
    use: "新建或打开助手时",
    enter: [
      key(6, { eyes: "closed", feet: "tuck", props: [["egg", 0]] }, "一颗蛋"),
      key(2, { eyes: "closed", feet: "tuck", dx: -1, props: [["egg", 0]] }, "晃一晃"),
      key(2, { eyes: "closed", feet: "tuck", dx: 1, props: [["egg", 0]] }, "晃一晃"),
      key(2, { eyes: "closed", feet: "tuck", dx: -1, props: [["egg", 0]] }, "晃一晃"),
      key(4, { eyes: "closed", feet: "tuck", props: [["egg", 1]] }, "裂开"),
      key(
        2,
        { eyes: "wide", body: "stretch", dy: -2, feet: "tuck", pin: 30, props: [["egg", 2]] },
        "顶开蛋壳",
      ),
      key(
        2,
        {
          eyes: "happy",
          dy: -3,
          feet: "tuck",
          arms: "both-up",
          pin: 60,
          props: [
            ["egg", 3],
            ["sparkle", 0],
          ],
        },
        "跳出来",
      ),
      key(2, { eyes: "happy", body: "squash", feet: "spread", props: [["sparkle", 1]] }, "落地"),
      key(3, { eyes: "happy", arms: "wave-up", pin: 30 }, "你好"),
      key(3, { eyes: "happy", arms: "wave-down", pin: 60 }, "你好"),
      key(3, { eyes: "happy", arms: "wave-up" }, "你好"),
      key(4, { eyes: "happy" }, "站稳"),
    ],
    loop: idleLoop(),
  },
  { id: "idle", name: "待机", group: "state", use: "空闲时", enter: [], loop: idleLoop() },
  {
    id: "listening",
    name: "在听",
    group: "state",
    use: "你在输入时",
    enter: [key(2, { eyes: "look-r" }, "转过来")],
    loop: [
      key(14, { eyes: "look-r" }, "听着"),
      key(3, { eyes: "look-r", body: "breath" }, "点头"),
      key(12, { eyes: "look-r" }, "听着"),
      key(1, { eyes: "blink" }, "眨眼"),
      key(2, { eyes: "look-r", pin: 30 }, "风车动一下"),
      key(3, { eyes: "look-r", pin: 60 }, "风车动一下"),
      key(12, { eyes: "look-r" }, "听着"),
    ],
  },
  {
    id: "thinking",
    name: "思考中",
    group: "state",
    use: "琢磨问题时",
    enter: [key(3, { eyes: "look-up" }, "抬头")],
    loop: [
      ...spin(8, { eyes: "look-up" }, "风车慢慢转", 2),
      ...spin(8, { eyes: "look-r" }, "风车慢慢转", 2, 2),
      key(1, { eyes: "blink", pin: 30 }, "眨眼"),
      ...spin(7, { eyes: "look-up" }, "风车慢慢转", 2, 2),
      ...spin(8, { eyes: "look-l" }, "风车慢慢转", 2),
    ],
  },
  {
    id: "working",
    name: "工作中",
    group: "state",
    use: "智能体正在工作时",
    enter: [key(2, { eyes: "look-up" }, "抬头")],
    loop: workingLoop(),
  },
  {
    id: "typing",
    name: "改文件",
    group: "activity",
    use: "改文件、写代码、操作电脑",
    enter: [key(4, { props: [["laptop", 2]] }, "打开电脑")],
    loop: [
      ...typingRun(9),
      key(6, { props: [["laptop", 2]] }, "停一下"),
      key(1, { eyes: "blink", props: [["laptop", 2]] }, "眨眼"),
      ...typingRun(9),
      key(8, { eyes: "look-up", props: [["laptop", 2]] }, "想一下"),
    ],
  },
  {
    id: "waiting",
    name: "等你确认",
    group: "state",
    use: "需要你批准或回答时",
    enter: [key(2, { eyes: "wide", arms: "reach-r", props: [["sign", 0]] }, "举牌")],
    loop: [
      key(10, { eyes: "wide", arms: "reach-r", props: [["sign", 0]] }, "看着你"),
      key(
        2,
        { eyes: "wide", arms: "reach-r", body: "squash", feet: "spread", props: [["sign", 1]] },
        "蹲",
      ),
      key(
        2,
        {
          eyes: "happy",
          arms: "reach-r",
          body: "stretch",
          dy: -2,
          feet: "tuck",
          pin: 30,
          props: [["sign", 0]],
        },
        "轻跳",
      ),
      key(
        2,
        {
          eyes: "wide",
          arms: "reach-r",
          body: "squash",
          feet: "spread",
          pin: 60,
          props: [["sign", 1]],
        },
        "落地",
      ),
      key(10, { eyes: "wide", arms: "reach-r", props: [["sign", 0]] }, "看着你"),
      key(1, { eyes: "blink", arms: "reach-r", props: [["sign", 0]] }, "眨眼"),
    ],
  },
  {
    id: "wave",
    name: "打招呼",
    group: "state",
    use: "见到你、有新消息时",
    enter: [key(4, {}, "站立"), key(2, { eyes: "happy" }, "看到你")],
    loop: [
      key(3, { eyes: "happy", arms: "wave-up", pin: 30 }, "挥手"),
      key(3, { eyes: "happy", arms: "wave-down", pin: 60 }, "挥手"),
      key(3, { eyes: "happy", arms: "wave-up" }, "挥手"),
      key(3, { eyes: "happy", arms: "wave-down", pin: 30 }, "挥手"),
      key(3, { eyes: "happy", arms: "wave-up", pin: 60 }, "挥手"),
      key(14, { eyes: "happy" }, "微笑"),
      key(1, { eyes: "blink" }, "眨眼"),
      key(16, {}, "站立"),
    ],
  },
  {
    id: "cheering",
    name: "完成啦",
    group: "state",
    use: "任务完成时",
    enter: [key(3, { body: "squash", feet: "spread", eyes: "happy" }, "蹲下")],
    loop: celebrateLoop(),
  },
  {
    id: "oops",
    name: "遇到问题",
    group: "state",
    use: "出错、需要你处理时",
    enter: [
      key(2, { eyes: "wide" }, "咦"),
      key(2, { eyes: "wide", dy: -1, feet: "tuck" }, "吓一跳"),
      key(3, { eyes: "wide" }, "站稳"),
    ],
    loop: [
      key(8, { eyes: "sad", props: [["sweat", 0]] }, "有点为难"),
      key(8, { eyes: "sad", props: [["sweat", 1]] }, "有点为难"),
      key(3, { eyes: "sad", pin: 30, props: [["sweat", 1]] }, "风车卡住"),
      key(5, { eyes: "sad", props: [["sweat", 0]] }, "风车卡住"),
      key(1, { eyes: "blink", props: [["sweat", 0]] }, "眨眼"),
      key(8, { eyes: "look-l", props: [["sweat", 0]] }, "等你看看"),
    ],
  },
  {
    id: "sleep",
    name: "打盹",
    group: "state",
    use: "很久没有操作时",
    enter: [
      key(6, { eyes: "blink" }, "犯困"),
      key(3, {}, "撑住"),
      key(8, { eyes: "closed" }, "闭眼"),
      key(4, { eyes: "closed", bend: 1 }, "风车垂下"),
    ],
    loop: [
      key(10, { eyes: "closed", bend: 2, props: [["zzz", 0]] }, "呼气"),
      key(10, { eyes: "closed", bend: 2, body: "breath", props: [["zzz", 1]] }, "吸气"),
      key(10, { eyes: "closed", bend: 2, props: [["zzz", 2]] }, "呼气"),
      key(10, { eyes: "closed", bend: 2, body: "breath", props: [["zzz", 3]] }, "吸气"),
    ],
  },
  {
    id: "reading",
    name: "读文件",
    group: "activity",
    use: "读取文件、查看代码时",
    enter: [key(3, { props: [["paper", 0]] }, "拿起文件")],
    loop: [
      key(5, { eyes: "look-l", props: [["paper", 0]] }, "从左读"),
      key(5, { eyes: "look-r", props: [["paper", 1]] }, "读到右边"),
      key(5, { eyes: "look-l", props: [["paper", 2]] }, "下一行"),
      key(5, { eyes: "look-r", props: [["paper", 3]] }, "读到右边"),
      key(2, { eyes: "blink", props: [["paper", 4]] }, "翻页"),
      key(2, { eyes: "open", pin: 30, props: [["paper", 4]] }, "翻页"),
    ],
  },
  {
    id: "command",
    name: "跑命令",
    group: "activity",
    use: "运行命令、跑测试时",
    enter: [key(3, { eyes: "look-r", props: [["terminal", 0]] }, "打开终端")],
    loop: Array.from({ length: 8 }, (_, i) =>
      key(
        3,
        { eyes: i === 6 ? "blink" : "look-r", pin: (i % 3) * 30, props: [["terminal", i]] },
        "看输出",
      ),
    ),
  },
  {
    id: "tool",
    name: "用工具",
    group: "activity",
    use: "调用应用、连接器和工具",
    enter: [key(3, { arms: "reach-r", props: [["wrench", 0]] }, "拿出扳手")],
    loop: [
      key(3, { arms: "reach-r", eyes: "look-r", props: [["wrench", 0]] }, "拧一下"),
      key(3, { arms: "reach-r", eyes: "look-r", pin: 30, props: [["wrench", 1]] }, "拧一下"),
      key(3, { arms: "reach-r", eyes: "look-r", props: [["wrench", 0]] }, "拧一下"),
      key(3, { arms: "reach-r", eyes: "look-r", pin: 60, props: [["wrench", 1]] }, "拧一下"),
      key(6, { arms: "reach-r", eyes: "happy", props: [["wrench", 0]] }, "拧好了"),
    ],
  },
  {
    id: "delegating",
    name: "派出子任务",
    group: "activity",
    use: "把任务分给几个子助手时",
    enter: [key(2, { eyes: "happy", arms: "both-up" }, "分头去")],
    loop: Array.from({ length: 12 }, (_, i) =>
      key(
        2,
        {
          eyes: i % 6 === 5 ? "blink" : "happy",
          arms: i % 4 < 2 ? "wave-up" : "wave-down",
          pin: (i % 3) * 30,
          props: [["helpers", i]],
        },
        "派出小帮手",
      ),
    ),
  },
  {
    id: "drawing",
    name: "画图",
    group: "activity",
    use: "生成图片时",
    enter: [key(3, { arms: "reach-r", eyes: "look-r", props: [["easel", 0]] }, "支起画板")],
    loop: Array.from({ length: 8 }, (_, i) =>
      key(
        3,
        {
          arms: i % 2 ? "reach-r" : "wave-down",
          eyes: i === 7 ? "happy" : "look-r",
          props: [["easel", i]],
        },
        "画一笔",
      ),
    ),
  },
  {
    id: "viewing",
    name: "看图",
    group: "activity",
    use: "查看图片、截图时",
    enter: [key(3, { props: [["picture", 0]] }, "拿起照片")],
    loop: [
      key(8, { eyes: "look-l", props: [["picture", 0]] }, "仔细看"),
      key(8, { eyes: "look-r", props: [["picture", 1]] }, "仔细看"),
      key(3, { eyes: "wide", props: [["picture", 0]] }, "看明白了"),
      key(6, { eyes: "happy", props: [["picture", 1]] }, "看明白了"),
    ],
  },
  {
    id: "replying",
    name: "回复中",
    group: "activity",
    use: "正在写回复时",
    enter: [key(2, { eyes: "happy", props: [["speech", 0]] }, "开口")],
    loop: [0, 1, 2, 0, 1, 2].map((frame, i) =>
      key(
        3,
        {
          eyes: i === 4 ? "blink" : "happy",
          dy: i % 2 ? -1 : 0,
          pin: (i % 3) * 30,
          props: [["speech", frame]],
        },
        "说着",
      ),
    ),
  },
  {
    id: "stalled",
    name: "重试中",
    group: "activity",
    use: "连接中断、正在重试时",
    enter: [key(2, { eyes: "look-up", props: [["hourglass", 0]] }, "等一下")],
    loop: [0, 1, 2, 3].map((frame) =>
      key(6, { eyes: frame === 3 ? "blink" : "look-up", props: [["hourglass", frame]] }, "等沙漏"),
    ),
  },
  {
    id: "search",
    name: "查资料",
    group: "activity",
    use: "浏览网页、搜索资料时",
    enter: [key(3, { arms: "reach-r", props: [["magnifier", 0]] }, "拿起放大镜")],
    loop: [
      key(6, { arms: "reach-r", eyes: "look-r", props: [["magnifier", 0]] }, "看右边"),
      key(
        6,
        { arms: "reach-r", eyes: "look-r", dx: 1, feet: "step-r", props: [["magnifier", 1]] },
        "往右挪",
      ),
      key(6, { arms: "reach-r", eyes: "look-l", props: [["magnifier", 0]] }, "看左边"),
      key(
        6,
        { arms: "reach-r", eyes: "look-l", dx: -1, feet: "step-l", props: [["magnifier", 1]] },
        "往左挪",
      ),
      key(3, { arms: "reach-r", eyes: "wide", props: [["magnifier", 0]] }, "找到了"),
      key(2, { arms: "reach-r", eyes: "happy", pin: 30, props: [["magnifier", 1]] }, "找到了"),
      key(2, { arms: "reach-r", eyes: "happy", pin: 60, props: [["magnifier", 0]] }, "找到了"),
      key(8, { arms: "reach-r", eyes: "happy", props: [["magnifier", 1]] }, "找到了"),
    ],
  },
  {
    id: "notes",
    name: "做计划",
    group: "activity",
    use: "制定计划、列待办时",
    enter: [key(3, { props: [["notebook", 0]] }, "翻开本子")],
    loop: [
      ...writingRun(),
      key(4, { props: [["notebook", 4]] }, "停笔"),
      ...spin(6, { eyes: "look-up", props: [["notebook", 4]] }, "想一下", 2),
      key(1, { eyes: "blink", props: [["notebook", 4]] }, "眨眼"),
      key(6, { eyes: "happy", props: [["notebook", 4]] }, "想好了"),
    ],
  },
  {
    id: "eureka",
    name: "灵光一现",
    group: "scene",
    use: "找到思路或答案时",
    enter: [
      ...spin(6, { eyes: "look-up" }, "想啊想"),
      ...spin(6, { eyes: "look-up" }, "想啊想", 2),
      key(2, { eyes: "wide", props: [["bulb", 0]] }, "咦"),
      key(2, { eyes: "wide", props: [["bulb", 1]] }, "亮了"),
      key(2, { body: "squash", feet: "spread", eyes: "happy", props: [["bulb", 2]] }, "蹲下"),
      key(
        2,
        { dy: -3, feet: "tuck", arms: "both-up", eyes: "happy", pin: 30, props: [["bulb", 2]] },
        "跳起来",
      ),
      key(
        2,
        { dy: -1, feet: "tuck", arms: "both-up", eyes: "happy", pin: 60, props: [["bulb", 2]] },
        "落下",
      ),
      key(2, { body: "squash", feet: "spread", eyes: "happy", props: [["bulb", 1]] }, "落地"),
    ],
    loop: [
      key(6, { eyes: "happy", props: [["bulb", 2]] }, "开心"),
      key(6, { eyes: "happy", props: [["bulb", 1]] }, "开心"),
    ],
  },
  {
    id: "coffee",
    name: "喝杯咖啡",
    group: "scene",
    use: "等待较久的任务时",
    enter: [key(3, { arms: "hold-r", props: [["cup", 0]] }, "端起咖啡")],
    loop: [
      key(4, { arms: "hold-r", props: [["cup", 0]] }, "端着"),
      key(4, { arms: "hold-r", props: [["cup", 1]] }, "端着"),
      key(4, { arms: "hold-r", props: [["cup", 0]] }, "端着"),
      key(4, { arms: "hold-r", props: [["cup", 1]] }, "端着"),
      key(3, { eyes: "closed", props: [["cup", 2]] }, "喝一口"),
      key(8, { eyes: "closed", props: [["cup", 2]] }, "喝一口"),
      key(4, { eyes: "happy", arms: "hold-r", props: [["cup", 0]] }, "真香"),
      key(6, { eyes: "happy", arms: "hold-r", props: [["cup", 1]] }, "真香"),
    ],
  },
];

export const MOSSBOT_KID_CLIP_GROUPS = [
  { id: "state", name: "伙伴状态" },
  { id: "activity", name: "工具场景" },
  { id: "scene", name: "其他场景" },
] as const;

/** Which clip the kid plays for each companion state. */
const CLIP_FOR_STATE: Record<MossbotCompanionState, string> = {
  idle: "idle",
  spawn: "startup",
  listening: "listening",
  thinking: "thinking",
  working: "working",
  busy: "typing",
  waiting: "waiting",
  notify: "wave",
  done: "cheering",
  error: "oops",
  sleeping: "sleep",
  greeting: "wave",
};

export function mossbotKidClipFor(state: MossbotCompanionState): MossbotKidClip {
  const id = CLIP_FOR_STATE[state] ?? "idle";
  return MOSSBOT_KID_CLIPS.find((clip) => clip.id === id) ?? MOSSBOT_KID_CLIPS[1]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenes from what the agent is really doing.

/** What the transcript's working line knows about the live turn (see chat/transcript/workingStatus.ts). */
export type MossbotKidActivity =
  | "thinking"
  | "replying"
  | "working"
  | "waiting"
  | "stalled"
  | "sending"
  | "done";

/** The running tool, as the transcript's work log describes it. */
export interface MossbotKidTool {
  readonly itemType?: string | undefined;
  readonly requestKind?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolTitle?: string | undefined;
  readonly label?: string | undefined;
  readonly command?: string | undefined;
  readonly hasSubagents?: boolean | undefined;
}

const ACTIVITY_SCENES: Record<Exclude<MossbotKidActivity, "working">, string> = {
  thinking: "thinking",
  replying: "replying",
  waiting: "waiting",
  stalled: "stalled",
  sending: "working",
  done: "cheering",
};

/** The scene (a clip id) for the live turn: its activity, and for a running tool, which tool it is. */
export function mossbotKidSceneFor(activity: MossbotKidActivity, tool?: MossbotKidTool): string {
  if (activity !== "working") return ACTIVITY_SCENES[activity];
  if (!tool) return "working";
  const text = [tool.toolName, tool.toolTitle, tool.label, tool.command]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (tool.itemType === "collab_agent_tool_call" || tool.hasSubagents) return "delegating";
  if (tool.itemType === "web_search" || /\b(web ?search|web ?fetch|browse|url)\b/.test(text))
    return "search";
  if (tool.itemType === "image_generation" || /\b(generate|create|draw)[\w ]*image/.test(text))
    return "drawing";
  if (tool.itemType === "image_view" || /\b(view image|screenshot)\b/.test(text)) return "viewing";
  if (tool.itemType === "file_change" || tool.requestKind === "file-change") return "typing";
  if (/\b(todo\w*|plan)\b/.test(text)) return "notes";
  if (/\b(edit|write|patch|apply_patch|multiedit)\b/.test(text)) return "typing";
  if (/\b(read|cat|head|tail|less|view|open)\b/.test(text)) return "reading";
  if (/\b(grep|rg|glob|find|search|ls)\b/.test(text)) return "search";
  if (tool.itemType === "command_execution" || tool.requestKind === "command") return "command";
  if (tool.itemType === "mcp_tool_call" || tool.itemType === "dynamic_tool_call") return "tool";
  return "working";
}

export function mossbotKidClip(id: string): MossbotKidClip {
  return MOSSBOT_KID_CLIPS.find((clip) => clip.id === id) ?? mossbotKidClipFor("idle");
}

// ---------------------------------------------------------------------------------------------------------------------
// Transitions. A scene never cuts to the next: the kid moves from whatever pose it is in into the next clip.

// Things the kid holds or sets up; they disappear and appear in a puff rather than popping.
const HELD = new Set([
  "laptop",
  "notebook",
  "cup",
  "magnifier",
  "paper",
  "picture",
  "terminal",
  "wrench",
  "easel",
  "speech",
  "sign",
  "hourglass",
]);
// Scenes whose motion is the pinwheel itself: entered by spinning it up rather than with a hop.
const SPINNING = new Set(["thinking", "working", "replying"]);

/**
 * The keyframes that carry the kid from `from` (the pose it shows now) into `to`.
 *
 * - Into sleep it blinks first; into an error it startles.
 * - Between two empty-handed scenes where the pinwheel does the work, the pinwheel spins up.
 * - Otherwise it hops: what it holds goes in a puff, it jumps with the pinwheel turning and a few sparkles, and lands
 *   in the next scene's pose, holding the next thing.
 */
export function mossbotKidBridge(from: MossbotKidPose, to: MossbotKidClip): MossbotKidKeyframe[] {
  const target = (to.enter[0] ?? to.loop[0])!.pose;
  const pin = from.pin;
  const still = { ...from, dx: 0, dy: 0, body: "normal" as const };
  if (to.id === "sleep") return [key(3, { ...still, eyes: "blink", props: [] }, "犯困")];
  if (to.id === "oops") {
    return [
      key(2, { ...still, eyes: "wide", dy: -1, feet: "tuck", props: [] }, "吓一跳"),
      key(1, { ...still, eyes: "wide", props: [] }, "站稳"),
    ];
  }
  const carrying = from.props.some(([name]) => HELD.has(name));
  const bringing = target.props.some(([name]) => HELD.has(name));
  if (!carrying && !bringing && SPINNING.has(to.id)) {
    return [3, 2, 2, 1, 1].map((ticks, i) =>
      key(ticks, { ...still, eyes: target.eyes, props: [], pin: pin + 30 * (i + 1) }, "风车转起来"),
    );
  }
  return [
    key(
      2,
      { ...still, body: "squash", feet: "spread", props: carrying ? [["poof", 0]] : [] },
      "蹲",
    ),
    key(
      1,
      {
        body: "stretch",
        dy: -2,
        feet: "tuck",
        eyes: "happy",
        pin: pin + 30,
        props: carrying ? [["poof", 1]] : [],
      },
      "起跳",
    ),
    key(
      2,
      {
        dy: -4,
        feet: "tuck",
        arms: "both-up",
        eyes: "happy",
        pin: pin + 60,
        props: [["sparkle", 0]],
      },
      "转一圈",
    ),
    key(
      1,
      {
        body: "stretch",
        dy: -2,
        feet: "tuck",
        eyes: "happy",
        pin: pin + 90,
        props: [["sparkle", 1]],
      },
      "落下",
    ),
    key(
      2,
      {
        ...target,
        dx: 0,
        dy: 0,
        body: "squash",
        feet: "spread",
        props: bringing ? [...target.props, ["poof", 2]] : target.props,
      },
      "落地",
    ),
  ];
}

/** `to`, entered through the transition from `from`. */
export function mossbotKidClipAfter(from: MossbotKidPose, to: MossbotKidClip): MossbotKidClip {
  return { ...to, enter: [...mossbotKidBridge(from, to), ...to.enter] };
}

export function mossbotKidClipTicks(frames: readonly MossbotKidKeyframe[]): number {
  return frames.reduce((sum, frame) => sum + frame.ticks, 0);
}

export interface MossbotKidSample {
  readonly pose: MossbotKidPose;
  /** The keyframe the pose comes from, for the studio's timeline. */
  readonly phase: "enter" | "loop";
  readonly index: number;
  /** Extra offset of the whole drawing, in stage pixels (fractional when smooth). */
  readonly offsetX: number;
  readonly offsetY: number;
}

const easeInOut = (t: number): number => t * t * (3 - 2 * t);

/** The shortest way between two pinwheel turns: the mark repeats every 90°, so 60° → 0° is a 30° step forward. */
function pinStep(from: number, to: number): number {
  const delta = (((to - from) % 90) + 90) % 90;
  return delta > 45 ? delta - 90 : delta;
}

/**
 * The pose a clip shows `elapsedMs` after it started: the entrance once, then the loop forever.
 *
 * Stepped mode is classic sprite animation: each keyframe holds still for its ticks. Smooth mode keeps every drawn
 * shape on whole pixels (eyes, arms and bodies still change on keyframes) but moves between keyframes: the pinwheel
 * turns continuously (it is re-rasterized at every whole degree) and the body glides from one position to the next,
 * offset on screen by fractions of a stage pixel. That is how a pixel sprite stays crisp and still looks fluid at the
 * display's own frame rate.
 */
export function sampleMossbotKidClip(
  clip: MossbotKidClip,
  elapsedMs: number,
  options: { smooth?: boolean } = {},
): MossbotKidSample {
  const tickMs = 1000 / MOSSBOT_KID_TICKS_PER_SECOND;
  let t = Math.max(0, elapsedMs) / tickMs;
  const enterTicks = mossbotKidClipTicks(clip.enter);
  let phase: "enter" | "loop" = "enter";
  if (t >= enterTicks) {
    phase = "loop";
    const loopTicks = mossbotKidClipTicks(clip.loop) || 1;
    t = (t - enterTicks) % loopTicks;
  }
  const frames = phase === "enter" ? clip.enter : clip.loop;
  let index = 0;
  while (index < frames.length - 1 && t >= frames[index]!.ticks) {
    t -= frames[index]!.ticks;
    index++;
  }
  const current = frames[index]!;
  if (!options.smooth) return { pose: current.pose, phase, index, offsetX: 0, offsetY: 0 };

  // The keyframe that follows, across the end of the entrance and the loop's own wrap.
  const next =
    index + 1 < frames.length
      ? frames[index + 1]!
      : phase === "enter"
        ? (clip.loop[0] ?? current)
        : clip.loop[0]!;
  // Move only during the last two ticks of a keyframe, so long holds stay still and short keyframes flow into each
  // other.
  const window = Math.min(current.ticks, 2);
  const u = Math.min(1, Math.max(0, (t - (current.ticks - window)) / window));
  const eased = easeInOut(u);
  const pin = current.pose.pin + pinStep(current.pose.pin, next.pose.pin) * u;
  return {
    pose: { ...current.pose, pin },
    phase,
    index,
    offsetX: (next.pose.dx - current.pose.dx) * eased,
    offsetY: (next.pose.dy - current.pose.dy) * eased,
  };
}
