import {
  MOSSBOT_ROOM_ERROR_CODE_PREFIX,
  MOSSBOT_ROOM_ERROR_CODES,
  type MossbotRoomErrorCode,
} from "@moss/contracts";
import { useTranslation } from "~/localization";
import { translateZhCnPresentationText } from "~/localization/zhCN";

const ASSISTANT_COPY: Record<string, string> = {
  Pin: "置顶",
  Unpin: "取消置顶",
  Pinned: "已置顶",
  Unread: "未读",
  More: "更多",
  Back: "返回",
  "Back to assistants": "返回助手列表",
  Edit: "编辑",
  Search: "搜索",
  Copied: "已复制",
  Notifications: "通知",
  "Assistant actions": "助手操作",
  "View profile": "查看资料",
  "Find in conversation": "在聊天中查找",
  "Mark as unread": "标为未读",
  "Main assistant": "主助手",
  "Set as main assistant": "设为主助手",
  "Share as template…": "分享为模板…",
  "Share conversation…": "分享聊天…",
  "Show assistant": "显示助手",
  "Hide assistant": "隐藏",
  "Archive assistant": "归档助手",
  "Delete assistant": "删除助手",
  "Delete assistant…": "删除…",
  "Could not delete assistant": "无法删除助手",
  "Assistant deleted": "助手已删除",
  "Resume assistant": "恢复助手",
  "Pause assistant": "暂停助手",
  "Type the assistant name to confirm deletion": "输入助手名称以确认删除",
  "Deleting removes this assistant, its conversation, context and automations. Linked repositories stay unchanged.":
    "删除后将移除这个助手及其聊天记录、上下文和自动化任务，不影响关联的代码仓库。",
  "Your profile": "个人资料",
  "New assistant or group": "新建助手或群聊",
  "New conversation group": "新建分组",
  "Create conversation group": "创建分组",
  "Rename conversation group": "重命名分组",
  "Move to conversation group": "移至分组",
  "Conversation group actions": "分组操作",
  "Remove group, keep conversations": "移除分组（保留会话）",
  "Move up": "上移",
  "Move down": "下移",
  Ungrouped: "未分组",
  Conversations: "会话",
  "Loading conversations…": "正在加载会话…",
  "Could not load assistants.": "暂时无法加载助手。",
  "No matching conversations.": "没有匹配的会话。",
  "Your conversations will live here.": "你的会话会显示在这里。",
  "Move conversations here from their menu.": "从会话菜单中移入这个分组。",
  "Choose a unique name, up to 60 characters. Groups organize conversations on this device; chat members stay the same.":
    "请填写不重复的名称，最多 60 个字符。分组用于整理此设备上的会话，不影响群聊成员。",
  "Group chat actions": "群聊操作",
  "Open group chat": "打开群聊",
  "Hide group chat": "隐藏群聊",
  "Show group chat": "显示群聊",
  members: "位成员",
  "Saving…": "正在保存…",
  "Delete group chat…": "删除群聊…",
  "Delete group chat": "删除群聊",
  "Deleting removes this group chat and its conversation history. The assistants and their own chats stay.":
    "删除后将移除这个群聊及其聊天记录，各位助手和它们自己的聊天不受影响。",
  Delete: "删除",
  Cancel: "取消",
  "Open conversation": "打开聊天",
  "Conversation filters": "会话筛选",
  "Show hidden assistants": "显示已隐藏的助手",
  "Search assistants and groups": "搜索助手和群聊",
  "Clear search": "清除搜索",
  "Scheduled tasks": "定时任务",
  "Knowledge library": "资料库",
  Computer: "电脑",
  "Access settings": "访问设置",
  "Files and tools": "文件与工具",
  enabled: "已开启",
  "Notify me when this assistant finishes or needs me.": "助手完成任务或等你处理时通知你。",
  "Notification settings": "通知设置",
  "Review the name and instructions before sharing. Memory, conversations and account access stay private.":
    "分享前请检查名称和指令。模板不包含记忆、聊天记录和账号权限。",
  "Download template": "下载模板",
  "Copy template": "复制模板",
  "Could not copy. Download the template instead.": "复制失败，请下载模板。",
  "Search messages…": "搜索聊天内容…",
  "Enter at least two characters.": "请输入至少两个字符。",
  "matching messages": "条匹配消息",
  "No matching messages.": "没有找到匹配的消息。",
  "What would you like help with?": "你最想让我帮你做什么？",
  "Dismiss suggestions": "收起建议",
  "Email and calendar": "邮件和日程",
  "Research and writing": "查资料、写东西",
  "Shopping and reservations": "购物、订票订餐",
  "Code and projects": "写代码、看项目",
  "Just chat": "先随便聊聊",
  "Or answer in the conversation below": "或在下方聊天中回答",
};

