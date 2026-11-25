// FILE: AccountSettingsPanel.tsx
// Purpose: Settings → 账号 panel. Houses all functionality moved from the removed
//          full-page `/account` screen: phone/Google/enterprise account status,
//          国内账号服务 notice, 登录方式 (`MossAccessLanesPanel`), saved Google accounts,
//          会员与积分 (`MossPayPanel`), 用量与充值 shortcut, and 退出登录.
// Layer: Settings UI components

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { MossAccessLanesPanel } from "~/components/auth/MossAccessLanesPanel";
import { mossAccessLaneSummary } from "~/components/auth/mossAccessLanes.logic";
import type { MossAccountView } from "~/components/auth/mossAccountRoutes.logic";
import { MossAuthLoading } from "~/components/auth/MossAuthShell";
import { mossCloudAuthErrorMessage } from "~/components/auth/mossCloudAuth.logic";
import { mossEnterpriseKeyStatusNotice } from "~/components/auth/mossEnterpriseKey.logic";
import { MossPayPanel } from "~/components/auth/MossPayPanel";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
  serverMossCloudLogoutMutationOptions,
  serverMossCloudRemoveAccountMutationOptions,
  serverMossCloudSelectAccountMutationOptions,
  serverMossEnterpriseKeySignOutMutationOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossLogoutMutationOptions,
} from "~/components/auth/mossServerReactQuery";
import { getProfileCopy } from "~/components/profile/profileCopy";
import { ProfileAvatar } from "~/components/profile/ProfileAvatar";
import { deriveProfileInitials } from "~/components/profile/profileFormatting";
import { useResolvedMossProfileAvatar } from "~/components/profile/useMossProfile";
import { useProfileAvatarColor } from "~/components/profile/useProfileAvatarColor";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button, buttonVariants } from "~/components/ui/button";
import { ArrowLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { closeSettings, type SettingsOpenRequest } from "~/settingsDialogStore";

function formatSessionDate(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return locale === "zh-CN" ? "未知" : "Unknown";
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function AccountSettingsPanel({
  accountView,
  onNavigate,
}: {
  readonly accountView?: MossAccountView | undefined;
  readonly onNavigate?: (request: SettingsOpenRequest) => void;
}) {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);
  const navigate = useNavigate();
  const [subView, setSubView] = useState<MossAccountView | null>(accountView ?? null);

  useEffect(() => {
    setSubView(accountView ?? null);
  }, [accountView]);

  const phoneQuery = useQuery(serverMossAccountSessionQueryOptions());
  const cloudQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const enterpriseQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());

  const openUsage = () => {
    if (onNavigate) {
      onNavigate({ section: "usage" });
    }
  };

  const openProfile = () => {
    closeSettings();
    void navigate({ to: "/profile" });
  };

  const openLogin = (addAccount = false) => {
    closeSettings();
    if (addAccount) {
      void navigate({ to: "/login", search: { add: true } });
      return;
    }
    void navigate({ to: "/login" });
  };

  if (subView === "google") {
    return (
      <MossCloudAccountSettingsBody
        canReturnToPhone={Boolean(phoneQuery.data?.authenticated)}
        onBackToPhone={() => setSubView(null)}
        onOpenLogin={openLogin}
        onOpenProfile={openProfile}
        onOpenUsage={openUsage}
      />
    );
  }

  if (phoneQuery.isPending || enterpriseQuery.isPending) {
    return <MossAuthLoading label={copy.accountSettings.loading} />;
  }

  if (phoneQuery.data?.authenticated) {
    return (
      <MossPhoneAccountSettingsBody
        onManageGoogle={() => setSubView("google")}
        onOpenLogin={() => openLogin(false)}
        onOpenProfile={openProfile}
        onOpenUsage={openUsage}
      />
    );
  }

  if (enterpriseQuery.data?.authenticated && !cloudQuery.data?.authenticated) {
    return (
      <MossEnterpriseAccountSettingsBody
        onManageGoogle={() => setSubView("google")}
        onOpenLogin={() => openLogin(false)}
        onOpenProfile={openProfile}
      />
    );
  }

  return (
    <MossCloudAccountSettingsBody
      canReturnToPhone={false}
      onOpenLogin={openLogin}
      onOpenProfile={openProfile}
      onOpenUsage={openUsage}
    />
  );
}

