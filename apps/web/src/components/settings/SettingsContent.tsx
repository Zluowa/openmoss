// FILE: SettingsContent.tsx
// Purpose: The right-hand side of the Settings dialog: the active page's title and its
//          grouped rows. The dialog owns the frame and navigation; this owns the pages.
// Layer: Settings UI
// Exports: SettingsContent, providerDocLabelKey

import {
  type DesktopAudioInputDevice,
  PROVIDER_DISPLAY_NAMES,
  type SidechatExpiry,
} from "@moss/contracts";
import {
  settingsSectionTranslationKeys,
  useTranslation,
  type TranslationKey,
} from "~/localization";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "~/betaFeatures";
import { sameAppSnapShortcut } from "@moss/shared/appSnapShortcut";
import { desktopFlavorFromProtocol } from "@moss/shared/betaFeatures";
import { SafariAccessSetupButton } from "~/components/SafariAccessOnboarding";
import { useEffect, useMemo, useState } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  DEFAULT_DIFF_RENDER_MODE,
  DIFF_RENDER_MODE_STORAGE_KEY,
  DiffRenderModeSchema,
  type DiffRenderMode,
} from "~/diffRenderMode";

import {
  type AppSettings,
  type FollowUpBehavior,
  type GitHubLinkOpenTarget,
  type MessageTrailAudioSource,
  type VoiceEnterBehavior,
  DEFAULT_UI_DENSITY,
  DEFAULT_CHAT_WIDTH,
  type UiDensity,
  MAX_CHAT_FONT_SIZE_PX,
  MAX_TERMINAL_FONT_SIZE_PX,
  MIN_CHAT_FONT_SIZE_PX,
  MIN_TERMINAL_FONT_SIZE_PX,
  defaultDesktopAppIconForFlavor,
  normalizeChatFontSizePx,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSizePx,
  isGitTextGenerationSettingsDirty,
  TERMINAL_FONT_FAMILY_SUGGESTIONS,
  useAppSettings,
} from "~/appSettings";
import { APP_VERSION } from "~/branding";
import { AboutSettingsSection, KeybindingsFileRow } from "./AdvancedSettingsPanel";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";
import { PluginLibrary } from "~/components/PluginLibrary";
import type { SettingsOpenRequest } from "~/settingsDialogStore";
import type { SettingsLocation } from "~/settingsLocation";
import { ComputerHistorySettingsPanel } from "./ComputerHistorySettingsPanel";
import { ConnectionsSettingsPanel } from "./ConnectionsSettingsPanel";
import { connectionTabFromSearch, type ConnectionTab } from "~/connectionSettingsNavigation";
import { RealtimeVoiceSettingsPanel } from "./RealtimeVoiceSettingsPanel";
import { AppIconPicker } from "./AppIconPicker";
import { ArchivedSettingsPanel, WorktreesSettingsPanel } from "./ConversationStorageSettingsPanels";
import {
  AppSnapSettingsPanel,
  BetaChannelSettingsPanel,
  NotificationsSettingsPanel,
} from "./DesktopSettingsPanels";
import { ImportSettingsPanel } from "./ImportSettingsPanel";
import { ModelsSettingsPanel } from "./ModelsSettingsPanel";
import { isProviderInstallSettingsDirty, ProvidersSettingsPanel } from "./ProvidersSettingsPanel";
import { ProviderOptionLabel } from "~/components/ProviderIcon";
import ReleaseHistoryDialog from "~/components/ReleaseHistoryDialog";
import {
  KeyboardShortcutsResetButton,
  KeyboardShortcutsSettingsPanel,
} from "./KeyboardShortcutsSettingsPanel";
import { ProfileSettingsPanel } from "./ProfileSettingsPanel";
import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";
import {
  SettingResetButton,
  SettingsSegmentedControl,
  SettingsSelectControl,
} from "./SettingControls";
import { SettingsRow, SettingsSection, SettingsSectionShell } from "./SettingsPanelPrimitives";
import { ThemeModePicker } from "./ThemeModePicker";
import { ThemePackEditor } from "~/components/ThemePackEditor";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { Button } from "~/components/ui/button";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { Input } from "~/components/ui/input";
import { SelectItem } from "~/components/ui/select";
import { ErrorReportsSettingsSection } from "./ErrorReportsSettingsSection";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { useDesktopCustomTitleBarState } from "~/hooks/useDesktopCustomTitleBar";
import { useKeepAwakeState } from "~/hooks/useKeepAwakeState";
import { KeepAwakeSettingsSection } from "~/components/KeepAwakeControls";
import { useTheme } from "~/hooks/useTheme";
import { isUiDensity } from "~/lib/appDensity";
import { isChatWidthMode, type ChatWidthMode } from "~/lib/chatWidth";
import { isElectron } from "~/env";
import { ResetIcon } from "~/lib/icons";
import {
  cn,
  getNavigatorPlatform,
  isLinuxPlatform,
  isMacPlatform,
  isWindowsPlatform,
} from "~/lib/utils";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { isProviderKind, sameProviderOrder } from "~/providerOrdering";
import {
  normalizeSettingsSection,
  SETTINGS_TARGETS,
  settingRowAnchorId,
} from "~/settingsNavigation";
import { isAudioLevelAvailable } from "~/lib/audioLevel";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

// ── Settings taxonomy ──────────────────────────────────────────────────────

const UI_DENSITY_OPTIONS = [
  {
    value: "compact",
    label: "Compact",
    description: "Tighter spacing everywhere.",
  },
  {
    value: "comfortable",
    label: "Comfortable",
    description: "Balanced spacing for everyday use.",
  },
  {
    value: "spacious",
    label: "Spacious",
    description: "More room around everything.",
  },
] as const satisfies ReadonlyArray<{
  value: UiDensity;
  label: string;
  description: string;
}>;

const CHAT_WIDTH_OPTIONS = [
  {
    value: "standard",
    label: "Standard",
    description: "The usual reading width.",
  },
  {
    value: "wide",
    label: "Wide",
    description: "Gives tables and wide content more room (72rem).",
  },
  {
    value: "full",
    label: "Full",
    description: "Lets the chat column use the full window width.",
  },
] as const satisfies ReadonlyArray<{
  value: ChatWidthMode;
  label: string;
  description: string;
}>;

const PROVIDER_SELECT_OPTIONS = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.kind);

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const SIDEBAR_PROJECT_SORT_ORDER_LABELS = {
  updated_at: "Recently active",
  created_at: "Recently added",
  manual: "Manual order",
} as const;

const SIDEBAR_THREAD_SORT_ORDER_LABELS = {
  updated_at: "Recently active",
  created_at: "Newest first",
} as const;

const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  { value: "queue", labelKey: "settings.behavior.followUp.option.queue" },
  { value: "steer", labelKey: "settings.behavior.followUp.option.steer" },
] as const satisfies ReadonlyArray<{ value: FollowUpBehavior; labelKey: TranslationKey }>;

const SIDECHAT_EXPIRY_OPTIONS = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "never", label: "Never" },
] as const satisfies ReadonlyArray<{ value: SidechatExpiry; label: string }>;

