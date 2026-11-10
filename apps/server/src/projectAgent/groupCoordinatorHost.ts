import { createHash } from "node:crypto";

import {
  MessageId,
  type ProjectAgentUserLocale,
  type ProjectKind,
  type ThreadId,
} from "@moss/contracts";
import { isGroupContainerKind } from "@moss/shared/projectContainers";
import { isWorkspaceRootWithin } from "@moss/shared/threadWorkspace";

export function isGroupCoordinatorHostProject(input: {
  readonly kind: ProjectKind | undefined;
  readonly workspaceRoot: string;
  readonly groupsWorkspaceRoot: string;
  readonly studioWorkspaceRoot: string;
}): boolean {
  if (!isGroupContainerKind(input.kind)) {
    return false;
  }
  if (input.kind === "studio") {
    return isWorkspaceRootWithin(input.workspaceRoot, input.studioWorkspaceRoot);
  }
  return isWorkspaceRootWithin(input.workspaceRoot, input.groupsWorkspaceRoot);
}

// Stored as a real chat message in the language the hub was set up in, and never rewritten: chat
// content stays as written, so a later language switch leaves it alone.
export function coordinatorWelcomeText(
  name: string | undefined,
  locale: ProjectAgentUserLocale = "en",
): string {
  if (locale === "zh-CN") {
    const hello = name ? `你好，${name}！` : "你好！";
    return `${hello}欢迎来到你的新 Hub。我负责协调这里的工作：有什么需要尽管告诉我，我会直接答复你，或者开启多个对话同时处理。\n\n这些对话会独立完成工作。右侧的 Hub 面板会显示哪些正在进行、哪些已完成、哪些需要你处理。我会留意进行中的工作，有事情完成或需要你处理时就发来进展。你也可以让我修改我的指令、添加代码仓库，或者定时向你发送进展。`;
  }
  return `Hi ${name ?? "there"}, welcome to your new hub. I coordinate the work here: ask for whatever you need, and I'll either answer you directly or start threads to work on things in parallel.\n\nThreads do the work on their own. The Hub panel on the right shows which ones are working, which are done, and which need you. I'll keep an eye on what's running and post updates when something finishes or needs you. You can also ask me to change my instructions, add repositories, or send you scheduled updates.`;
}

export function coordinatorWelcomeMessageId(threadId: ThreadId): MessageId {
  const hash = createHash("sha1").update(`${threadId}:welcome`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return MessageId.makeUnsafe(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}
