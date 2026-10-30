// FILE: RealtimeVoiceOnboarding.tsx
// Purpose: Gate the first Realtime Voice launch behind the source-faithful setup flow.
// Layer: Chat overlay

import type { RealtimeVoiceDescriptor, RealtimeVoiceId } from "@synara/contracts";
import { FoldersIcon, Loader2Icon, MonitorIcon, SparklesIcon, XIcon } from "~/lib/icons";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  readPersistedRealtimeVoicePreference,
  readRealtimeVoiceScreenContextPreference,
  REALTIME_VOICE_CATALOG,
  writeRealtimeVoicePreference,
  writeRealtimeVoiceScreenContextPreference,
} from "~/lib/realtimeVoicePreferences";
import { isMacPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

import { RealtimeVoicePreviewPicker } from "../settings/RealtimeVoicePreviewPicker";
import {
  loadRealtimeVoicePreviewManifest,
  type RealtimeVoicePreviewUrls,
} from "../settings/realtimeVoicePreviewManifest";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "../ui/dialog";
import { Switch } from "../ui/switch";

export const REALTIME_VOICE_ONBOARDING_COMPLETION_KEY =
  "moss.realtimeVoice.onboarding.completed.v1";
export const REALTIME_VOICE_ONBOARDING_COMPLETION_VALUE = "1";

type OnboardingStorage = Pick<Storage, "getItem" | "setItem">;

function resolveOnboardingStorage(storage?: OnboardingStorage | null): OnboardingStorage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function hasCompletedRealtimeVoiceOnboarding(storage?: OnboardingStorage | null): boolean {
  try {
    return (
      resolveOnboardingStorage(storage)?.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY) ===
      REALTIME_VOICE_ONBOARDING_COMPLETION_VALUE
    );
  } catch {
    return false;
  }
}

export function persistRealtimeVoiceOnboardingCompletion(
  storage?: OnboardingStorage | null,
): boolean {
  try {
    const target = resolveOnboardingStorage(storage);
    if (!target) return false;
    target.setItem(
      REALTIME_VOICE_ONBOARDING_COMPLETION_KEY,
      REALTIME_VOICE_ONBOARDING_COMPLETION_VALUE,
    );
    return true;
  } catch {
    return false;
  }
}

export interface RealtimeVoiceOnboardingCatalogSelection {
  readonly selectedVoiceId: RealtimeVoiceId | null;
  readonly voices: readonly RealtimeVoiceDescriptor[];
}

export function resolveRealtimeVoiceOnboardingCatalog(input: {
  readonly availableVoices: readonly RealtimeVoiceDescriptor[];
  readonly defaultVoice: RealtimeVoiceId;
  readonly persistedVoice: RealtimeVoiceId | null;
}): RealtimeVoiceOnboardingCatalogSelection {
  const availableIds = new Set(input.availableVoices.map((voice) => voice.id));
  const voices = REALTIME_VOICE_CATALOG.filter((voice) => availableIds.has(voice.id));
  const preferredVoice =
    input.persistedVoice && voices.some((voice) => voice.id === input.persistedVoice)
      ? input.persistedVoice
      : voices.some((voice) => voice.id === input.defaultVoice)
        ? input.defaultVoice
        : voices[0]?.id;
  return { selectedVoiceId: preferredVoice ?? null, voices };
}

type VoiceCatalogState =
  | { readonly status: "error" | "loading" }
  | {
      readonly status: "ready";
      readonly selectedVoiceId: RealtimeVoiceId;
      readonly voices: readonly RealtimeVoiceDescriptor[];
    }
  | { readonly status: "unavailable" };

interface RealtimeVoiceOnboardingProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCompleteStart: () => void | Promise<void>;
  /** Allows desktop shells and deterministic browser tests to provide the native platform. */
  readonly platform?: string;
}

function FeatureTip({
  description,
  icon,
  title,
}: {
  readonly description: string;
  readonly icon: React.ReactNode;
  readonly title: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-1 text-center sm:gap-2 sm:px-4">
      <div className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
        <span aria-hidden="true" className="text-primary">
          {icon}
        </span>
        <h2>{title}</h2>
      </div>
      <p className="max-w-md text-ui-lg leading-5 text-muted-foreground sm:leading-6">
        {description}
      </p>
    </div>
  );
}

