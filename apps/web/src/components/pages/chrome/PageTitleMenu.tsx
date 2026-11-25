// FILE: PageTitleMenu.tsx
// Purpose: The page's title pill and menu, built on SpaceTitleMenu so 文档 shares the unified
//          资料空间 title menu shape while preserving every document action in 更多操作.
// Layer: Space page chrome (owned by space-ui)

import type { LucideIcon } from "~/lib/icons";
import type { PageExportFormat } from "~/lib/pageExport";
import {
  PAGE_DOC_LANGUAGES,
  type PageEditorDocStyle,
  type PageEditorDocStylePatch,
} from "~/lib/pageRichEditorChannel";

import { ComposerPickerMenuSubPopup } from "../../chat/ComposerPickerMenuPopup";
import { SpaceTitleMenu } from "../../spaceTypes/shared/SpaceEditorChrome";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
} from "../../ui/menu";

export interface PageTitleMenuActions {
  onNavigation: () => void;
  onShare: () => void;
  onTogglePin: () => void;
  /** 重命名: the title pill turns into a field in place; called with the new name. */
  onRename: (title: string) => void;
  onDuplicate: () => void;
  onDownload: (format: PageExportFormat) => void;
  onHistory?: (() => void) | undefined;
  comments?: { readonly open: boolean; readonly onToggle: () => void } | undefined;
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
  const languageMenu =
    props.docStyle && props.onDocStyle ? (
      <MenuSub>
        <MenuSubTrigger>文档语言</MenuSubTrigger>
        <ComposerPickerMenuSubPopup className="w-44 min-w-44">
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
            <MenuRadioItem closeOnClick value="auto">
              跟随 Moss
            </MenuRadioItem>
            {PAGE_DOC_LANGUAGES.map((language) => (
              <MenuRadioItem
                closeOnClick
                key={language.tag}
                value={language.tag}
                lang={language.tag}
              >
                {language.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </ComposerPickerMenuSubPopup>
      </MenuSub>
    ) : undefined;

  const moreMenu = (
    <MenuSub>
      <MenuSubTrigger>更多操作</MenuSubTrigger>
      <ComposerPickerMenuSubPopup className="w-60 min-w-60">
        <MenuItem onClick={props.onNavigation}>
          <span className="flex-1">页面导航</span>
          <MenuShortcut>{PAGE_NAVIGATION_SHORTCUT_LABEL}</MenuShortcut>
        </MenuItem>
        {props.trashed ? null : (
          <>
            <MenuItem onClick={props.onShare}>分享</MenuItem>
            <MenuItem onClick={props.onTogglePin}>{props.pinned ? "取消置顶" : "置顶"}</MenuItem>
          </>
        )}
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
              <ComposerPickerMenuSubPopup className="w-40 min-w-40">
                <MenuRadioGroup
                  value={props.docStyle.width}
                  onValueChange={(width) =>
                    props.onDocStyle?.({ width: width as PageEditorDocStyle["width"] })
                  }
                >
                  <MenuRadioItem closeOnClick value="default">
                    默认宽度
                  </MenuRadioItem>
                  <MenuRadioItem closeOnClick value="wide">
                    宽页面
                  </MenuRadioItem>
                </MenuRadioGroup>
              </ComposerPickerMenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>字体</MenuSubTrigger>
              <ComposerPickerMenuSubPopup className="w-40 min-w-40">
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
                    <MenuRadioItem closeOnClick value="sans">
                      无衬线
                    </MenuRadioItem>
                    <MenuRadioItem closeOnClick value="serif" className="font-serif">
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
                    <MenuRadioItem closeOnClick value="sans">
                      无衬线
                    </MenuRadioItem>
                    <MenuRadioItem closeOnClick value="serif" className="font-serif">
                      衬线
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
              </ComposerPickerMenuSubPopup>
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
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );

  return (
    <SpaceTitleMenu
      title={props.title}
      untitled="未命名文档"
      icon={props.icon}
      readOnly={props.trashed}
      menuLabel="页面菜单"
      inlineRenameLabel="文档名称"
      pillKind="page"
      onRename={props.onRename}
      onVersionHistory={props.onHistory}
      onDuplicate={props.trashed ? undefined : props.onDuplicate}
      exportItems={[
        { id: "markdown", label: "Markdown (.md)", onSelect: () => props.onDownload("markdown") },
        { id: "html", label: "网页 (.html)", onSelect: () => props.onDownload("html") },
        { id: "docx", label: "Word (.docx)", onSelect: () => props.onDownload("docx") },
        { id: "pdf", label: "PDF（打印）", onSelect: () => props.onDownload("pdf") },
      ]}
      comments={props.comments}
      languageMenu={languageMenu}
      moreMenu={moreMenu}
      onTrash={props.trashed ? undefined : props.onTrash}
    />
  );
}