const GITHUB_LINK_OPEN_TARGET_LABELS = {
  app: "In Moss",
  browser: "In-app browser",
  external: "External browser",
} as const satisfies Record<GitHubLinkOpenTarget, string>;

const MESSAGE_TRAIL_AUDIO_SOURCE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "system", label: "Mac audio" },
  { value: "microphone", label: "Microphone" },
  { value: "both", label: "Both" },
] as const satisfies ReadonlyArray<{ value: MessageTrailAudioSource; label: string }>;

// Select items need a non-empty value; "" in settings means the Mac's default input.
const MAC_DEFAULT_MICROPHONE_VALUE = "mac-default";

function microphoneLabel(device: DesktopAudioInputDevice): string {
  return device.bluetooth ? `${device.name} (Bluetooth)` : device.name;
}

function MessageTrailMicrophoneRow({
  value,
  defaultValue,
  onChange,
}: {
  value: string;
  defaultValue: string;
  onChange: (microphoneId: string) => void;
}) {
  const [devices, setDevices] = useState<readonly DesktopAudioInputDevice[]>([]);

  // Listing only reads device names; plugging a device in or out refreshes it.
  useEffect(() => {
    const audioLevel = window.desktopBridge?.audioLevel;
    if (!audioLevel) return;
    let cancelled = false;
    const refresh = () => {
      void audioLevel
        .listMicrophones()
        .then((next) => {
          if (!cancelled) setDevices(next);
        })
        .catch(() => undefined);
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, []);

  const macDefault = devices.find((device) => device.default);
  const selected = devices.find((device) => device.id === value);
  const macDefaultLabel = macDefault
    ? `Mac default: ${microphoneLabel(macDefault)}`
    : "Mac default";
  const valueContent = !value
    ? macDefaultLabel
    : selected
      ? microphoneLabel(selected)
      : "Not connected";

  return (
    <SettingsRow
      title="Message trail microphone"
      description="The microphone the message marks listen to."
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton
            label="message trail microphone"
            onClick={() => onChange(defaultValue)}
          />
        ) : null
      }
      control={
        <SettingsSelectControl
          value={value || MAC_DEFAULT_MICROPHONE_VALUE}
          onValueChange={(next) => onChange(next === MAC_DEFAULT_MICROPHONE_VALUE ? "" : next)}
          ariaLabel="Message trail microphone"
          triggerClassName="w-full sm:w-64"
          valueContent={valueContent}
        >
          <SelectItem hideIndicator value={MAC_DEFAULT_MICROPHONE_VALUE}>
            {macDefaultLabel}
          </SelectItem>
          {devices.map((device) => (
            <SelectItem hideIndicator key={device.id} value={device.id}>
              {microphoneLabel(device)}
            </SelectItem>
          ))}
          {value && !selected ? (
            <SelectItem hideIndicator value={value}>
              Not connected
            </SelectItem>
          ) : null}
        </SettingsSelectControl>
      }
    />
  );
}

const VOICE_ENTER_BEHAVIOR_OPTIONS = [
  { value: "stop", label: "Stop" },
  { value: "send", label: "Stop and send" },
] as const satisfies ReadonlyArray<{ value: VoiceEnterBehavior; label: string }>;

// ── Settings UI primitives ────────────────────────────────────────────────

// Shared settings controls live in ~/components/settings/SettingControls.

function isProviderSelectOption(value: string): value is (typeof PROVIDER_SELECT_OPTIONS)[number] {
  return (PROVIDER_SELECT_OPTIONS as ReadonlyArray<string>).includes(value);
}
// Keys of AppSettings whose value is a plain boolean — the only ones that can be
// driven by the shared on/off toggle row below.
type BooleanSettingKey = {
  [Key in keyof AppSettings]-?: AppSettings[Key] extends boolean ? Key : never;
}[keyof AppSettings];

// ── Route screen ───────────────────────────────────────────────────────────