function MossAppshotLogo() {
  return (
    <svg
      aria-hidden="true"
      className="h-20 w-24 object-contain"
      data-moss-realtime-voice-appshot-logo="true"
      viewBox="0 0 96 80"
    >
      <defs>
        <linearGradient id="moss-appshot-bracket" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#24d6ff" />
          <stop offset="1" stopColor="#1677ff" />
        </linearGradient>
        <filter id="moss-appshot-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.18" />
        </filter>
      </defs>
      <g fill="none" stroke="url(#moss-appshot-bracket)" strokeLinecap="round" strokeWidth="7">
        <path d="M7 25V11a4 4 0 0 1 4-4h16" />
        <path d="M69 7h16a4 4 0 0 1 4 4v14" />
        <path d="M89 55v14a4 4 0 0 1-4 4H69" />
        <path d="M27 73H11a4 4 0 0 1-4-4V55" />
      </g>
      <g filter="url(#moss-appshot-shadow)">
        <rect x="20" y="10" width="56" height="60" rx="11" fill="white" />
        <circle cx="29" cy="20" r="2.7" fill="#ff5f57" />
        <circle cx="37" cy="20" r="2.7" fill="#febc2e" />
        <circle cx="45" cy="20" r="2.7" fill="#28c840" />
        <path
          d="M29 34h30M29 42h38M29 50h32M29 58h22"
          stroke="#154080"
          strokeLinecap="round"
          strokeWidth="3.4"
        />
      </g>
    </svg>
  );
}

