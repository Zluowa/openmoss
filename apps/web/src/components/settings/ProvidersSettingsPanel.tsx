// FILE: ProvidersSettingsPanel.tsx
// Purpose: Own provider picker, update, and CLI installation settings workflows.
// Layer: Settings panel

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@moss/contracts";
import { isBetaFeatureOn, VISIBLE_PROVIDER_DESCRIPTORS } from "../../betaFeatures";
import { isMossActiveProvider } from "~/providerProductCatalog";
import {
  normalizeProviderCliAlias,
  providerCliCommandName,
} from "@moss/shared/providerCliProfiles";
import { MOSS_CN_NPM_MIRROR_REGISTRY } from "@moss/shared/mossRealmCatalog";
import {
  MOSS_SERVER_AUTHORIZED_CLI_DRIVERS,
  isMossManagedCliAuthorized,
  providerImportedDirectoryConfig,
} from "@moss/shared/providerInstances";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  buildProviderInstanceSettingsPatch,
  getCodexAccountOptions,
  getManageableProviderInstances,
  getProviderInstanceOptions,
  removeManageableProviderInstance,
  type AppSettings,
  type AppSettingsBinding,
  type ManageableProviderInstance,
  type ProviderInstanceOption,
  type ProviderInstancePatch,
} from "~/appSettings";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { CentralIcon } from "~/lib/central-icons";
import {
  CopyIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  PlusIcon,
  PlayIcon,
  XIcon,
} from "~/lib/icons";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTranslation, type TranslationKey } from "~/localization";
import { normalizeProviderAccentColor } from "~/lib/providerInstancePresentation";
import {
  type ProviderAccountStatusSummary,
  type ProviderAccountStatusTone,
  providerAccountStatusSummary,
  providerSetupStatusLabel,
} from "~/lib/providerSetupStatus";
import {
  hasReconciledServerProviderStatuses,
  serverAllProviderUsageQueryOptions,
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  isProviderKind,
  isLocalProviderInstalled,
  prioritizeInstalledProviders,
  sameProviderOrder,
} from "~/providerOrdering";
import {
  getVisibleProviderUpdateStatuses,
  installedVersionLabel,
  providerVersionCheckSummary,
  shouldShowProviderUpdateStatus,
  withProviderUpdateTimeout,
} from "~/providerUpdates";
import { providerStatusInstanceKey, resolveAgentReadiness } from "~/lib/providerAvailability";
import { providersServedByMoss } from "~/components/chat/providerAccountSources";
import {
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_INSET_RADIUS_CLASS_NAME,
  SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import { ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME } from "~/surfaceStyles";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ProviderIcon } from "../ProviderIcon";
import { ProviderAccountAvatar } from "../ProviderAccountMark";
import { StatusChip } from "../ui/status-chip";
import {
  AddProviderAccountDialog,
  type AddProviderAccountConfigField,
  type AddProviderAccountInput,
} from "./AddProviderAccountDialog";
import { AgentInstallButton } from "./AgentInstallButton";
import { ProviderInstallationDialog } from "./ProviderInstallationDialog";
import { DebouncedSettingTextInput } from "./DebouncedSettingTextInput";
import { ProviderAccentColorControl } from "./ProviderAccentColorControl";
import { ProviderInstanceEnvironmentEditor } from "./ProviderInstanceEnvironmentEditor";
import {
  SettingResetButton,
  SettingsSelectControl,
  useSettingsRestoreSignal,
} from "./SettingControls";
import { AddUnifiedProviderDialog } from "./providers/AddUnifiedProviderDialog";
import { CliAgentDetailPane } from "./providers/CliAgentDetailPane";
import { MossProviderDetailPane } from "./providers/MossProviderDetailPane";
import { ProvidersPreferencesPane } from "./providers/ProvidersPreferencesPane";
import { ProvidersSplitWorkbench } from "./providers/ProvidersSplitWorkbench";
import { UnifiedProviderDetailPane } from "./providers/UnifiedProviderDetailPane";
import {
  resolveEffectiveCliSourceUi,
  type ProviderWorkbenchSelection,
} from "./providers/providerWorkbenchTypes";

type ProviderInstallTextKey =
  | "claudeBinaryPath"
  | "claudeHomePath"
  | "claudeSharedProjectsPath"
  | "codexBinaryPath"
  | "codexHomePath"
  | "cursorBinaryPath"
  | "cursorApiEndpoint"
  | "devinBinaryPath"
  | "antigravityBinaryPath"
  | "grokBinaryPath"
  | "openCodeBinaryPath"
  | "openCodeServerUrl"
  | "piBinaryPath"
  | "piAgentDir"
  | "ompBinaryPath"
  | "ompAgentDir"
  | "kimiBinaryPath"
  | "minimaxBinaryPath"
  | "zcodeBinaryPath";
type ProviderInstallPasswordKey = "openCodeServerPassword";
type ProviderInstallPasswordConfiguredKey = "openCodeServerPasswordConfigured";
type ProviderInstallBooleanKey =
  | "claudeEnableArtifacts"
  | "claudeShareStateAcrossAccounts"
  | "codexShareStateAcrossAccounts"
  | "openCodeExperimentalWebSockets";

type ProviderInstallTextField = {
  readonly kind: "text";
  readonly settingsKey: ProviderInstallTextKey;
  readonly folder?: true;
  readonly label: string;
  readonly placeholder: string;
  readonly description: ReactNode;
};
type ProviderInstallPasswordField = {
  readonly kind: "password";
  readonly settingsKey: ProviderInstallPasswordKey;
  readonly configuredKey: ProviderInstallPasswordConfiguredKey;
  readonly label: string;
  readonly placeholder: string;
  readonly description: ReactNode;
};
type ProviderInstallBooleanField = {
  readonly kind: "boolean";
  readonly settingsKey: ProviderInstallBooleanKey;
  readonly label: string;
  readonly description: ReactNode;
};
type ProviderInstallField =
  | ProviderInstallTextField
  | ProviderInstallPasswordField
  | ProviderInstallBooleanField;
/** One-line shell install for CLIs Moss cannot install itself, plus sign-in guidance. */
type ProviderInstallCommand = {
  readonly command: string;
  /** Localized follow-up: alternative installers, sign-in steps, prerequisites. */
  readonly noteKey: TranslationKey;
};
type ProviderInstallSettings = {
  readonly provider: ProviderKind;
  readonly install?: ProviderInstallCommand;
  readonly fields: readonly ProviderInstallField[];
};

const PROVIDER_VISIBILITY_OPTIONS = VISIBLE_PROVIDER_DESCRIPTORS.filter((descriptor) =>
  isMossActiveProvider(descriptor.kind),
).map((descriptor) => ({
  provider: descriptor.kind,
  title: descriptor.displayName,
  setupDocsHref: descriptor.setupDocsHref,
}));

