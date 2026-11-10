// FILE: TopBarQuickActions.tsx
// Purpose: Icon-only quick actions beside the page title pill: 生成, 图像, 可视化 and ＋ (the
//          page's insert menu, which also holds 子页面). Each opens its card at the cursor, or
//          at the end of the page.
// Layer: Space page chrome slot `topBarQuickActions` — owned by page-ai. The slot sits in an
//        icon-only capsule (PageTopBar), so every action is a 28px PageChromeButton square.

import { PageImageIcon, PageVisualizeIcon, SparklesIcon } from "~/lib/icons";
import { pageAiKey, usePageAiSession } from "~/lib/pageAi/pageAiSession";

import { pageAiLocale, pageAiText } from "../ai/pageAiText";
import { PageChromeButton } from "./PageChromeButton";
import { PAGE_INSERT_SUBPAGE, PageInsertMenu } from "./PageInsertMenu";
import type { PageChromeSlotProps } from "./pageChromeContext";

export function TopBarQuickActions({ context }: PageChromeSlotProps) {
  const text = pageAiText(pageAiLocale());
  const session = usePageAiSession(
    pageAiKey(context.account, context.scopeSpaceId, context.page.id),
  );
  if (context.readOnly) return null;
  const editor = session.editor;
  const actions = [
    { icon: SparklesIcon, label: text.generate, mode: "generate" as const },
    { icon: PageImageIcon, label: text.image, mode: "image" as const },
    { icon: PageVisualizeIcon, label: text.visualize, mode: "visualize" as const },
  ];
  return (
    <>
      {actions.map((action) => (
        <PageChromeButton
          key={action.mode}
          icon={action.icon}
          label={action.label}
          iconOnly
          active={session.openCard === action.mode}
          disabled={!editor}
          onClick={() => editor?.openAiInput(action.mode)}
        />
      ))}
      <PageInsertMenu
        editorReady={!!editor}
        onRun={(value) =>
          value === PAGE_INSERT_SUBPAGE ? context.createChildPage() : editor?.runInsertItem(value)
        }
      />
    </>
  );
}