function AccountIdentityBanner({
  eyebrow,
  title,
  initials: initialsOverride,
  subtitle,
  monoTitle = false,
  onOpenProfile,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly initials?: string | undefined;
  readonly subtitle: string;
  readonly monoTitle?: boolean;
  readonly onOpenProfile: () => void;
}) {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);
  const { avatarSrc, profileState } = useResolvedMossProfileAvatar();
  const { color: avatarColor } = useProfileAvatarColor();
  const effectiveName = profileState?.profile.displayName?.trim() || title;
  const initials = initialsOverride ?? deriveProfileInitials(effectiveName, "M");

  return (
    <section
      className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-card border border-border/70 p-4"
      data-testid="settings-account-summary"
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <ProfileAvatar
          initials={initials}
          color={avatarColor}
          image={avatarSrc}
          className="size-12 shrink-0 border border-border/60"
          textClassName="text-ui-lg"
        />
        <div className="min-w-0">
          <p className="text-ui-xs text-muted-foreground">{eyebrow}</p>
          <p
            className={cn(
              "mt-0.5 truncate text-ui-lg font-medium text-foreground",
              monoTitle && "font-mono",
            )}
          >
            {title}
          </p>
          <p className="mt-0.5 truncate text-ui-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onOpenProfile}>
        {copy.accountSettings.openProfile}
      </Button>
    </section>
  );
}

function MossPhoneAccountSettingsBody({
  onManageGoogle,
  onOpenLogin,
  onOpenProfile,
  onOpenUsage,
}: {
  readonly onManageGoogle: () => void;
  readonly onOpenLogin: () => void;
  readonly onOpenProfile: () => void;
  readonly onOpenUsage: () => void;
}) {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossAccountSessionQueryOptions());
  const logoutMutation = useMutation(serverMossLogoutMutationOptions({ queryClient }));
  const session = accountQuery.data?.session;

  if (accountQuery.isPending) {
    return <MossAuthLoading label={copy.accountSettings.loading} />;
  }
  if (accountQuery.isError) {
    return (
      <Alert variant="error">
        <AlertDescription>无法加载手机号账号，请重试。</AlertDescription>
      </Alert>
    );
  }
  if (!session) {
    return (
      <section className="flex flex-col items-start gap-3 rounded-card border border-dashed p-5 text-ui text-muted-foreground">
        <p>{copy.accountSettings.signedOutTitle}</p>
        <Button type="button" size="sm" onClick={onOpenLogin}>
          {copy.accountSettings.goToSignIn}
        </Button>
      </section>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-account-phone">
      <AccountIdentityBanner
        eyebrow="Moss 账号"
        title={session.user.displayName ?? session.user.phoneNumber}
        subtitle={`${session.user.phoneNumber} · 手机号已验证`}
        onOpenProfile={onOpenProfile}
      />

      <section className="rounded-card border border-border/70 p-4">
        <h2 className="text-ui-lg font-medium">国内账号服务</h2>
        <p className="mt-1 text-ui leading-6 text-muted-foreground">
          短信验证由提市科技的阿里云服务处理，账号与积分数据独立存储在 Moss 项目中。
        </p>
      </section>

      <MossAccessLanesPanel onNavigateToAuth={closeSettings} onManageGoogle={onManageGoogle} />

      <MossPayPanel />

      <section className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-card border border-border/70 p-4">
        <h2 className="min-w-0 text-ui-lg font-medium">
          {copy.accountSettings.usageAndCreditsTitle}
        </h2>
        <Button type="button" onClick={onOpenUsage} size="sm">
          {copy.accountSettings.openUsage}
        </Button>
      </section>

      <section className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-border/70 pt-5">
        <p aria-live="polite" className="text-ui-sm text-muted-foreground" role="status">
          {logoutMutation.isPending ? copy.accountSettings.signingOut : null}
        </p>
        <Button
          type="button"
          disabled={logoutMutation.isPending}
          onClick={() =>
            logoutMutation.mutate(undefined, {
              onSuccess: () => {
                closeSettings();
                void navigate({ to: "/login", replace: true });
              },
            })
          }
          variant="outline"
        >
          {copy.accountSettings.signOut}
        </Button>
      </section>
    </div>
  );
}

