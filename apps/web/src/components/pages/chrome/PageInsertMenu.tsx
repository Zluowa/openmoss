// FILE: PageInsertMenu.tsx
// Purpose: The top bar's ＋: a dropdown of everything a page can insert (生成 / 新建 / 媒体 / 基础 /
//          提及). Choosing an item asks the page editor to run it at the cursor, the same item
//          the editor's own slash menu runs.
// Layer: Space page chrome — part of page-ai's `topBarQuickActions` slot.

import { AddPlusIcon } from "~/lib/icons";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuShortcut,
  MenuTrigger,
} from "../../ui/menu";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { pageAiLocale, pageAiText } from "../ai/pageAiText";
import {
  PAGE_CHROME_CAPSULE_BUTTON_CLASS_NAME,
  PAGE_CHROME_ICON_BUTTON_CLASS_NAME,
} from "./pageChromeStyles";

/** 子页面 is the page view's own flow; every other item runs in the editor. */
export const PAGE_INSERT_SUBPAGE = "page_subpage";

export function PageInsertMenu(props: {
  /** The page editor is connected; editor-run items wait for it. */
  editorReady: boolean;
  onRun: (value: string) => void;
}) {
  const text = pageAiText(pageAiLocale());
  return (
    <Menu>
      {/* PageChromeButton's capsule square; the trigger renders its own button for the menu. */}
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={text.insert}
            title={text.insert}
            className={cn(
              PAGE_CHROME_CAPSULE_BUTTON_CLASS_NAME,
              PAGE_CHROME_ICON_BUTTON_CLASS_NAME,
            )}
          />
        }
      >
        <AddPlusIcon aria-hidden className="size-4 shrink-0" />
      </MenuTrigger>
      <ComposerPickerMenuPopup
        align="start"
        className="max-h-[min(400px,70vh)] w-80 min-w-80 overflow-y-auto"
      >
        {text.insertMenu.map((section) => (
          <MenuGroup key={section.title}>
            <MenuGroupLabel>{section.title}</MenuGroupLabel>
            {section.items.map((item) => (
              <MenuItem
                key={item.value}
                disabled={!props.editorReady && item.value !== PAGE_INSERT_SUBPAGE}
                onClick={() => props.onRun(item.value)}
              >
                <CentralIcon name={item.icon} className="size-4 shrink-0 text-foreground/75" />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={
                      item.description
                        ? "max-w-[60%] flex-none truncate"
                        : "min-w-0 flex-1 truncate"
                    }
                  >
                    {item.label}
                  </span>
                  {item.description ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </span>
                {item.shortcut ? <MenuShortcut>{item.shortcut}</MenuShortcut> : null}
              </MenuItem>
            ))}
          </MenuGroup>
        ))}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
