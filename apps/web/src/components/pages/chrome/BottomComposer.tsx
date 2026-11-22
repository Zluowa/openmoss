// FILE: BottomComposer.tsx
// Purpose: Claude-1:1 centered bottom floating pill toolbar for Docs pages (`Fonts`, quick insert
//          actions, `More ...` with page-width toggle, `评论`, and `问 Moss` bound in place to the
//          SpaceCanvasChatDock). Respects `--foot-bar-room` (60px) clearance and avoids raw HTML
//          buttons/shadows so `design:check` stays green.
// Layer: Space page chrome slot `bottomComposer`

import {
  ChevronDownIcon,
  CodeIcon,
  ListChecksIcon,
  ListTodoIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PageCommentIcon,
  PageImageIcon,
  SparklesIcon,
  TableIcon,
  TextSizeIcon,
} from "~/lib/icons";
import { pageAiKey, usePageAiSession } from "~/lib/pageAi/pageAiSession";
import { type PageEditorDocStyle, type PageEditorDocStylePatch } from "~/lib/pageRichEditorChannel";

import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { pageDocStyleOf } from "../comments/pageDocComments";
import type { PageChromeSlotProps } from "./pageChromeContext";

export interface PageBottomComposerProps extends PageChromeSlotProps {
  readonly docStyle?: PageEditorDocStyle | undefined;
  readonly onDocStyle?: ((patch: PageEditorDocStylePatch) => void) | undefined;
}

export function BottomComposer({
  context,
  docStyle: docStyleProp,
  onDocStyle,
}: PageBottomComposerProps) {
  const session = usePageAiSession(
    pageAiKey(context.account, context.scopeSpaceId, context.page.id),
  );
  if (context.readOnly) return null;

  const editor = session.editor;
  const dock = context.dock ?? null;
  const docStyle = docStyleProp ?? pageDocStyleOf(context.page);
  const isWide = docStyle.width === "wide";
  const commentsOpen = context.activePanel === "comments";

  const handleAskMoss = () => {
    if (dock) {
      void dock.ask();
      return;
    }
    editor?.openAiInput("generate");
  };

  return (
    <div
      className="pointer-events-none sticky bottom-0 z-10 flex min-h-[60px] items-end justify-center px-4 pb-3 pt-1"
      data-page-composer
    >
      <div
        role="toolbar"
        aria-label="文档底部工具栏"
        className="pointer-events-auto inline-flex h-10 max-w-full flex-nowrap items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-popover/95 px-2 shadow-xl backdrop-blur-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* Fonts & headings */}
        <Menu modal={false}>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                aria-label="字体与标题"
                className="h-7 shrink-0 gap-1 rounded-full px-2.5 text-ui-sm text-foreground"
              />
            }
          >
            <TextSizeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span>字体</span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" side="top" className="w-52 min-w-52">
            <MenuGroup>
              <MenuGroupLabel>段落层级</MenuGroupLabel>
              <MenuItem disabled={!editor} onClick={() => editor?.runInsertItem("h1")}>
                <span>一级标题</span>
              </MenuItem>
              <MenuItem disabled={!editor} onClick={() => editor?.runInsertItem("h2")}>
                <span>二级标题</span>
              </MenuItem>
              <MenuItem disabled={!editor} onClick={() => editor?.runInsertItem("h3")}>
                <span>三级标题</span>
              </MenuItem>
            </MenuGroup>
            {onDocStyle ? (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>标题字体</MenuGroupLabel>
                  <MenuRadioGroup
                    value={docStyle.headingFont}
                    onValueChange={(value) =>
                      onDocStyle({ headingFont: value as PageEditorDocStyle["headingFont"] })
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
                  <MenuGroupLabel>正文字体</MenuGroupLabel>
                  <MenuRadioGroup
                    value={docStyle.textFont}
                    onValueChange={(value) =>
                      onDocStyle({ textFont: value as PageEditorDocStyle["textFont"] })
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
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>

        {/* Quick insert shortcuts */}
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="插入表格"
          tooltip="插入表格"
          tooltipSide="top"
          disabled={!editor}
          className="h-7 w-7 shrink-0 rounded-full"
          onClick={() => editor?.runInsertItem("table")}
        >
          <TableIcon className="size-3.5" />
        </IconButton>
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="插入图像"
          tooltip="插入图像"
          tooltipSide="top"
          disabled={!editor}
          className="h-7 w-7 shrink-0 rounded-full"
          onClick={() => editor?.runInsertItem("page_ai_image")}
        >
          <PageImageIcon className="size-3.5" />
        </IconButton>
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="插入待办清单"
          tooltip="待办清单"
          tooltipSide="top"
          disabled={!editor}
          className="h-7 w-7 shrink-0 rounded-full"
          onClick={() => editor?.runInsertItem("todo")}
        >
          <ListChecksIcon className="size-3.5" />
        </IconButton>
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="插入列表"
          tooltip="无序列表"
          tooltipSide="top"
          disabled={!editor}
          className="h-7 w-7 shrink-0 rounded-full"
          onClick={() => editor?.runInsertItem("disc")}
        >
          <ListTodoIcon className="size-3.5" />
        </IconButton>

        {/* More ... */}
        <Menu modal={false}>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="更多操作"
                className="h-7 w-7 shrink-0 rounded-full"
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" aria-hidden />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="center" side="top" className="w-52 min-w-52">
            <MenuGroup>
              <MenuGroupLabel>常用块</MenuGroupLabel>
              <MenuItem disabled={!editor} onClick={() => editor?.runInsertItem("decimal")}>
                <span>有序列表</span>
              </MenuItem>
              <MenuItem disabled={!editor} onClick={() => editor?.runInsertItem("blockquote")}>
                <span>引用</span>
              </MenuItem>
              <MenuItem disabled={!editor} onClick={() => editor?.runInsertItem("code_block")}>
                <CodeIcon className="size-3.5 shrink-0" aria-hidden />
                <span>代码块</span>
              </MenuItem>
              <MenuItem disabled={!editor} onClick={() => editor?.runInsertItem("hr")}>
                <MinusIcon className="size-3.5 shrink-0" aria-hidden />
                <span>分隔线</span>
              </MenuItem>
              <MenuItem disabled={!editor} onClick={() => editor?.runInsertItem("callout")}>
                <span>强调块</span>
              </MenuItem>
              <MenuItem onClick={() => context.createChildPage()}>
                <span>新建子页面</span>
              </MenuItem>
            </MenuGroup>
            {onDocStyle ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => onDocStyle({ width: isWide ? "default" : "wide" })}>
                  <span>{isWide ? "恢复默认宽度" : "加宽页面"}</span>
                </MenuItem>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>

        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />

        {/* Comment panel toggle */}
        <Button
          size="xs"
          variant={commentsOpen ? "secondary" : "ghost"}
          aria-pressed={commentsOpen}
          className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-ui-sm"
          onClick={() => context.openPanel(commentsOpen ? null : "comments")}
        >
          <PageCommentIcon className="size-3.5 shrink-0" aria-hidden />
          <span>评论</span>
        </Button>

        {/* Ask Moss pill opening SpaceCanvasChatDock in place */}
        <Button
          size="xs"
          variant={dock?.busy ? "secondary" : "default"}
          data-page-ask-moss
          className="h-7 shrink-0 gap-1.5 rounded-full px-3 text-ui-sm font-medium tabular-nums"
          onClick={handleAskMoss}
        >
          <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
          <span>{dock?.busy && dock.statusLabel ? dock.statusLabel : "问 Moss"}</span>
        </Button>
      </div>
    </div>
  );
}
