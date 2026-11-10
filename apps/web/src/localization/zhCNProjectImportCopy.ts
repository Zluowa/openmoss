// FILE: zhCNProjectImportCopy.ts
// Purpose: Simplified Chinese for importing projects and conversations from other agents.
// Layer: Pure localization data
// Project and conversation titles pass through the patterns untouched.

import { phraseTranslator } from "./zhCNPhraseTable";

const PROJECT_IMPORT_COPY: Readonly<Record<string, string>> = {
  "Bring the conversations your agents already have on this computer into Moss.":
    "把这台电脑上各个智能体已有的对话导入 Moss。",
  "Could not find local projects.": "无法查找本地项目。",
  "Import failed. Try again.": "导入失败。请重试。",
  "Could not start the import.": "无法开始导入。",
  "Finding projects…": "正在查找项目…",
  "Scan again": "重新扫描",
  "Find projects": "查找项目",
  "Projects keep their existing folders, and conversations are copied into Moss. Nothing in your current projects changes.":
    "项目保留现有文件夹，对话会复制到 Moss 中。你当前的项目不会有任何变化。",
  "Include archived": "包括已归档的",
  "Select all": "全选",
  "No projects match your search.": "没有与搜索匹配的项目。",
  "No local projects found for these providers.": "未找到这些服务商的本地项目。",
  "History shows text messages; tool details and attachments may be missing.":
    "历史记录只显示文字消息；工具详情和附件可能缺失。",
  "Adds to existing": "添加到现有项目",
  "The folder moved or is missing. Link its new location to continue these conversations, or import the history alone.":
    "文件夹已移动或缺失。请关联它的新位置以继续这些对话，或只导入历史记录。",
  "All conversations are archived. Enable archived conversations to select them.":
    "所有对话都已归档。请启用已归档的对话后再选择。",
  "Links the existing folder without adding conversations.": "只关联现有文件夹，不添加对话。",
  "Untitled conversation": "未命名对话",
  "Already present": "已存在",
  "Could not load history.": "无法加载历史记录。",
  "Load earlier messages": "加载更早的消息",
  "Loading earlier messages…": "正在加载更早的消息…",
  "Retry loading earlier messages": "重新加载更早的消息",
  "Could not load earlier messages.": "无法加载更早的消息。",
  "Agents found on this computer": "在这台电脑上找到的智能体",
  "Looking for conversations from your agents…": "正在查找你的智能体留下的对话…",
  "Looking…": "正在查找…",
  "Could not look for conversations on this computer.": "无法在这台电脑上查找对话。",
  "ZCode chats": "ZCode 对话",
  "Choose projects": "选择项目",
  "Search projects…": "搜索项目…",
  "Add a folder instead": "改为添加文件夹",
  "Import conversations from your agents": "从你的智能体导入对话",
  "Stopping…": "正在停止…",
  "Moss is still busy starting up. Scan again in a moment.":
    "Moss 还在启动中，请稍后点「重新扫描」。",
  "No conversations from other agents were found on this computer.":
    "在这台电脑上没有找到其他智能体的对话。",
  "No conversations from other agents were found on this computer. Add a project folder to start.":
    "在这台电脑上没有找到其他智能体的对话。添加一个项目文件夹即可开始。",
  "Tick an agent above to import its conversations.": "勾选上方的智能体即可导入它的对话。",
  "Codex and Claude Code conversations continue where they left off; other agents' conversations are copied as messages.":
    "Codex 和 Claude Code 的对话可以接着继续；其他智能体的对话会以消息形式复制过来。",
  "This conversation has no text messages to copy.": "这个对话没有可复制的文字消息。",
  "History only": "仅历史记录",
  "Not imported": "未导入",
  "Moss couldn't add this conversation.": "Moss 无法添加这个对话。",
  "Moss was busy for a moment. It can try again.": "Moss 刚才有点忙，可以再试一次。",
  "Moss couldn't read this conversation's files.": "Moss 读不了这个对话的文件。",
  "The disk was busy. Moss can try again.": "磁盘正忙，Moss 可以再试一次。",
  "Choose an absolute project folder path.": "请选择一个完整路径的项目文件夹。",
  "Refresh the project list before importing.": "请先重新扫描，再导入。",
  "This conversation is no longer in the project preview. Refresh the list.":
    "这个对话已不在列表里。请重新扫描。",
  "The account this conversation was found in is unavailable. Refresh the list.":
    "找到这个对话的账号已不可用。请重新扫描。",
  "The provider's storage location changed. Refresh the project list.":
    "这个智能体的存储位置变了。请重新扫描。",
  "The selected project folder does not exist.": "所选的项目文件夹不存在。",
  "The destination project was removed while this import was pending.":
    "导入过程中目标项目已被移除。",
  "The import destination changed. Refresh the project list and retry.":
    "导入位置已变化。请重新扫描后再试。",
  "The import destination was removed. Retry to create a new conversation copy.":
    "导入位置已被移除。重试会创建一个新的对话副本。",
  "The imported project could not be loaded.": "无法加载导入的项目。",
  "The imported conversation no longer exists.": "这个导入的对话已不存在。",
  "The conversation file is no longer on this computer.": "这个对话的文件已不在这台电脑上。",
};

export const translateZhCnProjectImportCopyText = phraseTranslator(PROJECT_IMPORT_COPY, [
  [/^(\d+) conversations across (\d+) projects? selected\.$/, "已选择 $2 个项目中的 $1 个对话。"],
  [/^Importing (\d+) of (\d+)$/, "正在导入第 $1 个（共 $2 个）"],
  [/^(\d+) imported or already present\.$/, "$1 个已导入或已存在。"],
  [/^(\d+) conversations?$/, "$1 个对话"],
  [/^Conversations in (.+)$/, "$1 中的对话"],
  [/^New folder for (.+)$/, "$1 的新文件夹"],
  [/^Import Untitled conversation$/, "导入未命名对话"],
  [/^Import (\d+) conversations?$/, "导入 $1 个对话"],
  [/^Add (\d+) projects?$/, "添加 $1 个项目"],
  [/^Importing (\d+) of (\d+)…$/, "正在导入 $1/$2…"],
  [/^Retry (\d+) failed$/, "重试 $1 个失败项"],
  [/^(\d+) conversations? couldn't be imported$/, "$1 个对话未能导入"],
  [
    /^(\d+) imported\. Import stopped; the rest are still selected\.$/,
    "已导入 $1 个。导入已停止，其余仍保持选中。",
  ],
  [/^Not found: (.+) · (\d+) can't be copied \((.+)\)\.$/, "没有找到：$1 · $2 个无法复制（$3）。"],
  [/^Not found: (.+)\.$/, "没有找到：$1。"],
  [/^(\d+) can't be copied \((.+)\)\.$/, "$1 个无法复制（$2）。"],
  [
    /^Found (\d+) (.+?) conversations? that can't be copied: (.+) keeps them encrypted\.$/,
    "找到 $1 个 $2 对话，但无法复制：$3 对它们做了加密。",
  ],
  [
    /^Found (\d+) (.+?) conversations? that can't be copied yet: Moss can't read this (.+) format\.$/,
    "找到 $1 个 $2 对话，但暂时无法复制：Moss 还读不了这种 $3 格式。",
  ],
  [/^Could not look for conversations: (.+)$/, "无法查找对话：$1"],
  [
    /^This (.+) version stores conversations in a format Moss can't read yet\.$/,
    "这个 $1 版本保存对话的格式 Moss 暂时还读不了。",
  ],
]);
