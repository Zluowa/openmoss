// FILE: PageShortcutsDialog.tsx
// Purpose: 键盘快捷键 for a 资料空间 page: the keys the page editor answers, grouped the way a
//          person looks for them (writing, blocks, find, comments and AI).
// Layer: Space page chrome
// Exports: PageShortcutsDialog, PAGE_SHORTCUT_GROUPS

import { isMacNavigatorPlatform } from "~/lib/utils";

import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Kbd, KbdGroup } from "../../ui/kbd";

/** Keys as written for Windows; `Mod` is Ctrl there and ⌘ on a Mac. */
export const PAGE_SHORTCUT_GROUPS: readonly {
  title: string;
  rows: readonly { label: string; keys: readonly string[] }[];
}[] = [
  {
    title: "书写",
    rows: [
      { label: "插入内容", keys: ["/"] },
      { label: "提及页面、文件或 Moss", keys: ["@"] },
      { label: "加粗", keys: ["Mod", "B"] },
      { label: "斜体", keys: ["Mod", "I"] },
      { label: "删除线", keys: ["Mod", "Shift", "S"] },
      { label: "行内代码", keys: ["Mod", "E"] },
      { label: "链接", keys: ["Mod", "K"] },
      { label: "同一块内换行", keys: ["Shift", "Enter"] },
      { label: "撤销", keys: ["Mod", "Z"] },
      { label: "重做", keys: ["Mod", "Shift", "Z"] },
    ],
  },
  {
    title: "块",
    rows: [
      { label: "标题 1–6", keys: ["Mod", "Alt", "1–6"] },
      { label: "代码块", keys: ["Mod", "Alt", "8"] },
      { label: "选中当前块", keys: ["Esc"] },
      { label: "复制块", keys: ["Mod", "D"] },
      { label: "上移块", keys: ["Mod", "Shift", "↑"] },
      { label: "下移块", keys: ["Mod", "Shift", "↓"] },
      { label: "列表缩进、表格下一格", keys: ["Tab"] },
      { label: "取消缩进、表格上一格", keys: ["Shift", "Tab"] },
    ],
  },
  {
    title: "查找",
    rows: [
      { label: "在页面中查找", keys: ["Mod", "F"] },
      { label: "查找和替换", keys: ["Mod", "H"] },
      { label: "下一个结果", keys: ["Enter"] },
      { label: "上一个结果", keys: ["Shift", "Enter"] },
      { label: "页面导航", keys: ["Mod", "Shift", "E"] },
    ],
  },
  {
    title: "评论和 AI",
    rows: [
      { label: "评论选中的文字", keys: ["Mod", "Alt", "M"] },
      { label: "下一条 / 上一条评论", keys: ["Alt", "↓ ↑"] },
      { label: "用 AI 修改选中的内容", keys: ["Mod", "J"] },
      { label: "发送评论", keys: ["Enter"] },
      { label: "评论里换行", keys: ["Shift", "Enter"] },
    ],
  },
];

export function PageShortcutsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mac = isMacNavigatorPlatform();
  const key = (name: string) =>
    name === "Mod" ? (mac ? "⌘" : "Ctrl") : name === "Alt" && mac ? "⌥" : name;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2" data-page-shortcuts>
            {PAGE_SHORTCUT_GROUPS.map((group) => (
              <section key={group.title} className="flex flex-col gap-1">
                <h3 className="mb-1 text-ui-sm font-medium text-muted-foreground">{group.title}</h3>
                {group.rows.map((row) => (
                  <div key={row.label} className="flex min-h-7 items-center justify-between gap-3">
                    <span className="text-ui">{row.label}</span>
                    <KbdGroup>
                      {row.keys.map((name, index) => (
                        <Kbd key={`${index}:${name}`}>{key(name)}</Kbd>
                      ))}
                    </KbdGroup>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
