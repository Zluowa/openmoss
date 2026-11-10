// FILE: ProvidersSettingsPanel.tsx
// Purpose: Own provider picker, update, and CLI installation settings workflows.
// Layer: Settings panel

import {
  DEFAULT_CODEX_ACCOUNT_ID,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettings,
} from "@moss/contracts";
import { isBetaFeatureOn, VISIBLE_PROVIDER_DESCRIPTORS } from "../../betaFeatures";
import {
  normalizeProviderCliAlias,
  providerCliCommandName,
} from "@moss/shared/providerCliProfiles";
import { MOSS_CN_NPM_MIRROR_REGISTRY } from "@moss/shared/mossRealmCatalog";
import { MOSS_OFFICIAL_SITE_URL } from "@moss/shared/desktopIdentity";
import { providerImportedDirectoryConfig } from "@moss/shared/providerInstances";
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
  type NewChatModelSource,
  type ProviderInstanceOption,
  type ProviderInstancePatch,
} from "~/appSettings";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { CentralIcon } from "~/lib/central-icons";
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
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
  installedProgramStatus,
  installedVersionLabel,
  isProviderLatestVersionKnowable,
  isProviderUpdateActive,
  providerVersionCheckSummary,
  shouldOfferProviderUpdateAction,
  shouldPromptProviderUpdate,
  shouldShowProviderUpdateStatus,
  withProviderUpdateTimeout,
} from "~/providerUpdates";
import { agentSettingsAnchorId } from "~/lib/agentInstall";
import { supportsAgentSignIn } from "~/lib/agentSignIn";
import { providerStatusInstanceKey, resolveAgentReadiness } from "~/lib/providerAvailability";
import {
  PROVIDER_READINESS_LABEL_KEY,
  providerReadinessDescriptionKey,
} from "~/lib/providerReadinessCopy";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
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
import { AgentSignInButton } from "./AgentSignInButton";
import { ProviderInstallationDialog } from "./ProviderInstallationDialog";
import { DebouncedSettingTextInput } from "./DebouncedSettingTextInput";
import { ProviderAccentColorControl } from "./ProviderAccentColorControl";
import { ProviderInstanceEnvironmentEditor } from "./ProviderInstanceEnvironmentEditor";
import {
  SettingResetButton,
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
  SettingsSelectControl,
  useSettingsRestoreSignal,
} from "./SettingControls";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

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
  | "droidBinaryPath"
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
  readonly docs: ReadonlyArray<{ readonly label: string; readonly href: string }>;
  readonly install?: ProviderInstallCommand;
  readonly fields: readonly ProviderInstallField[];
};

const PROVIDER_VISIBILITY_OPTIONS = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => ({
  provider: descriptor.kind,
  title: descriptor.displayName,
  setupDocsHref: descriptor.setupDocsHref,
}));

// CLI guides live on Moss's own site, never the vendor's.
const MOSS_PROVIDER_DOCS: ProviderInstallSettings["docs"] = [
  { label: "Read the guide", href: MOSS_OFFICIAL_SITE_URL },
];