const PROVIDER_INSTALL_SETTINGS: readonly ProviderInstallSettings[] = [
  {
    provider: "codex",
    fields: [
      {
        kind: "text",
        settingsKey: "codexBinaryPath",
        label: "Codex binary path",
        placeholder: "Codex binary path",
        description: (
          <>
            Moss uses the selected program, then the installed CLI, then its bundled copy. Program
            changes take effect after restarting Moss.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "codexHomePath",
        folder: true,
        label: "CODEX_HOME path",
        placeholder: "CODEX_HOME",
        description:
          "Codex home directory. When history sharing is enabled, this is the shared history source; each account needs a separate private config and sign-in directory.",
      },
      {
        kind: "boolean",
        settingsKey: "codexShareStateAcrossAccounts",
        label: "Share Codex history across accounts",
        description:
          "New chats use the selected history source with private account credentials and configuration. Existing chats keep their original history source. No history is moved or merged.",
      },
    ],
  },
  {
    provider: "claudeAgent",
    fields: [
      {
        kind: "text",
        settingsKey: "claudeBinaryPath",
        label: "Claude binary path",
        placeholder: "Claude binary path",
        description: (
          <>
            Moss uses the selected program, then the installed CLI, then its bundled copy. Program
            changes take effect after restarting Moss.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "claudeHomePath",
        folder: true,
        label: "Claude HOME path",
        placeholder: "Claude HOME",
        description: "Optional HOME directory for this Claude account.",
      },
      {
        kind: "text",
        settingsKey: "claudeSharedProjectsPath",
        label: "Shared Claude projects directory",
        placeholder: "Absolute projects directory",
        folder: true,
        description:
          "Choose the existing projects directory to share. Each account needs an explicit, separate private HOME and config directory.",
      },
      {
        kind: "boolean",
        settingsKey: "claudeShareStateAcrossAccounts",
        label: "Share Claude history across accounts",
        description:
          "New chats use this projects directory. Existing chats keep their original source. A newly shared Moss account starts with fresh user settings, home plugins and caches; workspace configuration still applies.",
      },
      {
        kind: "boolean",
        settingsKey: "claudeEnableArtifacts",
        label: "Artifacts, /design and /slides",
        description: (
          <>
            Claude Code keeps Artifacts off in embedded sessions. Turn this on so{" "}
            <code>/design</code> and <code>/slides</code> publish to claude.ai. Needs a claude.ai
            login on a Pro, Max, Team or Enterprise plan, and applies to new sessions.
          </>
        ),
      },
    ],
  },
  {
    provider: "cursor",
    fields: [
      {
        kind: "text",
        settingsKey: "cursorBinaryPath",
        label: "Cursor binary path",
        placeholder: "Cursor Agent or Cursor CLI path",
        description: (
          <>
            Leave blank to use <code>cursor-agent</code> from your PATH. Cursor editor CLI paths are
            accepted too.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "cursorApiEndpoint",
        label: "Cursor API endpoint",
        placeholder: "https://api2.cursor.sh",
        description: "Optional Cursor API endpoint override passed to `cursor-agent -e`.",
      },
    ],
  },
  {
    provider: "antigravity",
    fields: [
      {
        kind: "text",
        settingsKey: "antigravityBinaryPath",
        label: "Antigravity binary path",
        placeholder: "Antigravity CLI binary path",
        description: (
          <>
            Leave blank to use <code>agy</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "grok",
    fields: [
      {
        kind: "text",
        settingsKey: "grokBinaryPath",
        label: "Grok binary path",
        placeholder: "Grok binary path",
        description: (
          <>
            Leave blank to use <code>grok</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "devin",
    fields: [
      {
        kind: "text",
        settingsKey: "devinBinaryPath",
        label: "Devin binary path",
        placeholder: "devin",
        description: (
          <>
            Leave blank to use <code>devin</code> from your PATH. Authenticate with{" "}
            <code>devin auth login</code> or set WINDSURF_API_KEY.
          </>
        ),
      },
    ],
  },
  {
    provider: "opencode",
    fields: [
      {
        kind: "text",
        settingsKey: "openCodeBinaryPath",
        label: "OpenCode binary path",
        placeholder: "OpenCode binary path",
        description: (
          <>
            Leave blank to use <code>opencode</code> from your PATH.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "openCodeServerUrl",
        label: "OpenCode server URL",
        placeholder: "http://127.0.0.1:4096",
        description: "Optional existing OpenCode server URL. Leave blank to spawn a local server.",
      },
      {
        kind: "password",
        settingsKey: "openCodeServerPassword",
        configuredKey: "openCodeServerPasswordConfigured",
        label: "OpenCode server password",
        placeholder: "OpenCode server password",
        description: "Optional password for an externally managed OpenCode server.",
      },
      {
        kind: "boolean",
        settingsKey: "openCodeExperimentalWebSockets",
        label: "OpenAI response WebSockets",
        description:
          "Use Opencode's experimental OpenAI response WebSocket transport for managed local servers.",
      },
    ],
  },
  {
    provider: "pi",
    fields: [
      {
        kind: "text",
        settingsKey: "piBinaryPath",
        label: "Pi binary path",
        placeholder: "Pi binary path",
        description: (
          <>
            Leave blank to use <code>pi</code> from your PATH.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "piAgentDir",
        label: "Pi agent directory",
        placeholder: "Pi agent directory",
        description: "Optional custom Pi agent directory for auth, models, skills, and commands.",
      },
    ],
  },
  {
    provider: "omp",
    fields: [
      {
        kind: "text",
        settingsKey: "ompBinaryPath",
        label: "Oh My Pi binary path",
        placeholder: "Oh My Pi binary path",
        description: (
          <>
            Leave blank to use <code>omp</code> from your PATH.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "ompAgentDir",
        label: "Oh My Pi agent directory",
        placeholder: "Oh My Pi agent directory",
        description:
          "Optional custom Oh My Pi agent directory for auth, models, skills, and commands.",
      },
    ],
  },
  {
    provider: "kimi",
    install: {
      command: "npm install -g @moonshot-ai/kimi-code",
      noteKey: "settings.providers.install.kimi.note",
    },
    fields: [
      {
        kind: "text",
        settingsKey: "kimiBinaryPath",
        label: "Kimi Code binary path",
        placeholder: "Kimi Code binary path",
        description: (
          <>
            Leave blank to use <code>kimi</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "minimax",
    install: {
      // MiniMax Code ships a native better-sqlite3 dependency, so npm needs the
      // install scripts allowed (the README's official command).
      command: "npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3",
      noteKey: "settings.providers.install.minimax.note",
    },
    fields: [
      {
        kind: "text",
        settingsKey: "minimaxBinaryPath",
        label: "MiniMax Code binary path",
        placeholder: "MiniMax Code binary path",
        description: (
          <>
            Leave blank to use <code>mcode</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "zcode",
    install: {
      command: "npm install -g zcode-acp-server",
      noteKey: "settings.providers.install.zcode.note",
    },
    fields: [
      {
        kind: "text",
        settingsKey: "zcodeBinaryPath",
        label: "ZCode binary path",
        placeholder: "ZCode bridge binary path",
        description: (
          <>
            Leave blank to use <code>zcode-acp-server</code> from your PATH.
          </>
        ),
      },
    ],
  },
];

/** The same install, downloading from the mainland China mirror. */
export function withCnMirrorRegistry(command: string): string {
  return command.replace(
    /^npm install -g /,
    `npm install -g --registry=${MOSS_CN_NPM_MIRROR_REGISTRY} `,
  );
}

/** The shell command that installs a provider's CLI, when Moss shows one. */
export function providerInstallCommandFor(provider: ProviderKind): string | null {
  return (
    PROVIDER_INSTALL_SETTINGS.find((entry) => entry.provider === provider)?.install?.command ?? null
  );
}

// Retired and beta-only providers keep their stored install fields for decode
// compatibility, but never surface in product UI.
const VISIBLE_PROVIDER_INSTALL_SETTINGS = PROVIDER_INSTALL_SETTINGS.filter(
  (config) => isMossActiveProvider(config.provider) && isBetaFeatureOn(config.provider),
);

function isProviderInstallFieldDirty(
  field: ProviderInstallField,
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return field.kind === "password"
    ? settings[field.configuredKey] !== defaults[field.configuredKey]
    : settings[field.settingsKey] !== defaults[field.settingsKey];
}

function isProviderInstallConfigDirty(
  config: ProviderInstallSettings,
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return (
    config.fields.some((field) => isProviderInstallFieldDirty(field, settings, defaults)) ||
    JSON.stringify(
      Object.fromEntries(
        Object.entries(settings.providerInstances).filter(
          ([, instance]) => instance.driver === config.provider,
        ),
      ),
    ) !==
      JSON.stringify(
        Object.fromEntries(
          Object.entries(defaults.providerInstances).filter(
            ([, instance]) => instance.driver === config.provider,
          ),
        ),
      ) ||
    (config.provider === "codex" &&
      (settings.selectedCodexAccountId !== defaults.selectedCodexAccountId ||
        JSON.stringify(settings.codexAccounts) !== JSON.stringify(defaults.codexAccounts)))
  );
}

export function isProviderInstallSettingsDirty(
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return PROVIDER_INSTALL_SETTINGS.some((config) =>
    isProviderInstallConfigDirty(config, settings, defaults),
  );
}

function createClosedProviderInstallDisclosureState(): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.map((config) => [config.provider, false]),
  ) as Record<ProviderKind, boolean>;
}

export function createProviderInstallResetPatch(defaults: AppSettings): Partial<AppSettings> {
  const fieldPatch = Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.flatMap((config) =>
      config.fields.map((field) => [field.settingsKey, defaults[field.settingsKey]]),
    ),
  ) as Partial<AppSettings>;
  return {
    ...fieldPatch,
    codexAccounts: defaults.codexAccounts,
    selectedCodexAccountId: defaults.selectedCodexAccountId,
    providerInstances: defaults.providerInstances,
  };
}

function setProviderListMembership(
  current: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  included: boolean,
): ProviderKind[] {
  const withoutTarget = current.filter((entry) => entry !== provider);
  return included ? [...withoutTarget, provider] : withoutTarget;
}

function isProviderPickerProviderEnabled(
  providerStatus: Pick<ServerProviderStatus, "available"> | null | undefined,
  isHidden: boolean,
): boolean {
  return providerStatus?.available === true && !isHidden;
}

function SortableProviderVisibilityRow(props: {
  option: { provider: ProviderKind; title: string; setupDocsHref?: string };
  providerStatus: ServerProviderStatus | undefined;
  statusReconciled: boolean;
  isDisabled: boolean;
  isHidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}) {
  const { t, format } = useTranslation();
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.option.provider });
  const isChecking = !props.statusReconciled || props.providerStatus === undefined;
  const isAvailable = props.providerStatus?.available === true;
  const isEnabled = isProviderPickerProviderEnabled(props.providerStatus, props.isHidden);
  const readiness =
    !isChecking && !props.isDisabled && props.providerStatus
      ? resolveAgentReadiness(props.providerStatus)
      : null;
  const isNotInstalled = !isAvailable && readiness?.state === "notInstalled";
  const statusText = isNotInstalled
    ? readiness.reason === "desktop-app-only"
      ? format("provider.readiness.notInstalled.desktopApp", { provider: props.option.title })
      : t("provider.readiness.notInstalled")
    : providerSetupStatusLabel({
        status: props.providerStatus,
        reconciled: props.statusReconciled,
        disabled: props.isDisabled,
      });

  return (
    <div
      ref={setNodeRef}
      data-testid="provider-visibility-row"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
        "flex items-center justify-between gap-3 px-3 py-2.5",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={cn(
            "inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing",
            ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME,
            SETTINGS_INSET_RADIUS_CLASS_NAME,
          )}
          aria-label={`Reorder ${props.option.title}`}
          {...attributes}
          {...listeners}
        >
          <CentralIcon name="dot-grid-2x3" className="size-4" />
        </button>
        <ProviderIcon provider={props.option.provider} className="size-4 shrink-0" />
        <span className="min-w-0">
          <span className="block truncate text-ui-lg leading-snug text-foreground">
            {props.option.title}
          </span>
          <span className="block text-ui-sm text-muted-foreground">{statusText}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {isNotInstalled ? (
          <AgentInstallButton
            provider={props.option.provider}
            providerLabel={props.option.title}
            readiness={readiness}
            status={props.providerStatus}
            fallbackUrl={props.option.setupDocsHref}
          />
        ) : null}
        <Switch
          checked={isEnabled}
          disabled={isChecking || !isAvailable}
          onCheckedChange={(checked) => props.onHiddenChange(!Boolean(checked))}
          aria-label={
            isChecking
              ? `Checking ${props.option.title} CLI availability`
              : isAvailable
                ? `Show ${props.option.title} in the provider picker`
                : `${props.option.title} is unavailable in the provider picker`
          }
        />
      </div>
    </div>
  );
}

// Renders `code` spans from a localized note without letting translations carry markup.
function renderInlineCode(text: string): ReactNode {
  const segments = text.split("`");
  if (segments.length < 3) return text;
  return segments.map((segment, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono text-[0.92em]">
        {segment}
      </code>
    ) : (
      segment
    ),
  );
}

function ProviderInstallCommandCard({ install }: { install: ProviderInstallCommand }) {
  const { t } = useTranslation();
  return (
    <div className={cn(SETTINGS_OUTLINED_SURFACE_CLASS_NAME, "px-3 py-2.5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="shrink-0 text-ui leading-snug font-medium text-foreground">
          {t("settings.providers.install.commandLabel")}
        </span>
        <div className="flex min-w-0 items-center gap-2 sm:max-w-[70%]">
          <code className="min-w-0 flex-1 truncate rounded-control border border-border/70 bg-background/60 px-2.5 py-1.5 font-mono text-ui-sm">
            {install.command}
          </code>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={t("settings.providers.install.copyCommandAria")}
            onClick={() => void copyTextToClipboard(install.command)}
          >
            <CopyIcon className="size-4" />
          </Button>
        </div>
      </div>
      <p className="mt-2 text-ui-sm leading-snug text-muted-foreground">
        {renderInlineCode(t(install.noteKey))}
      </p>
    </div>
  );
}

async function openProviderGuide(url: string, failureTitle: string) {
  try {
    await ensureNativeApi().shell.openExternal(url);
  } catch {
    toastManager.add({ type: "error", title: failureTitle });
  }
}

function formatProviderVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function providerUpdateStatusLabel(provider: ServerProviderStatus): string | null {
  const state = provider.updateState?.status;
  if (state === "queued") return "Update queued";
  if (state === "running") return "Updating";
  if (state === "succeeded") return "Updated";
  if (state === "failed") return "Update failed";
  if (state === "unchanged") return "Still outdated";
  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest" && advisory.latestVersion) {
    const currentVersion = formatProviderVersion(advisory.currentVersion);
    const latestVersion = formatProviderVersion(advisory.latestVersion);
    return currentVersion ? `${currentVersion} -> ${latestVersion}` : `Latest ${latestVersion}`;
  }
  return installedVersionLabel(provider, true);
}

function providerUpdateFailureMessage(provider: ServerProviderStatus | undefined): string | null {
  const state = provider?.updateState;
  if (!state || (state.status !== "failed" && state.status !== "unchanged")) return null;
  return state.output?.trim() || state.message || "The provider update did not complete.";
}

function providerStatusDisplayName(status: ServerProviderStatus): string {
  if (status.displayName?.trim()) return status.displayName;
  const driver = status.driver ?? status.provider;
  return isProviderKind(driver) ? PROVIDER_DISPLAY_NAMES[driver] : driver;
}

function ProviderUpdateAction(props: {
  providerStatus: ServerProviderStatus;
  active: boolean;
  disabled: boolean;
  onUpdate: (provider: ProviderKind, instanceId?: ProviderInstanceId) => void;
}) {
  const advisory = props.providerStatus.versionAdvisory;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={props.disabled}
      title={advisory?.updateCommand ? `Run ${advisory.updateCommand}` : undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const driver = props.providerStatus.driver ?? props.providerStatus.provider;
        if (!isProviderKind(driver)) return;
        props.onUpdate(driver, providerStatusInstanceKey(props.providerStatus));
      }}
    >
      {props.active ? (
        <Loader2Icon className="size-4 animate-spin" />
      ) : (
        <DownloadIcon className="size-4" />
      )}
      {props.active ? "Updating" : "Update"}
    </Button>
  );
}

function AccountFolderButton({ onSelect }: { onSelect: (directory: string) => void }) {
  const { t } = useTranslation();
  const desktop = typeof window !== "undefined" && Boolean(window.desktopBridge);
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={!desktop}
      title={desktop ? undefined : "Directory selection is available in the Moss desktop app."}
      onClick={async () => {
        try {
          const directory = await ensureNativeApi().dialogs.pickFolder();
          if (directory) onSelect(directory);
        } catch {
          toastManager.add({ type: "error", title: t("folderPicker.openFailed") });
        }
      }}
    >
      <FolderOpenIcon className="size-4" />
      Choose folder
    </Button>
  );
}

function ProviderInstallFieldControl(props: {
  field: ProviderInstallField;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const id = `provider-install-${props.field.settingsKey}`;
  if (props.field.kind === "boolean") {
    return (
      <label
        htmlFor={id}
        className="flex items-start justify-between gap-3 rounded-control border border-border/70 bg-background/60 px-3 py-2"
      >
        <span className="min-w-0">
          <span className="block text-ui leading-snug font-medium text-foreground">
            {props.field.label}
          </span>
          <span className="mt-1 block text-ui leading-snug text-muted-foreground">
            {props.field.description}
          </span>
        </span>
        <Switch
          id={id}
          checked={props.settings[props.field.settingsKey]}
          onCheckedChange={(checked) =>
            props.updateSettings({ [props.field.settingsKey]: Boolean(checked) })
          }
        />
      </label>
    );
  }

  const configured =
    props.field.kind === "password" ? props.settings[props.field.configuredKey] : false;
  const isPassword = props.field.kind === "password";
  return (
    <div className="block">
      <label htmlFor={id} className="block text-ui leading-snug font-medium text-foreground">
        {props.field.label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <DebouncedSettingTextInput
          id={id}
          size="sm"
          variant="soft"
          className="min-w-0 flex-1"
          value={isPassword ? "" : props.settings[props.field.settingsKey]}
          onCommit={(nextValue) =>
            props.updateSettings({ [props.field.settingsKey]: nextValue } as Partial<AppSettings>)
          }
          placeholder={
            isPassword && configured
              ? "Configured — enter a replacement or leave blank"
              : props.field.placeholder
          }
          type={isPassword ? "password" : undefined}
          autoComplete={isPassword ? "new-password" : undefined}
          spellCheck={false}
        />
        {props.field.kind === "text" && props.field.folder ? (
          <AccountFolderButton
            onSelect={(directory) => props.updateSettings({ [props.field.settingsKey]: directory })}
          />
        ) : null}
      </div>
      <span className="mt-1 block text-ui leading-snug text-muted-foreground">
        {props.field.description}
      </span>
    </div>
  );
}

// Settings written before accounts became provider instances also store which Codex
// account new threads start on. Only those settings still need the choice surfaced.
function CodexDefaultAccountControl(props: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  // The default account goes by the provider's name here too, as in the account list.
  const accountOptions = getCodexAccountOptions(props.settings).map((account) =>
    account.isDefault ? { ...account, label: PROVIDER_DISPLAY_NAMES.codex } : account,
  );
  const selectedAccountLabel =
    accountOptions.find((account) => account.id === props.settings.selectedCodexAccountId)?.label ??
    PROVIDER_DISPLAY_NAMES.codex;

  return (
    <div className="space-y-1">
      <span className="block text-ui-sm font-medium text-foreground">
        Codex account for new threads
      </span>
      <SettingsSelectControl
        value={props.settings.selectedCodexAccountId}
        onValueChange={(selectedCodexAccountId) => props.updateSettings({ selectedCodexAccountId })}
        ariaLabel="Codex account for new threads"
        triggerClassName="w-full"
        valueContent={<span className="truncate">{selectedAccountLabel}</span>}
      >
        {accountOptions.map((account) => (
          <SelectItem hideIndicator key={account.id} value={account.id}>
            <span className="truncate">{account.label}</span>
          </SelectItem>
        ))}
      </SettingsSelectControl>
      <span className="block text-ui-sm text-muted-foreground">
        Used until you pick another account in the model picker.
      </span>
    </div>
  );
}

// Null for a provider-wide setting that no account config carries.
function providerInstanceConfigKey(field: ProviderInstallField): string | null {
  switch (field.settingsKey) {
    case "codexHomePath":
    case "claudeHomePath":
      return "homePath";
    case "cursorApiEndpoint":
      return "apiEndpoint";
    case "openCodeServerUrl":
      return "serverUrl";
    case "openCodeServerPassword":
      return "serverPassword";
    case "openCodeExperimentalWebSockets":
      return "experimentalWebSockets";
    // These settings are provider-wide; new account configs must not inherit them.
    case "claudeEnableArtifacts":
    case "claudeShareStateAcrossAccounts":
    case "claudeSharedProjectsPath":
    case "codexShareStateAcrossAccounts":
      return null;
    case "piAgentDir":
    case "ompAgentDir":
      return "agentDir";
    default:
      return "binaryPath";
  }
}

/** Launch config a new instance inherits from the provider's current install fields. */
export function providerInstanceLaunchConfigFor(
  provider: ProviderKind,
  settings: AppSettings,
): Record<string, unknown> {
  const config = PROVIDER_INSTALL_SETTINGS.find((entry) => entry.provider === provider);
  return config ? providerInstanceLaunchConfig(config, settings) : {};
}

function providerInstanceLaunchConfig(
  config: ProviderInstallSettings,
  settings: AppSettings,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of config.fields) {
    const key = providerInstanceConfigKey(field);
    if (key === null) continue;
    const value = settings[field.settingsKey];
    if (typeof value === "boolean") {
      if (value) result[key] = true;
      continue;
    }
    if (value.trim()) result[key] = value;
  }
  // A home names an account's identity: inheriting the default's would sign the new
  // account in as the default one.
  if (config.provider === "codex" || config.provider === "claudeAgent") {
    delete result.homePath;
  }
  return result;
}

// Paths that give a new account its own identity; asked for when adding one.
function providerAccountIdentityFields(
  provider: ProviderKind,
): ReadonlyArray<AddProviderAccountConfigField> {
  if (provider === "codex") {
    return [
      {
        key: "homePath",
        label: "CODEX_HOME path",
        placeholder: "~/.codex-work",
        description: "Leave blank and Moss keeps this account's sign-in in its own folder.",
      },
    ];
  }
  if (provider === "claudeAgent") {
    return [
      {
        key: "configDir",
        label: "Claude config directory",
        placeholder: "~/.claude-work",
        description:
          "Leave blank and Moss keeps this account's sign-in in its own folder. " +
          "Set a directory to use a Claude config folder you already signed in to.",
      },
    ];
  }
  if (provider === "pi" || provider === "omp") return [];
  return [
    {
      key: "profileDir",
      label: "Profile directory",
      placeholder: "Provider account directory",
      description: "Used as this account's provider config root without changing your shell files.",
    },
  ];
}

const ACCOUNT_STATUS_PILL_CLASS_NAME: Record<ProviderAccountStatusTone, string> = {
  ready: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  error: "bg-red-500/12 text-red-700 dark:text-red-300",
  idle: "bg-muted text-muted-foreground",
};

const ACCOUNT_STATUS_DOT_CLASS_NAME: Record<ProviderAccountStatusTone, string> = {
  ready: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/40",
};

const ProviderSignInDialog = lazy(() => import("./ProviderSignInDialog"));

function ProviderAccountsControl(props: {
  config: ProviderInstallSettings;
  providerStatusByInstance: ReadonlyMap<string, ServerProviderStatus>;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const provider = props.config.provider;
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  const usageQuery = useQuery(
    serverAllProviderUsageQueryOptions({ enabled: provider === "claudeAgent" }),
  );
  const usageByInstance = useMemo(
    () =>
      new Map(
        (usageQuery.data ?? []).map((snapshot) => [
          snapshot.instanceId ?? snapshot.provider,
          snapshot,
        ]),
      ),
    [usageQuery.data],
  );
  const allAccounts = getProviderInstanceOptions(props.settings);
  // Default first, then the provider's other accounts by name.
  const accounts = allAccounts.filter((account) => account.provider === provider);
  const manageableById = new Map(
    getManageableProviderInstances(props.settings, provider).map((entry) => [
      String(entry.instanceId),
      entry,
    ]),
  );
  const [selectedAccountId, setSelectedAccountId] = useState<string>(provider);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [signInAccount, setSignInAccount] = useState<ProviderInstanceOption | null>(null);
  const [startingSignIn, setStartingSignIn] = useState(false);
  const signInPendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const startSignIn = async (account: ProviderInstanceOption) => {
    if (signInPendingRef.current) return;
    signInPendingRef.current = true;
    setStartingSignIn(true);
    try {
      // This is queued behind edits already being saved; the server must see
      // the account's latest settings before it resolves the login environment.
      await props.updateSettingsAndWait({});
      if (mountedRef.current) setSignInAccount(account);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to start sign-in",
        description: error instanceof Error ? error.message : "Unable to save provider settings.",
      });
    } finally {
      signInPendingRef.current = false;
      if (mountedRef.current) setStartingSignIn(false);
    }
  };
  const selectedAccount =
    accounts.find((account) => account.instanceId === selectedAccountId) ?? accounts[0];

  const terminalCommandCounts = allAccounts.reduce((counts, option) => {
    const config = props.settings.providerInstances[String(option.instanceId)]?.config;
    const command = providerCliCommandName({
      provider: option.provider,
      instanceId: option.instanceId,
      config:
        config && typeof config === "object" && !Array.isArray(config)
          ? (config as Record<string, unknown>)
          : undefined,
    });
    counts.set(command, (counts.get(command) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  const updateInstances = (next: Record<string, ProviderInstanceConfig>) => {
    props.updateSettings({ providerInstances: next as ProviderInstanceConfigMap });
  };
  const addAccount = (input: AddProviderAccountInput) => {
    const installConfig = PROVIDER_INSTALL_SETTINGS.find(
      (entry) => entry.provider === input.provider,
    );
    updateInstances({
      ...props.settings.providerInstances,
      [input.instanceId]: {
        driver: input.provider,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: true,
        config: {
          // A new account starts from the provider's own binary and endpoint settings.
          ...(installConfig ? providerInstanceLaunchConfig(installConfig, props.settings) : {}),
          ...input.config,
        },
      },
    });
    if (input.provider === provider) setSelectedAccountId(input.instanceId);
    toastManager.add({
      type: "success",
      title: "Account added",
      description: `${PROVIDER_DISPLAY_NAMES[input.provider]} account '${
        input.displayName || input.instanceId
      }' was added.`,
    });
  };
  const nextImportedInstanceId = () => {
    const prefix = provider === "claudeAgent" ? "claude" : provider;
    const existingIds = new Set(allAccounts.map((option) => String(option.instanceId)));
    let index = 2;
    while (existingIds.has(`${prefix}_${index}`)) index += 1;
    return `${prefix}_${index}`;
  };
  const importInstance = async () => {
    let selectedDirectory: string | null;
    try {
      selectedDirectory = await ensureNativeApi().dialogs.pickFolder();
    } catch {
      toastManager.add({ type: "error", title: t("folderPicker.openFailed") });
      return;
    }
    if (!selectedDirectory) return;
    // Derived accounts share this namespace with explicit entries. Reusing a
    // derived id would mutate that account instead of creating a new one.
    const instanceId = nextImportedInstanceId();
    const directoryName = selectedDirectory.split(/[\\/]/).filter(Boolean).at(-1);
    updateInstances({
      ...props.settings.providerInstances,
      [instanceId]: {
        driver: provider,
        displayName: directoryName || `${providerLabel} imported`,
        enabled: true,
        config: {
          ...providerInstanceLaunchConfig(props.config, props.settings),
          ...providerImportedDirectoryConfig(provider, selectedDirectory),
        },
      },
    });
    setSelectedAccountId(instanceId);
    toastManager.add({
      type: "success",
      title: `${providerLabel} account imported`,
      description: "Moss references the selected directory; no files were moved or copied.",
    });
  };
  const updateInstance = (
    instanceId: string,
    patch: ProviderInstancePatch,
    legacyCodexAccountId: string | null = null,
  ) => {
    const settingsPatch = buildProviderInstanceSettingsPatch(
      props.settings,
      instanceId,
      patch,
      legacyCodexAccountId,
    );
    if (settingsPatch) props.updateSettings(settingsPatch);
  };
  // Restore appearance and enablement while retaining the account's name and launch overrides.
  const resetDefaultAccount = () => {
    const explicit = props.settings.providerInstances[provider];
    if (!explicit) return;
    const { accentColor: _accentColor, enabled: _enabled, ...rest } = explicit;
    const next = { ...props.settings.providerInstances } as Record<string, ProviderInstanceConfig>;
    if (Object.keys(rest).length > 1) {
      next[provider] = rest;
    } else {
      delete next[provider];
    }
    updateInstances(next);
  };
  const readConfigString = (config: unknown, key: string): string => {
    if (!config || typeof config !== "object" || Array.isArray(config)) return "";
    const value = (config as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };
  const readConfigBoolean = (config: unknown, key: string): boolean => {
    if (!config || typeof config !== "object" || Array.isArray(config)) return false;
    return (config as Record<string, unknown>)[key] === true;
  };
  const isAccountProvider = provider === "codex" || provider === "claudeAgent";
  // Launch details most accounts never touch; kept behind the editor's Advanced disclosure.
  const isAdvancedField = (field: ProviderInstallField) =>
    field.kind === "boolean" ||
    providerInstanceConfigKey(field) === "binaryPath" ||
    field.settingsKey === "claudeHomePath";

  const renderField = (
    field: ProviderInstallField,
    { instanceId, instance, legacyCodexAccountId }: ManageableProviderInstance,
  ) => {
    const configKey = providerInstanceConfigKey(field);
    if (configKey === null) return null;
    if (field.kind === "boolean") {
      return (
        <label
          key={field.settingsKey}
          className="flex items-center justify-between gap-3 sm:col-span-2"
        >
          <span className="text-ui-sm font-medium text-foreground">{field.label}</span>
          <Switch
            checked={readConfigBoolean(instance.config, configKey)}
            onCheckedChange={(checked) =>
              updateInstance(instanceId, { config: { [configKey]: checked } })
            }
            aria-label={`${field.label} for ${instance.displayName || instanceId}`}
          />
        </label>
      );
    }
    const redacted =
      field.kind === "password" &&
      instance.config !== null &&
      typeof instance.config === "object" &&
      !Array.isArray(instance.config) &&
      (instance.config as Record<string, unknown>)[`${configKey}Redacted`] === true;
    const inputId = `provider-instance-${instanceId}-${configKey}`;
    return (
      <div className="block" key={field.settingsKey}>
        <label htmlFor={inputId} className="block text-ui-sm font-medium text-foreground">
          {field.label}
        </label>
        <div className="mt-1 flex items-center gap-2">
          <DebouncedSettingTextInput
            id={inputId}
            size="sm"
            variant="soft"
            className="flex-1"
            type={field.kind === "password" ? "password" : "text"}
            value={redacted ? "" : readConfigString(instance.config, configKey)}
            onCommit={(value) => {
              if (redacted && value.length === 0) return;
              updateInstance(instanceId, { config: { [configKey]: value } }, legacyCodexAccountId);
            }}
            placeholder={redacted ? "Secret saved — type to replace" : field.placeholder}
            spellCheck={false}
          />
          {redacted ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => updateInstance(instanceId, { config: { [configKey]: "" } })}
              aria-label={`Clear saved ${field.label.toLowerCase()} for ${
                instance.displayName || instanceId
              }`}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderCodexPrivateHome = (id: string, config: unknown, legacyAccount: string | null) => {
    const inputId = `provider-instance-${id}-shadow-home`;
    const save = (shadowHomePath: string) =>
      updateInstance(id, { config: { shadowHomePath } }, legacyAccount);
    return (
      <div>
        <label htmlFor={inputId} className="block text-ui-sm font-medium text-foreground">
          {props.settings.codexShareStateAcrossAccounts
            ? "Private config and sign-in directory"
            : "Shadow auth home"}
        </label>
        <div className="mt-1 flex items-center gap-2">
          <DebouncedSettingTextInput
            id={inputId}
            size="sm"
            variant="soft"
            className="min-w-0 flex-1"
            value={readConfigString(config, "shadowHomePath")}
            onCommit={save}
            placeholder={
              props.settings.codexShareStateAcrossAccounts
                ? "Absolute private directory"
                : "~/.codex_work"
            }
            spellCheck={false}
          />
          <AccountFolderButton onSelect={save} />
        </div>
      </div>
    );
  };

  const renderAccountRuntime = (entry: ManageableProviderInstance, cliCommand: string) => {
    const { instanceId, instance, legacyCodexAccountId } = entry;
    const cliAlias = readConfigString(instance.config, "cliAlias");
    const cliAliasInvalid =
      cliAlias.length > 0 && normalizeProviderCliAlias(cliAlias) === undefined;
    const cliCommandConflicts = (terminalCommandCounts.get(cliCommand) ?? 0) > 1;
    return (
      <>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="block text-ui-sm font-medium text-foreground">Terminal command</span>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-control border border-border/70 bg-background/60 px-2.5 py-1.5 text-ui-sm">
                {cliCommand}
              </code>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`Copy ${cliCommand}`}
                onClick={() => void copyTextToClipboard(cliCommand)}
              >
                <CopyIcon className="size-4" />
              </Button>
            </div>
          </label>
          {props.config.fields
            .filter((field) => !isAdvancedField(field))
            .map((field) => renderField(field, entry))}
          {provider === "codex"
            ? renderCodexPrivateHome(instanceId, instance.config, legacyCodexAccountId)
            : null}
          {provider === "claudeAgent" ? (
            <label className="block sm:col-span-2">
              <span className="block text-ui-sm font-medium text-foreground">
                Claude config directory
              </span>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-config-dir`}
                size="sm"
                variant="soft"
                className="mt-1"
                value={readConfigString(instance.config, "configDir")}
                onCommit={(configDir) => updateInstance(instanceId, { config: { configDir } })}
                placeholder="~/.claude-work"
                spellCheck={false}
              />
            </label>
          ) : null}
          {isAccountProvider ? (
            <span className="block text-ui-sm text-muted-foreground sm:col-span-2">
              {provider === "codex" && props.settings.codexShareStateAcrossAccounts
                ? "Use a separate private directory for this account. The shared history directory is selected on the default account."
                : provider === "claudeAgent" && props.settings.claudeShareStateAcrossAccounts
                  ? "Choose a private HOME for this account. The config directory defaults to .claude inside that HOME."
                  : provider === "codex"
                    ? "Leave both paths blank and Moss keeps this account's sign-in in its " +
                      "own folder. Set a shadow auth home to keep only the sign-in elsewhere " +
                      "while sharing settings and history with the default account, or a " +
                      "CODEX_HOME to keep everything separate."
                    : "Leave blank and Moss keeps this account's sign-in in its own folder. " +
                      "Set a directory to use a Claude config folder you already signed in to."}
            </span>
          ) : null}
          {!isAccountProvider && provider !== "pi" && provider !== "omp" ? (
            <label className="block sm:col-span-2">
              <span className="block text-ui-sm font-medium text-foreground">
                Profile directory
              </span>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-profile-dir`}
                size="sm"
                variant="soft"
                className="mt-1"
                value={readConfigString(instance.config, "profileDir")}
                onCommit={(profileDir) => updateInstance(instanceId, { config: { profileDir } })}
                placeholder="Provider account directory"
                spellCheck={false}
              />
              <span className="mt-1 block text-ui-sm text-muted-foreground">
                Used as this account&apos;s provider config root without changing your shell files.
              </span>
            </label>
          ) : null}
        </div>
        <ProviderInstanceAdvancedSection>
          <label className="block sm:col-span-2">
            <span className="block text-ui-sm font-medium text-foreground">Command override</span>
            <DebouncedSettingTextInput
              id={`provider-instance-${instanceId}-cli-alias`}
              size="sm"
              variant="soft"
              className="mt-1"
              value={cliAlias}
              onCommit={(cliAlias) => updateInstance(instanceId, { config: { cliAlias } })}
              placeholder={cliCommand}
              spellCheck={false}
            />
            <span
              className={cn(
                "mt-1 block text-ui-sm",
                cliAliasInvalid || cliCommandConflicts
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {cliAliasInvalid
                ? "Use 1–64 letters, numbers, dashes, or underscores; bare provider commands are reserved."
                : cliCommandConflicts
                  ? "This command is already assigned to another account. Choose a unique override."
                  : "Available in Moss terminals for zsh, bash, fish, and scripts."}
            </span>
          </label>
          {props.config.fields.filter(isAdvancedField).map((field) => renderField(field, entry))}
          {provider === "claudeAgent" ? (
            <label className="block">
              <span className="block text-ui-sm font-medium text-foreground">
                Claude credential directory
              </span>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-secure-storage-dir`}
                size="sm"
                variant="soft"
                className="mt-1"
                value={readConfigString(instance.config, "secureStorageDir")}
                onCommit={(secureStorageDir) =>
                  updateInstance(instanceId, { config: { secureStorageDir } })
                }
                placeholder="Optional shared credential directory"
                spellCheck={false}
              />
              <span className="mt-1 block text-ui-sm text-muted-foreground">
                Leave blank unless your setup already uses a separate secure-storage directory.
              </span>
            </label>
          ) : null}
        </ProviderInstanceAdvancedSection>
      </>
    );
  };

  const renderEditor = (account: ProviderInstanceOption) => {
    const instanceId = String(account.instanceId);
    const manageable = manageableById.get(instanceId) ?? null;
    const explicit = props.settings.providerInstances[instanceId];
    const legacyCodexAccountId = manageable?.legacyCodexAccountId ?? null;
    const liveStatus = props.providerStatusByInstance.get(instanceId);
    const status = providerAccountStatusSummary({
      status: liveStatus,
      enabled: account.enabled,
      usageSnapshot: usageByInstance.get(instanceId),
    });
    const cliCommand = account.isDefault
      ? provider === "claudeAgent"
        ? "claude"
        : provider
      : providerCliCommandName({
          provider,
          instanceId: account.instanceId,
          config:
            manageable?.instance.config &&
            typeof manageable.instance.config === "object" &&
            !Array.isArray(manageable.instance.config)
              ? (manageable.instance.config as Record<string, unknown>)
              : undefined,
        });
    const defaultIsCustomized =
      account.isDefault &&
      explicit !== undefined &&
      (explicit.accentColor !== undefined || explicit.enabled === false);
    return (
      <div
        className={cn(
          SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
          SETTINGS_INSET_RADIUS_CLASS_NAME,
          "min-w-0 flex-1 overflow-hidden",
        )}
        // Remount per account so a pending debounced edit can never land on another one.
        key={instanceId}
        role="group"
        aria-label={`${account.label} account`}
      >
        <div className="flex items-start gap-3 border-b border-border/70 bg-muted/25 px-3 py-3">
          <ProviderAccountAvatar provider={provider} accentColor={account.accentColor} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-ui-lg font-medium text-foreground">
                {account.label}
              </span>
              {account.isDefault ? (
                <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-ui-2xs font-medium text-muted-foreground">
                  Default
                </span>
              ) : null}
            </div>
            <StatusChip
              variant="pill"
              className={cn("mt-1 w-fit max-w-full", ACCOUNT_STATUS_PILL_CLASS_NAME[status.tone])}
              dotClassName={ACCOUNT_STATUS_DOT_CLASS_NAME[status.tone]}
            >
              <span className="truncate">{status.headline}</span>
            </StatusChip>
          </div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!account.enabled || liveStatus?.available === false || startingSignIn}
            aria-label={`Sign in to ${account.label}`}
            onClick={() => void startSignIn(account)}
          >
            {startingSignIn ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <PlayIcon className="size-4" />
            )}
            Sign in
          </Button>
          {account.isDefault ? (
            defaultIsCustomized ? (
              <SettingResetButton
                label={`${account.label} account`}
                onClick={resetDefaultAccount}
              />
            ) : null
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                props.updateSettings(removeManageableProviderInstance(props.settings, instanceId));
                setSelectedAccountId(provider);
              }}
            >
              <XIcon className="size-4" />
              Remove
            </Button>
          )}
        </div>

        {status.detail && status.tone !== "ready" && status.tone !== "idle" ? (
          <div className="border-b border-border/70 px-3 py-2 text-ui-sm text-muted-foreground">
            {liveStatus?.authStatus === "unauthenticated"
              ? "Use Sign in to authenticate this account, then complete the provider's prompts."
              : status.detail}
          </div>
        ) : null}

        <ProviderAccountEditorSection title="Identity">
          <div className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor={`provider-instance-${instanceId}-label`}
                className="block text-ui-sm font-medium text-foreground"
              >
                Display name
              </label>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-label`}
                size="sm"
                variant="soft"
                value={
                  account.isDefault
                    ? (explicit?.displayName ?? "")
                    : (manageable?.instance.displayName ?? "")
                }
                onCommit={(displayName) =>
                  updateInstance(instanceId, { displayName }, legacyCodexAccountId)
                }
                placeholder={account.isDefault ? providerLabel : "Work"}
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <span className="block text-ui-sm font-medium text-foreground">Accent color</span>
              <div className="flex min-h-7 items-center">
                <ProviderAccentColorControl
                  value={account.accentColor}
                  accountLabel={account.label}
                  onChange={(accentColor) =>
                    updateInstance(instanceId, { accentColor: accentColor ?? null })
                  }
                />
              </div>
            </div>
          </div>
        </ProviderAccountEditorSection>

        <ProviderAccountEditorSection title="Runtime">
          {account.isDefault ? (
            <div className="space-y-3">
              {props.config.fields.map((field) => (
                <ProviderInstallFieldControl
                  key={field.settingsKey}
                  field={field}
                  settings={props.settings}
                  updateSettings={props.updateSettings}
                />
              ))}
              {provider === "codex" && props.settings.codexShareStateAcrossAccounts
                ? renderCodexPrivateHome(instanceId, explicit?.config, null)
                : null}
              {provider === "codex" && props.settings.codexAccounts.length > 0 ? (
                <CodexDefaultAccountControl
                  settings={props.settings}
                  updateSettings={props.updateSettings}
                />
              ) : null}
            </div>
          ) : manageable ? (
            renderAccountRuntime(manageable, cliCommand)
          ) : null}
        </ProviderAccountEditorSection>

        {/* A migrated Codex account is routed by its saved identity; an environment of
            its own would make the server drop that route, so none is offered. */}
        {legacyCodexAccountId === null ? (
          <ProviderAccountEditorSection title="Environment">
            <ProviderInstanceEnvironmentEditor
              instanceId={instanceId}
              environment={
                account.isDefault ? explicit?.environment : manageable?.instance.environment
              }
              onChange={(environment) => updateInstance(instanceId, { environment })}
            />
          </ProviderAccountEditorSection>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 sm:flex-nowrap">
        <div className="min-w-0">
          <span className="block text-ui-sm font-medium text-foreground">
            {providerLabel} accounts
          </span>
          <span className="mt-1 block text-ui-sm text-muted-foreground">
            {(provider === "codex" && props.settings.codexShareStateAcrossAccounts) ||
            (provider === "claudeAgent" && props.settings.claudeShareStateAcrossAccounts)
              ? "Each account signs in separately. Chats created with shared history keep their selected source when you switch accounts."
              : "Each account signs in on its own and gets its own tab in the model picker. A thread stays on the account it started with."}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={importInstance}
            disabled={typeof window === "undefined" || !window.desktopBridge}
            title={
              typeof window === "undefined" || !window.desktopBridge
                ? "Directory import is available in the Moss desktop app."
                : `Use an existing ${providerLabel} directory as a new account, without moving it.`
            }
          >
            <FolderOpenIcon className="size-4" />
            Import directory
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setAddDialogOpen(true)}>
            <PlusIcon className="size-4" />
            Add account
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div
          role="list"
          aria-label={`${providerLabel} accounts`}
          className={cn(
            SETTINGS_INSET_LIST_CLASS_NAME,
            SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
            "shrink-0 md:w-60",
          )}
        >
          {accounts.map((account) => {
            const selected = account.instanceId === selectedAccount?.instanceId;
            const status = providerAccountStatusSummary({
              status: props.providerStatusByInstance.get(account.instanceId),
              enabled: account.enabled,
              usageSnapshot: usageByInstance.get(account.instanceId),
            });
            return (
              <div
                key={account.instanceId}
                role="listitem"
                className={cn(
                  "relative flex items-center gap-2 px-3 py-2.5 transition-colors",
                  selected
                    ? // The bar takes the account's accent, so the selection points at it.
                      "bg-muted/55 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full before:bg-(--account-accent,var(--foreground))"
                    : "hover:bg-muted/25",
                  !account.enabled && !selected && "opacity-60",
                )}
                style={
                  normalizeProviderAccentColor(account.accentColor)
                    ? ({
                        "--account-accent": normalizeProviderAccentColor(account.accentColor),
                      } as CSSProperties)
                    : undefined
                }
              >
                <button
                  type="button"
                  aria-label={`Select ${account.label}`}
                  aria-current={selected ? "true" : undefined}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
                  onClick={() => setSelectedAccountId(account.instanceId)}
                >
                  <ProviderAccountAvatar provider={provider} accentColor={account.accentColor} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-sm font-medium text-foreground">
                      {account.label}
                    </span>
                    <ProviderInstanceStatusLine status={status} />
                  </span>
                </button>
                <Switch
                  checked={account.enabled}
                  onCheckedChange={(enabled) =>
                    updateInstance(account.instanceId, { enabled: Boolean(enabled) })
                  }
                  aria-label={`Enable ${account.label}`}
                />
              </div>
            );
          })}
        </div>
        {selectedAccount ? renderEditor(selectedAccount) : null}
      </div>

      {signInAccount ? (
        <Suspense fallback={<p className="text-ui-sm text-muted-foreground">Opening sign-in…</p>}>
          <ProviderSignInDialog
            provider={provider}
            instanceId={String(signInAccount.instanceId)}
            accountLabel={signInAccount.label}
            onClose={() => setSignInAccount(null)}
          />
        </Suspense>
      ) : null}
      <AddProviderAccountDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        providers={PROVIDER_VISIBILITY_OPTIONS.filter(
          (option) => !props.settings.disabledProviders.includes(option.provider),
        ).map((option) => ({
          provider: option.provider,
          label: option.title,
        }))}
        initialProvider={provider}
        // Includes accounts of a missing driver, which the list does not show.
        existingIds={
          new Set([
            ...allAccounts.map((option) => String(option.instanceId)),
            ...Object.keys(props.settings.providerInstances),
          ])
        }
        configFieldsFor={providerAccountIdentityFields}
        onAdd={addAccount}
      />
    </div>
  );
}

function ProviderInstanceStatusLine(props: { status: ProviderAccountStatusSummary }) {
  return (
    <StatusChip
      className="text-ui-xs text-muted-foreground"
      dotClassName={ACCOUNT_STATUS_DOT_CLASS_NAME[props.status.tone]}
    >
      <span className="truncate">{props.status.headline}</span>
    </StatusChip>
  );
}

// One titled band of the account editor; bands are separated by hairlines.
function ProviderAccountEditorSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border/70 px-3 py-3 last:border-b-0">
      <h4 className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h4>
      {props.children}
    </section>
  );
}

function ProviderInstanceAdvancedSection(props: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        type="button"
        className="mt-3 flex items-center gap-1 text-ui-sm text-muted-foreground"
      >
        Advanced
        <DisclosureChevron open={open} className="size-4 shrink-0" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{props.children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export type ProvidersSettingsPanelProps = AppSettingsBinding & {
  readonly active: boolean;
  readonly providerTarget?: ProviderKind | null;
  readonly resetEpoch: number;
  readonly updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
};

export function ProvidersSettingsPanel({
  settings,
  defaults,
  updateSettings,
  updateSettingsAndWait,
  active,
  providerTarget = null,
  resetEpoch,
}: ProvidersSettingsPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const refreshProvidersInFlightRef = useRef(false);
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const [selection, setSelection] = useState<ProviderWorkbenchSelection>(() =>
    providerTarget && isMossActiveProvider(providerTarget)
      ? { kind: "cli", provider: providerTarget }
      : { kind: "moss" },
  );
  const [addUnifiedDialogOpen, setAddUnifiedDialogOpen] = useState(false);
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>(
    () => ({
      ...createClosedProviderInstallDisclosureState(),
      ...(providerTarget && isMossActiveProvider(providerTarget) ? { [providerTarget]: true } : {}),
    }),
  );
  const [updatingProviders, setUpdatingProviders] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );
  const providerEnablementMutationInFlightRef = useRef(false);
  const [providerEnablementMutationPending, setProviderEnablementMutationPending] = useState(false);
  const [disabledProvidersOpen, setDisabledProvidersOpen] = useState(false);
  const [installationProvider, setInstallationProvider] = useState<ProviderKind | null>(null);
  const installedProviderRef = useRef(new Set<ProviderKind>());
  for (const status of serverConfigQuery.data?.providers ?? []) {
    const provider = status.driver ?? status.provider;
    if (
      isProviderKind(provider) &&
      isMossActiveProvider(provider) &&
      isLocalProviderInstalled(status)
    )
      installedProviderRef.current.add(provider);
  }
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const hiddenProviderCount = hiddenProviderSet.size;
  const disabledProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.disabledProviders),
    [settings.disabledProviders],
  );
  const providerVisibilityOptionsByProvider = useMemo(
    () =>
      new Map<ProviderKind, (typeof PROVIDER_VISIBILITY_OPTIONS)[number]>(
        PROVIDER_VISIBILITY_OPTIONS.map((option) => [option.provider, option]),
      ),
    [],
  );
  const orderedProviderVisibilityOptions = useMemo(
    () =>
      (sameProviderOrder(settings.providerOrder, defaults.providerOrder)
        ? prioritizeInstalledProviders(settings.providerOrder, installedProviderRef.current)
        : settings.providerOrder
      ).flatMap((provider) => {
        const option = providerVisibilityOptionsByProvider.get(provider);
        return option ? [option] : [];
      }),
    [
      providerVisibilityOptionsByProvider,
      settings.providerOrder,
      defaults.providerOrder,
      serverConfigQuery.data?.providers,
    ],
  );
  const providerVisibilitySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const enabledProviderOptions = orderedProviderVisibilityOptions.filter(
    (option) => !disabledProviderSet.has(option.provider),
  );
  const disabledProviderOptions = orderedProviderVisibilityOptions.filter((option) =>
    disabledProviderSet.has(option.provider),
  );
  const enabledProviderCount = enabledProviderOptions.length;
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const providerStatusByProvider = useMemo(
    () =>
      new Map<ProviderKind, ServerProviderStatus>(
        localProviderStatuses.flatMap((status) => {
          const driver = status.driver ?? status.provider;
          return isProviderKind(driver) &&
            isMossActiveProvider(driver) &&
            providerStatusInstanceKey(status) === driver
            ? [[driver, status] as const]
            : [];
        }),
      ),
    [localProviderStatuses],
  );
  // Agents a working Moss lane serves: their row says so instead of asking for a sign-in.
  const mossSupportedCliDriverSet = useMemo<ReadonlySet<ProviderKind>>(
    () => new Set(MOSS_SERVER_AUTHORIZED_CLI_DRIVERS),
    [],
  );
  const servedByMossProviders = useMemo(() => {
    const served = new Set<ProviderKind>();
    for (const driver of providersServedByMoss(localProviderStatuses)) {
      if (isMossManagedCliAuthorized(settings, driver)) {
        served.add(driver);
      }
    }
    return served;
  }, [
    localProviderStatuses,
    settings.mossCliModelAuthDisabledProviders,
    settings.mossCliModelAuthEnabled,
  ]);
  const providerStatusByInstance = useMemo(
    () =>
      new Map<string, ServerProviderStatus>(
        localProviderStatuses.map((status) => [providerStatusInstanceKey(status), status]),
      ),
    [localProviderStatuses],
  );
  const availableProviderCount = enabledProviderOptions.filter(
    (option) => providerStatusByProvider.get(option.provider)?.available === true,
  ).length;
  const visibleAvailableProviderCount = enabledProviderOptions.filter(
    (option) =>
      providerStatusByProvider.get(option.provider)?.available === true &&
      !hiddenProviderSet.has(option.provider),
  ).length;
  const hasPendingProviderStatuses =
    !providerStatusesReconciled ||
    enabledProviderOptions.some((option) => !providerStatusByProvider.has(option.provider));
  const providerUpdateServerSettings = useMemo(
    () =>
      serverSettingsQuery.data
        ? {
            ...serverSettingsQuery.data,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }
        : null,
    [serverSettingsQuery.data, settings.enableProviderUpdateChecks],
  );
  const outdatedProviderStatuses = useMemo(
    () =>
      getVisibleProviderUpdateStatuses({
        providers: serverConfigQuery.data?.providers ?? [],
        hiddenProviders: settings.hiddenProviders,
        serverSettings: providerUpdateServerSettings,
      }).filter((status) => {
        const driver = (status.driver ?? status.provider) as ProviderKind;
        return isMossActiveProvider(driver) && !disabledProviderSet.has(driver);
      }),
    [
      disabledProviderSet,
      providerUpdateServerSettings,
      serverConfigQuery.data?.providers,
      settings.hiddenProviders,
    ],
  );
  const versionCheckSummary = !settings.enableProviderUpdateChecks
    ? "Automatic checks off"
    : providerVersionCheckSummary({
        providers: (serverConfigQuery.data?.providers ?? []).filter((status) => {
          const driver = (status.driver ?? status.provider) as ProviderKind;
          return isMossActiveProvider(driver) && !disabledProviderSet.has(driver);
        }),
        hiddenProviders: settings.hiddenProviders,
        serverSettings: providerUpdateServerSettings,
        outdatedCount: outdatedProviderStatuses.length,
      });

  const unifiedProviders = serverSettingsQuery.data?.unifiedProviders ?? [];
  const defaultUnifiedProviderId = serverSettingsQuery.data?.defaultUnifiedProviderId ?? null;
  const unifiedProviderByCli = useMemo(
    () => serverSettingsQuery.data?.unifiedProviderByCli ?? {},
    [serverSettingsQuery.data?.unifiedProviderByCli],
  );

  const invalidateServerSettingsAndConfig = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() }),
      queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() }),
    ]);
  }, [queryClient]);

  const routeCliSource = useCallback(
    async (driver: ProviderKind, source: string) => {
      await ensureNativeApi().server.updateSettings({
        unifiedProviderByCli: {
          ...unifiedProviderByCli,
          [driver]: source,
        },
      });
      await invalidateServerSettingsAndConfig();
    },
    [invalidateServerSettingsAndConfig, unifiedProviderByCli],
  );

  const setDefaultUnifiedProvider = useCallback(
    async (id: string | null) => {
      await ensureNativeApi().server.updateSettings({ defaultUnifiedProviderId: id });
      await invalidateServerSettingsAndConfig();
    },
    [invalidateServerSettingsAndConfig],
  );

  const updateProviderEnablement = useCallback(
    async (disabledProviders: ProviderKind[]) => {
      if (providerEnablementMutationInFlightRef.current) return;
      providerEnablementMutationInFlightRef.current = true;
      setProviderEnablementMutationPending(true);
      try {
        await updateSettingsAndWait({ disabledProviders });
      } catch {
        toastManager.add({ type: "error", title: t("settings.providers.activity.error") });
      } finally {
        providerEnablementMutationInFlightRef.current = false;
        setProviderEnablementMutationPending(false);
      }
    },
    [updateSettingsAndWait, t],
  );

  useSettingsRestoreSignal(resetEpoch, () => {
    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
    setDisabledProvidersOpen(false);
  });

  useEffect(() => {
    if (!active || !providerTarget || !isMossActiveProvider(providerTarget)) return;
    setSelection({ kind: "cli", provider: providerTarget });
    if (disabledProviderSet.has(providerTarget)) {
      setDisabledProvidersOpen(true);
    }
    setOpenInstallProviders((current) => ({ ...current, [providerTarget]: true }));
  }, [active, disabledProviderSet, providerTarget]);

  const handleProviderOrderDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active: dragActive, over } = event;
      if (!over || dragActive.id === over.id) return;
      const fromIndex = settings.providerOrder.indexOf(dragActive.id as ProviderKind);
      const toIndex = settings.providerOrder.indexOf(over.id as ProviderKind);
      if (fromIndex < 0 || toIndex < 0) return;
      updateSettings({ providerOrder: arrayMove([...settings.providerOrder], fromIndex, toIndex) });
    },
    [settings.providerOrder, updateSettings],
  );

  const runProviderUpdate = useCallback(
    async (provider: ProviderKind, instanceId?: ProviderInstanceId) => {
      const targetId = instanceId ?? provider;
      if (updatingProviders.has(targetId)) return;
      setUpdatingProviders((current) => new Set(current).add(targetId));
      await withProviderUpdateTimeout({
        provider,
        request: ensureNativeApi().server.updateProvider({
          provider,
          ...(instanceId ? { instanceId } : {}),
        }),
      })
        .then((result) => {
          const refreshedProvider = result.providers.find(
            (status) =>
              (status.driver ?? status.provider) === provider &&
              providerStatusInstanceKey(status) === targetId,
          );
          const failureMessage = providerUpdateFailureMessage(refreshedProvider);
          if (failureMessage) {
            const manualCommand = refreshedProvider?.versionAdvisory?.updateCommand?.trim();
            toastManager.add({
              type: "error",
              title: `Could not update ${refreshedProvider ? providerStatusDisplayName(refreshedProvider) : PROVIDER_DISPLAY_NAMES[provider]}`,
              description: manualCommand
                ? `${failureMessage}\n\nCopy the command below to update manually in a terminal.`
                : failureMessage,
              ...(manualCommand ? { data: { copyText: manualCommand } } : {}),
            });
          }
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[provider]}`,
            description: error instanceof Error ? error.message : "The provider update failed.",
          });
        })
        .finally(async () => {
          await queryClient
            .invalidateQueries({ queryKey: serverQueryKeys.config() })
            .catch(() => undefined);
          setUpdatingProviders((current) => {
            const next = new Set(current);
            next.delete(targetId);
            return next;
          });
        });
    },
    [queryClient, updatingProviders],
  );

  if (!active) return null;

  const refreshProviders = async () => {
    if (refreshProvidersInFlightRef.current) return;
    refreshProvidersInFlightRef.current = true;
    setRefreshingProviders(true);
    try {
      await refreshProviderStatuses();
    } finally {
      refreshProvidersInFlightRef.current = false;
      setRefreshingProviders(false);
    }
  };

  const activeCliProviders = orderedProviderVisibilityOptions.map((option) => option.provider);
  const selectedUnifiedProvider =
    selection.kind === "unified"
      ? unifiedProviders.find((item) => item.id === selection.id)
      : undefined;
  const selectedCli = selection.kind === "cli" ? selection.provider : null;
  const selectedCliOption = selectedCli
    ? providerVisibilityOptionsByProvider.get(selectedCli)
    : null;
  const selectedCliConfig = selectedCli
    ? VISIBLE_PROVIDER_INSTALL_SETTINGS.find((entry) => entry.provider === selectedCli)
    : null;
  const selectedCliStatus = selectedCli ? providerStatusByProvider.get(selectedCli) : undefined;
  const selectedCliEffectiveStatus =
    selectedCli && selectedCliOption
      ? (localProviderStatuses.find(
          (status) =>
            (status.driver ?? status.provider) === selectedCli &&
            status.enabled !== false &&
            status.available &&
            status.version,
        ) ?? selectedCliStatus)
      : undefined;
  const selectedCliShowUpdateStatus = selectedCliEffectiveStatus
    ? shouldShowProviderUpdateStatus({
        provider: selectedCliEffectiveStatus,
        hiddenProviderSet,
        serverSettings: providerUpdateServerSettings,
      })
    : false;
  const selectedCliAdvisory = selectedCliEffectiveStatus?.versionAdvisory;
  const selectedCliUpdateLabel = selectedCliEffectiveStatus
    ? !settings.enableProviderUpdateChecks
      ? installedVersionLabel(selectedCliEffectiveStatus, false)
      : selectedCliAdvisory?.status === "behind_latest" && !selectedCliShowUpdateStatus
        ? null
        : providerUpdateStatusLabel(selectedCliEffectiveStatus)
    : null;

  const resetSingleProviderConfig = (config: ProviderInstallSettings) => {
    const fieldPatch = Object.fromEntries(
      config.fields.map((field) => [field.settingsKey, defaults[field.settingsKey]]),
    ) as Partial<AppSettings>;
    const remainingInstances = Object.fromEntries(
      Object.entries(settings.providerInstances).filter(
        ([, instance]) => instance.driver !== config.provider,
      ),
    ) as ProviderInstanceConfigMap;
    updateSettings({
      ...fieldPatch,
      providerInstances: remainingInstances,
      ...(config.provider === "codex"
        ? {
            codexAccounts: defaults.codexAccounts,
            selectedCodexAccountId: defaults.selectedCodexAccountId,
          }
        : {}),
    });
  };

  let detailPaneContent;
  if (selection.kind === "unified" && selectedUnifiedProvider) {
    detailPaneContent = (
      <UnifiedProviderDetailPane
        provider={selectedUnifiedProvider}
        activeCliProviders={activeCliProviders}
        defaultUnifiedProviderId={defaultUnifiedProviderId}
        unifiedProviderByCli={unifiedProviderByCli}
        onUpdated={invalidateServerSettingsAndConfig}
        onDeleted={async () => {
          setSelection({ kind: "moss" });
          await invalidateServerSettingsAndConfig();
        }}
        onRouteCli={routeCliSource}
        onSetGlobalDefault={setDefaultUnifiedProvider}
      />
    );
  } else if (selection.kind === "cli" && selectedCliOption && selectedCli) {
    const enabled = !disabledProviderSet.has(selectedCli);
    const cliStatus = selectedCliStatus;
    const versionStatus = selectedCliEffectiveStatus;
    const instanceKey = versionStatus ? providerStatusInstanceKey(versionStatus) : selectedCli;
    const installConfig = selectedCliConfig ?? { provider: selectedCli, fields: [] };
    const installFieldsDirty = isProviderInstallConfigDirty(installConfig, settings, defaults);
    detailPaneContent = (
      <CliAgentDetailPane
        provider={selectedCli}
        title={selectedCliOption.title}
        setupDocsHref={selectedCliOption.setupDocsHref}
        enabled={enabled}
        isHidden={hiddenProviderSet.has(selectedCli)}
        statusReconciled={providerStatusesReconciled}
        providerStatus={cliStatus}
        servedByMoss={servedByMossProviders.has(selectedCli)}
        supportsMossAuth={mossSupportedCliDriverSet.has(selectedCli)}
        mossAuthorized={isMossManagedCliAuthorized(settings, selectedCli)}
        isInstalled={installedProviderRef.current.has(selectedCli)}
        updating={updatingProviders.has(instanceKey)}
        checksEnabled={settings.enableProviderUpdateChecks}
        showProviderUpdateStatus={selectedCliShowUpdateStatus}
        updateStatusLabel={selectedCliUpdateLabel}
        routingSource={resolveEffectiveCliSourceUi({
          defaultUnifiedProviderId,
          unifiedProviderByCli,
          provider: selectedCli,
        })}
        unifiedProviders={unifiedProviders}
        advancedOpen={openInstallProviders[selectedCli] ?? false}
        installFieldsDirty={installFieldsDirty}
        enablementPending={providerEnablementMutationPending}
        enablementDisabled={!serverSettingsQuery.data || providerEnablementMutationPending}
        onAdvancedOpenChange={(open) =>
          setOpenInstallProviders((current) => ({ ...current, [selectedCli]: open }))
        }
        onRouteChange={(source) => void routeCliSource(selectedCli, source)}
        onToggleEnabled={(checked) =>
          void updateProviderEnablement(
            setProviderListMembership(settings.disabledProviders, selectedCli, !checked),
          )
        }
        onToggleHidden={(hidden) =>
          updateSettings({
            hiddenProviders: setProviderListMembership(
              settings.hiddenProviders,
              selectedCli,
              hidden,
            ),
          })
        }
        onOpenInstallation={() => setInstallationProvider(selectedCli)}
        onOpenGuide={() =>
          void openProviderGuide(
            selectedCliOption.setupDocsHref,
            t("settings.providers.setupGuideFailed"),
          )
        }
        onResetProvider={() => resetSingleProviderConfig(installConfig)}
        renderUpdateAction={(status, updateActive) => (
          <ProviderUpdateAction
            providerStatus={status}
            active={updateActive}
            disabled={updateActive}
            onUpdate={(provider, id) => void runProviderUpdate(provider, id)}
          />
        )}
        renderInstallCommandCard={() =>
          installConfig.install ? (
            <ProviderInstallCommandCard
              install={
                versionStatus?.versionAdvisory?.packageChannel === "cn-mirror"
                  ? {
                      ...installConfig.install,
                      command: withCnMirrorRegistry(installConfig.install.command),
                    }
                  : installConfig.install
              }
            />
          ) : null
        }
        renderAccountsControl={() => (
          <ProviderAccountsControl
            key={selectedCli}
            config={installConfig}
            providerStatusByInstance={providerStatusByInstance}
            settings={settings}
            updateSettings={updateSettings}
            updateSettingsAndWait={updateSettingsAndWait}
          />
        )}
      />
    );
  } else if (selection.kind === "preferences") {
    detailPaneContent = (
      <ProvidersPreferencesPane
        settings={settings}
        defaults={defaults}
        serverSettings={serverSettingsQuery.data}
        unifiedProviders={unifiedProviders}
        enabledProviderCount={enabledProviderCount}
        availableProviderCount={availableProviderCount}
        visibleAvailableProviderCount={visibleAvailableProviderCount}
        hasPendingProviderStatuses={hasPendingProviderStatuses}
        isProviderOrderDirty={isProviderOrderDirty}
        hiddenProviderCount={hiddenProviderCount}
        versionCheckSummary={versionCheckSummary}
        outdatedProviderStatuses={outdatedProviderStatuses}
        updatingProviders={updatingProviders}
        updateSettings={updateSettings}
        onSetDefaultUnifiedProvider={setDefaultUnifiedProvider}
        getStatusDisplayName={providerStatusDisplayName}
        getUpdateStatusLabel={providerUpdateStatusLabel}
        renderUpdateAction={(status, updateActive) => (
          <ProviderUpdateAction
            providerStatus={status}
            active={updateActive}
            disabled={updateActive}
            onUpdate={(provider) => void runProviderUpdate(provider)}
          />
        )}
        renderVisibilityDragList={() => (
          <DndContext
            sensors={providerVisibilitySensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleProviderOrderDragEnd}
          >
            <SortableContext
              items={enabledProviderOptions.map((option) => option.provider)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {enabledProviderOptions.map((option) => (
                  <SortableProviderVisibilityRow
                    key={option.provider}
                    option={option}
                    providerStatus={providerStatusByProvider.get(option.provider)}
                    statusReconciled={providerStatusesReconciled}
                    isDisabled={disabledProviderSet.has(option.provider)}
                    isHidden={hiddenProviderSet.has(option.provider)}
                    onHiddenChange={(hidden) =>
                      updateSettings({
                        hiddenProviders: setProviderListMembership(
                          settings.hiddenProviders,
                          option.provider,
                          hidden,
                        ),
                      })
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      />
    );
  } else {
    detailPaneContent = (
      <MossProviderDetailPane
        activeCliProviders={activeCliProviders}
        unifiedProviders={unifiedProviders}
        defaultUnifiedProviderId={defaultUnifiedProviderId}
        unifiedProviderByCli={unifiedProviderByCli}
        mossCliModelAuthEnabled={settings.mossCliModelAuthEnabled}
        mossCliModelAuthDisabledProviders={settings.mossCliModelAuthDisabledProviders}
        onToggleMossCliModelAuth={(enabled) => updateSettings({ mossCliModelAuthEnabled: enabled })}
        onToggleMossCliProviderAuth={(provider, allowed) =>
          updateSettings({
            mossCliModelAuthDisabledProviders: setProviderListMembership(
              settings.mossCliModelAuthDisabledProviders,
              provider,
              !allowed,
            ),
          })
        }
        onSetAllMossCliProvidersAuth={(allowAll) =>
          updateSettings({
            mossCliModelAuthDisabledProviders: allowAll
              ? []
              : [...MOSS_SERVER_AUTHORIZED_CLI_DRIVERS],
          })
        }
        onSelectCli={(provider) => setSelection({ kind: "cli", provider })}
        onAddUnifiedProvider={() => setAddUnifiedDialogOpen(true)}
      />
    );
  }

  return (
    <>
      {installationProvider ? (
        <ProviderInstallationDialog
          provider={installationProvider}
          enabled={!disabledProviderSet.has(installationProvider)}
          guideUrl={providerVisibilityOptionsByProvider.get(installationProvider)!.setupDocsHref}
          onClose={() => setInstallationProvider(null)}
          onDisable={() =>
            updateProviderEnablement(
              setProviderListMembership(settings.disabledProviders, installationProvider, true),
            )
          }
          onChanged={async (result) => {
            if (result.source === "missing")
              installedProviderRef.current.delete(installationProvider);
            await queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
          }}
        />
      ) : null}

      <AddUnifiedProviderDialog
        open={addUnifiedDialogOpen}
        onOpenChange={setAddUnifiedDialogOpen}
        existingProviders={unifiedProviders}
        onSaved={async (saved) => {
          await invalidateServerSettingsAndConfig();
          setSelection({ kind: "unified", id: saved.id });
        }}
      />

      <ProvidersSplitWorkbench
        selection={selection}
        onSelect={setSelection}
        unifiedProviders={unifiedProviders}
        defaultUnifiedProviderId={defaultUnifiedProviderId}
        unifiedProviderByCli={unifiedProviderByCli}
        mossCliModelAuthEnabled={settings.mossCliModelAuthEnabled}
        enabledCliOptions={enabledProviderOptions}
        disabledCliOptions={disabledProviderOptions}
        disabledOpen={disabledProvidersOpen}
        onDisabledOpenChange={setDisabledProvidersOpen}
        providerStatusByProvider={providerStatusByProvider}
        statusReconciled={providerStatusesReconciled}
        refreshingProviders={refreshingProviders}
        onRefreshProviders={() => void refreshProviders()}
        onOpenAddProvider={() => setAddUnifiedDialogOpen(true)}
      >
        {detailPaneContent}
      </ProvidersSplitWorkbench>
    </>
  );
}
