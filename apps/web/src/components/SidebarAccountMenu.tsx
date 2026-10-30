// FILE: SidebarAccountMenu.tsx
// Purpose: Codex-style account controls in the bottom-left sidebar footer.
// Layer: Web UI
// Exports: SidebarAccountMenu, its testable view, and identity derivation helpers.

import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossCloudAccountSummary,
  MossEnterpriseKeyState,
} from "@synara/contracts";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
  serverMossCloudLogoutMutationOptions,
  serverMossEnterpriseKeySignOutMutationOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossLogoutMutationOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ChevronRightIcon, CircleQuestionIcon, SettingsIcon, SparklesIcon } from "~/lib/icons";
import { GaugeIcon, LogInIcon, LogOutIcon } from "./auth/mossIcons";
import { resolveMossPayQuotaAccountIdentity } from "~/lib/mossPayQuotaIdentity";

import { isMacPlatform } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuShortcut, MenuTrigger } from "./ui/menu";
import { SidebarMenuButton } from "./ui/sidebar";
import { toastManager } from "./ui/toast";

export type SidebarAccountIdentityKind =
  | "authenticated"
  | "saved"
  | "anonymous"
  | "loading"
  | "unavailable";

export interface SidebarAccountIdentity {
  readonly kind: SidebarAccountIdentityKind;
  readonly label: string;
  readonly initials: string;
  readonly title?: string;
  /** Optional unmasked label shown only inside the account menu. */
  readonly menuLabel?: string;
  /** Optional unmasked tooltip shown only inside the account menu. */
  readonly menuTitle?: string;
}

interface AccountIdentitySource {
  readonly displayName: string | null;
  readonly email: string;
}

function accountLabel(account: AccountIdentitySource): string {
  const displayName = account.displayName?.trim();
  return displayName || account.email;
}

function accountInitials(account: AccountIdentitySource): string {
  const displayName = account.displayName?.trim();
  const localPart = account.email.split("@", 1)[0]?.trim();
  const source = displayName || localPart || account.email;
  const words = source.split(/\s+/u).filter(Boolean);

  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toLocaleUpperCase();
  }

  return Array.from(source.replace(/\s+/gu, "")).slice(0, 2).join("").toLocaleUpperCase();
}

function phoneAccountInitials(user: {
  readonly displayName: string | null;
  readonly phoneNumber: string;
}): string {
  const source = user.displayName?.trim() || user.phoneNumber.replace(/^\+86/u, "") || "Moss";
  return Array.from(source.replace(/\s+/gu, "")).slice(0, 2).join("").toLocaleUpperCase();
}

/**
 * Keeps the account footer useful without exposing a phone number in the persistent sidebar.
 * Mainland China numbers retain their country prefix and the conventional first-three/last-four
 * display; other formats use the same first-three/last-four rule without guessing a country code.
 */
export function maskPhoneNumber(phoneNumber: string): string {
  const normalized = phoneNumber.trim().replace(/[^\d+]/gu, "");
  if (!normalized) return normalized;

  const hasMainlandChinaPrefix = normalized.startsWith("+86");
  const digits = normalized.replace(/\D/gu, "");
  const nationalDigits = hasMainlandChinaPrefix ? digits.slice(2) : digits;
  if (!nationalDigits) return normalized;

  const visiblePrefixLength = Math.min(3, Math.max(1, nationalDigits.length - 2));
  const visibleSuffixLength = Math.min(4, Math.max(1, nationalDigits.length - visiblePrefixLength));
  const prefix = nationalDigits.slice(0, visiblePrefixLength);
  const suffix = nationalDigits.slice(-visibleSuffixLength);
  const masked = `${prefix}****${suffix}`;

  if (hasMainlandChinaPrefix) return `+86 ${masked}`;
  return normalized.startsWith("+") ? `+${masked}` : masked;
}

