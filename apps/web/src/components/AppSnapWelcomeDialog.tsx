// FILE: AppSnapWelcomeDialog.tsx
// Purpose: Introduce AppSnap once on supported desktop installs and route users
// directly to its opt-in setup panel. Either answer is remembered for good; Settings →
// AppSnap stays the way back.
// Layer: Root web overlay
//
// Rendered through the shared AnnouncementSheet. `AuthenticatedAppSnapWelcomeDialog`
// defers it until a Moss account is signed in.

import { Schema } from "effect";
import { useEffect, useState, type ReactNode } from "react";

import { flushLocalStorageToDisk, useLocalStorage } from "../hooks/useLocalStorage";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { CentralIcon } from "../lib/central-icons";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { AnnouncementSheet } from "./AnnouncementSheet";
import { openSettings as openSettingsDialog } from "~/settingsDialogStore";

const APP_SNAP_WELCOME_STORAGE_KEY = "moss:appsnap-welcome:v1";

const AppSnapWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type AppSnapWelcomeStorage = typeof AppSnapWelcomeStorageSchema.Type;

const INITIAL_STORAGE: AppSnapWelcomeStorage = { acknowledged: false };

export function AppSnapWelcomeDialog({
  children,
  deferred = false,
}: {
  children?: ReactNode;
  /** Signed out: the sheet waits (unacknowledged) and does not hold the children back. */
  deferred?: boolean;
}) {
  const [storage, setStorage] = useLocalStorage(
    APP_SNAP_WELCOME_STORAGE_KEY,
    INITIAL_STORAGE,
    AppSnapWelcomeStorageSchema,
  );
  const [open, setOpen] = useState(false);
  // Windows has no Option keys: AppSnap there runs on a key combination the person picks.
  const [windows, setWindows] = useState(false);
  const [probeSettled, setProbeSettled] = useState(false);
  const handedOff = useAnnouncementSheetSlotStore((state) => state.handedOff);
  // Both startup dialogs probe asynchronously; without arbitration a fresh macOS install
  // could stack this sheet on the welcome tour. Wait for the tour's gate and its close.
  const onboardingBlocking = useOnboardingDialogStore(
    (store) => !store.startupGateSettled || store.isOpen,
  );

  useEffect(() => {
    if (storage.acknowledged) {
      return;
    }

    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;

    let disposed = false;
    void bridge
      .getState()
      .then((state) => {
        if (disposed || !state.supported) return;
        setWindows(state.platform === "windows");
        setOpen(true);
      })
      .catch((error) => {
        // Do not acknowledge a failed probe: a transient desktop startup issue
        // should not permanently hide the introduction on the next launch.
        console.warn("[appsnap] Could not check welcome-dialog support", error);
      })
      .finally(() => {
        if (!disposed) setProbeSettled(true);
      });

    return () => {
      disposed = true;
    };
  }, [storage.acknowledged]);

  const acknowledge = () => {
    setOpen(false);
    setStorage({ acknowledged: true });
    // A stop within Chromium's delayed commit would otherwise bring the sheet back.
    flushLocalStorageToDisk();
  };

  const openSettings = () => {
    acknowledge();
    openSettingsDialog({ section: "appsnap" });
  };

  // Derived instead of synced: acknowledging closes the dialog in the same
  // render, so the effect never needs a synchronous setOpen(false).
  const dialogOpen = open && !storage.acknowledged && !onboardingBlocking && !deferred;

  return (
    <>
      {(storage.acknowledged || !window.desktopBridge?.appSnap || probeSettled) &&
      (!dialogOpen || handedOff)
        ? children
        : null}
      <AnnouncementSheet
        open={dialogOpen}
        hero={
          // Same glyph as the AppSnap settings panel this dialog links to.
          <span className="flex size-16 shrink-0 items-center justify-center rounded-card border border-[color:var(--color-border)] bg-muted/30 text-foreground">
            <CentralIcon name="screen-capture" className="size-8" />
          </span>
        }
        title="Moss AppSnaps are live!"
        description={
          windows ? (
            <>
              Pick a shortcut in AppSnap settings to snap any app&rsquo;s window into the task
              you&rsquo;re working in.
            </>
          ) : (
            <>
              Press both Option keys (⌥&thinsp;⌥) to snap any app&rsquo;s window into the task
              you&rsquo;re working in.
            </>
          )
        }
        dismissLabel="Not now"
        confirmLabel="Set up AppSnap"
        onDismiss={acknowledge}
        onConfirm={openSettings}
      />
    </>
  );
}
