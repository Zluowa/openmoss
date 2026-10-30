// FILE: RealtimeVoiceSettingsPanel.tsx
// Purpose: Configure persistent Realtime Voice, microphone, shortcut, and privacy preferences.
// Layer: Settings UI

import type {
  DesktopAppSnapState,
  RealtimeVoiceDescriptor,
  RealtimeVoiceId,
} from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  formatRealtimeVoiceShortcut,
  readRealtimeVoiceInputDevicePreference,
  readPersistedRealtimeVoicePreference,
  readRealtimeVoicePreference,
  readRealtimeVoiceScreenContextPreference,
  readRealtimeVoiceShortcutPreference,
  REALTIME_VOICE_CATALOG,
  realtimeVoiceShortcutFromKeyboardEvent,
  writeRealtimeVoiceInputDevicePreference,
  writeRealtimeVoicePreference,
  writeRealtimeVoiceScreenContextPreference,
  writeRealtimeVoiceShortcutPreference,
} from "~/lib/realtimeVoicePreferences";
import { resolveRealtimeVoiceMicrophoneHealth } from "~/lib/realtimeVoiceMicrophoneHealth";
import { readNativeApi } from "~/nativeApi";

import { RealtimeVoicePreviewPicker } from "./RealtimeVoicePreviewPicker";
import {
  loadRealtimeVoicePreviewManifest,
  type RealtimeVoicePreviewUrls,
} from "./realtimeVoicePreviewManifest";
import { SettingsRow, SettingsSection, SettingsSelectPopup } from "./SettingsPanelPrimitives";

const SYSTEM_DEFAULT_DEVICE_VALUE = "__moss_system_default_microphone__";
const GENERIC_SHORTCUT_ERROR = "Failed to update voice chat hotkey";

type VoiceCatalogState =
  | { readonly status: "error" | "loading" | "unavailable" }
  | { readonly status: "ready"; readonly voices: readonly RealtimeVoiceDescriptor[] };

type DeviceCatalogState =
  | { readonly status: "error" | "loading" }
  | { readonly status: "ready"; readonly devices: readonly MediaDeviceInfo[] };

export function filterRealtimeVoiceAudioInputs(
  devices: readonly MediaDeviceInfo[],
): readonly MediaDeviceInfo[] {
  return devices.filter(
    (device) =>
      device.kind === "audioinput" && device.deviceId.length > 0 && device.deviceId !== "default",
  );
}

function screenContextStatus(state: DesktopAppSnapState): string | null {
  if (state.status === "ready") return null;
  if (state.status === "permission-required") {
    return state.message ?? "Screen Recording permission is required.";
  }
  if (state.status === "unsupported") return "Screen context is unavailable on this platform.";
  return state.message ?? `AppSnap is ${state.status}.`;
}

function microphoneLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Microphone ${index + 1}`;
}

function exactAvailableVoices(
  availableVoices: readonly RealtimeVoiceDescriptor[],
): readonly RealtimeVoiceDescriptor[] {
  const availableIds = new Set(availableVoices.map((voice) => voice.id));
  return REALTIME_VOICE_CATALOG.filter((voice) => availableIds.has(voice.id));
}

export function RealtimeVoiceSettingsPanel() {
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalogState>({ status: "loading" });
  const [voiceId, setVoiceId] = useState<RealtimeVoiceId>(readRealtimeVoicePreference);
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [draftVoiceId, setDraftVoiceId] = useState<RealtimeVoiceId>(voiceId);
  const [voiceSaveState, setVoiceSaveState] = useState<"error" | "idle" | "saving">("idle");
  const [previewAvailability, setPreviewAvailability] = useState<"loading" | "ready">("loading");
  const [previewUrls, setPreviewUrls] = useState<RealtimeVoicePreviewUrls>({});

  const [deviceCatalog, setDeviceCatalog] = useState<DeviceCatalogState>({ status: "loading" });
  const [deviceId, setDeviceId] = useState<string | null>(readRealtimeVoiceInputDevicePreference);
  const [microphoneCaptureErrorName, setMicrophoneCaptureErrorName] = useState<string | null>(null);
  const microphonePermissionRequestRef = useRef<Promise<void> | null>(null);

  const [shortcut, setShortcut] = useState<string | null>(readRealtimeVoiceShortcutPreference);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutPending, setShortcutPending] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  const [screenContext, setScreenContext] = useState(readRealtimeVoiceScreenContextPreference);
  const [screenContextHelp, setScreenContextHelp] = useState<string | null>(null);

  const loadVoiceCatalog = useCallback(async () => {
    setVoiceCatalog({ status: "loading" });
    try {
      const api = readNativeApi();
      if (!api) throw new Error("Native API not found");
      const result = await api.realtimeVoice.listVoices();
      const voices = exactAvailableVoices(result.voices);
      const persistedVoice = readPersistedRealtimeVoicePreference();
      const defaultVoice = voices.some((voice) => voice.id === result.defaultVoice)
        ? result.defaultVoice
        : voices[0]?.id;
      const nextVoice =
        persistedVoice && voices.some((voice) => voice.id === persistedVoice)
          ? persistedVoice
          : defaultVoice;
      if (nextVoice) {
        setVoiceId(nextVoice);
        setDraftVoiceId(nextVoice);
      }
      setVoiceCatalog(voices.length > 0 ? { status: "ready", voices } : { status: "unavailable" });
    } catch {
      setVoiceCatalog({ status: "error" });
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    setDeviceCatalog({ status: "loading" });
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setDeviceCatalog({ status: "ready", devices: [] });
        return;
      }
      const devices = filterRealtimeVoiceAudioInputs(
        await navigator.mediaDevices.enumerateDevices(),
      );
      setDeviceCatalog({ status: "ready", devices });
    } catch {
      setDeviceCatalog({ status: "error" });
    }
  }, []);

  const requestMicrophonePermissionAndRefresh = useCallback(async () => {
    if (microphonePermissionRequestRef.current) {
      await microphonePermissionRequestRef.current;
      return;
    }
    const request = (async () => {
      if (navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
          setMicrophoneCaptureErrorName(null);
        } catch (cause) {
          setMicrophoneCaptureErrorName(
            cause instanceof DOMException && cause.name ? cause.name : "UnknownError",
          );
          // A denied prompt still needs a fresh enumeration for an accurate empty state.
        }
      }
      await refreshDevices();
    })();
    microphonePermissionRequestRef.current = request;
    try {
      await request;
    } finally {
      microphonePermissionRequestRef.current = null;
    }
  }, [refreshDevices]);

  const applyShortcut = useCallback(async (nextShortcut: string | null) => {
    setShortcutPending(true);
    setShortcutError(null);
    try {
      const desktopShortcut = window.desktopBridge?.realtimeVoice;
      if (!desktopShortcut) {
        setShortcut(nextShortcut);
        writeRealtimeVoiceShortcutPreference(nextShortcut);
        return;
      }
      const result = await desktopShortcut.setGlobalShortcut(nextShortcut);
      if (!result.registered) {
        setShortcut(result.shortcut);
        writeRealtimeVoiceShortcutPreference(result.shortcut);
        setShortcutError(result.reason ?? GENERIC_SHORTCUT_ERROR);
        return;
      }
      setShortcut(result.shortcut);
      writeRealtimeVoiceShortcutPreference(result.shortcut);
    } catch {
      setShortcutError(GENERIC_SHORTCUT_ERROR);
    } finally {
      setShortcutPending(false);
    }
  }, []);

  useEffect(() => {
    void loadVoiceCatalog();
    void refreshDevices();

    let previewCancelled = false;
    void loadRealtimeVoicePreviewManifest().then(
      (urls) => {
        if (previewCancelled) return;
        setPreviewUrls(urls);
        setPreviewAvailability("ready");
      },
      () => {
        if (previewCancelled) return;
        setPreviewUrls({});
        setPreviewAvailability("ready");
      },
    );

    const initialShortcut = readRealtimeVoiceShortcutPreference();
    const desktopShortcut = window.desktopBridge?.realtimeVoice;
    if (desktopShortcut) {
      setShortcutPending(true);
      void desktopShortcut
        .setGlobalShortcut(initialShortcut)
        .then((result) => {
          setShortcut(result.shortcut);
          if (result.shortcut !== initialShortcut) {
            writeRealtimeVoiceShortcutPreference(result.shortcut);
          }
          setShortcutError(result.registered ? null : (result.reason ?? GENERIC_SHORTCUT_ERROR));
        })
        .catch(() => setShortcutError(GENERIC_SHORTCUT_ERROR))
        .finally(() => setShortcutPending(false));
    }

    if (readRealtimeVoiceScreenContextPreference()) {
      void window.desktopBridge?.appSnap
        .setEnabled(true)
        .then((state) => setScreenContextHelp(screenContextStatus(state)))
        .catch(() => setScreenContextHelp("Screen context is unavailable."));
    }

    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      previewCancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [loadVoiceCatalog, refreshDevices]);

  useEffect(() => {
    if (!capturingShortcut) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturingShortcut(false);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        setCapturingShortcut(false);
        void applyShortcut(null);
        return;
      }
      const nextShortcut = realtimeVoiceShortcutFromKeyboardEvent(event);
      if (!nextShortcut) return;
      setCapturingShortcut(false);
      void applyShortcut(nextShortcut);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [applyShortcut, capturingShortcut]);

  const voices = voiceCatalog.status === "ready" ? voiceCatalog.voices : [];
  const selectedVoice = voices.find((voice) => voice.id === voiceId) ?? voices[0];
  const draftVoice =
    voices.find((voice) => voice.id === draftVoiceId) ?? selectedVoice ?? voices[0];

  const devices = deviceCatalog.status === "ready" ? deviceCatalog.devices : [];
  const selectedDeviceIndex = devices.findIndex((device) => device.deviceId === deviceId);
  const selectedDevice = devices[selectedDeviceIndex];
  const selectedDeviceLabel =
    deviceId === null
      ? "System default"
      : selectedDevice
        ? microphoneLabel(selectedDevice, selectedDeviceIndex)
        : deviceCatalog.status === "ready"
          ? "Unavailable microphone"
          : "Selected microphone";
  const microphoneHealth = resolveRealtimeVoiceMicrophoneHealth({
    audioInputCount: devices.length,
    captureErrorName: microphoneCaptureErrorName,
    enumerationAvailable: typeof navigator.mediaDevices?.enumerateDevices === "function",
    enumerationFailed: deviceCatalog.status === "error",
  });
  const microphoneStatus =
    deviceCatalog.status === "loading" || microphoneHealth.status === "ready" ? null : (
      <span
        className={
          microphoneHealth.status === "permission-denied" ||
          microphoneHealth.status === "unavailable"
            ? "text-destructive"
            : undefined
        }
      >
        {microphoneHealth.message}
        {microphoneHealth.actionLabel ? (
          <Button
            type="button"
            size="xs"
            variant="link"
            className="ml-1 h-auto p-0 align-baseline"
            onClick={() => void requestMicrophonePermissionAndRefresh()}
          >
            {microphoneHealth.actionLabel}
          </Button>
        ) : null}
      </span>
    );

  const openVoiceDialog = () => {
    if (!selectedVoice) return;
    setDraftVoiceId(selectedVoice.id);
    setVoiceSaveState("idle");
    setVoiceDialogOpen(true);
  };

  const saveVoice = async () => {
    if (!draftVoice || voiceSaveState === "saving") return;
    setVoiceSaveState("saving");
    await Promise.resolve();
    if (!writeRealtimeVoicePreference(draftVoice.id)) {
      setVoiceSaveState("error");
      return;
    }
    setVoiceId(draftVoice.id);
    setVoiceSaveState("idle");
    setVoiceDialogOpen(false);
  };

  const voiceControl = (() => {
    if (voiceCatalog.status === "loading") {
      return (
        <Button type="button" size="sm" variant="secondary" disabled>
          Loading…
        </Button>
      );
    }
    if (voiceCatalog.status === "error" || voiceCatalog.status === "unavailable") {
      return (
        <Button type="button" size="sm" variant="secondary" onClick={() => void loadVoiceCatalog()}>
          Retry
        </Button>
      );
    }
    return (
      <Button type="button" size="sm" variant="secondary" onClick={openVoiceDialog}>
        <span aria-hidden="true" className="size-3 rounded-full bg-blue-500" />
        {selectedVoice?.displayName}
      </Button>
    );
  })();

  const voiceLoadStatus =
    voiceCatalog.status === "error" ? (
      <span role="alert" className="text-destructive">
        Unable to load voice settings
      </span>
    ) : voiceCatalog.status === "unavailable" ? (
      <span role="status">No compatible voices are available</span>
    ) : null;

  return (
    <div className="space-y-8">
      <SettingsSection title="General">
        <SettingsRow
          title="Microphone"
          description="Used for voice chat and dictation"
          status={microphoneStatus}
          control={
            <Select
              value={deviceId ?? SYSTEM_DEFAULT_DEVICE_VALUE}
              onOpenChange={(open) => {
                if (open) void requestMicrophonePermissionAndRefresh();
              }}
              onValueChange={(value) => {
                if (value === null) return;
                const nextDeviceId = value === SYSTEM_DEFAULT_DEVICE_VALUE ? null : value;
                setDeviceId(nextDeviceId);
                writeRealtimeVoiceInputDevicePreference(nextDeviceId);
              }}
            >
              <SelectTrigger size="sm" className="w-full max-w-60 sm:w-56" aria-label="Microphone">
                <SelectValue>{selectedDeviceLabel}</SelectValue>
              </SelectTrigger>
              <SettingsSelectPopup align="end">
                <SelectItem value={SYSTEM_DEFAULT_DEVICE_VALUE}>System default</SelectItem>
                {devices.length > 0 ? <SelectSeparator /> : null}
                {devices.map((device, index) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {microphoneLabel(device, index)}
                  </SelectItem>
                ))}
                {deviceCatalog.status === "loading" ? (
                  <div
                    role="status"
                    className="px-3 py-2 text-center text-ui-sm text-muted-foreground"
                  >
                    Loading microphones
                  </div>
                ) : deviceCatalog.status === "error" ? (
                  <div role="alert" className="px-3 py-2 text-center text-ui-sm text-destructive">
                    Unable to load microphones
                  </div>
                ) : devices.length === 0 ? (
                  <div
                    role={microphoneHealth.status === "permission-denied" ? "alert" : "status"}
                    className="px-3 py-2 text-center text-ui-sm text-muted-foreground"
                  >
                    {microphoneHealth.message}
                  </div>
                ) : null}
              </SettingsSelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Voice chat">
        <SettingsRow
          title="Voice"
          description="Choose the voice Moss uses for new voice chats"
          status={voiceLoadStatus}
          control={voiceControl}
        />
        <SettingsRow
          title="Voice chat hotkey"
          description="Start voice chat from anywhere on desktop"
          status={
            shortcutError ? (
              <span role="alert" className="text-destructive">
                {shortcutError}
              </span>
            ) : null
          }
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Voice chat hotkey capture"
              disabled={shortcutPending}
              onClick={() => {
                setShortcutError(null);
                setCapturingShortcut(true);
              }}
            >
              {capturingShortcut ? "Press shortcut…" : formatRealtimeVoiceShortcut(shortcut)}
            </Button>
          }
        />
        <SettingsRow
          title="Screen context"
          description="Let Moss inspect the foreground app when you refer to what's on screen. macOS asks for access the first time Moss needs it"
          status={screenContextHelp}
          control={
            <Switch
              checked={screenContext}
              aria-label="Enable screen context for voice chat"
              onCheckedChange={(enabled) => {
                if (!enabled) {
                  setScreenContext(false);
                  setScreenContextHelp(null);
                  writeRealtimeVoiceScreenContextPreference(false);
                  return;
                }
                const appSnap = window.desktopBridge?.appSnap;
                if (!appSnap) {
                  setScreenContext(false);
                  setScreenContextHelp("Screen context requires the macOS desktop app.");
                  writeRealtimeVoiceScreenContextPreference(false);
                  return;
                }
                setScreenContext(true);
                setScreenContextHelp(null);
                writeRealtimeVoiceScreenContextPreference(true);
                void appSnap
                  .setEnabled(true)
                  .then(async (state) => {
                    const readyState =
                      state.status === "permission-required"
                        ? await appSnap.requestPermissions()
                        : state;
                    setScreenContextHelp(screenContextStatus(readyState));
                  })
                  .catch(() => setScreenContextHelp("Screen context could not be enabled."));
              }}
            />
          }
        />
      </SettingsSection>

      <Dialog
        open={voiceDialogOpen}
        onOpenChange={(open) => {
          if (!open && voiceSaveState === "saving") return;
          if (open && selectedVoice) setDraftVoiceId(selectedVoice.id);
          setVoiceSaveState("idle");
          setVoiceDialogOpen(open);
        }}
      >
        <DialogPopup className="max-w-md gap-0" showCloseButton={voiceSaveState !== "saving"}>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void saveVoice();
            }}
          >
            <DialogHeader className="px-5 pt-5">
              <DialogTitle>Choose a voice</DialogTitle>
            </DialogHeader>
            <DialogPanel className="px-5 pb-1">
              {draftVoice ? (
                <RealtimeVoicePreviewPicker
                  previewAvailability={previewAvailability}
                  previewUrls={previewUrls}
                  selectedVoiceId={draftVoice.id}
                  voices={voices}
                  onVoiceChange={(voice) => {
                    setVoiceSaveState("idle");
                    setDraftVoiceId(voice.id);
                  }}
                />
              ) : (
                <p role="status" className="py-6 text-center text-ui-lg text-muted-foreground">
                  No compatible voices are available
                </p>
              )}
              {voiceSaveState === "error" ? (
                <p role="alert" className="mt-2 text-center text-ui-lg text-destructive">
                  Unable to save voice
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter className="mt-4 px-5 pb-5">
              <Button
                type="button"
                variant="secondary"
                disabled={voiceSaveState === "saving"}
                onClick={() => setVoiceDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!draftVoice || voiceSaveState === "saving"}>
                {voiceSaveState === "saving" ? "Saving…" : "Done"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