export function resolveSidebarAccountIdentity(input: {
  readonly phoneState?: MossAccountSessionState | null | undefined;
  readonly enterpriseState?: MossEnterpriseKeyState | null | undefined;
  readonly state: MossCloudAccountState | null | undefined;
  readonly accounts: readonly MossCloudAccountSummary[] | null | undefined;
  readonly pending: boolean;
  readonly unavailable: boolean;
}): SidebarAccountIdentity {
  const phoneSession =
    input.phoneState?.authenticated && input.phoneState.session ? input.phoneState.session : null;
  const authenticatedAccount =
    input.state?.authenticated && input.state.account ? input.state.account : null;
  const savedAccount =
    input.accounts?.find((account) => account.selected) ?? input.accounts?.[0] ?? null;
  const account = authenticatedAccount ?? savedAccount;

  if (phoneSession) {
    const phoneNumber = phoneSession.user.phoneNumber;
    const maskedPhoneNumber = maskPhoneNumber(phoneNumber);
    return {
      kind: "authenticated",
      label: phoneSession.user.displayName?.trim() || maskedPhoneNumber,
      initials: phoneAccountInitials(phoneSession.user),
      title: phoneSession.user.displayName?.trim() || maskedPhoneNumber,
      menuLabel: phoneNumber,
      menuTitle: phoneNumber,
    };
  }

  if (authenticatedAccount) {
    return {
      kind: "authenticated",
      label: accountLabel(authenticatedAccount),
      initials: accountInitials(authenticatedAccount),
      title: authenticatedAccount.email,
    };
  }

  if (input.enterpriseState?.authenticated) {
    const keyLabel = `${input.enterpriseState.keyPrefix ?? "moss_sk_"}…`;
    return {
      kind: "authenticated",
      label: "企业 API Key",
      initials: "企",
      title: keyLabel,
      menuLabel: keyLabel,
      menuTitle: keyLabel,
    };
  }

  if (input.pending) {
    return { kind: "loading", label: "Moss", initials: "M" };
  }

  if (input.unavailable) {
    return { kind: "unavailable", label: "Moss", initials: "M" };
  }

  if (account) {
    return {
      kind: "saved",
      label: accountLabel(account),
      initials: accountInitials(account),
      title: account.email,
    };
  }

  return { kind: "anonymous", label: "Moss", initials: "M" };
}

export interface SidebarAccountMenuLabels {
  readonly openMenu: string;
  readonly remainingUsage: string;
  readonly upgrade: string;
  readonly settings: string;
  readonly signIn: string;
  readonly signOut: string;
  readonly signingOut: string;
  readonly chooseAccount: string;
  readonly loading: string;
  readonly unavailable: string;
  readonly help: string;
}

export interface SidebarAccountMenuViewProps {
  readonly identity: SidebarAccountIdentity;
  readonly labels: SidebarAccountMenuLabels;
  readonly settingsShortcutLabel: string;
  readonly signingOut?: boolean;
  /** Plan tier shown under the account name in the menu header (Codex "Free" slot). */
  readonly planName?: string | null;
  /** Optional full help menu control rendered at the trailing edge of the account row. */
  readonly helpControl?: ReactNode;
  readonly onOpenAccount: () => void;
  readonly onOpenUsage: () => void;
  readonly onOpenUpgrade: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenHelp: () => void;
  readonly onSignOut: () => void;
}

function AccountAvatar({ identity }: { readonly identity: SidebarAccountIdentity }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-text-accent)_16%,transparent)] text-ui-timestamp font-medium leading-none text-[var(--color-text-accent)]"
    >
      {identity.initials}
    </span>
  );
}

const ACCOUNT_MENU_ITEM_CLASS_NAME = "min-h-8 gap-2 rounded-lg px-2 py-1 text-ui";

interface SidebarAccountMenuPopupSectionsProps {
  readonly identity: SidebarAccountIdentity;
  readonly labels: SidebarAccountMenuLabels;
  readonly planName?: string | null;
  readonly settingsShortcutLabel: string;
  readonly signingOut: boolean;
  readonly onOpenAccount: () => void;
  readonly onOpenUsage: () => void;
  readonly onOpenUpgrade: () => void;
  readonly onOpenSettings: () => void;
  readonly onSignOut: () => void;
}