const PROVIDER_INSTALL_SETTINGS: readonly ProviderInstallSettings[] = [
  {
    provider: "codex",
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    provider: "droid",
    docs: MOSS_PROVIDER_DOCS,
    fields: [
      {
        kind: "text",
        settingsKey: "droidBinaryPath",
        label: "Droid binary path",
        placeholder: "droid",
        description: (
          <>
            Leave blank to use <code>droid</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "devin",
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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
    docs: MOSS_PROVIDER_DOCS,
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

// Beta-only providers keep their stored install fields but
// their install row is hidden.
const VISIBLE_PROVIDER_INSTALL_SETTINGS = PROVIDER_INSTALL_SETTINGS.filter((config) =>
  isBetaFeatureOn(config.provider),
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

function createProviderInstallDisclosureState(
  settings: AppSettings,
): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.map((config) => [
      config.provider,
      config.fields.some((field) =>
        field.kind === "password"
          ? settings[field.configuredKey]
          : Boolean(settings[field.settingsKey]),
      ) ||
        Object.values(settings.providerInstances).some(
          (instance) => instance.driver === config.provider,
        ) ||
        (config.provider === "codex" &&
          (settings.codexAccounts.length > 0 ||
            settings.selectedCodexAccountId !== DEFAULT_CODEX_ACCOUNT_ID)),
    ]),
  ) as Record<ProviderKind, boolean>;
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

const NEW_CHAT_MODEL_SOURCE_OPTIONS: ReadonlyArray<SettingsSegmentedOption<NewChatModelSource>> = [
  { value: "moss", label: "Moss" },
  { value: "own", label: "Local account" },
];

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
  option: { provider: ProviderKind; title: string };
  providerStatus: ServerProviderStatus | undefined;
  statusReconciled: boolean;
  isDisabled: boolean;
  isHidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}) {
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

  return (
    <div
      ref={setNodeRef}
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
          <span className="block text-ui-sm text-muted-foreground">
            {providerSetupStatusLabel({
              status: props.providerStatus,
              reconciled: props.statusReconciled,
              disabled: props.isDisabled,
            })}
          </span>
        </span>
      </div>
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
          <code className="min-w-0 flex-1 truncate rounded-md border border-border/70 bg-background/60 px-2.5 py-1.5 font-mono text-ui-sm">
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

function ProviderDocsLinks({ docs }: { docs: ProviderInstallSettings["docs"] }) {
  const { t } = useTranslation();
  return (
    <div className={cn(SETTINGS_OUTLINED_SURFACE_CLASS_NAME, "px-3 py-2.5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-ui leading-snug font-medium text-foreground">CLI docs</span>
        <div className="flex flex-wrap gap-2">
          {docs.map((doc) => (
            <Button
              key={`${doc.label}:${doc.href}`}
              variant="outline"
              size="sm"
              onClick={() =>
                void openProviderGuide(doc.href, t("settings.providers.setupGuideFailed"))
              }
            >
              <span>{doc.label}</span>
              <ExternalLinkIcon className="size-3" />
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
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
        className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2"
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
              <code className="min-w-0 flex-1 truncate rounded-md border border-border/70 bg-background/60 px-2.5 py-1.5 text-ui-sm">
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

function ProviderToolRow(props: {
  config: ProviderInstallSettings;
  open: boolean;
  settings: AppSettings;
  defaults: AppSettings;
  hiddenProviderSet: ReadonlySet<ProviderKind>;
  serverSettings: Pick<
    ServerSettings,
    "providers" | "providerInstances" | "enableProviderUpdateChecks"
  > | null;
  providerStatus: ServerProviderStatus | undefined;
  providerStatusByInstance: ReadonlyMap<string, ServerProviderStatus>;
  updatingProviders: ReadonlySet<ProviderInstanceId>;
  onOpenChange: (open: boolean) => void;
  onUpdate: (provider: ProviderKind, instanceId?: ProviderInstanceId) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const title = PROVIDER_DISPLAY_NAMES[props.config.provider];
  const isDirty = isProviderInstallConfigDirty(props.config, props.settings, props.defaults);
  const showProviderUpdateStatus = props.providerStatus
    ? shouldShowProviderUpdateStatus({
        provider: props.providerStatus,
        hiddenProviderSet: props.hiddenProviderSet,
        serverSettings: props.serverSettings,
      })
    : false;
  const updateAdvisory = props.providerStatus?.versionAdvisory;
  const providerUpdateSuppressed =
    updateAdvisory?.status === "behind_latest" && !showProviderUpdateStatus;
  const providerUpdateLabel = props.providerStatus
    ? !props.settings.enableProviderUpdateChecks
      ? installedVersionLabel(props.providerStatus, false)
      : providerUpdateSuppressed
        ? null
        : providerUpdateStatusLabel(props.providerStatus)
    : null;
  const updateActive = Boolean(
    (props.providerStatus && isProviderUpdateActive(props.providerStatus)) ||
    props.updatingProviders.has(
      props.providerStatus
        ? providerStatusInstanceKey(props.providerStatus)
        : props.config.provider,
    ),
  );
  const showUpdateButton = props.providerStatus
    ? shouldPromptProviderUpdate(props.providerStatus) &&
      (showProviderUpdateStatus || updateAdvisory?.status === "unknown")
    : false;
  // Self-updating CLIs never report a latest version, so the update stays available
  // inside the panel rather than as a header badge that can never be satisfied.
  const showSelfManagedUpdate = props.providerStatus
    ? shouldOfferProviderUpdateAction(props.providerStatus) &&
      !isProviderLatestVersionKnowable(props.providerStatus)
    : false;

  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
      <div className="border-t border-border/70 first:border-t-0">
        <div className="flex min-h-11 items-center gap-2 px-3 py-2">
          <CollapsibleTrigger
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="min-w-0 flex-1 text-ui-lg font-medium text-foreground">{title}</span>
            {isDirty ? (
              <span className="shrink-0 text-ui-sm text-muted-foreground">Custom</span>
            ) : null}
            {providerUpdateLabel ? (
              <span
                className={cn(
                  "shrink-0 text-ui-sm",
                  updateAdvisory?.status === "behind_latest"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {providerUpdateLabel}
              </span>
            ) : null}
            <DisclosureChevron
              open={props.open}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </CollapsibleTrigger>
          {showUpdateButton && props.providerStatus ? (
            <ProviderUpdateAction
              providerStatus={props.providerStatus}
              active={updateActive}
              disabled={updateActive}
              onUpdate={props.onUpdate}
            />
          ) : null}
        </div>

        <CollapsiblePanel>
          <div className="border-t border-border/70 bg-muted/20 px-3 py-3">
            <div className="space-y-3">
              <ProviderDocsLinks docs={props.config.docs} />
              {props.config.install ? (
                <ProviderInstallCommandCard
                  install={
                    props.providerStatus?.versionAdvisory?.packageChannel === "cn-mirror"
                      ? {
                          ...props.config.install,
                          command: withCnMirrorRegistry(props.config.install.command),
                        }
                      : props.config.install
                  }
                />
              ) : null}
              {showProviderUpdateStatus && updateAdvisory?.status === "behind_latest" ? (
                <div className="text-ui leading-snug text-muted-foreground">
                  {updateAdvisory.canUpdate && updateAdvisory.updateCommand ? (
                    <>
                      <span>Command: </span>
                      <code className="font-mono">{updateAdvisory.updateCommand}</code>
                    </>
                  ) : (
                    "A newer version is available, but Moss could not identify a safe one-click update command for this installation."
                  )}
                </div>
              ) : null}
              {showSelfManagedUpdate && props.providerStatus ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-ui leading-snug text-muted-foreground">
                    {title} manages its own releases, so Moss cannot tell whether a newer version
                    exists. Run the update to be sure.
                  </div>
                  <ProviderUpdateAction
                    providerStatus={props.providerStatus}
                    active={updateActive}
                    disabled={updateActive}
                    onUpdate={props.onUpdate}
                  />
                </div>
              ) : null}
              <ProviderAccountsControl
                config={props.config}
                providerStatusByInstance={props.providerStatusByInstance}
                settings={props.settings}
                updateSettings={props.updateSettings}
                updateSettingsAndWait={props.updateSettingsAndWait}
              />
            </div>
          </div>
        </CollapsiblePanel>
      </div>
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
  const { format, t } = useTranslation();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const refreshProvidersInFlightRef = useRef(false);
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>(
    () => ({
      ...createProviderInstallDisclosureState(settings),
      ...(providerTarget ? { [providerTarget]: true } : {}),
    }),
  );
  const [updatingProviders, setUpdatingProviders] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );
  const providerEnablementMutationInFlightRef = useRef(false);
  const [providerEnablementMutationPending, setProviderEnablementMutationPending] = useState(false);
  const [disabledProvidersOpen, setDisabledProvidersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(providerTarget));
  const [installationProvider, setInstallationProvider] = useState<ProviderKind | null>(null);
  const installedProviderRef = useRef(new Set<ProviderKind>());
  for (const status of serverConfigQuery.data?.providers ?? []) {
    const provider = status.driver ?? status.provider;
    if (isProviderKind(provider) && isLocalProviderInstalled(status))
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
          return isProviderKind(driver) && providerStatusInstanceKey(status) === driver
            ? [[driver, status] as const]
            : [];
        }),
      ),
    [localProviderStatuses],
  );
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
      }).filter(
        (status) => !disabledProviderSet.has((status.driver ?? status.provider) as ProviderKind),
      ),
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
        providers: (serverConfigQuery.data?.providers ?? []).filter(
          (s) => !disabledProviderSet.has((s.driver ?? s.provider) as ProviderKind),
        ),
        hiddenProviders: settings.hiddenProviders,
        serverSettings: providerUpdateServerSettings,
        outdatedCount: outdatedProviderStatuses.length,
      });
  const installSettingsDirty = isProviderInstallSettingsDirty(settings, defaults);

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
    setAdvancedOpen(false);
  });

  useEffect(() => {
    if (!active || !providerTarget) return;
    setAdvancedOpen(true);
    if (disabledProviderSet.has(providerTarget)) {
      setDisabledProvidersOpen(true);
    } else {
      setOpenInstallProviders((current) => ({ ...current, [providerTarget]: true }));
    }
  }, [active, disabledProviderSet, providerTarget]);

  const handleProviderOrderDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = settings.providerOrder.indexOf(active.id as ProviderKind);
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

  const renderProviderActivityRow = (option: (typeof PROVIDER_VISIBILITY_OPTIONS)[number]) => {
    const enabled = !disabledProviderSet.has(option.provider);
    const providerStatus = providerStatusByProvider.get(option.provider);
    const readiness =
      enabled && providerStatusesReconciled && providerStatus
        ? resolveAgentReadiness(providerStatus)
        : null;
    // One plain line from the server's readiness, never the CLI's own diagnostic, and one
    // action: 登录 runs the agent's sign-in in the browser, 安装 installs it in place.
    const descriptionKey = readiness ? providerReadinessDescriptionKey(readiness) : null;
    const canSignIn =
      readiness?.state === "needsLogin" && supportsAgentSignIn(option.provider, providerStatus);
    // Only what Moss cannot fix by itself keeps the agent's own help page.
    const showGuide =
      readiness?.state === "error" || (readiness?.state === "needsLogin" && !canSignIn);
    return (
      <SettingsListRow
        key={option.provider}
        id={agentSettingsAnchorId(option.provider)}
        title={
          <span className="flex items-center gap-2">
            <ProviderIcon provider={option.provider} className="size-4 shrink-0" />
            <span>{option.title}</span>
          </span>
        }
        description={
          <span className="block" data-agent-readiness={readiness?.state ?? "unknown"}>
            {readiness
              ? descriptionKey
                ? format(descriptionKey, { provider: option.title })
                : t(PROVIDER_READINESS_LABEL_KEY[readiness.state])
              : providerSetupStatusLabel({
                  status: providerStatus,
                  reconciled: providerStatusesReconciled,
                  disabled: !enabled,
                })}
          </span>
        }
        actions={
          <>
            {installedProviderRef.current.has(option.provider) ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setInstallationProvider(option.provider)}
                aria-label={format("settings.providers.installation.title", {
                  provider: option.title,
                })}
              >
                {t("settings.providers.installation.manage")}
              </Button>
            ) : null}
            {readiness?.state === "notInstalled" ? (
              <AgentInstallButton
                provider={option.provider}
                providerLabel={option.title}
                readiness={readiness}
                status={providerStatus}
                fallbackUrl={option.setupDocsHref}
              />
            ) : null}
            {canSignIn ? (
              <AgentSignInButton
                provider={option.provider}
                providerLabel={option.title}
                status={providerStatus}
              />
            ) : null}
            {showGuide ? (
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  void openProviderGuide(
                    option.setupDocsHref,
                    t("settings.providers.setupGuideFailed"),
                  )
                }
                aria-label={format("settings.providers.setupGuideAria", { provider: option.title })}
              >
                {t("settings.providers.setupGuide")}
                <ExternalLinkIcon className="size-3" />
              </Button>
            ) : null}
            <Switch
              checked={enabled}
              className={
                providerEnablementMutationPending ? "data-disabled:cursor-progress" : undefined
              }
              aria-busy={providerEnablementMutationPending}
              disabled={!serverSettingsQuery.data || providerEnablementMutationPending}
              onCheckedChange={(checked) =>
                void updateProviderEnablement(
                  setProviderListMembership(
                    settings.disabledProviders,
                    option.provider,
                    !Boolean(checked),
                  ),
                )
              }
              aria-label={`${enabled ? "Disable" : "Enable"} ${option.title}`}
            />
          </>
        }
      />
    );
  };

  return (
    <div className="space-y-6">
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
      <SettingsSection title="Provider activity">
        <SettingsRow
          title="Enabled providers"
          description="Turn agents on or off across Moss. Agents you turn off are hidden from pickers; their settings and conversations are kept, and running turns continue."
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={refreshingProviders}
              onClick={() => void refreshProviders()}
            >
              {refreshingProviders ? <Loader2Icon className="size-4 animate-spin" /> : null}
              {refreshingProviders ? "Checking setup" : "Refresh status"}
            </Button>
          }
          status={
            providerEnablementMutationPending
              ? "Saving provider activity"
              : `${enabledProviderCount} of ${PROVIDER_VISIBILITY_OPTIONS.length} enabled`
          }
          resetAction={
            disabledProviderSet.size > 0 && !providerEnablementMutationPending ? (
              <SettingResetButton
                label="enabled providers"
                onClick={() => void updateProviderEnablement([...defaults.disabledProviders])}
              />
            ) : null
          }
        >
          {enabledProviderCount > 0 ? (
            <div
              className={cn(
                "mt-4",
                SETTINGS_INSET_LIST_CLASS_NAME,
                SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
              )}
            >
              {enabledProviderOptions.map(renderProviderActivityRow)}
            </div>
          ) : (
            <p className="mt-4 text-ui text-muted-foreground">
              No providers enabled. Open Disabled providers below to enable one.
            </p>
          )}
          {disabledProviderOptions.length > 0 ? (
            <Collapsible
              open={disabledProvidersOpen}
              onOpenChange={setDisabledProvidersOpen}
              className="mt-3"
            >
              <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left text-ui text-muted-foreground">
                <DisclosureChevron open={disabledProvidersOpen} className="size-4 shrink-0" />
                <span>Disabled providers ({disabledProviderOptions.length})</span>
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div
                  className={cn(
                    SETTINGS_INSET_LIST_CLASS_NAME,
                    SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
                  )}
                >
                  {disabledProviderOptions.map(renderProviderActivityRow)}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left text-ui font-medium">
          <DisclosureChevron open={advancedOpen} className="size-4 shrink-0" />
          {t("settings.providers.advanced.section")}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-6 pt-4">
            <SettingsSection title="Provider picker">
              <SettingsRow
                title="Default provider for new chats"
                description="New chats, Canvas and other quick actions take an agent's models from this provider unless you pick another one in the model picker. Moss is used while you are signed in to Moss."
                control={
                  <SettingsSegmentedControl
                    ariaLabel="Default provider for new chats"
                    value={settings.newChatModelSource}
                    onValueChange={(newChatModelSource) => updateSettings({ newChatModelSource })}
                    options={NEW_CHAT_MODEL_SOURCE_OPTIONS}
                  />
                }
                resetAction={
                  settings.newChatModelSource !== defaults.newChatModelSource ? (
                    <SettingResetButton
                      label="default provider for new chats"
                      onClick={() =>
                        updateSettings({ newChatModelSource: defaults.newChatModelSource })
                      }
                    />
                  ) : null
                }
              />
              <SettingsRow
                title="Available CLIs"
                description="Show or hide installed providers in the picker and drag them into your preferred order. Hiding a provider here does not disable its server activity."
                status={
                  serverConfigQuery.isPending || hasPendingProviderStatuses
                    ? "Checking installed CLIs"
                    : availableProviderCount === 0
                      ? "No CLIs detected"
                      : visibleAvailableProviderCount < availableProviderCount
                        ? `${visibleAvailableProviderCount} of ${availableProviderCount} installed shown`
                        : isProviderOrderDirty
                          ? `${availableProviderCount} installed · custom order`
                          : `${availableProviderCount} installed`
                }
                resetAction={
                  hiddenProviderCount > 0 || isProviderOrderDirty ? (
                    <SettingResetButton
                      label="provider picker"
                      onClick={() =>
                        updateSettings({
                          hiddenProviders: defaults.hiddenProviders,
                          providerOrder: defaults.providerOrder,
                        })
                      }
                    />
                  ) : null
                }
              >
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
                    <div className="mt-4 space-y-2">
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
              </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Performance">
              <SettingsRow
                title="Keep Moss responsive"
                description="Give agent processes and their commands a moderately lower CPU priority when the machine is busy."
                status="Applies to newly launched agent processes. Restart existing sessions to apply consistently."
                resetAction={
                  settings.lowerProviderProcessPriority !==
                  defaults.lowerProviderProcessPriority ? (
                    <SettingResetButton
                      label="Keep Moss responsive"
                      onClick={() =>
                        updateSettings({
                          lowerProviderProcessPriority: defaults.lowerProviderProcessPriority,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.lowerProviderProcessPriority}
                    onCheckedChange={(checked) =>
                      updateSettings({ lowerProviderProcessPriority: Boolean(checked) })
                    }
                    aria-label="Keep Moss responsive"
                  />
                }
              />
            </SettingsSection>

            <div id={SETTINGS_TARGETS.providerUpdates}>
              <SettingsSection title="Updates">
                <SettingsRow
                  title="Automatic CLI update checks"
                  description="Check Codex, Claude, and other provider CLIs for newer versions in the background."
                  resetAction={
                    settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks ? (
                      <SettingResetButton
                        label="CLI update checks"
                        onClick={() =>
                          updateSettings({
                            enableProviderUpdateChecks: defaults.enableProviderUpdateChecks,
                          })
                        }
                      />
                    ) : null
                  }
                  control={
                    <Switch
                      checked={settings.enableProviderUpdateChecks}
                      onCheckedChange={(checked) =>
                        updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
                      }
                      aria-label="Automatic CLI update checks"
                    />
                  }
                />

                <SettingsRow
                  title="Provider updates"
                  description="Review installed provider tools that Moss can safely update."
                  status={versionCheckSummary}
                >
                  {settings.enableProviderUpdateChecks && outdatedProviderStatuses.length > 0 ? (
                    <div
                      className={cn(
                        "mt-4",
                        SETTINGS_INSET_LIST_CLASS_NAME,
                        SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
                      )}
                    >
                      {outdatedProviderStatuses.map((providerStatus) => {
                        const instanceId = providerStatusInstanceKey(providerStatus);
                        const updateActive =
                          isProviderUpdateActive(providerStatus) ||
                          updatingProviders.has(instanceId);
                        const updateLabel = providerUpdateStatusLabel(providerStatus);
                        return (
                          <SettingsListRow
                            key={instanceId}
                            title={providerStatusDisplayName(providerStatus)}
                            description={updateLabel || undefined}
                            actions={
                              providerStatus.versionAdvisory?.canUpdate ? (
                                <ProviderUpdateAction
                                  providerStatus={providerStatus}
                                  active={updateActive}
                                  disabled={updateActive}
                                  onUpdate={(provider) => void runProviderUpdate(provider)}
                                />
                              ) : (
                                <span className="text-ui-sm text-muted-foreground">
                                  Manual update
                                </span>
                              )
                            }
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </SettingsRow>
              </SettingsSection>
            </div>

            <div id={SETTINGS_TARGETS.providerInstalls}>
              <SettingsSection title="Provider tools">
                <SettingsRow
                  title="Installed CLIs"
                  description="Review provider versions and update tools. Open a row only when you need binary overrides."
                  status={versionCheckSummary}
                  resetAction={
                    installSettingsDirty ? (
                      <SettingResetButton
                        label="provider tools"
                        onClick={() => {
                          updateSettings(createProviderInstallResetPatch(defaults));
                          setOpenInstallProviders(createClosedProviderInstallDisclosureState());
                        }}
                      />
                    ) : null
                  }
                >
                  <div className="mt-4">
                    <div className={SETTINGS_INSET_LIST_CLASS_NAME}>
                      {VISIBLE_PROVIDER_INSTALL_SETTINGS.filter(
                        (config) => !disabledProviderSet.has(config.provider),
                      ).map((config) => (
                        <ProviderToolRow
                          key={config.provider}
                          config={config}
                          open={openInstallProviders[config.provider]}
                          settings={settings}
                          defaults={defaults}
                          hiddenProviderSet={hiddenProviderSet}
                          serverSettings={providerUpdateServerSettings}
                          providerStatus={installedProgramStatus(
                            config.provider,
                            providerStatusByProvider.get(config.provider),
                            localProviderStatuses,
                          )}
                          providerStatusByInstance={providerStatusByInstance}
                          updatingProviders={updatingProviders}
                          onOpenChange={(open) =>
                            setOpenInstallProviders((existing) => ({
                              ...existing,
                              [config.provider]: open,
                            }))
                          }
                          onUpdate={(provider) => void runProviderUpdate(provider)}
                          updateSettings={updateSettings}
                          updateSettingsAndWait={updateSettingsAndWait}
                        />
                      ))}
                    </div>
                  </div>
                </SettingsRow>
              </SettingsSection>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
