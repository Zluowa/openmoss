// FILE: PageTitleMenu.tsx
// Purpose: The page's title pill and the menu it opens: navigation, share, pin, rename,
//          duplicate, download, new window, activity, files, move, schedule, delete.
// Layer: Space page chrome (owned by space-ui)

import type { LucideIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ChevronDownIcon } from "~/lib/icons";
import type { PageExportFormat } from "~/lib/pageExport";

import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { PAGE_CHROME_PILL_CLASS_NAME } from "./pageChromeStyles";

export interface PageTitleMenuActions {
  onNavigation: () => void;
  onShare: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDownload: (format: PageExportFormat) => void;
  onOpenInNewWindow: () => void;
  onActivity: () => void;
  onFiles: () => void;
  onMove?: (() => void) | undefined;
  onSchedule?: (() => void) | undefined;
  onContinueInChat: () => void;
  onEditSource?: (() => void) | undefined;
  onBackupDrafts: () => void;
  onTrash: () => void;
}

export const PAGE_NAVIGATION_SHORTCUT_LABEL = "Ctrl+Shift+E";

export function PageTitleMenu(
  props: PageTitleMenuActions & {
    title: string;
    icon: LucideIcon;
    pinned: boolean;
    trashed: boolean;
    sourceEditing: boolean;
  },
) {
  const Icon = props.icon;
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className={cn(PAGE_CHROME_PILL_CLASS_NAME, "max-w-[min(22rem,40vw)] min-w-0")}
            aria-label={`${props.title} 页面菜单`}
            data-page-title-pill
          />
        }
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{props.title || "未命名页面"}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" className="w-60 min-w-60">
        <MenuItem onClick={props.onNavigation}>
          <span className="flex-1">页面导航</span>
          <MenuShortcut>{PAGE_NAVIGATION_SHORTCUT_LABEL}</MenuShortcut>
        </MenuItem>
        {props.trashed ? null : (
          <>
            <MenuItem onClick={props.onShare}>分享</MenuItem>
            <MenuItem onClick={props.onTogglePin}>{props.pinned ? "取消置顶" : "置顶"}</MenuItem>
            <MenuItem onClick={props.onRename}>重命名</MenuItem>
            <MenuItem onClick={props.onDuplicate}>复制</MenuItem>
          </>
        )}
        <MenuSub>
          <MenuSubTrigger>下载</MenuSubTrigger>
          <MenuSubPopup className="w-44 min-w-44">
            <MenuItem onClick={() => props.onDownload("markdown")}>Markdown (.md)</MenuItem>
            <MenuItem onClick={() => props.onDownload("html")}>网页 (.html)</MenuItem>
            <MenuItem onClick={() => props.onDownload("docx")}>Word (.docx)</MenuItem>
            <MenuItem onClick={() => props.onDownload("pdf")}>PDF（打印）</MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuItem onClick={props.onOpenInNewWindow}>在新窗口中打开</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={props.onActivity}>页面动态</MenuItem>
        <MenuItem onClick={props.onFiles}>文件列表</MenuItem>
        {props.trashed ? null : (
          <>
            <MenuItem onClick={props.onContinueInChat}>在对话中继续</MenuItem>
            {props.onMove ? <MenuItem onClick={props.onMove}>移动到…</MenuItem> : null}
            {props.onSchedule ? <MenuItem onClick={props.onSchedule}>定时更新…</MenuItem> : null}
            {props.onEditSource ? (
              <MenuItem onClick={props.onEditSource}>
                {props.sourceEditing ? "返回文档编辑" : "编辑 Markdown 源码"}
              </MenuItem>
            ) : null}
          </>
        )}
        <MenuItem onClick={props.onBackupDrafts}>备份未保存草稿</MenuItem>
        {props.trashed ? null : (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={props.onTrash}>
              删除
            </MenuItem>
          </>
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