/** Codex account menu body: plan header, then 剩余用量 / 升级 / 设置 / 退出登录 (no Mini). */
function SidebarAccountMenuPopupSections({
  identity,
  labels,
  planName = null,
  settingsShortcutLabel,
  signingOut,
  onOpenAccount,
  onOpenUsage,
  onOpenUpgrade,
  onOpenSettings,
  onSignOut,
}: SidebarAccountMenuPopupSectionsProps) {
  const accountRowDisabled =
    identity.kind === "loading" || identity.kind === "unavailable" || identity.kind === "anonymous";
  const accountRowLabel =
    identity.kind === "loading"
      ? labels.loading
      : identity.kind === "unavailable"
        ? labels.unavailable
        : identity.label;
  const accountMenuLabel = identity.menuLabel ?? accountRowLabel;

  return (
    <div className="p-1">
      <MenuGroup>
        <MenuItem
          className={ACCOUNT_MENU_ITEM_CLASS_NAME}
          disabled={accountRowDisabled}
          onClick={onOpenAccount}
        >
          <AccountAvatar identity={identity} />
          <span
            className="flex min-w-0 flex-1 flex-col"
            title={identity.menuTitle ?? identity.title}
          >
            <span className="min-w-0 truncate">{accountMenuLabel}</span>
            {planName ? (
              <span className="min-w-0 truncate text-ui-xs text-muted-foreground">{planName}</span>
            ) : null}
          </span>
        </MenuItem>
      </MenuGroup>

      <MenuSeparator className="mx-2 my-1" />

      <MenuGroup>
        <MenuItem className={ACCOUNT_MENU_ITEM_CLASS_NAME} onClick={onOpenUsage}>
          <GaugeIcon aria-hidden="true" className="size-4" />
          <span className="min-w-0 flex-1 truncate">{labels.remainingUsage}</span>
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground/70"
          />
        </MenuItem>
        <MenuItem className={ACCOUNT_MENU_ITEM_CLASS_NAME} onClick={onOpenUpgrade}>
          <SparklesIcon aria-hidden="true" className="size-4" />
          <span className="min-w-0 flex-1 truncate">{labels.upgrade}</span>
        </MenuItem>
        <MenuItem className={ACCOUNT_MENU_ITEM_CLASS_NAME} onClick={onOpenSettings}>
          <SettingsIcon aria-hidden="true" className="size-4" />
          <span className="min-w-0 flex-1 truncate">{labels.settings}</span>
          <MenuShortcut>{settingsShortcutLabel}</MenuShortcut>
        </MenuItem>
        {identity.kind === "authenticated" ? (
          <MenuItem
            className={ACCOUNT_MENU_ITEM_CLASS_NAME}
            disabled={signingOut}
            onClick={onSignOut}
          >
            <LogOutIcon aria-hidden="true" className="size-4" />
            <span>{signingOut ? labels.signingOut : labels.signOut}</span>
          </MenuItem>
        ) : identity.kind === "saved" || identity.kind === "anonymous" ? (
          <MenuItem className={ACCOUNT_MENU_ITEM_CLASS_NAME} onClick={onOpenAccount}>
            <LogInIcon aria-hidden="true" className="size-4" />
            <span>{identity.kind === "saved" ? labels.chooseAccount : labels.signIn}</span>
          </MenuItem>
        ) : null}
      </MenuGroup>
    </div>
  );
}

