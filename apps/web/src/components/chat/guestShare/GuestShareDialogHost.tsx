// FILE: GuestShareDialogHost.tsx
// Purpose: Mounts the one app-wide "Share with guest" dialog for whichever thread asked
//          for it (chat header, sidebar thread menu).
// Layer: Chat UI host
// Exports: GuestShareDialogHost
// Depends on: guestShareDialogStore, router (account sign-in)

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useGuestShareDialogStore } from "~/guestShareDialogStore";
import { GuestShareDialog } from "./GuestShareDialog";

export function GuestShareDialogHost() {
  const threadId = useGuestShareDialogStore((state) => state.threadId);
  const close = useGuestShareDialogStore((state) => state.close);
  const navigate = useNavigate();
  // The dialog keeps its thread while it animates closed, so the content does not vanish
  // a frame before the popup does.
  const [retainedThreadId, setRetainedThreadId] = useState(threadId);
  useEffect(() => {
    if (threadId !== null) setRetainedThreadId(threadId);
  }, [threadId]);
  const shownThreadId = threadId ?? retainedThreadId;
  if (shownThreadId === null) return null;
  return (
    <GuestShareDialog
      key={shownThreadId}
      threadId={shownThreadId}
      open={threadId !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onSignIn={() => {
        close();
        void navigate({ to: "/login" });
      }}
    />
  );
}
