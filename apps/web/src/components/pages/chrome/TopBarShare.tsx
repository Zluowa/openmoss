// FILE: TopBarShare.tsx
// Purpose: The 分享 button at the right end of the page top bar and the dialog it opens.
// Layer: Space page chrome slot, last part of `topBarRight` — owned by sharing. The title
//        menu's 分享 item calls `openPageShare` below.

import { useEffect, useState } from "react";

import { PageShareDialog, type PageShareTab } from "../sharing/PageShareDialog";
import type { PageChromeSlotProps } from "./pageChromeContext";
import { PAGE_CHROME_PILL_CLASS_NAME } from "./pageChromeStyles";

type ShareListener = (tab: PageShareTab) => void;
const listeners = new Set<ShareListener>();

/** Opens the share dialog from elsewhere in the chrome (the title menu's 分享, or 发布). */
export function openPageShare(tab: PageShareTab = "share") {
  for (const listener of listeners) listener(tab);
}

export function TopBarShare({ context }: PageChromeSlotProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PageShareTab>("share");
  useEffect(() => {
    const listener: ShareListener = (next) => {
      setTab(next);
      setOpen(true);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  if (context.page.trashedAt) return null;
  return (
    <>
      <button
        type="button"
        className={PAGE_CHROME_PILL_CLASS_NAME}
        onClick={() => {
          setTab("share");
          setOpen(true);
        }}
      >
        分享
      </button>
      <PageShareDialog
        open={open}
        onOpenChange={setOpen}
        account={context.account}
        scopeSpaceId={context.scopeSpaceId}
        page={context.page}
        flush={context.flush}
        initialTab={tab}
      />
    </>
  );
}