export function SidebarAccountMenuView({
  identity,
  labels,
  settingsShortcutLabel,
  signingOut = false,
  planName = null,
  helpControl,
  onOpenAccount,
  onOpenUsage,
  onOpenUpgrade,
  onOpenSettings,
  onOpenHelp,
  onSignOut,
}: SidebarAccountMenuViewProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex h-8 min-w-0 items-center gap-2" data-testid="sidebar-account-footer">
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          render={
            <SidebarMenuButton
              aria-label={`${labels.openMenu}: ${identity.label}`}
              className="h-[30px] min-w-0 flex-1 gap-2 rounded-control px-1.5 text-ui-lg font-normal"
              data-testid="sidebar-account-menu-trigger"
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
                  event.preventDefault();
                  setMenuOpen(true);
                }
              }}
              title={identity.title}
            />
          }
        >
          <AccountAvatar identity={identity} />
          <span className="min-w-0 flex-1 truncate">{identity.label}</span>
        </MenuTrigger>

        <ComposerPickerMenuPopup
          align="start"
          className="w-[calc(var(--anchor-width)+5rem)] min-w-56 max-w-[calc(100vw-1rem)] rounded-xl border-[0.5px] border-border bg-[color-mix(in_srgb,var(--color-background-elevated-primary-opaque)_94%,transparent)] shadow-lg backdrop-blur-xl before:hidden"
          side="top"
          sideOffset={6}
        >
          <SidebarAccountMenuPopupSections
            identity={identity}
            labels={labels}
            planName={planName}
            settingsShortcutLabel={settingsShortcutLabel}
            signingOut={signingOut}
            onOpenAccount={onOpenAccount}
            onOpenUsage={onOpenUsage}
            onOpenUpgrade={onOpenUpgrade}
            onOpenSettings={onOpenSettings}
            onSignOut={onSignOut}
          />
        </ComposerPickerMenuPopup>
      </Menu>

      {helpControl !== undefined ? (
        helpControl
      ) : (
        <button
          aria-label={labels.help}
          className="flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground outline-none transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60"
          data-testid="sidebar-help-trigger"
          onClick={onOpenHelp}
          title={labels.help}
          type="button"
        >
          <CircleQuestionIcon aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  );
}

interface SidebarAccountMenuModel {
  readonly identity: SidebarAccountIdentity;
  readonly planName: string | null;
  readonly labels: SidebarAccountMenuLabels;
  readonly settingsShortcutLabel: string;
  readonly signingOut: boolean;
  readonly onOpenAccount: () => void;
  readonly onOpenUsage: () => void;
  readonly onOpenUpgrade: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenHelp: () => void;
  readonly onSignOut: () => void;
}

function useSidebarAccountMenuModel(): SidebarAccountMenuModel {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const phoneQuery = useQuery(serverMossAccountSessionQueryOptions());
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const accountsQuery = useQuery(serverMossCloudAccountsQueryOptions());
  const phoneLogoutMutation = useMutation(serverMossLogoutMutationOptions({ queryClient }));
  const cloudLogoutMutation = useMutation(serverMossCloudLogoutMutationOptions({ queryClient }));
  const enterpriseQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());
  const enterpriseSignOutMutation = useMutation(
    serverMossEnterpriseKeySignOutMutationOptions({ queryClient }),
  );
  const macPlatform = typeof navigator !== "undefined" && isMacPlatform(navigator.platform ?? "");
  const settingsShortcutLabel = macPlatform ? "⌘," : "Ctrl+,";
  const identity = resolveSidebarAccountIdentity({
    phoneState: phoneQuery.data,
    enterpriseState: enterpriseQuery.data,
    state: accountQuery.data,
    accounts: accountsQuery.data?.accounts,
    pending:
      phoneQuery.isPending ||
      (!accountQuery.data &&
        (accountQuery.isPending || (!accountsQuery.data && accountsQuery.isPending))),
    unavailable: phoneQuery.isError && accountQuery.isError && accountsQuery.isError,
  });
  const phoneAuthenticated = Boolean(phoneQuery.data?.authenticated && phoneQuery.data.session);

  // Codex header slot: avatar + name + current plan tier. Quota carries planCode,
  // the catalog resolves it to a display name; hide the subtitle when unknown.
  const payAccountIdentity = resolveMossPayQuotaAccountIdentity(phoneQuery.data, accountQuery.data);
  const payQuotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({
      enabled: identity.kind === "authenticated" && payAccountIdentity !== null,
      accountIdentity: payAccountIdentity,
    }),
  );
  const payCatalogQuery = useQuery(
    serverMossPayCatalogQueryOptions({ enabled: identity.kind === "authenticated" }),
  );
  const payPlanCode = payQuotaQuery.data?.planCode?.trim() ?? "";
  const planName = payPlanCode
    ? (payCatalogQuery.data?.plans.find((plan) => plan.code === payPlanCode)?.displayName.trim() ??
      payPlanCode)
    : null;

  const openSettings = useCallback(() => void navigate({ to: "/settings" }), [navigate]);

  useEffect(() => {
    const handleSettingsShortcut = (event: KeyboardEvent) => {
      const modifierPressed = macPlatform ? event.metaKey : event.ctrlKey;
      if (
        !modifierPressed ||
        event.altKey ||
        event.shiftKey ||
        event.key !== "," ||
        event.defaultPrevented
      ) {
        return;
      }

      event.preventDefault();
      openSettings();
    };

    window.addEventListener("keydown", handleSettingsShortcut);
    return () => window.removeEventListener("keydown", handleSettingsShortcut);
  }, [macPlatform, openSettings]);

  const handleSignOut = async () => {
    try {
      if (phoneAuthenticated) {
        await phoneLogoutMutation.mutateAsync();
      } else if (accountQuery.data?.authenticated || !enterpriseQuery.data?.authenticated) {
        await cloudLogoutMutation.mutateAsync();
      } else {
        await enterpriseSignOutMutation.mutateAsync();
      }
      await navigate({ to: "/login" });
    } catch {
      toastManager.add({ type: "error", title: t("sidebar.accountMenu.signOutFailed") });
    }
  };

  return {
    identity,
    planName,
    labels: {
      openMenu: t("sidebar.accountMenu.open"),
      remainingUsage: t("sidebar.accountMenu.remainingUsage"),
      upgrade: t("sidebar.accountMenu.upgrade"),
      settings: t("sidebar.settings"),
      signIn: t("sidebar.accountMenu.signIn"),
      signOut: t("sidebar.accountMenu.signOut"),
      signingOut: t("sidebar.accountMenu.signingOut"),
      chooseAccount: t("sidebar.accountMenu.chooseAccount"),
      loading: t("sidebar.accountMenu.loading"),
      unavailable: t("sidebar.accountMenu.unavailable"),
      help: t("sidebar.accountMenu.help"),
    },
    settingsShortcutLabel,
    signingOut:
      phoneLogoutMutation.isPending ||
      cloudLogoutMutation.isPending ||
      enterpriseSignOutMutation.isPending,
    onOpenAccount: () =>
      void navigate({ to: identity.kind === "anonymous" ? "/login" : "/account" }),
    onOpenHelp: () => void navigate({ to: "/settings", search: { section: "shortcuts" } }),
    onOpenSettings: openSettings,
    onOpenUsage: () => void navigate({ to: "/settings", search: { section: "usage" } }),
    onOpenUpgrade: () => void navigate({ to: "/membership", search: { focus: "plans" } }),
    onSignOut: () => void handleSignOut(),
  };
}

