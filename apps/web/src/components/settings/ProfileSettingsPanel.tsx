// FILE: ProfileSettingsPanel.tsx
// Purpose: ChatGPT-style Moss Profile dashboard shared between the full-page `/profile`
//          view and Settings → Profile. Wired to the `#759` profile contract for inline
//          display name, unique @handle, 20 Notion-style Moss SVG preset avatars, and
//          custom image upload, while preserving Moss's multi-provider local telemetry.
// Layer: Web profile feature

import type {
  MossProfileAvatar,
  MossProfileCheckHandleResult,
  MossProfileState,
  MossProfileUpdateInput,
  MossProfileUploadAvatarInput,
  ProfileStats,
  ProfileTokenStats,
} from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { ProviderIcon } from "~/components/ProviderIcon";
import { fallbackMossPlanName, maskPhoneNumber } from "~/components/SidebarAccountMenu";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { CentralIcon } from "~/lib/central-icons";
import { resolveMossPayQuotaAccountIdentity } from "~/lib/mossPayQuotaIdentity";
import {
  serverProfileStatsQueryOptions,
  serverProfileTokenStatsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { closeSettings, navigateSettings } from "~/settingsDialogStore";
import { ActivityHeatmap, type ProfileActivityView } from "../profile/ActivityHeatmap";
import { AvatarPickerDialog } from "../profile/AvatarPickerDialog";
import { resolveProfileAvatarSrc } from "../profile/profileAvatarPresets";
import { getProfileCopy } from "../profile/profileCopy";
import {
  deriveProfileInitials,
  formatCompact,
  formatDays,
  formatDuration,
  formatNumber,
  formatProviderLabel,
  toDisplayName,
} from "../profile/profileFormatting";
import { ProfileIdentityHeader } from "../profile/ProfileIdentityHeader";
import {
  selectProfileHeatmap,
  selectProfileModelUsage,
  selectProfileTopProvider,
} from "../profile/profileSelectors";
import { InsightRow, ModelUsageRow, StatTile } from "../profile/ProfileStatRows";
import { ProfileUsageCoverage } from "../profile/ProfileUsageCoverage";
import {
  formatDisplayHandle,
  normalizeProfileHandleDraft,
  validateProfileHandleLocal,
} from "../profile/profileValidation";
import { ShareDialog } from "../profile/ShareDialog";
import { useMossProfileMutations, useMossProfileState } from "../profile/useMossProfile";
import { useProfileAvatarColor } from "../profile/useProfileAvatarColor";
import { useProfileAvatarImage } from "../profile/useProfileAvatarImage";
import { useProfileHandle } from "../profile/useProfileHandle";
import { useProfileName } from "../profile/useProfileName";

/** Whether a Moss account is signed in: by phone, cloud account, or enterprise key. */
export type ProfileAccountState = "signedIn" | "signedOut" | "checking";

export interface ProfileAccountContext {
  readonly state: ProfileAccountState;
  readonly planName: string | null;
  readonly accountSummary: string | null;
}

export function useProfileAccountContext(): ProfileAccountContext {
  const { t } = useTranslation();
  const cloudQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const phoneQuery = useQuery(serverMossAccountSessionQueryOptions());
  const enterpriseQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());

  const phoneSession =
    phoneQuery.data?.authenticated && phoneQuery.data.session ? phoneQuery.data.session : null;
  const cloudAccount =
    cloudQuery.data?.authenticated && cloudQuery.data.account ? cloudQuery.data.account : null;
  const enterpriseSignedIn = Boolean(enterpriseQuery.data?.authenticated);

  const state: ProfileAccountState =
    phoneSession || cloudAccount || enterpriseSignedIn
      ? "signedIn"
      : cloudQuery.isPending || phoneQuery.isPending
        ? "checking"
        : "signedOut";

  const payAccountIdentity = resolveMossPayQuotaAccountIdentity(phoneQuery.data, cloudQuery.data);
  const payQuotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({
      enabled: state === "signedIn" && payAccountIdentity !== null,
      accountIdentity: payAccountIdentity,
    }),
  );
  const payCatalogQuery = useQuery(
    serverMossPayCatalogQueryOptions({ enabled: state === "signedIn" }),
  );

  const payPlanCode = payQuotaQuery.data?.planCode?.trim() ?? "";
  const planName = payPlanCode
    ? (payCatalogQuery.data?.plans.find((plan) => plan.code === payPlanCode)?.displayName.trim() ??
      fallbackMossPlanName(payPlanCode, t("mossPay.settings.freePlan")))
    : enterpriseSignedIn && !phoneSession && !cloudAccount
      ? fallbackMossPlanName("enterprise")
      : null;

  const accountSummary = phoneSession
    ? maskPhoneNumber(phoneSession.user.phoneNumber)
    : cloudAccount
      ? cloudAccount.email
      : enterpriseSignedIn && enterpriseQuery.data?.keyPrefix
        ? `${enterpriseQuery.data.keyPrefix}…`
        : null;

  return { state, planName, accountSummary };
}