// Stable failures the assistant and group services return. Anything else
// (transport, provider or stack text) is replaced by the generic retry line.
const ERROR_COPY: Record<string, string> = {
  "Choose an available Mossbot assistant.": "请选择一位可用的助手。",
  "Give the group a name.": "请给群聊起个名字。",
  "Group members changed. Reopen the member list.": "群成员已变更，请重新打开成员列表。",
  "Group settings are still being saved. Retry shortly.": "群聊设置还在保存，请稍后重试。",
  "Room not found.": "找不到这个群聊。",
  "Select each assistant once.": "每位助手只能选一次。",
  "Stop the group before changing its members or responder.":
    "请先停止群聊，再修改成员或默认回复者。",
  "The group project was deleted.": "这个群聊的项目已被删除。",
  "This group exchange reached its message limit.": "这轮群聊的消息数已达上限。",
  "This group exchange reached its turn limit.": "这轮群聊的回合数已达上限。",
  "This member conversation was deleted.": "这位成员的会话已被删除。",
  "You are not a member of this room.": "你不在这个群聊中。",
  "Choose at least one assistant.": "请至少选择一位助手。",
  "Choose a responder who is in the group.": "请选择一位群内成员作为回复者。",
  "Something went wrong. Please retry.": "操作没有完成，请重试。",
  "This message was already sent with different content.": "这条消息已经用不同的内容发送过了。",
  "This message request was already used with different content.":
    "这条消息已经用不同的内容发送过了。",
  "This room request was already used with different settings.":
    "这个群聊已经用不同的设置创建过了。",
  "Only an assistant that is replying can post to the group.": "只有正在回复的助手才能在群里发言。",
  "Several assistants share this name. Choose one from the member list.":
    "有几位助手同名，请从成员列表中选择。",
  "Several assistants share this name. Select the intended assistant from the member list.":
    "有几位助手同名，请从成员列表中选择。",
  "The group is unavailable right now. Please retry.": "群聊暂时不可用，请重试。",
  "This assistant could not reply. Please retry.": "这位助手没能回复，请重试。",
  "Could not create this assistant.": "无法创建这个助手，请重试。",
  Failed: "失败",
};

// The server's stable codes (`mossbot.<code>` on the wire, the bare code in a delivery's
// error) name the failure; each maps to one plain sentence. English wording stays for old data.
const CODE_COPY: Readonly<Record<MossbotRoomErrorCode, string>> = {
  room_not_found: "Room not found.",
  request_conflict: "This room request was already used with different settings.",
  duplicate_member: "Select each assistant once.",
  name_required: "Give the group a name.",
  saving: "Group settings are still being saved. Retry shortly.",
  not_member: "You are not a member of this room.",
  message_conflict: "This message was already sent with different content.",
  no_active_turn: "Only an assistant that is replying can post to the group.",
  message_limit: "This group exchange reached its message limit.",
  turn_limit: "This group exchange reached its turn limit.",
  members_changed: "Group members changed. Reopen the member list.",
  stop_first: "Stop the group before changing its members or responder.",
  project_deleted: "The group project was deleted.",
  member_thread_deleted: "This member conversation was deleted.",
  assistant_unavailable: "Choose an available Mossbot assistant.",
  ambiguous_name: "Several assistants share this name. Choose one from the member list.",
  unavailable: "The group is unavailable right now. Please retry.",
  member_turn_failed: "This assistant could not reply. Please retry.",
};

function errorCodeOf(cause: unknown): MossbotRoomErrorCode | null {
  const raw =
    typeof cause === "string"
      ? cause
      : typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code: unknown }).code)
        : "";
  const code = raw.startsWith(MOSSBOT_ROOM_ERROR_CODE_PREFIX)
    ? raw.slice(MOSSBOT_ROOM_ERROR_CODE_PREFIX.length)
    : raw;
  return (MOSSBOT_ROOM_ERROR_CODES as readonly string[]).includes(code)
    ? (code as MossbotRoomErrorCode)
    : null;
}

function errorMessageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return typeof cause.message === "string" ? cause.message : "";
  }
  return typeof cause === "string" ? cause : "";
}

/** One plain sentence for a failed assistant or group action, never raw diagnostic text. */
export function mossbotErrorText(
  cause: unknown,
  locale: string,
  fallback = "Something went wrong. Please retry.",
): string {
  const code = errorCodeOf(cause);
  const message = code ? CODE_COPY[code] : errorMessageOf(cause);
  const known = Object.keys(ERROR_COPY).find((english) => message.includes(english));
  const english = known ?? fallback;
  return locale === "zh-CN" ? (ERROR_COPY[english] ?? ASSISTANT_COPY[english] ?? english) : english;
}

/** Uses the shared Moss copy catalog for template names, dynamic statuses and aria labels. */
export function useMossbotCopy() {
  const { locale } = useTranslation();
  return {
    locale,
    t: (english: string) =>
      locale === "zh-CN"
        ? (ASSISTANT_COPY[english] ?? translateZhCnPresentationText(english))
        : english,
    errorText: (cause: unknown, fallback?: string) => mossbotErrorText(cause, locale, fallback),
  };
}
