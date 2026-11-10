// FILE: AdvancedSettingsPanel.tsx
// Purpose: What used to be the "System tools" page, folded into the pages people look in:
//          General › About (version, release notes, feature tour, sign-out, a repair action
//          that only appears when it is needed) and Keybindings › the config file row.
// Layer: Settings UI components
// Exports: AboutSettingsSection, KeybindingsFileRow

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { logoutCurrentBrowserSession } from "~/authLogout";
import { useFeatureTourStore } from "~/featureTour/store";
import { APP_VERSION } from "~/branding";
import { resolveAndPersistPreferredEditor } from "~/editorPreferences";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { serverAuthSessionQueryOptions, serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useStore } from "~/store";
import { createAllThreadsMessagelessSelector, createThreadShellsSelector } from "~/storeSelectors";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

/**
 * General › About. The repair row only exists when projects are present and no chat
 * history loaded — the one situation it fixes — so nobody else has to read about it.
 */
export function AboutSettingsSection(props: { onOpenReleaseHistory: () => void }) {
  const authSessionQuery = useQuery(serverAuthSessionQueryOptions());
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const threadShells = useStore(useMemo(() => createThreadShellsSelector(), []));
  const allThreadsMessageless = useStore(useMemo(() => createAllThreadsMessagelessSelector(), []));
  const projectCount = useStore((store) => store.projects.length);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const [isRepairingLocalState, setIsRepairingLocalState] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const shouldOfferRecoveryTools = useMemo(() => {
    if (!threadsHydrated || projectCount === 0) return false;
    return threadShells.length === 0 || allThreadsMessageless;
  }, [allThreadsMessageless, projectCount, threadShells.length, threadsHydrated]);

  const repairLocalState = useCallback(async () => {
    if (isRepairingLocalState) return;
    const api = readNativeApi() ?? ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      ["Repair local data?", "Moss rebuilds its project index. Your chats stay."].join("\n"),
    );
    if (!confirmed) return;

    setIsRepairingLocalState(true);
    await api.orchestration
      .repairState()
      .then((snapshot) => {
        syncServerReadModel(snapshot);
        toastManager.add({ type: "success", title: "Local data repaired" });
      })
      .catch(() => {
        toastManager.add({ type: "error", title: "Couldn't repair local data. Try again." });
      })
      .finally(() => {
        setIsRepairingLocalState(false);
      });
  }, [isRepairingLocalState, syncServerReadModel]);

  const logoutCurrentSession = useCallback(async () => {
    if (
      isLoggingOut ||
      !authSessionQuery.data?.authenticated ||
      !authSessionQuery.data.sessionMethod
    )
      return;
    const api = readNativeApi() ?? ensureNativeApi();
    setIsLoggingOut(true);
    const result = await logoutCurrentBrowserSession({
      confirm: () => api.dialogs.confirm("Sign out this browser?"),
      logout: () => api.server.logoutAuthSession(),
      navigate: (path) => window.location.assign(path),
      onError: () => toastManager.add({ type: "error", title: "Couldn't sign out. Try again." }),
    });
    if (result !== "redirecting") setIsLoggingOut(false);
  }, [isLoggingOut, authSessionQuery.data?.authenticated, authSessionQuery.data?.sessionMethod]);

  return (
    <SettingsSection title="About">
      <SettingsRow
        title="Version"
        description="Current version"
        control={
          <span className="text-ui leading-snug font-medium text-muted-foreground tabular-nums">
            {APP_VERSION}
          </span>
        }
      />
      <SettingsRow
        title="Release notes"
        description="What changed in each update."
        control={
          <Button size="xs" variant="outline" onClick={props.onOpenReleaseHistory}>
            View
          </Button>
        }
      />
      <SettingsRow
        title="Feature tour"
        description="A short look at what Moss can do."
        control={
          <Button size="xs" variant="outline" onClick={() => useFeatureTourStore.getState().open()}>
            Replay
          </Button>
        }
      />
      {shouldOfferRecoveryTools ? (
        <SettingsRow
          title="Repair local data"
          description="Use this if your chats don't show up. Your chats stay."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={isRepairingLocalState}
              onClick={() => void repairLocalState()}
            >
              {isRepairingLocalState ? "Repairing…" : "Repair"}
            </Button>
          }
        />
      ) : null}
      {authSessionQuery.data?.authenticated && authSessionQuery.data.sessionMethod ? (
        <SettingsRow
          title="This browser"
          description="Sign out and close this browser's connection."
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={isLoggingOut}
              onClick={() => void logoutCurrentSession()}
            >
              {isLoggingOut ? "Signing out…" : "Sign out"}
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/** Keybindings › the saved bindings file, for people who prefer editing it by hand. */
export function KeybindingsFileRow() {
  const configQuery = useQuery(serverConfigQueryOptions());
  const [isOpening, setIsOpening] = useState(false);
  const keybindingsConfigPath = configQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = configQuery.data?.availableEditors;

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      toastManager.add({ type: "error", title: "No editor found to open the file." });
      return;
    }
    setIsOpening(true);
    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch(() => {
        toastManager.add({ type: "error", title: "Couldn't open the file. Try again." });
      })
      .finally(() => setIsOpening(false));
  }, [availableEditors, keybindingsConfigPath]);

  return (
    <SettingsSection title="Advanced">
      <SettingsRow
        title="Keybindings file"
        description="Edit every shortcut in a text editor."
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!keybindingsConfigPath || isOpening}
            onClick={openKeybindingsFile}
          >
            {isOpening ? "Opening…" : "Open"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