export function ProfileSettingsPanel() {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);
  const coreQuery = useQuery(serverProfileStatsQueryOptions());
  const tokenQuery = useQuery(serverProfileTokenStatsQueryOptions());
  const accountContext = useProfileAccountContext();
  const profileQuery = useMossProfileState();
  const { updateMutation, uploadAvatarMutation, checkHandle } = useMossProfileMutations();
  const navigate = useNavigate();

  if (coreQuery.isPending) {
    return <ProfileSkeleton />;
  }
  if (coreQuery.isError || !coreQuery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-ui leading-snug text-muted-foreground">{copy.loadStatsError}</p>
        <Button variant="outline" size="sm" onClick={() => void coreQuery.refetch()}>
          {copy.tryAgain}
        </Button>
      </div>
    );
  }

  return (
    <ProfileContent
      account={accountContext.state}
      planName={accountContext.planName}
      accountSummary={accountContext.accountSummary}
      profileState={profileQuery.profileState}
      presentation="settings"
      onSignIn={() => {
        closeSettings();
        void navigate({ to: "/login" });
      }}
      onOpenAccountSettings={() => navigateSettings({ section: "account" })}
      onRetryProfileSync={() => void profileQuery.refetch()}
      onUpdateProfile={async (input) => {
        await updateMutation.mutateAsync(input);
      }}
      onUploadAvatar={async (input) => {
        await uploadAvatarMutation.mutateAsync(input);
      }}
      onCheckHandle={checkHandle}
      stats={coreQuery.data}
      tokenStats={tokenQuery.data ?? null}
      tokensPending={tokenQuery.isPending}
    />
  );
}

function ProfilePageShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <div
        className="sticky top-0 z-20 flex h-[46px] shrink-0 items-center justify-between bg-popover/95 backdrop-blur-sm"
        data-testid="profile-page-toolbar"
      >
        <h1 className="text-sm font-normal text-foreground">{title}</h1>
        {actions ?? <span />}
      </div>
      {/* The sections need room between them: without it the sign-in button sat on the stat
          tiles and the month labels ran into the next heading. */}
      <div className="flex min-w-0 flex-col gap-8 pt-2 pb-8">{children}</div>
    </div>
  );
}

export interface ProfileContentProps {
  readonly account: ProfileAccountState;
  readonly onSignIn: () => void;
  readonly stats: ProfileStats;
  readonly tokenStats: ProfileTokenStats | null;
  readonly tokensPending: boolean;
  readonly profileState?: MossProfileState | null;
  readonly planName?: string | null;
  readonly accountSummary?: string | null;
  readonly presentation?: "page" | "settings";
  readonly onOpenAccountSettings?: () => void;
  readonly onRetryProfileSync?: () => void;
  readonly onUpdateProfile?: (input: MossProfileUpdateInput) => Promise<void>;
  readonly onUploadAvatar?: (input: MossProfileUploadAvatarInput) => Promise<void>;
  readonly onCheckHandle?: (rawHandle: string) => Promise<MossProfileCheckHandleResult>;
  readonly shareOpen?: boolean;
  readonly onShareOpenChange?: (open: boolean) => void;
}