export function SettingsContent({
  location,
  onNavigate,
}: {
  readonly location: SettingsLocation;
  readonly onNavigate: (request: SettingsOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const [defaultDiffRenderMode, setDefaultDiffRenderMode] = useLocalStorage(
    DIFF_RENDER_MODE_STORAGE_KEY,
    DEFAULT_DIFF_RENDER_MODE,
    DiffRenderModeSchema,
  );
  const routeSearch = location as unknown as Record<string, unknown>;
  const activeSection = normalizeSettingsSection(location.section);
  const [lastConnectionTab, setLastConnectionTab] = useState<ConnectionTab>("devices");
  const connectionTab = connectionTabFromSearch(routeSearch, lastConnectionTab);
  useEffect(() => {
    if (activeSection === "connections") setLastConnectionTab(connectionTab);
  }, [activeSection, connectionTab]);
  const selectConnectionTab = (tab: ConnectionTab) => {
    setLastConnectionTab(tab);
    onNavigate({ section: "connections", connectionTab: tab });
  };
  const settingsTarget = typeof routeSearch.target === "string" ? routeSearch.target : null;
  const settingsProviderTarget =
    typeof routeSearch.provider === "string" && isProviderKind(routeSearch.provider)
      ? routeSearch.provider
      : null;

  const {
    isDefaultActiveTheme,
    resetAllThemes,
    resolvedTheme,
    theme,
    setTheme,
    systemUiFont,
    setSystemUiFont,
  } = useTheme();
  const { settings, defaults, updateSettings, updateSettingsAndWait, resetSettings } =
    useAppSettings();
  const keepAwake = useKeepAwakeState();
  const [releaseHistoryOpen, setReleaseHistoryOpen] = useState(false);
  const [resetEpoch, setResetEpoch] = useState(0);
  const platform = getNavigatorPlatform();
  const desktopFlavor = useMemo(
    () =>
      desktopFlavorFromProtocol(
        typeof window === "undefined" ? undefined : window.location?.protocol,
        import.meta.env.DEV,
      ),
    [],
  );
  const defaultDesktopAppIcon = defaultDesktopAppIconForFlavor(desktopFlavor);
  const shouldShowFontSmoothing = isMacPlatform(platform);
  const supportsCustomTitleBarSetting =
    isElectron && (isWindowsPlatform(platform) || isLinuxPlatform(platform));
  const customTitleBarState = useDesktopCustomTitleBarState();
  const customTitleBarRestartRequired =
    customTitleBarState.supported && settings.useCustomTitleBar !== customTitleBarState.active;
  const customTitleBarPreferenceDirty =
    supportsCustomTitleBarSetting &&
    (settings.useCustomTitleBar !== defaults.useCustomTitleBar ||
      (customTitleBarState.supported &&
        customTitleBarState.preference !== defaults.useCustomTitleBar));

  function showCustomTitleBarRestartToast(): void {
    toastManager.add({
      type: "warning",
      title: "Restart to apply title bar",
      description: "Applies the next time Moss opens.",
      actionProps: {
        "aria-label": "Restart Moss",
        children: "Restart",
        onClick: () => {
          void window.desktopBridge?.customTitleBar?.relaunch();
        },
      },
    });
  }

  async function persistCustomTitleBarPreference(
    enabled: boolean,
  ): Promise<{ readonly restartRequired: boolean } | null> {
    try {
      const bridge = window.desktopBridge?.customTitleBar;
      if (!bridge) throw new Error("Desktop title bar bridge is unavailable.");
      const state = await bridge.setPreference(enabled);
      if (!state.supported || state.preference !== enabled) {
        throw new Error("Desktop title bar preference was not persisted.");
      }
      return state;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update title bar",
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function applyCustomTitleBarPreference(enabled: boolean): Promise<void> {
    const previous = settings.useCustomTitleBar;
    updateSettings({ useCustomTitleBar: enabled });
    const state = await persistCustomTitleBarPreference(enabled);
    if (state === null) {
      updateSettings({ useCustomTitleBar: previous });
      return;
    }
    if (state.restartRequired) showCustomTitleBarRestartToast();
  }

  const visibleTerminalFontFamilySuggestions = useMemo(() => {
    const query = settings.terminalFontFamily.trim().toLowerCase();
    if (!query) return TERMINAL_FONT_FAMILY_SUGGESTIONS;
    return TERMINAL_FONT_FAMILY_SUGGESTIONS.filter((suggestion) =>
      suggestion.toLowerCase().includes(query),
    );
  }, [settings.terminalFontFamily]);

  const isGitTextGenerationModelDirty = isGitTextGenerationSettingsDirty(settings, defaults);
  const isInstallSettingsDirty = isProviderInstallSettingsDirty(settings, defaults);
  const hiddenProviderCount = new Set(settings.hiddenProviders).size;
  const enabledProviderSelectOptions = PROVIDER_SELECT_OPTIONS.filter(
    (provider) => !settings.disabledProviders.includes(provider),
  );
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const isProviderActivityDirty =
    settings.disabledProviders.length !== defaults.disabledProviders.length ||
    settings.disabledProviders.some(
      (provider, index) => provider !== defaults.disabledProviders[index],
    );

  // Deep links and sidebar search targets all resolve to stable DOM ids in the active panel.
  useEffect(() => {
    if (!settingsTarget) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(settingsTarget)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, settingsTarget]);

  const changedSettingLabels = [
    ...(theme !== "system" ? ["Theme"] : []),
    ...(!isDefaultActiveTheme ? [`${resolvedTheme === "dark" ? "Dark" : "Light"} theme pack`] : []),
    ...(settings.defaultProvider !== defaults.defaultProvider ? ["Default provider"] : []),
    ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? ["New thread mode"] : []),
    ...(settings.composerPredictionsEnabled !== defaults.composerPredictionsEnabled
      ? ["Show predictions"]
      : []),
    ...(settings.anchorSentMessagesToTop !== defaults.anchorSentMessagesToTop
      ? ["Move sent messages to top"]
      : []),
    ...(settings.archiveDeletesOrphanedWorktree !== defaults.archiveDeletesOrphanedWorktree
      ? ["Delete worktree on archive"]
      : []),
    ...(settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder
      ? ["Project sort order"]
      : []),
    ...(settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder
      ? ["Thread sort order"]
      : []),
    ...(settings.sidebarThreadAttentionFirst !== defaults.sidebarThreadAttentionFirst
      ? ["Working and unread on top"]
      : []),
    ...(settings.showChatsSection !== defaults.showChatsSection ? ["Chats section"] : []),
    ...(settings.showAutomationRunThreads !== defaults.showAutomationRunThreads
      ? ["Automation runs"]
      : []),
    ...(settings.uiDensity !== defaults.uiDensity ? ["UI density"] : []),
    ...(settings.chatWidth !== defaults.chatWidth ? ["Chat width"] : []),
    ...(settings.desktopAppIcon !== defaultDesktopAppIcon ? ["App icon"] : []),
    ...(customTitleBarPreferenceDirty ? ["Custom title bar"] : []),
    ...(settings.chatFontSizePx !== defaults.chatFontSizePx ? ["Base font size"] : []),
    ...(settings.terminalFontSizePx !== defaults.terminalFontSizePx ? ["Terminal font size"] : []),
    ...(settings.terminalFontFamily !== defaults.terminalFontFamily ? ["Terminal font"] : []),
    ...(shouldShowFontSmoothing &&
    settings.enableNativeFontSmoothing !== defaults.enableNativeFontSmoothing
      ? ["Font smoothing"]
      : []),
    ...(settings.timestampFormat !== defaults.timestampFormat ? ["Time format"] : []),
    ...(settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts
      ? ["Activity toasts"]
      : []),
    ...(settings.enableSystemTaskCompletionNotifications !==
    defaults.enableSystemTaskCompletionNotifications
      ? ["Desktop notifications"]
      : []),
    ...(settings.notifyAfterSubagentsFinish !== defaults.notifyAfterSubagentsFinish
      ? ["Wait for subagents"]
      : []),
    ...(settings.enableAssistantStreaming !== defaults.enableAssistantStreaming
      ? ["Assistant output"]
      : []),
    ...(settings.collapseFinishedTurns !== defaults.collapseFinishedTurns
      ? ["Fold finished turns"]
      : []),
    ...(settings.composerEffortSlider !== defaults.composerEffortSlider ? ["Effort slider"] : []),
    ...(settings.messageTrailAudioSource !== defaults.messageTrailAudioSource
      ? ["Message trail sound"]
      : []),
    ...(settings.messageTrailMicrophoneId !== defaults.messageTrailMicrophoneId
      ? ["Message trail microphone"]
      : []),
    ...(settings.followUpBehavior !== defaults.followUpBehavior ? ["Follow-up behavior"] : []),
    ...(settings.sidechatExpiry !== defaults.sidechatExpiry ? ["Side chat expiry"] : []),
    ...(settings.voiceEnterBehavior !== defaults.voiceEnterBehavior
      ? ["Enter while dictating"]
      : []),
    ...(settings.autoOpenDevicePane !== defaults.autoOpenDevicePane
      ? ["Automatically open simulator"]
      : []),
    ...(settings.enableAppSnap !== defaults.enableAppSnap ? ["AppSnap"] : []),
    ...(!sameAppSnapShortcut(settings.appSnapShortcut, defaults.appSnapShortcut)
      ? ["AppSnap shortcut"]
      : []),
    ...(settings.appSnapPlaySound !== defaults.appSnapPlaySound ? ["AppSnap capture sound"] : []),
    ...(settings.computerControlEnabled !== defaults.computerControlEnabled
      ? ["Computer control"]
      : []),
    ...(settings.autoOpenComputerPane !== defaults.autoOpenComputerPane
      ? ["Computer preview auto-open"]
      : []),
    ...(settings.agentCursorColorMode !== defaults.agentCursorColorMode
      ? ["Agent cursor colors"]
      : []),
    ...(settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks
      ? ["Provider update checks"]
      : []),
    ...(settings.lowerProviderProcessPriority !== defaults.lowerProviderProcessPriority
      ? ["Keep Moss responsive"]
      : []),
    ...(defaultDiffRenderMode !== DEFAULT_DIFF_RENDER_MODE ? ["Diff layout"] : []),
    ...(settings.diffWordWrap !== defaults.diffWordWrap ? ["Diff line wrapping"] : []),
    ...(settings.githubLinkOpenTarget !== defaults.githubLinkOpenTarget
      ? ["Open pull requests and issues"]
      : []),
    ...(settings.showPullRequestDiffColors !== defaults.showPullRequestDiffColors
      ? ["Pull request diff colors"]
      : []),
    ...(settings.githubInboxIncludeUpstreams !== defaults.githubInboxIncludeUpstreams
      ? ["Include fork upstreams"]
      : []),
    ...(settings.confirmThreadDelete !== defaults.confirmThreadDelete
      ? ["Delete confirmation"]
      : []),
    ...(settings.confirmThreadArchive !== defaults.confirmThreadArchive
      ? ["Archive confirmation"]
      : []),
    ...(settings.confirmTerminalTabClose !== defaults.confirmTerminalTabClose
      ? ["Terminal close confirmation"]
      : []),
    ...(isGitTextGenerationModelDirty ? ["Git writing model"] : []),
    ...(settings.sourceControlWritingStyle !== defaults.sourceControlWritingStyle ||
    settings.sourceControlCustomInstructions !== defaults.sourceControlCustomInstructions
      ? ["Source control writing style"]
      : []),
    ...(settings.customCodexModels.length > 0 ||
    settings.customClaudeModels.length > 0 ||
    settings.customCursorModels.length > 0 ||
    settings.customAntigravityModels.length > 0 ||
    settings.customGrokModels.length > 0 ||
    settings.customDroidModels.length > 0 ||
    settings.customOpenCodeModels.length > 0 ||
    settings.customPiModels.length > 0
      ? ["Custom models"]
      : []),
    ...(isInstallSettingsDirty ? ["Provider installs"] : []),
    ...(isProviderActivityDirty ? ["Provider activity"] : []),
    ...(hiddenProviderCount > 0 ? ["Provider visibility"] : []),
    ...(isProviderOrderDirty ? ["Provider order"] : []),
  ];

  async function restoreDefaults() {
    if (changedSettingLabels.length === 0) return;

    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    if (customTitleBarPreferenceDirty) {
      const state = await persistCustomTitleBarPreference(defaults.useCustomTitleBar);
      if (state === null) return;
      if (state.restartRequired) showCustomTitleBarRestartToast();
    }

    setTheme("system");
    resetAllThemes();
    setDefaultDiffRenderMode(DEFAULT_DIFF_RENDER_MODE);
    await resetSettings();
    setResetEpoch((current) => current + 1);
  }

  // Shared on/off settings row: a labelled Switch bound to a boolean AppSettings
  // key, with the standard "reset to default" affordance shown only when changed.
  // Rows with bespoke controls (e.g. the desktop-notifications Test button) keep
  // their own markup instead of using this helper.
  const renderBooleanSettingRow = (config: {
    settingKey: BooleanSettingKey;
    title: string;
    description: string;
    resetLabel: string;
    ariaLabel: string;
  }) => {
    const { settingKey, title, description, resetLabel, ariaLabel } = config;
    const isChanged = settings[settingKey] !== defaults[settingKey];
    return (
      <SettingsRow
        title={title}
        description={description}
        resetAction={
          isChanged ? (
            <SettingResetButton
              label={resetLabel}
              onClick={() =>
                updateSettings({ [settingKey]: defaults[settingKey] } as Partial<AppSettings>)
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings[settingKey]}
            onCheckedChange={(checked) =>
              updateSettings({ [settingKey]: Boolean(checked) } as Partial<AppSettings>)
            }
            aria-label={ariaLabel}
          />
        }
      />
    );
  };

  const renderGeneralPanel = () => (
    <div className="space-y-6">
      <SafariAccessSetupButton />
      <BetaChannelSettingsPanel active={true} />
      <SettingsSection title="Core defaults">
        <SettingsRow
          title="Default provider"
          description="Used for new chats until you pick a model."
          resetAction={
            settings.defaultProvider !== defaults.defaultProvider ? (
              <SettingResetButton
                label="default provider"
                onClick={() => updateSettings({ defaultProvider: defaults.defaultProvider })}
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={
                settings.disabledProviders.includes(settings.defaultProvider)
                  ? null
                  : settings.defaultProvider
              }
              disabled={enabledProviderSelectOptions.length === 0}
              onValueChange={(value) => {
                if (!isProviderSelectOption(value) || settings.disabledProviders.includes(value))
                  return;
                updateSettings({ defaultProvider: value });
              }}
              ariaLabel="Default provider"
              valueContent={
                settings.disabledProviders.includes(settings.defaultProvider) ? (
                  "Choose an enabled provider"
                ) : (
                  <ProviderOptionLabel
                    provider={settings.defaultProvider}
                    label={PROVIDER_DISPLAY_NAMES[settings.defaultProvider]}
                  />
                )
              }
            >
              {enabledProviderSelectOptions.map((provider) => (
                <SelectItem hideIndicator key={provider} value={provider}>
                  <ProviderOptionLabel
                    provider={provider}
                    label={PROVIDER_DISPLAY_NAMES[provider]}
                  />
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title="New threads"
          description="Where new chats work by default."
          resetAction={
            settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value !== "local" && value !== "worktree") return;
                updateSettings({
                  defaultThreadEnvMode: value,
                });
              }}
              ariaLabel="Default thread mode"
              valueContent={settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
            >
              <SelectItem hideIndicator value="local">
                Local
              </SelectItem>
              <SelectItem hideIndicator value="worktree">
                New worktree
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        {renderBooleanSettingRow({
          settingKey: "composerPredictionsEnabled",
          title: t("settings.general.composerPrediction.title"),
          description: t("settings.general.composerPrediction.description"),
          resetLabel: t("settings.general.composerPrediction.resetLabel"),
          ariaLabel: t("settings.general.composerPrediction.aria"),
        })}

        {renderBooleanSettingRow({
          settingKey: "archiveDeletesOrphanedWorktree",
          title: "Delete worktree on archive",
          description: "Remove an unused worktree after archiving. The branch stays.",
          resetLabel: "delete worktree on archive",
          ariaLabel: "Delete worktree on archive",
        })}

        {renderBooleanSettingRow({
          settingKey: "anchorSentMessagesToTop",
          title: "Move sent messages to top",
          description: "Scroll each message you send to the top.",
          resetLabel: "move sent messages to top",
          ariaLabel: "Move sent messages to top",
        })}

        <SettingsRow
          title="Welcome tour"
          description="Go through first-time setup again."
          control={
            <Button
              variant="outline"
              onClick={() => useOnboardingDialogStore.getState().openDialog()}
            >
              Open welcome tour
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Sidebar organization">
        <SettingsRow
          title="Project order"
          description="How projects are sorted in the sidebar."
          resetAction={
            settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder ? (
              <SettingResetButton
                label="project order"
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: defaults.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (value !== "updated_at" && value !== "created_at" && value !== "manual") {
                  return;
                }
                updateSettings({ sidebarProjectSortOrder: value });
              }}
              ariaLabel="Project sort order"
              valueContent={SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder]}
            >
              <SelectItem hideIndicator value="updated_at">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.updated_at}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.created_at}
              </SelectItem>
              <SelectItem hideIndicator value="manual">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.manual}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title="Thread order"
          description="How chats are sorted in each project."
          resetAction={
            settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder ? (
              <SettingResetButton
                label="thread order"
                onClick={() =>
                  updateSettings({
                    sidebarThreadSortOrder: defaults.sidebarThreadSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarThreadSortOrder}
              onValueChange={(value) => {
                if (value !== "updated_at" && value !== "created_at") {
                  return;
                }
                updateSettings({ sidebarThreadSortOrder: value });
              }}
              ariaLabel="Thread sort order"
              valueContent={SIDEBAR_THREAD_SORT_ORDER_LABELS[settings.sidebarThreadSortOrder]}
            >
              <SelectItem hideIndicator value="updated_at">
                {SIDEBAR_THREAD_SORT_ORDER_LABELS.updated_at}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {SIDEBAR_THREAD_SORT_ORDER_LABELS.created_at}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        {renderBooleanSettingRow({
          settingKey: "sidebarThreadAttentionFirst",
          title: "Working and unread on top",
          description: "Keep chats that are working or unread at the top.",
          resetLabel: "working and unread on top",
          ariaLabel: "Move working and unread threads to the top of the sidebar",
        })}
      </SettingsSection>

      <SettingsSection title="Sidebar sections">
        {renderBooleanSettingRow({
          settingKey: "showChatsSection",
          title: "Chats",
          description: "Show chats outside projects.",
          resetLabel: "chats section",
          ariaLabel: "Show the Chats section in the sidebar",
        })}

        {renderBooleanSettingRow({
          settingKey: "showAutomationRunThreads",
          title: "Automation runs",
          description: "Show the chat each automation run creates.",
          resetLabel: "automation runs",
          ariaLabel: "Show automation run threads in the sidebar",
        })}
      </SettingsSection>

      <div id={SETTINGS_TARGETS.environmentPanel} className="space-y-6">
        <SettingsSection title="Environment panel">
          {renderBooleanSettingRow({
            settingKey: "environmentPanelDefaultOpen",
            title: "Open by default",
            description: "Open the Environment panel in new chats.",
            resetLabel: "environment panel default open",
            ariaLabel: "Open the Environment panel by default on normal threads",
          })}
        </SettingsSection>

        <SettingsSection title="Code and status">
          {renderBooleanSettingRow({
            settingKey: "showEnvironmentSubagents",
            title: "Subagents",
            description: "Show the chat's subagents.",
            resetLabel: "subagents section",
            ariaLabel: "Show the Subagents section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentUsage",
            title: "Usage",
            description: "Show account usage.",
            resetLabel: "usage section",
            ariaLabel: "Show the Usage section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentRepository",
            title: "Repository",
            description: "Show the GitHub repository link.",
            resetLabel: "repository section",
            ariaLabel: "Show the Repository section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentPullRequest",
            title: "Pull request",
            description: "Show the branch's open pull request.",
            resetLabel: "pull request section",
            ariaLabel: "Show the Pull request section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentEditor",
            title: "Editor",
            description: "Show the editor and Open in editor.",
            resetLabel: "editor section",
            ariaLabel: "Show the Editor section in the Environment panel",
          })}
        </SettingsSection>

        <SettingsSection title="Context and notes">
          {renderBooleanSettingRow({
            settingKey: "showEnvironmentRecap",
            title: "Recap",
            description: "Show the chat recap.",
            resetLabel: "recap section",
            ariaLabel: "Show the Recap section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentPinned",
            title: "Pinned messages",
            description: "Show pinned messages.",
            resetLabel: "pinned messages section",
            ariaLabel: "Show the Pinned messages section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentInstructions",
            title: "Project instructions",
            description: "Show the project's instructions.",
            resetLabel: "project instructions section",
            ariaLabel: "Show the Project instructions section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentNotepad",
            title: "Notepad",
            description: "Show the chat's notepad.",
            resetLabel: "notepad section",
            ariaLabel: "Show the Notepad section in the Environment panel",
          })}
        </SettingsSection>
      </div>

      <ErrorReportsSettingsSection
        checked={settings.errorReportsEnabled}
        isDefault={settings.errorReportsEnabled === defaults.errorReportsEnabled}
        defaultValue={defaults.errorReportsEnabled}
        onChange={(errorReportsEnabled) => updateSettings({ errorReportsEnabled })}
      />
      <AboutSettingsSection onOpenReleaseHistory={() => setReleaseHistoryOpen(true)} />
    </div>
  );

  const renderAppearancePanel = () => (
    <div className="space-y-6">
      <SettingsSectionShell
        title="Theme"
        action={
          theme !== "system" ? (
            <SettingResetButton label="theme" onClick={() => setTheme("system")} />
          ) : null
        }
      >
        {/* The mode picker is the one settings control that sits directly on the page
            instead of inside a card — the mockups are the whole UI, so boxing them in
            a card reads as chrome around chrome. The anchor keeps search deep-links
            (`?target=setting-theme`) working without the SettingsRow. */}
        <div id={settingRowAnchorId("Theme")} className="scroll-mt-24 pb-1.5">
          <ThemeModePicker value={theme} onValueChange={setTheme} ariaLabel="Theme preference" />
        </div>

        <div className="space-y-3">
          {(resolvedTheme === "dark"
            ? (["dark", "light"] as const)
            : (["light", "dark"] as const)
          ).map((variant) => (
            <ThemePackEditor
              key={variant}
              variant={variant}
              isActive={resolvedTheme === variant}
              mode={theme}
            />
          ))}
        </div>
      </SettingsSectionShell>

      {isElectron ? (
        <SettingsSection title="App">
          <SettingsRow
            title="App icon"
            description="The icon in the dock or taskbar."
            resetAction={
              settings.desktopAppIcon !== defaultDesktopAppIcon ? (
                <SettingResetButton
                  label="app icon"
                  onClick={() => updateSettings({ desktopAppIcon: defaultDesktopAppIcon })}
                />
              ) : null
            }
            control={
              <AppIconPicker
                platform={platform}
                value={settings.desktopAppIcon}
                onValueChange={async (desktopAppIcon) => {
                  if (desktopAppIcon !== settings.desktopAppIcon) {
                    updateSettings({ desktopAppIcon });
                  }
                  await window.desktopBridge?.setAppIcon(desktopAppIcon);
                }}
              />
            }
          />
          {supportsCustomTitleBarSetting ? (
            <SettingsRow
              title="Use custom title bar"
              description={
                customTitleBarRestartRequired
                  ? "Restart Moss to apply. Some Linux window managers work better with the system title bar."
                  : "Replace the system title bar with Moss's frameless chrome and window controls. Restart required to apply."
              }
              status={customTitleBarRestartRequired ? "Restart required" : undefined}
              resetAction={
                settings.useCustomTitleBar !== defaults.useCustomTitleBar ? (
                  <SettingResetButton
                    label="custom title bar"
                    onClick={() => {
                      void applyCustomTitleBarPreference(defaults.useCustomTitleBar);
                    }}
                  />
                ) : null
              }
              control={
                <div className="flex items-center gap-2">
                  {customTitleBarRestartRequired ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        void window.desktopBridge?.customTitleBar?.relaunch();
                      }}
                    >
                      Restart
                    </Button>
                  ) : null}
                  <Switch
                    checked={settings.useCustomTitleBar}
                    onCheckedChange={(checked) => {
                      void applyCustomTitleBarPreference(Boolean(checked));
                    }}
                    aria-label="Use custom title bar"
                  />
                </div>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Typography and spacing">
        <SettingsRow
          title="Use default UI font"
          description="Use Moss's default font instead of the theme's."
          resetAction={
            !systemUiFont ? (
              <SettingResetButton label="default UI font" onClick={() => setSystemUiFont(true)} />
            ) : null
          }
          control={
            <Switch
              checked={systemUiFont}
              onCheckedChange={(checked) => setSystemUiFont(Boolean(checked))}
              aria-label="Use default UI font"
            />
          }
        />

        <SettingsRow
          title="UI density"
          description="How much space sits around things."
          resetAction={
            settings.uiDensity !== defaults.uiDensity ? (
              <SettingResetButton
                label="UI density"
                onClick={() =>
                  updateSettings({
                    uiDensity: DEFAULT_UI_DENSITY,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.uiDensity}
              onValueChange={(value) => {
                if (!isUiDensity(value)) {
                  return;
                }
                updateSettings({ uiDensity: value });
              }}
              ariaLabel="UI density"
              options={UI_DENSITY_OPTIONS}
            />
          }
        />

        <SettingsRow
          title="Chat width"
          description="How wide the chat can grow."
          resetAction={
            settings.chatWidth !== defaults.chatWidth ? (
              <SettingResetButton
                label="chat width"
                onClick={() =>
                  updateSettings({
                    chatWidth: DEFAULT_CHAT_WIDTH,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.chatWidth}
              onValueChange={(value) => {
                if (!isChatWidthMode(value)) {
                  return;
                }
                updateSettings({ chatWidth: value });
              }}
              ariaLabel="Chat width"
              options={CHAT_WIDTH_OPTIONS}
            />
          }
        />

        <SettingsRow
          title="Base font size"
          description="The base text size for Moss."
          resetAction={
            settings.chatFontSizePx !== defaults.chatFontSizePx ? (
              <SettingResetButton
                label="base font size"
                onClick={() =>
                  updateSettings({
                    chatFontSizePx: defaults.chatFontSizePx,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Input
                type="number"
                size="sm"
                min={MIN_CHAT_FONT_SIZE_PX}
                max={MAX_CHAT_FONT_SIZE_PX}
                step={1}
                inputMode="numeric"
                variant="soft"
                className="w-full text-right sm:w-20"
                value={String(settings.chatFontSizePx)}
                onChange={(event) => {
                  const nextValue = event.target.value.trim();
                  if (nextValue.length === 0) return;
                  updateSettings({
                    chatFontSizePx: normalizeChatFontSizePx(Number(nextValue)),
                  });
                }}
                aria-label="Base font size in pixels"
              />
              <span className="text-ui leading-snug text-muted-foreground">px</span>
            </div>
          }
        />

        <SettingsRow
          title="Terminal font size"
          description="Text size in the terminal."
          resetAction={
            settings.terminalFontSizePx !== defaults.terminalFontSizePx ? (
              <SettingResetButton
                label="terminal font size"
                onClick={() =>
                  updateSettings({
                    terminalFontSizePx: defaults.terminalFontSizePx,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Input
                type="number"
                size="sm"
                min={MIN_TERMINAL_FONT_SIZE_PX}
                max={MAX_TERMINAL_FONT_SIZE_PX}
                step={1}
                inputMode="numeric"
                variant="soft"
                className="w-full text-right sm:w-20"
                value={String(settings.terminalFontSizePx)}
                onChange={(event) => {
                  const nextValue = event.target.value.trim();
                  if (nextValue.length === 0) return;
                  updateSettings({
                    terminalFontSizePx: normalizeTerminalFontSizePx(Number(nextValue)),
                  });
                }}
                aria-label="Terminal font size in pixels"
              />
              <span className="text-ui leading-snug text-muted-foreground">px</span>
            </div>
          }
        />

        <SettingsRow
          title="Terminal font"
          description="Any monospace font on this computer."
          resetAction={
            settings.terminalFontFamily !== defaults.terminalFontFamily ? (
              <SettingResetButton
                label="terminal font"
                onClick={() =>
                  updateSettings({
                    terminalFontFamily: defaults.terminalFontFamily,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end sm:w-auto">
              <Autocomplete
                items={visibleTerminalFontFamilySuggestions}
                mode="none"
                openOnInputClick
                value={settings.terminalFontFamily}
                onValueChange={(value) => {
                  updateSettings({
                    terminalFontFamily: normalizeTerminalFontFamily(value),
                  });
                }}
              >
                <AutocompleteInput
                  size="sm"
                  variant="soft"
                  showTrigger
                  showClear={settings.terminalFontFamily.length > 0}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="Default (JetBrains Mono)"
                  className="w-full sm:w-56"
                  aria-label="Terminal font family"
                />
                <AutocompletePopup className="w-56 min-w-56 font-system-ui">
                  <AutocompleteList>
                    {visibleTerminalFontFamilySuggestions.map((suggestion, index) => (
                      <AutocompleteItem
                        key={suggestion}
                        index={index}
                        value={suggestion}
                        className="font-normal text-[var(--color-text-foreground)]"
                        onClick={() => {
                          updateSettings({
                            terminalFontFamily: normalizeTerminalFontFamily(suggestion),
                          });
                        }}
                      >
                        {suggestion}
                      </AutocompleteItem>
                    ))}
                    <AutocompleteEmpty>No matching suggested fonts.</AutocompleteEmpty>
                  </AutocompleteList>
                </AutocompletePopup>
              </Autocomplete>
            </div>
          }
        />

        {shouldShowFontSmoothing
          ? renderBooleanSettingRow({
              settingKey: "enableNativeFontSmoothing",
              title: "Font smoothing",
              description: "Lighter, crisper text.",
              resetLabel: "font smoothing",
              ariaLabel: "Enable font smoothing",
            })
          : null}
      </SettingsSection>

      <SettingsSection title="Time and reading">
        <SettingsRow
          title="Time format"
          description="12- or 24-hour time."
          resetAction={
            settings.timestampFormat !== defaults.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: defaults.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value !== "locale" && value !== "12-hour" && value !== "24-hour") {
                  return;
                }
                updateSettings({
                  timestampFormat: value,
                });
              }}
              ariaLabel="Timestamp format"
              triggerClassName="w-full sm:w-40"
              valueContent={TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}
            >
              <SelectItem hideIndicator value="locale">
                {TIMESTAMP_FORMAT_LABELS.locale}
              </SelectItem>
              <SelectItem hideIndicator value="12-hour">
                {TIMESTAMP_FORMAT_LABELS["12-hour"]}
              </SelectItem>
              <SelectItem hideIndicator value="24-hour">
                {TIMESTAMP_FORMAT_LABELS["24-hour"]}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
    </div>
  );

  const renderBehaviorPanel = () => (
    <div className="space-y-6">
      <SettingsSection title="Conversation">
        <SettingsRow
          title={t("settings.behavior.followUp.title")}
          description={t("settings.behavior.followUp.description")}
          resetAction={
            settings.followUpBehavior !== defaults.followUpBehavior ? (
              <SettingResetButton
                label={t("settings.behavior.followUp.resetLabel")}
                onClick={() =>
                  updateSettings({
                    followUpBehavior: defaults.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.followUpBehavior}
              onValueChange={(value) => updateSettings({ followUpBehavior: value })}
              ariaLabel={t("settings.behavior.followUp.aria")}
              options={FOLLOW_UP_BEHAVIOR_OPTIONS.map(({ labelKey, value }) => ({
                label: t(labelKey),
                value,
              }))}
            />
          }
        />

        <SettingsRow
          title="Side chat expiry"
          description="Close side chats that sit unused this long."
          resetAction={
            settings.sidechatExpiry !== defaults.sidechatExpiry ? (
              <SettingResetButton
                label="side chat expiry"
                onClick={() =>
                  updateSettings({
                    sidechatExpiry: defaults.sidechatExpiry,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.sidechatExpiry}
              onValueChange={(value) => updateSettings({ sidechatExpiry: value })}
              ariaLabel="Side chat expiry"
              options={SIDECHAT_EXPIRY_OPTIONS}
            />
          }
        />

        <SettingsRow
          title="Enter while dictating"
          description="What Enter does while you dictate."
          resetAction={
            settings.voiceEnterBehavior !== defaults.voiceEnterBehavior ? (
              <SettingResetButton
                label="enter while dictating"
                onClick={() =>
                  updateSettings({
                    voiceEnterBehavior: defaults.voiceEnterBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.voiceEnterBehavior}
              onValueChange={(value) => updateSettings({ voiceEnterBehavior: value })}
              ariaLabel="Enter while dictating"
              options={VOICE_ENTER_BEHAVIOR_OPTIONS}
            />
          }
        />

        {renderBooleanSettingRow({
          settingKey: "enableAssistantStreaming",
          title: "Assistant output",
          description: "Show replies as they are written.",
          resetLabel: "assistant output",
          ariaLabel: "Stream assistant messages",
        })}

        {renderBooleanSettingRow({
          settingKey: "collapseFinishedTurns",
          title: "Fold finished turns",
          description: "Fold each finished turn into one line.",
          resetLabel: "fold finished turns",
          ariaLabel: "Fold finished turns",
        })}

        {renderBooleanSettingRow({
          settingKey: "composerEffortSlider",
          title: "Effort slider",
          description: "Pick thinking effort with a slider.",
          resetLabel: "effort slider",
          ariaLabel: "Show effort slider in the composer",
        })}

        {isAudioLevelAvailable() ? (
          <SettingsRow
            title="Message trail sound"
            description="Let the message marks move with sound."
            resetAction={
              settings.messageTrailAudioSource !== defaults.messageTrailAudioSource ? (
                <SettingResetButton
                  label="message trail sound"
                  onClick={() =>
                    updateSettings({ messageTrailAudioSource: defaults.messageTrailAudioSource })
                  }
                />
              ) : null
            }
            control={
              <SettingsSegmentedControl
                value={settings.messageTrailAudioSource}
                onValueChange={(value) => updateSettings({ messageTrailAudioSource: value })}
                ariaLabel="Message trail sound"
                options={MESSAGE_TRAIL_AUDIO_SOURCE_OPTIONS}
              />
            }
          />
        ) : null}

        {isAudioLevelAvailable() &&
        (settings.messageTrailAudioSource === "microphone" ||
          settings.messageTrailAudioSource === "both") ? (
          <MessageTrailMicrophoneRow
            value={settings.messageTrailMicrophoneId}
            defaultValue={defaults.messageTrailMicrophoneId}
            onChange={(messageTrailMicrophoneId) => updateSettings({ messageTrailMicrophoneId })}
          />
        ) : null}

        {renderBooleanSettingRow({
          settingKey: "autoOpenDevicePane",
          title: "Automatically open simulator",
          description: "Open the Simulator pane when an agent uses it.",
          resetLabel: "automatically open simulator",
          ariaLabel: "Automatically open simulator",
        })}
      </SettingsSection>

      <KeepAwakeSettingsSection
        state={keepAwake}
        mode={settings.keepAwakeMode}
        defaultMode={defaults.keepAwakeMode}
        onSelectMode={(keepAwakeMode) => updateSettings({ keepAwakeMode })}
      />

      <SettingsSection title="Review">
        <SettingsRow
          title="Diff layout"
          description="Stacked or side by side."
          resetAction={
            defaultDiffRenderMode !== DEFAULT_DIFF_RENDER_MODE ? (
              <SettingResetButton
                label="diff layout"
                onClick={() => setDefaultDiffRenderMode(DEFAULT_DIFF_RENDER_MODE)}
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={defaultDiffRenderMode}
              onValueChange={setDefaultDiffRenderMode}
              ariaLabel="Diff layout"
              options={
                [
                  { value: "stacked", label: "Stacked" },
                  { value: "split", label: "Split" },
                ] satisfies ReadonlyArray<{ value: DiffRenderMode; label: string }>
              }
            />
          }
        />
        <SettingsRow
          title="Open pull requests and issues"
          description="Where pull request and issue links open."
          resetAction={
            settings.githubLinkOpenTarget !== defaults.githubLinkOpenTarget ? (
              <SettingResetButton
                label="open pull requests and issues"
                onClick={() =>
                  updateSettings({
                    githubLinkOpenTarget: defaults.githubLinkOpenTarget,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.githubLinkOpenTarget}
              onValueChange={(value) => {
                if (value !== "app" && value !== "browser" && value !== "external") {
                  return;
                }
                updateSettings({
                  githubLinkOpenTarget: value,
                });
              }}
              ariaLabel="Open pull requests and issues"
              triggerClassName="w-full sm:w-40"
              valueContent={GITHUB_LINK_OPEN_TARGET_LABELS[settings.githubLinkOpenTarget]}
            >
              <SelectItem hideIndicator value="app">
                {GITHUB_LINK_OPEN_TARGET_LABELS.app}
              </SelectItem>
              <SelectItem hideIndicator value="browser">
                {GITHUB_LINK_OPEN_TARGET_LABELS.browser}
              </SelectItem>
              <SelectItem hideIndicator value="external">
                {GITHUB_LINK_OPEN_TARGET_LABELS.external}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        {renderBooleanSettingRow({
          settingKey: "showPullRequestDiffColors",
          title: t("settings.behavior.pullRequestDiffColors.title"),
          description: t("settings.behavior.pullRequestDiffColors.description"),
          resetLabel: t("settings.behavior.pullRequestDiffColors.resetLabel"),
          ariaLabel: t("settings.behavior.pullRequestDiffColors.aria"),
        })}

        {renderBooleanSettingRow({
          settingKey: "githubInboxIncludeUpstreams",
          title: "Include fork upstreams",
          description: "Include the repository a fork came from.",
          resetLabel: "include fork upstreams",
          ariaLabel: "Include fork upstreams in code review",
        })}

        {renderBooleanSettingRow({
          settingKey: "diffWordWrap",
          title: "Diff line wrapping",
          description: "Wrap long lines in diffs.",
          resetLabel: "diff line wrapping",
          ariaLabel: "Wrap diff lines by default",
        })}
      </SettingsSection>

      <SettingsSection title="Safety confirmations">
        {renderBooleanSettingRow({
          settingKey: "confirmThreadDelete",
          title: "Delete confirmation",
          description: "Ask before deleting a thread and its chat history.",
          resetLabel: "delete confirmation",
          ariaLabel: "Confirm thread deletion",
        })}

        {renderBooleanSettingRow({
          settingKey: "confirmThreadArchive",
          title: "Archive confirmation",
          description: "Ask before archiving a thread.",
          resetLabel: "archive confirmation",
          ariaLabel: "Confirm thread archive",
        })}

        {renderBooleanSettingRow({
          settingKey: "confirmTerminalTabClose",
          title: "Terminal close confirmation",
          description: "Ask before closing a terminal tab and clearing its history.",
          resetLabel: "terminal close confirmation",
          ariaLabel: "Confirm terminal tab close",
        })}
      </SettingsSection>
    </div>
  );

  const renderRouteOwnedPanel = () => {
    switch (activeSection) {
      case "general":
        return renderGeneralPanel();
      case "import":
        return <ImportSettingsPanel />;
      case "appearance":
        return renderAppearancePanel();
      case "behavior":
        return renderBehaviorPanel();
      case "shortcuts":
        return (
          <div className="space-y-6">
            <KeyboardShortcutsSettingsPanel />
            <KeybindingsFileRow />
          </div>
        );
      case "plugins":
        return (
          <PluginLibrary
            embeddedInSettings
            settingsTab={location.pluginTab ?? "plugins"}
            onSettingsTabChange={(tab) => onNavigate({ section: "plugins", pluginTab: tab })}
          />
        );
      case "history":
        return <ComputerHistorySettingsPanel />;

      case "voice":
        return <RealtimeVoiceSettingsPanel />;
      case "profile":
        return <ProfileSettingsPanel />;
      case "usage":
        return <ProviderUsageSettingsPanel />;
      default:
        return null;
    }
  };

  const pageTitle = t(settingsSectionTranslationKeys(activeSection).label);
  const pageDescription = t(settingsSectionTranslationKeys(activeSection).description);
  // Pages that draw their own header (Profile's hero, Plugins' title with its actions).
  const pageOwnsHeader = activeSection === "profile" || activeSection === "plugins";
  const pageHasNoDefaults =
    activeSection === "connections" ||
    activeSection === "computer-use" ||
    activeSection === "archived" ||
    activeSection === "worktrees" ||
    activeSection === "usage" ||
    activeSection === "import" ||
    activeSection === "history";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        data-testid="settings-page-scroll"
      >
        <div
          className={cn(
            "mx-auto w-full",
            // Plugins brings its own 768px column with 20px gutters and top margin.
            activeSection === "plugins" ? "max-w-3xl px-3 pb-12" : "max-w-[46rem] px-8 pt-7 pb-12",
          )}
          data-settings-section={activeSection}
        >
          {!pageOwnsHeader ? (
            <header className="mb-7 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className={PAGE_TITLE_CLASS_NAME}>{pageTitle}</h1>
                <p className="mt-1 truncate text-ui text-muted-foreground">{pageDescription}</p>
              </div>
              {activeSection === "shortcuts" ? (
                <KeyboardShortcutsResetButton />
              ) : pageHasNoDefaults ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground"
                  disabled={changedSettingLabels.length === 0}
                  onClick={() => void restoreDefaults()}
                >
                  <ResetIcon className="size-4" />
                  {t("settings.dialog.restoreDefaults")}
                </Button>
              )}
            </header>
          ) : null}

          {renderRouteOwnedPanel()}
          {/* These workflow owners stay mounted while the dialog is open so drafts, request
              guards, and pending mutations survive page switches; inactive panels render no DOM. */}
          <div className="contents">
            <NotificationsSettingsPanel
              active={activeSection === "notifications"}
              settings={settings}
              defaults={defaults}
              updateSettings={updateSettings}
            />
            <AppSnapSettingsPanel
              active={activeSection === "appsnap"}
              settings={settings}
              defaults={defaults}
              updateSettings={updateSettings}
            />
            <ComputerSettingsPanel
              active={activeSection === "computer-use"}
              settings={settings}
              defaults={defaults}
              updateSettings={updateSettings}
            />
            <ConnectionsSettingsPanel
              active={activeSection === "connections"}
              tab={connectionTab}
              onTabChange={selectConnectionTab}
            />
            <WorktreesSettingsPanel active={activeSection === "worktrees"} />
            <ArchivedSettingsPanel active={activeSection === "archived"} />
            <ModelsSettingsPanel
              active={activeSection === "models"}
              settings={settings}
              defaults={defaults}
              updateSettings={updateSettings}
              resetEpoch={resetEpoch}
            />
            <ProvidersSettingsPanel
              active={activeSection === "providers"}
              providerTarget={settingsProviderTarget}
              settings={settings}
              defaults={defaults}
              updateSettings={updateSettings}
              updateSettingsAndWait={updateSettingsAndWait}
              resetEpoch={resetEpoch}
            />
          </div>
        </div>
      </div>
      {/* Mounted beside the scroller so the dialog portal is never clipped by it. */}
      <ReleaseHistoryDialog
        open={releaseHistoryOpen}
        onOpenChange={setReleaseHistoryOpen}
        defaultExpandedVersion={APP_VERSION}
      />
    </div>
  );
}

export function providerDocLabelKey(label: string): TranslationKey {
  if (label === "Install") {
    return "settings.providers.docs.install";
  }
  if (label === "Update") {
    return "settings.providers.docs.update";
  }
  if (label === "Config") {
    return "settings.providers.docs.config";
  }
  if (label === "Headless") {
    return "settings.providers.docs.headless";
  }
  if (label === "Reference") {
    return "settings.providers.docs.reference";
  }
  if (label === "Hooks") {
    return "settings.providers.docs.hooks";
  }
  return "settings.providers.docs.title";
}