function StepShell({
  backAction,
  children,
  onSubmit,
  primaryAction,
  primaryClassName,
  primaryDisabled = false,
  primaryLoading = false,
}: {
  readonly backAction?: () => void;
  readonly children: React.ReactNode;
  readonly onSubmit: () => void;
  readonly primaryAction: string;
  readonly primaryClassName?: string;
  readonly primaryDisabled?: boolean;
  readonly primaryLoading?: boolean;
}) {
  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 pt-10 pb-1 sm:pt-5">
        {children}
      </div>
      <div className="flex w-full shrink-0 items-center justify-between gap-3 px-5 pb-5">
        {backAction ? (
          <Button type="button" variant="secondary" disabled={primaryLoading} onClick={backAction}>
            Back
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
        <Button
          type="submit"
          className={primaryClassName}
          disabled={primaryDisabled || primaryLoading}
        >
          {primaryLoading ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {primaryAction}
        </Button>
      </div>
    </form>
  );
}

function IntroductionStep({ onNext }: { readonly onNext: () => void }) {
  return (
    <StepShell primaryAction="Next" onSubmit={onNext}>
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 text-center sm:gap-8 sm:pt-4">
        <h1 className="text-[28px] leading-tight font-normal tracking-tight text-foreground">
          Meet Moss Voice
        </h1>
        <div className="flex w-full max-w-lg flex-col gap-5 sm:gap-8">
          <FeatureTip
            icon={<FoldersIcon className="size-5" />}
            title="Work across projects"
            description="Start new tasks, coordinate work in progress, and pick up where you left off—without micromanaging"
          />
          <FeatureTip
            icon={<MonitorIcon className="size-5" />}
            title="Work across your desktop"
            description="Use your files, apps, and connected tools—from Slack and GitHub to Notion and beyond"
          />
          <FeatureTip
            icon={<SparklesIcon className="size-5" />}
            title="Explore, plan, and learn"
            description="Talk through a PR, ask questions about a codebase, or learn a new topic through natural back-and-forth"
          />
        </div>
      </div>
    </StepShell>
  );
}

function AppshotsStep({
  enabled,
  error,
  isSaving,
  onBack,
  onEnabledChange,
  onNext,
}: {
  readonly enabled: boolean;
  readonly error: string | null;
  readonly isSaving: boolean;
  readonly onBack: () => void;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onNext: () => void;
}) {
  const isAvailable = Boolean(window.desktopBridge?.appSnap);
  return (
    <StepShell
      backAction={onBack}
      primaryAction="Start voice chat"
      primaryDisabled={isSaving}
      onSubmit={onNext}
    >
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 text-center sm:gap-8">
        <MossAppshotLogo />
        <div className="flex flex-col gap-3">
          <h1 className="text-[28px] leading-tight font-normal tracking-tight text-foreground">
            Bring your screen into the conversation
          </h1>
          <p className="text-ui-lg leading-5 text-muted-foreground sm:leading-6">
            Appshots let Moss use the active window&rsquo;s image and text when you ask about
            what&rsquo;s on screen.
          </p>
        </div>
        <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-popover text-left">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-ui-lg font-medium text-foreground">Use Appshots</p>
              <p className="text-ui-sm leading-4 text-muted-foreground">
                You can turn this off anytime in Settings
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isSaving ? (
                <span role="status" className="inline-flex">
                  <Loader2Icon
                    aria-hidden="true"
                    className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                  />
                  <span className="sr-only">Saving Appshots preference</span>
                </span>
              ) : null}
              <Switch
                aria-label="Use Appshots"
                checked={enabled}
                disabled={!isAvailable || isSaving}
                onCheckedChange={onEnabledChange}
              />
            </div>
          </div>
          {error || !isAvailable ? (
            <div className="border-t border-border px-4 py-3">
              <p role={error ? "alert" : undefined} className="text-ui-lg text-destructive">
                {error
                  ? "Appshots couldn’t be updated"
                  : "Appshots aren’t available on this device"}
              </p>
              {error ? <p className="mt-1 text-ui-sm text-muted-foreground">{error}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </StepShell>
  );
}

export function RealtimeVoiceOnboarding({
  open,
  onClose,
  onCompleteStart,
  platform,
}: RealtimeVoiceOnboardingProps) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalogState>({ status: "loading" });
  const [selectedVoiceId, setSelectedVoiceId] = useState<RealtimeVoiceId | null>(null);
  const [previewAvailability, setPreviewAvailability] = useState<"loading" | "ready">("loading");
  const [previewUrls, setPreviewUrls] = useState<RealtimeVoicePreviewUrls>({});
  const [screenContextEnabled, setScreenContextEnabled] = useState(false);
  const [appshotsSaving, setAppshotsSaving] = useState(false);
  const [appshotsError, setAppshotsError] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const voiceRequestRef = useRef(0);
  const appshotsRequestRef = useRef(0);
  const appshotsInitializedRef = useRef(false);

  const loadVoices = useCallback(async () => {
    const requestId = voiceRequestRef.current + 1;
    voiceRequestRef.current = requestId;
    setVoiceCatalog({ status: "loading" });
    try {
      const api = readNativeApi();
      if (!api) throw new Error("Native API not found");
      const result = await api.realtimeVoice.listVoices();
      if (voiceRequestRef.current !== requestId) return;
      const resolved = resolveRealtimeVoiceOnboardingCatalog({
        availableVoices: result.voices,
        defaultVoice: result.defaultVoice,
        persistedVoice: readPersistedRealtimeVoicePreference(),
      });
      if (!resolved.selectedVoiceId || resolved.voices.length === 0) {
        setSelectedVoiceId(null);
        setVoiceCatalog({ status: "unavailable" });
        return;
      }
      setSelectedVoiceId(resolved.selectedVoiceId);
      setVoiceCatalog({
        status: "ready",
        selectedVoiceId: resolved.selectedVoiceId,
        voices: resolved.voices,
      });
    } catch {
      if (voiceRequestRef.current === requestId) setVoiceCatalog({ status: "error" });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setCompletionError(null);
    setCompleting(false);
    setAppshotsError(null);
    setAppshotsSaving(false);
    setScreenContextEnabled(readRealtimeVoiceScreenContextPreference());
    setPreviewAvailability("loading");
    setPreviewUrls({});
    appshotsInitializedRef.current = false;
    void loadVoices();
    let cancelled = false;
    void loadRealtimeVoicePreviewManifest().then(
      (urls) => {
        if (!cancelled) {
          setPreviewUrls(urls);
          setPreviewAvailability("ready");
        }
      },
      () => {
        if (!cancelled) setPreviewAvailability("ready");
      },
    );
    return () => {
      cancelled = true;
      voiceRequestRef.current += 1;
      appshotsRequestRef.current += 1;
    };
  }, [loadVoices, open]);

  const updateAppshots = useCallback(
    async (enabled: boolean, requestPermissions: boolean) => {
      const requestId = appshotsRequestRef.current + 1;
      appshotsRequestRef.current = requestId;
      const previousEnabled = screenContextEnabled;
      setAppshotsSaving(true);
      setAppshotsError(null);
      try {
        const appSnap = window.desktopBridge?.appSnap;
        if (!appSnap) throw new Error("Appshots require the macOS desktop app.");
        let state = await appSnap.setEnabled(enabled);
        if (
          enabled &&
          requestPermissions &&
          state.supported &&
          state.status === "permission-required"
        ) {
          state = await appSnap.requestPermissions();
        }
        if (appshotsRequestRef.current !== requestId) return;
        const nextEnabled = enabled && state.supported && state.enabled;
        setScreenContextEnabled(nextEnabled);
        writeRealtimeVoiceScreenContextPreference(nextEnabled);
        if (
          enabled &&
          (!state.supported ||
            state.status === "unsupported" ||
            state.status === "permission-required" ||
            state.status === "error")
        ) {
          setAppshotsError(
            state.message ?? "Allow Screen Recording in macOS Privacy & Security, then try again.",
          );
        }
      } catch (error) {
        if (appshotsRequestRef.current !== requestId) return;
        setScreenContextEnabled(previousEnabled);
        setAppshotsError(
          error instanceof Error ? error.message : "Screen context could not be enabled.",
        );
      } finally {
        if (appshotsRequestRef.current === requestId) setAppshotsSaving(false);
      }
    },
    [screenContextEnabled],
  );

  const isMac = isMacPlatform(
    platform ?? (typeof navigator === "undefined" ? "" : navigator.platform),
  );
  const advanceIntroduction = () => {
    setStep(1);
  };

  const advanceVoice = () => {
    if (!isMac) {
      complete();
      return;
    }
    setStep(2);
    if (!appshotsInitializedRef.current) {
      appshotsInitializedRef.current = true;
      void updateAppshots(true, true);
    }
  };

  const complete = () => {
    if (voiceCatalog.status !== "ready" || !selectedVoiceId || completing) return;
    setCompleting(true);
    setCompletionError(null);
    if (!writeRealtimeVoicePreference(selectedVoiceId)) {
      setCompletionError("Unable to save voice");
      setCompleting(false);
      return;
    }
    // The parent launch flow persists completion only after the first voice
    // session reaches a working active state.
    onClose();
    void onCompleteStart();
  };

  const selectedVoice =
    voiceCatalog.status === "ready"
      ? (voiceCatalog.voices.find((voice) => voice.id === selectedVoiceId) ??
        voiceCatalog.voices[0])
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !completing) onClose();
      }}
    >
      <DialogPopup
        backdropClassName="bg-black/[0.133]"
        bottomStickOnMobile={false}
        showCloseButton={false}
        className="h-[min(520px,calc(100dvh-2rem))] w-[min(480px,92vw)] max-w-none overflow-hidden rounded-dialog border-0 bg-popover/90 shadow-lg ring-[0.5px] ring-border backdrop-blur-xl dark:bg-[#262626]/90 motion-reduce:transition-none"
        data-moss-realtime-voice-onboarding="true"
        data-realtime-voice-onboarding-step={step}
      >
        <DialogTitle className="sr-only">Set up voice chat</DialogTitle>
        {!completing ? (
          <DialogClose
            aria-label="Close voice chat setup"
            className="absolute top-4 right-4 z-10 motion-reduce:transition-none"
            render={<Button size="icon-xs" variant="ghost" className="!size-6" />}
          >
            <XIcon aria-hidden="true" className="size-4" />
          </DialogClose>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col" key={step}>
          {step === 0 ? <IntroductionStep onNext={advanceIntroduction} /> : null}
          {step === 1 ? (
            voiceCatalog.status === "ready" && selectedVoice ? (
              <StepShell
                backAction={() => setStep(0)}
                primaryAction={isMac ? "Next" : "Start voice chat"}
                primaryClassName="h-8 min-h-8 w-[118px] min-w-[118px]"
                primaryLoading={completing}
                onSubmit={advanceVoice}
              >
                <div className="mx-auto flex w-full max-w-xl flex-col items-center text-center">
                  <div className="flex flex-col gap-2 text-center">
                    <h1 className="text-[28px] leading-tight font-normal tracking-tight text-foreground">
                      Choose your voice
                    </h1>
                    <p className="text-ui-lg leading-5 text-muted-foreground sm:leading-6">
                      You can change this anytime in Settings
                    </p>
                  </div>
                  <div className="w-full max-w-full overflow-hidden [&>div>div:first-of-type]:max-w-full [&>div>div:first-of-type]:gap-2 [&>div>div:first-of-type>div]:w-[min(14rem,calc(100vw-10rem))] sm:[&>div>div:first-of-type]:gap-6 sm:[&>div>div:first-of-type>div]:w-56">
                    <RealtimeVoicePreviewPicker
                      previewAvailability={previewAvailability}
                      previewUrls={previewUrls}
                      selectedVoiceId={selectedVoice.id}
                      voices={voiceCatalog.voices}
                      onVoiceChange={(voice) => {
                        setCompletionError(null);
                        setSelectedVoiceId(voice.id);
                      }}
                    />
                  </div>
                  {completionError ? (
                    <p role="alert" className="mt-2 text-ui-lg text-destructive">
                      {completionError}
                    </p>
                  ) : null}
                </div>
              </StepShell>
            ) : (
              <StepShell
                backAction={() => setStep(0)}
                primaryAction={voiceCatalog.status === "loading" ? "Loading…" : "Retry"}
                primaryDisabled={voiceCatalog.status === "loading"}
                onSubmit={() => void loadVoices()}
              >
                <div className="flex flex-col items-center gap-4 text-center">
                  <h1 className="text-[28px] leading-tight font-normal tracking-tight text-foreground">
                    Choose your voice
                  </h1>
                  <p role="status" className="text-ui-lg text-muted-foreground">
                    {voiceCatalog.status === "loading"
                      ? "Loading compatible voices…"
                      : "Unable to load voice settings"}
                  </p>
                </div>
              </StepShell>
            )
          ) : null}
          {step === 2 ? (
            <AppshotsStep
              enabled={screenContextEnabled}
              error={appshotsError}
              isSaving={appshotsSaving || completing}
              onBack={() => setStep(1)}
              onEnabledChange={(enabled) => void updateAppshots(enabled, enabled)}
              onNext={complete}
            />
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
