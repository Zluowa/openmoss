// FILE: PageTitleMenu.tsx
// Purpose: The page's title pill and the menu it opens: navigation, share, pin, rename,
//          duplicate, download, find and replace, page width and fonts, new window, activity,
//          files, move, schedule, keyboard shortcuts, delete.
// Layer: Space page chrome (owned by space-ui)

import type { LucideIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ChevronDownIcon } from "~/lib/icons";
import type { PageExportFormat } from "~/lib/pageExport";
import {
  PAGE_DOC_LANGUAGES,
  type PageEditorDocStyle,
  type PageEditorDocStylePatch,
} from "~/lib/pageRichEditorChannel";

import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
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
  /** 查找 / 查找和替换 in the page editor; absent where the editor is not the rich one. */
  onFind?: ((replace: boolean) => void) | undefined;
  /** 页面宽度 and 字体 for this page on this device. */
  docStyle?: PageEditorDocStyle | undefined;
  onDocStyle?: ((patch: PageEditorDocStylePatch) => void) | undefined;
  onShortcuts?: (() => void) | undefined;
  /** 建议模式: edits become proposals; absent where the editor cannot. */
  suggesting?: { on: boolean; toggle: () => void } | undefined;
  /** 朗读: the page read by the system voice; absent where speech is not available. */
  readAloud?: { state: "idle" | "playing" | "paused"; toggle: () => void } | undefined;
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
export const PAGE_FIND_SHORTCUT_LABEL = "Ctrl+H";

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
        {props.onFind ? (
          <MenuItem onClick={() => props.onFind?.(true)}>
            <span className="flex-1">{props.trashed ? "查找" : "查找和替换"}</span>
            <MenuShortcut>{props.trashed ? "Ctrl+F" : PAGE_FIND_SHORTCUT_LABEL}</MenuShortcut>
          </MenuItem>
        ) : null}
        {props.docStyle && props.onDocStyle ? (
          <>
            <MenuSub>
              <MenuSubTrigger>页面宽度</MenuSubTrigger>
              <MenuSubPopup className="w-40 min-w-40">
                <MenuRadioGroup
                  value={props.docStyle.width}
                  onValueChange={(width) =>
                    props.onDocStyle?.({ width: width as PageEditorDocStyle["width"] })
                  }
                >
                  <MenuRadioItem value="default">默认宽度</MenuRadioItem>
                  <MenuRadioItem value="wide">宽页面</MenuRadioItem>
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>字体</MenuSubTrigger>
              <MenuSubPopup className="w-40 min-w-40">
                <MenuGroup>
                  <MenuGroupLabel>标题</MenuGroupLabel>
                  <MenuRadioGroup
                    value={props.docStyle.headingFont}
                    onValueChange={(font) =>
                      props.onDocStyle?.({
                        headingFont: font as PageEditorDocStyle["headingFont"],
                      })
                    }
                  >
                    <MenuRadioItem value="sans">无衬线</MenuRadioItem>
                    <MenuRadioItem value="serif" className="font-serif">
                      衬线
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>正文</MenuGroupLabel>
                  <MenuRadioGroup
                    value={props.docStyle.textFont}
                    onValueChange={(font) =>
                      props.onDocStyle?.({ textFont: font as PageEditorDocStyle["textFont"] })
                    }
                  >
                    <MenuRadioItem value="sans">无衬线</MenuRadioItem>
                    <MenuRadioItem value="serif" className="font-serif">
                      衬线
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>文档语言</MenuSubTrigger>
              <MenuSubPopup className="w-44 min-w-44">
                <MenuGroupLabel>用于读屏和拼写检查</MenuGroupLabel>
                <MenuRadioGroup
                  value={props.docStyle.lang ?? "auto"}
                  onValueChange={(lang) =>
                    props.onDocStyle?.(
                      lang === "auto"
                        ? { lang: undefined }
                        : { lang: lang as NonNullable<PageEditorDocStyle["lang"]> },
                    )
                  }
                >
                  <MenuRadioItem value="auto">跟随 Moss</MenuRadioItem>
                  {PAGE_DOC_LANGUAGES.map((language) => (
                    <MenuRadioItem key={language.tag} value={language.tag} lang={language.tag}>
                      {language.name}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          </>
        ) : null}
        {props.suggesting && !props.trashed ? (
          <MenuItem onClick={props.suggesting.toggle}>
            {props.suggesting.on ? "退出建议模式" : "建议模式"}
          </MenuItem>
        ) : null}
        {props.readAloud ? (
          <MenuItem onClick={props.readAloud.toggle}>
            {props.readAloud.state === "playing"
              ? "暂停朗读"
              : props.readAloud.state === "paused"
                ? "继续朗读"
                : "朗读页面"}
          </MenuItem>
        ) : null}
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
        {props.onShortcuts ? <MenuItem onClick={props.onShortcuts}>键盘快捷键</MenuItem> : null}
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