export function SidebarAccountMenu(props?: { readonly helpControl?: ReactNode }) {
  const model = useSidebarAccountMenuModel();
  return <SidebarAccountMenuView {...model} helpControl={props?.helpControl} />;
}

/**
 * Codex rail account entry: the bottom rail avatar opens the account menu next to
 * the rail instead of navigating away. Content is shared with the footer view.
 */
export function RailAccountMenu() {
  const model = useSidebarAccountMenuModel();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Menu open={menuOpen} onOpenChange={setMenuOpen}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`${model.labels.openMenu}: ${model.identity.label}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-sidebar-rail-item="profile"
            data-testid="rail-account-menu-trigger"
            title={model.identity.title}
            className="group/rail-item flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-control text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
          />
        }
      >
        <span
          aria-hidden="true"
          className="flex size-[22px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-text-accent)_16%,transparent)] text-ui-2xs font-medium leading-none text-[var(--color-text-accent)]"
        >
          {model.identity.initials}
        </span>
      </MenuTrigger>
      <ComposerPickerMenuPopup
        align="end"
        className="min-w-56 max-w-[calc(100vw-1rem)] rounded-xl border-[0.5px] border-border bg-[color-mix(in_srgb,var(--color-background-elevated-primary-opaque)_94%,transparent)] shadow-lg backdrop-blur-xl before:hidden"
        side="right"
        sideOffset={8}
      >
        <SidebarAccountMenuPopupSections
          identity={model.identity}
          labels={model.labels}
          planName={model.planName}
          settingsShortcutLabel={model.settingsShortcutLabel}
          signingOut={model.signingOut}
          onOpenAccount={model.onOpenAccount}
          onOpenUsage={model.onOpenUsage}
          onOpenUpgrade={model.onOpenUpgrade}
          onOpenSettings={model.onOpenSettings}
          onSignOut={model.onSignOut}
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