export function ProfileContent({
  account,
  onSignIn,
  stats,
  tokenStats,
  tokensPending,
  profileState = null,
  planName = null,
  accountSummary = null,
  presentation = "settings",
  onOpenAccountSettings,
  onRetryProfileSync,
  onUpdateProfile,
  onUploadAvatar,
  onCheckHandle,
  shareOpen: controlledShareOpen,
  onShareOpenChange,
}: ProfileContentProps) {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);
  const [uncontrolledShareOpen, setUncontrolledShareOpen] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [activityView, setActivityView] = useState<ProfileActivityView>("daily");

  const shareOpen = controlledShareOpen ?? uncontrolledShareOpen;
  const setShareOpen = onShareOpenChange ?? setUncontrolledShareOpen;

  const defaultName = toDisplayName(stats.identity.homeDirBasename);
  const { name: localName, setName: setLocalName } = useProfileName(defaultName);
  const {
    handle: localHandle,
    setHandle: setLocalHandle,
    isCustom: hasLocalCustomHandle,
  } = useProfileHandle(stats.identity.defaultHandle);
  const { color: avatarColor, setColor: setAvatarColor } = useProfileAvatarColor();
  const { image: legacyAvatarImage, setImage: setLegacyAvatarImage } = useProfileAvatarImage();

  const signedOut = account !== "signedIn";
  const hasServerProfile = profileState !== null;
  const serverProfile = profileState?.profile ?? null;
  const serverProfileCustomized = Boolean(serverProfile && serverProfile.updatedAt !== null);

  const effectiveDisplayName = serverProfile
    ? serverProfile.displayName.trim() || defaultName
    : localName;
  const hasCustomName = serverProfile ? serverProfileCustomized : localName !== defaultName;

  const effectiveHandle: string | null = serverProfile
    ? serverProfile.handle
    : signedOut && !hasLocalCustomHandle
      ? null
      : normalizeProfileHandleDraft(localHandle);

  const effectiveAvatar: MossProfileAvatar = serverProfile
    ? serverProfile.avatar
    : legacyAvatarImage
      ? { kind: "upload", url: legacyAvatarImage }
      : { kind: "initials" };

  // Signed out, never show the raw machine home-folder name (e.g. "PR" / "Profile" / "@profile")
  // until the person explicitly sets a local display name, handle, or avatar.
  const headerTitle = signedOut && !hasCustomName ? copy.signedOutTitle : effectiveDisplayName;
  const showSignedOutAvatarGlyph =
    signedOut && !hasCustomName && effectiveAvatar.kind === "initials" && !legacyAvatarImage;
  const editable = hasServerProfile
    ? profileState.editable && (account === "signedIn" || presentation === "page")
    : account === "signedIn" || presentation === "page";
  const sync = profileState?.sync ?? (signedOut ? "local" : "synced");

  const resolvedAvatarSrc = resolveProfileAvatarSrc(effectiveAvatar, legacyAvatarImage);
  const resolvedInitials =
    signedOut && !hasCustomName
      ? "M"
      : deriveProfileInitials(effectiveDisplayName, stats.identity.initials || "M");
  const shareHandle = formatDisplayHandle(effectiveHandle) ?? stats.identity.defaultHandle;

  // Tokens/day when available, prompts/day otherwise — shared with ShareCard.
  const heatmap = selectProfileHeatmap(stats, tokenStats);
  const topProvider = selectProfileTopProvider(stats, tokenStats);
  const modelUsage = selectProfileModelUsage(stats, tokenStats);
  const peakHourLabel = formatPeakHourLabel(stats.activeHours.startHour, locale);

  const handleSaveDisplayName = useCallback(
    async (nextName: string) => {
      if (onUpdateProfile) {
        await onUpdateProfile({ displayName: nextName });
        return;
      }
      setLocalName(nextName);
    },
    [onUpdateProfile, setLocalName],
  );

  const handleSaveHandle = useCallback(
    async (normalizedHandle: string) => {
      if (onUpdateProfile) {
        await onUpdateProfile({ handle: normalizedHandle });
        return;
      }
      setLocalHandle(normalizedHandle);
    },
    [onUpdateProfile, setLocalHandle],
  );

  const handleCheckHandle = useCallback(
    async (rawHandle: string): Promise<MossProfileCheckHandleResult> => {
      if (onCheckHandle) {
        return onCheckHandle(rawHandle);
      }
      const normalized = normalizeProfileHandleDraft(rawHandle);
      const localInvalid = validateProfileHandleLocal(normalized);
      if (localInvalid) {
        return { handle: normalized, status: localInvalid };
      }
      if (normalized === normalizeProfileHandleDraft(effectiveHandle ?? "")) {
        return { handle: normalized, status: "current" };
      }
      return { handle: normalized, status: "available" };
    },
    [effectiveHandle, onCheckHandle],
  );

  const handleSelectPreset = useCallback(
    async (presetId: string) => {
      if (onUpdateProfile) {
        await onUpdateProfile({ avatar: { kind: "preset", id: presetId } });
        return;
      }
      setLegacyAvatarImage(`/avatars/${presetId}.svg`);
    },
    [onUpdateProfile, setLegacyAvatarImage],
  );

  const handleSelectInitials = useCallback(
    async (accentColor: string) => {
      setAvatarColor(accentColor);
      if (onUpdateProfile) {
        await onUpdateProfile({ avatar: { kind: "initials" } });
        return;
      }
      setLegacyAvatarImage(null);
    },
    [onUpdateProfile, setAvatarColor, setLegacyAvatarImage],
  );

  const handleUploadAvatar = useCallback(
    async (input: MossProfileUploadAvatarInput) => {
      if (onUploadAvatar) {
        await onUploadAvatar(input);
        return;
      }
      setLegacyAvatarImage(`data:${input.mimeType};base64,${input.dataBase64}`);
    },
    [onUploadAvatar, setLegacyAvatarImage],
  );

  const body = (
    <>
      <ProfileIdentityHeader
        account={account}
        presentation={presentation}
        displayName={effectiveDisplayName}
        headerTitle={headerTitle}
        handle={effectiveHandle}
        initials={resolvedInitials}
        avatar={effectiveAvatar}
        avatarColor={avatarColor}
        legacyAvatarImage={legacyAvatarImage}
        showSignedOutAvatarGlyph={showSignedOutAvatarGlyph}
        editable={editable}
        sync={sync}
        planName={planName}
        accountSummary={accountSummary}
        onOpenAvatarPicker={() => setAvatarPickerOpen(true)}
        onSaveDisplayName={handleSaveDisplayName}
        onSaveHandle={handleSaveHandle}
        onCheckHandle={handleCheckHandle}
        onSignIn={onSignIn}
        {...(onOpenAccountSettings ? { onOpenAccountSettings } : {})}
        {...(onRetryProfileSync ? { onRetrySync: onRetryProfileSync } : {})}
      />

      {/* ChatGPT-style 5-column stat strip */}
      <div
        className="grid grid-cols-2 divide-x divide-y divide-border/50 overflow-hidden rounded-card border border-border/60 bg-card/40 sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0"
        data-testid="profile-stats-row"
      >
        <StatTile
          label={copy.stats.lifetimeTokens}
          value={
            tokensPending ? null : formatCompact(tokenStats?.lifetimeTotalTokens ?? null, locale)
          }
        />
        <StatTile
          label={copy.stats.peakDay}
          value={tokensPending ? null : formatCompact(tokenStats?.peakDayTokens ?? null, locale)}
        />
        <StatTile
          label={copy.stats.longestTask}
          value={formatDuration(stats.activity.longestTaskMs, locale)}
        />
        <StatTile
          label={copy.stats.longestStreak}
          value={formatDays(stats.activity.longestStreakDays, locale)}
        />
        <StatTile
          label={copy.stats.currentStreak}
          value={formatDays(stats.activity.currentStreakDays, locale)}
        />
      </div>

      {/* Token activity heatmap (Daily / Weekly / Cumulative) */}
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-ui">
          <h3 className="text-ui-lg font-medium text-foreground">{copy.heatmap.title}</h3>
          <div className="flex items-center gap-1" role="group" aria-label={copy.heatmap.title}>
            <ActivityViewButton
              active={activityView === "daily"}
              onSelect={() => setActivityView("daily")}
            >
              {copy.heatmap.daily}
            </ActivityViewButton>
            <ActivityViewButton
              active={activityView === "weekly"}
              onSelect={() => setActivityView("weekly")}
            >
              {copy.heatmap.weekly}
            </ActivityViewButton>
            <ActivityViewButton
              active={activityView === "cumulative"}
              onSelect={() => setActivityView("cumulative")}
            >
              {copy.heatmap.cumulative}
            </ActivityViewButton>
          </div>
        </div>
        {stats.providerModels.some((entry) => entry.provider === "claudeAgent") ||
        tokenStats?.providers.includes("claudeAgent") ? (
          <p className="text-ui-sm leading-snug text-muted-foreground">{copy.heatmap.claudeNote}</p>
        ) : null}
        {tokensPending ? (
          <Skeleton className="h-32 w-full rounded-card" />
        ) : (
          <ActivityHeatmap
            cells={heatmap.cells}
            fill
            radius={4}
            gap={3}
            tooltip
            tooltipUnit={heatmap.unit}
            locale={locale}
            showMonths
            monthsPosition="bottom"
            view={activityView}
            animated
          />
        )}
      </section>

      {/* Recent project / overview + Popular plugins & agents */}
      <div className="grid gap-x-12 gap-y-7 md:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h3 className="text-ui-lg font-medium text-foreground">{copy.sections.recentWork}</h3>
          {stats.mostWorkedProject ? (
            <div className="flex items-start gap-3 rounded-card border border-border/60 bg-card/40 p-3.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-muted/60 text-muted-foreground">
                <CentralIcon name="folder" className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-ui-xs text-muted-foreground">{copy.sections.topProject}</p>
                <p className="truncate text-ui font-medium text-foreground">
                  {stats.mostWorkedProject.title}
                </p>
                <p className="mt-0.5 text-ui-xs text-muted-foreground tabular-nums">
                  {copy.sections.topProjectMeta(
                    stats.mostWorkedProject.promptCount,
                    stats.mostWorkedProject.threadCount,
                    stats.mostWorkedProject.activeDays,
                  )}
                </p>
              </div>
            </div>
          ) : null}
          <dl className="flex flex-col gap-2.5">
            <InsightRow
              label={copy.sections.mostUsedProvider}
              value={
                topProvider.provider
                  ? `${formatProviderLabel(topProvider.provider)}${
                      topProvider.percent !== null
                        ? topProvider.metric === "tokens"
                          ? copy.sections.providerShareOfTokens(topProvider.percent)
                          : copy.sections.providerShareOfTurns(topProvider.percent)
                        : ""
                    }`
                  : "—"
              }
            />
            <InsightRow
              label={copy.sections.mostUsedReasoning}
              value={
                stats.insights.topReasoning
                  ? `${capitalize(stats.insights.topReasoning)}${
                      stats.insights.topReasoningPercent !== null
                        ? ` · ${stats.insights.topReasoningPercent}%`
                        : ""
                    }`
                  : "—"
              }
            />
            <InsightRow label={copy.sections.mostActiveHour} value={peakHourLabel} />
            <InsightRow
              label={copy.sections.skillsExplored}
              value={formatNumber(stats.insights.skillsExplored)}
            />
            <InsightRow
              label={copy.sections.totalPrompts}
              value={formatNumber(stats.activity.totalPromptsSent)}
            />
            <InsightRow
              label={copy.sections.totalThreads}
              value={formatNumber(stats.activity.totalThreads)}
            />
          </dl>
          <ProfileUsageCoverage unavailableProviders={topProvider.unavailableProviders} />
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-ui-lg font-medium text-foreground">{copy.sections.popularPlugins}</h3>
          {stats.skills.length > 0 ? (
            <ul className="flex flex-col gap-2.5">
              {stats.skills.slice(0, 6).map((skill) => (
                <li
                  key={`${skill.kind}:${skill.name}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-control-xs bg-muted/60">
                      <CentralIcon
                        name={skill.kind === "agent" ? "agent" : "building-blocks"}
                        className="size-3.5"
                      />
                    </span>
                    <span className="truncate text-ui leading-snug">{skill.displayName}</span>
                  </span>
                  <span className="shrink-0 text-ui-sm leading-snug tabular-nums text-muted-foreground">
                    {copy.sections.runs(formatNumber(skill.runCount))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ui-sm leading-snug text-muted-foreground">
              {copy.sections.noPlugins}
            </p>
          )}
        </section>
      </div>

      {/* Model usage */}
      <section className="flex flex-col gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">{copy.sections.modelUsage}</h3>
        <p className="text-ui-sm leading-snug text-muted-foreground">
          {modelUsage.metric === "tokens"
            ? copy.sections.shareOfTokens
            : copy.sections.shareOfTurns}
        </p>
        {modelUsage.entries.length > 0 ? (
          <ul className="grid grid-cols-1 gap-x-12 gap-y-3 sm:grid-cols-2">
            {modelUsage.entries.slice(0, 8).map((entry) => (
              <ModelUsageRow
                key={`${entry.instanceId}:${entry.model}`}
                icon={
                  entry.provider !== "unknown" ? (
                    <ProviderIcon provider={entry.provider} className="size-4 shrink-0" />
                  ) : (
                    <CentralIcon name="chart-2" className="size-4 shrink-0 text-muted-foreground" />
                  )
                }
                model={entry.model}
                percent={entry.percent}
              />
            ))}
          </ul>
        ) : (
          <p className="text-ui-sm leading-snug text-muted-foreground">
            {copy.sections.noModelActivity}
          </p>
        )}
        <ProfileUsageCoverage unavailableProviders={modelUsage.unavailableProviders} />
      </section>

      <ShareDialog
        stats={stats}
        tokenStats={tokenStats}
        displayName={effectiveDisplayName}
        handle={shareHandle}
        avatarColor={avatarColor}
        avatarImage={resolvedAvatarSrc}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      <AvatarPickerDialog
        open={avatarPickerOpen}
        onOpenChange={setAvatarPickerOpen}
        currentAvatar={effectiveAvatar}
        initials={resolvedInitials}
        avatarColor={avatarColor}
        onSelectPreset={handleSelectPreset}
        onSelectInitials={handleSelectInitials}
        onUploadAvatar={handleUploadAvatar}
      />
    </>
  );

  if (presentation === "page") {
    return <div className="flex min-w-0 flex-col gap-8">{body}</div>;
  }

  // Settings mode: keep the compact toolbar; hide Share/Edit buttons while signed out in Settings.
  const settingsActions = signedOut ? undefined : (
    <div className="flex items-center justify-end gap-2">
      <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
        <CentralIcon name="share-os" />
        {copy.share}
      </Button>
      {editable ? (
        <Button variant="outline" size="sm" onClick={() => setAvatarPickerOpen(true)}>
          <CentralIcon name="pencil" />
          {copy.changeAvatar}
        </Button>
      ) : null}
    </div>
  );

  return (
    <ProfilePageShell title={copy.title} actions={settingsActions}>
      {body}
    </ProfilePageShell>
  );
}

// ── Small pieces ───────────────────────────────────────────────────────

function ActivityViewButton({
  active,
  children,
  onSelect,
}: {
  active: boolean;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      shape="capsule"
      aria-pressed={active}
      className={cn(
        "px-2.5 text-ui-sm font-normal",
        active
          ? "bg-[color-mix(in_srgb,var(--color-text-foreground)_7%,transparent)] text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onSelect}
    >
      {children}
    </Button>
  );
}

function formatHour(hour: number, locale: "zh-CN" | "en"): string {
  const normalized = ((hour % 24) + 24) % 24;
  if (locale === "zh-CN") {
    return `${String(normalized).padStart(2, "0")}:00`;
  }
  if (normalized === 0) return "12 AM";
  if (normalized === 12) return "12 PM";
  return normalized < 12 ? `${normalized} AM` : `${normalized - 12} PM`;
}

function formatPeakHourLabel(startHour: number | null, locale: "zh-CN" | "en"): string {
  return startHour === null ? "—" : formatHour(startHour, locale);
}

export function ProfileSkeleton() {
  return (
    <div className="flex flex-col items-center gap-7 py-4">
      <Skeleton className="size-24 rounded-full" />
      <div className="flex flex-col items-center gap-2">
        <Skeleton className="h-7 w-40 rounded-control" />
        <Skeleton className="h-4 w-28 rounded-control" />
      </div>
      <Skeleton className="h-[72px] w-full rounded-card" />
      <Skeleton className="h-28 w-full rounded-card" />
      <div className="grid w-full gap-7 md:grid-cols-2">
        <Skeleton className="h-44 w-full rounded-card" />
        <Skeleton className="h-44 w-full rounded-card" />
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