function MossCloudAccountSettingsBody({
  canReturnToPhone,
  onBackToPhone,
  onOpenLogin,
  onOpenProfile,
  onOpenUsage,
}: {
  readonly canReturnToPhone: boolean;
  readonly onBackToPhone?: () => void;
  readonly onOpenLogin: (addAccount?: boolean) => void;
  readonly onOpenProfile: () => void;
  readonly onOpenUsage: () => void;
}) {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const accountsQuery = useQuery(serverMossCloudAccountsQueryOptions());
  const selectMutation = useMutation(serverMossCloudSelectAccountMutationOptions({ queryClient }));
  const removeMutation = useMutation(serverMossCloudRemoveAccountMutationOptions({ queryClient }));
  const logoutMutation = useMutation(serverMossCloudLogoutMutationOptions({ queryClient }));

  const state = accountQuery.data;
  const account = state?.account;
  const accounts = accountsQuery.data?.accounts ?? [];
  const operationError = selectMutation.error ?? removeMutation.error ?? logoutMutation.error;

  if (accountQuery.isPending || accountsQuery.isPending) {
    return <MossAuthLoading label={copy.accountSettings.loading} />;
  }

  if (accountQuery.isError || accountsQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="error">
          <AlertTitle>{copy.accountSettings.loadFailedTitle}</AlertTitle>
        </Alert>
        <div>
          <Button
            type="button"
            onClick={() => {
              void accountQuery.refetch();
              void accountsQuery.refetch();
            }}
            variant="outline"
            size="sm"
          >
            {copy.accountSettings.retry}
          </Button>
        </div>
      </div>
    );
  }

  if (!state?.configured) {
    return (
      <div className="flex flex-col gap-4">
        {canReturnToPhone && onBackToPhone ? (
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={onBackToPhone}>
              <ArrowLeftIcon className="size-4" />
              {copy.accountSettings.backToPhoneAccount}
            </Button>
          </div>
        ) : null}
        <p className="text-ui text-muted-foreground" role="status">
          {copy.accountSettings.signInUnavailable}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-account-cloud">
      {canReturnToPhone && onBackToPhone ? (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={onBackToPhone}>
            <ArrowLeftIcon className="size-4" />
            {copy.accountSettings.backToPhoneAccount}
          </Button>
        </div>
      ) : null}

      {account ? (
        <AccountIdentityBanner
          eyebrow="Moss"
          title={account.displayName ?? account.email}
          subtitle={`${account.emailVerified ? copy.accountSettings.verified : copy.accountSettings.verificationNeeded} · ${
            state.modelGatewayConfigured
              ? mossAccessLaneSummary("global")
              : copy.accountSettings.signedIn
          }`}
          onOpenProfile={onOpenProfile}
        />
      ) : (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-border/70 p-4">
          <h2 className="min-w-0 text-ui-lg font-medium text-foreground">
            {copy.accountSettings.signedOutTitle}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onOpenProfile}>
              {copy.accountSettings.openProfile}
            </Button>
            <Button type="button" size="sm" onClick={() => onOpenLogin(false)}>
              {copy.accountSettings.goToSignIn}
            </Button>
          </div>
        </section>
      )}

      {operationError ? (
        <Alert variant="error">
          <AlertTitle>{copy.accountSettings.actionFailed}</AlertTitle>
          <AlertDescription>
            {mossCloudAuthErrorMessage(operationError, "account")}
          </AlertDescription>
        </Alert>
      ) : null}

      {account ? <MossAccessLanesPanel onNavigateToAuth={closeSettings} /> : null}

      <section aria-labelledby="saved-accounts-heading" className="min-w-0">
        <div className="flex items-center justify-between gap-4">
          <h2 id="saved-accounts-heading" className="text-ui-lg font-medium">
            {copy.accountSettings.googleAccountsTitle}
          </h2>
          <Link
            className={cn(buttonVariants({ size: "sm", variant: "outline" }), "shrink-0")}
            onClick={closeSettings}
            search={{ add: true }}
            to="/login"
          >
            {copy.accountSettings.addAccount}
          </Link>
        </div>

        {accounts.length === 0 ? (
          <p className="mt-3 rounded-card border border-dashed p-4 text-ui-sm text-muted-foreground">
            {copy.accountSettings.noSavedAccounts}
          </p>
        ) : (
          <ul
            className="mt-3 divide-y overflow-hidden rounded-card border border-border/70"
            aria-label={copy.accountSettings.googleAccountsTitle}
          >
            {accounts.map((saved) => {
              const busy =
                (selectMutation.isPending && selectMutation.variables?.accountId === saved.id) ||
                (removeMutation.isPending && removeMutation.variables?.accountId === saved.id);
              return (
                <li className="flex min-w-0 items-center gap-3 p-3" key={saved.id}>
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-ui font-medium"
                  >
                    {saved.email.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ui font-medium">
                      {saved.displayName ?? saved.email}
                    </p>
                    <p className="truncate text-ui-xs text-muted-foreground">
                      {saved.email} ·{" "}
                      {saved.selected
                        ? copy.accountSettings.current
                        : saved.sessionAvailable
                          ? copy.accountSettings.ready
                          : copy.accountSettings.signInAgain}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {saved.selected ? (
                      <Button
                        type="button"
                        aria-label={`Use ${saved.email}`}
                        disabled
                        size="sm"
                        variant="outline"
                      >
                        {copy.accountSettings.current}
                      </Button>
                    ) : saved.sessionAvailable ? (
                      <Button
                        type="button"
                        aria-label={`Use ${saved.email}`}
                        disabled={busy || selectMutation.isPending || removeMutation.isPending}
                        onClick={() => selectMutation.mutate({ accountId: saved.id })}
                        size="sm"
                        variant="outline"
                      >
                        {selectMutation.isPending &&
                        selectMutation.variables?.accountId === saved.id
                          ? copy.accountSettings.switching
                          : copy.accountSettings.use}
                      </Button>
                    ) : (
                      <Link
                        aria-label={`Use ${saved.email}`}
                        className={buttonVariants({ size: "sm", variant: "outline" })}
                        onClick={closeSettings}
                        search={{ add: true }}
                        to="/login"
                      >
                        {copy.signIn}
                      </Link>
                    )}
                    <Button
                      type="button"
                      aria-label={`Remove ${saved.email}`}
                      disabled={busy || selectMutation.isPending || removeMutation.isPending}
                      onClick={() => removeMutation.mutate({ accountId: saved.id })}
                      size="sm"
                      variant="ghost"
                    >
                      {removeMutation.isPending && removeMutation.variables?.accountId === saved.id
                        ? copy.accountSettings.removing
                        : copy.accountSettings.remove}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {account && state.session ? <MossPayPanel /> : null}
      {account && state.session ? (
        <section className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-card border border-border/70 p-4">
          <h2 className="min-w-0 text-ui-lg font-medium">
            {copy.accountSettings.usageAndCreditsTitle}
          </h2>
          <Button type="button" onClick={onOpenUsage} size="sm">
            {copy.accountSettings.openUsage}
          </Button>
        </section>
      ) : null}

      {account && state.session ? (
        <section className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-border/70 pt-5">
          <p aria-live="polite" className="text-ui-sm text-muted-foreground" role="status">
            {logoutMutation.isPending
              ? copy.accountSettings.signingOut
              : copy.accountSettings.sessionExpires(
                  formatSessionDate(state.session.expiresAt, locale),
                )}
          </p>
          <Button
            type="button"
            disabled={
              logoutMutation.isPending || selectMutation.isPending || removeMutation.isPending
            }
            onClick={() => logoutMutation.mutate()}
            variant="outline"
          >
            {copy.accountSettings.signOut}
          </Button>
        </section>
      ) : null}
    </div>
  );
}

function MossEnterpriseAccountSettingsBody({
  onManageGoogle,
  onOpenLogin,
  onOpenProfile,
}: {
  readonly onManageGoogle: () => void;
  readonly onOpenLogin: () => void;
  readonly onOpenProfile: () => void;
}) {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const stateQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());
  const signOut = useMutation(serverMossEnterpriseKeySignOutMutationOptions({ queryClient }));
  const state = stateQuery.data;
  const statusNotice = mossEnterpriseKeyStatusNotice(state?.modelGatewayStatus);

  if (stateQuery.isPending) {
    return <MossAuthLoading label={copy.accountSettings.loading} />;
  }
  if (!state?.authenticated) {
    return (
      <section className="flex flex-col items-start gap-3 rounded-card border border-dashed p-5 text-ui text-muted-foreground">
        <p>{copy.accountSettings.signedOutTitle}</p>
        <Button type="button" size="sm" onClick={onOpenLogin}>
          {copy.accountSettings.goToSignIn}
        </Button>
      </section>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-account-enterprise">
      <AccountIdentityBanner
        eyebrow="Moss 企业账号"
        title="企业 API Key"
        initials="企"
        subtitle={`${state.modelCount > 0 ? `${state.modelCount} 个可用模型 · ` : ""}${mossAccessLaneSummary("enterprise")}`}
        onOpenProfile={onOpenProfile}
      />

      {statusNotice ? (
        <Alert role="alert" variant="error">
          <AlertDescription>{statusNotice}</AlertDescription>
        </Alert>
      ) : null}

      <MossAccessLanesPanel onNavigateToAuth={closeSettings} onManageGoogle={onManageGoogle} />

      <section className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-border/70 pt-5">
        <p className="text-ui-sm text-muted-foreground" role="status">
          {signOut.isPending ? copy.accountSettings.signingOut : null}
        </p>
        <Button
          type="button"
          disabled={signOut.isPending}
          onClick={() =>
            signOut.mutate(undefined, {
              onSuccess: () => {
                closeSettings();
                void navigate({ to: "/login", replace: true });
              },
            })
          }
          variant="outline"
        >
          {copy.accountSettings.signOut}
        </Button>
      </section>
    </div>
  );
}
