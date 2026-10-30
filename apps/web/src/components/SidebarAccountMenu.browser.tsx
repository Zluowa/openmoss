import "../index.css";

import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossCloudAccountSummary,
} from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";

import {
  maskPhoneNumber,
  resolveSidebarAccountIdentity,
  SidebarAccountMenuView,
  type SidebarAccountIdentity,
  type SidebarAccountMenuLabels,
} from "./SidebarAccountMenu";
import { SidebarProvider } from "./ui/sidebar";

const LABELS: SidebarAccountMenuLabels = {
  openMenu: "打开账号菜单",
  remainingUsage: "剩余用量",
  upgrade: "升级以获享更高限额",
  settings: "设置",
  signIn: "登录",
  signOut: "退出登录",
  signingOut: "正在退出…",
  chooseAccount: "选择账号",
  loading: "正在检查账号…",
  unavailable: "账号暂不可用",
  help: "帮助与快捷键",
};

const AUTHENTICATED_IDENTITY: SidebarAccountIdentity = {
  kind: "authenticated",
  label: "qwer",
  initials: "QW",
  title: "qwer@example.com",
};

async function renderAccountMenu(
  identity: SidebarAccountIdentity = AUTHENTICATED_IDENTITY,
  helpControl?: ReactNode,
) {
  const callbacks = {
    onOpenAccount: vi.fn(),
    onOpenUsage: vi.fn(),
    onOpenUpgrade: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenHelp: vi.fn(),
    onSignOut: vi.fn(),
  };

  return {
    callbacks,
    screen: await render(
      <SidebarProvider open>
        <div className="w-64 px-2 py-[7px]">
          <SidebarAccountMenuView
            helpControl={helpControl}
            identity={identity}
            labels={LABELS}
            settingsShortcutLabel="⌘,"
            {...callbacks}
          />
        </div>
      </SidebarProvider>,
    ),
  };
}

async function openAccountMenu() {
  await page.getByRole("button", { name: /打开账号菜单/ }).click();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("SidebarAccountMenu", () => {
  it("matches the Codex account menu structure without a Mini entry", async () => {
    const { screen } = await renderAccountMenu();

    try {
      const trigger = page.getByRole("button", { name: /打开账号菜单.*qwer/ });
      await expect.element(trigger).toHaveAttribute("aria-haspopup", "menu");
      expect(trigger.element().getBoundingClientRect().height).toBe(30);
      await expect.element(page.getByRole("button", { name: "帮助与快捷键" })).toBeVisible();

      await openAccountMenu();

      await expect.element(page.getByRole("menuitem", { name: "qwer" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "剩余用量" })).toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: "升级以获享更高限额" }))
        .toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: /设置.*⌘,/ })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "退出登录" })).toBeVisible();
      expect(document.body.textContent).not.toMatch(/显示宠物|Show pet|显示 ?Mini|Show Mini/i);
    } finally {
      await screen.unmount();
    }
  });

  it("shows the plan tier under the account name in the menu header", async () => {
    const callbacks = {
      onOpenAccount: vi.fn(),
      onOpenUsage: vi.fn(),
      onOpenUpgrade: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenHelp: vi.fn(),
      onSignOut: vi.fn(),
    };
    const screen = await render(
      <SidebarProvider open>
        <div className="w-64 px-2 py-[7px]">
          <SidebarAccountMenuView
            identity={AUTHENTICATED_IDENTITY}
            labels={LABELS}
            planName="Free"
            settingsShortcutLabel="⌘,"
            {...callbacks}
          />
        </div>
      </SidebarProvider>,
    );

    try {
      await openAccountMenu();
      const header = page.getByRole("menuitem", { name: /qwer.*Free/ });
      await expect.element(header).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("connects account, usage, settings, help, and sign-out actions", async () => {
    const { callbacks, screen } = await renderAccountMenu();

    try {
      await openAccountMenu();
      await page.getByRole("menuitem", { name: "qwer" }).click();
      expect(callbacks.onOpenAccount).toHaveBeenCalledOnce();

      await openAccountMenu();
      await page.getByRole("menuitem", { name: "剩余用量" }).click();
      expect(callbacks.onOpenUsage).toHaveBeenCalledOnce();

      await openAccountMenu();
      await page.getByRole("menuitem", { name: "升级以获享更高限额" }).click();
      expect(callbacks.onOpenUpgrade).toHaveBeenCalledOnce();

      await openAccountMenu();
      await page.getByRole("menuitem", { name: /设置/ }).click();
      expect(callbacks.onOpenSettings).toHaveBeenCalledOnce();

      await openAccountMenu();
      await page.getByRole("menuitem", { name: "退出登录" }).click();
      expect(callbacks.onSignOut).toHaveBeenCalledOnce();

      await page.getByRole("button", { name: "帮助与快捷键" }).click();
      expect(callbacks.onOpenHelp).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("renders the shared help menu in the account row without a second trigger", async () => {
    const { screen } = await renderAccountMenu(
      AUTHENTICATED_IDENTITY,
      <button aria-label="Moss help">?</button>,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Moss help" })).toBeVisible();
      expect(page.getByRole("button", { name: "帮助与快捷键" }).length).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("shows sign-in instead of sign-out for a new user", async () => {
    const { callbacks, screen } = await renderAccountMenu({
      kind: "anonymous",
      label: "Moss",
      initials: "M",
    });

    try {
      await openAccountMenu();
      await expect.element(page.getByRole("menuitem", { name: "登录" })).toBeVisible();
      expect(page.getByRole("menuitem", { name: "退出登录" }).length).toBe(0);
      await page.getByRole("menuitem", { name: "登录" }).click();
      expect(callbacks.onOpenAccount).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("masks a phone in the footer while keeping the full number in the account menu", async () => {
    const { screen } = await renderAccountMenu({
      kind: "authenticated",
      label: "+86 138****0000",
      initials: "13",
      title: "+86 138****0000",
      menuLabel: "+8613800000000",
      menuTitle: "+8613800000000",
    });

    try {
      const trigger = page.getByRole("button", { name: /打开账号菜单.*\+86 138\*\*\*\*0000/ });
      await expect.element(trigger).toBeVisible();
      await expect.element(trigger).toHaveAttribute("title", "+86 138****0000");
      await openAccountMenu();
      await expect.element(page.getByRole("menuitem", { name: "+8613800000000" })).toBeVisible();
      expect(
        document.querySelector('[role="menuitem"] span[title="+8613800000000"]'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("supports keyboard opening and restores focus after Escape", async () => {
    const { screen } = await renderAccountMenu();

    try {
      const currentTrigger = () =>
        document.querySelector<HTMLElement>('[data-testid="sidebar-account-menu-trigger"]');

      await page.getByRole("button", { name: /打开账号菜单.*qwer/ }).click();
      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
      });
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(currentTrigger());
      });

      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
      });

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(currentTrigger());
      });
    } finally {
      await screen.unmount();
    }
  });
});

describe("maskPhoneNumber", () => {
  it("keeps a mainland China phone recognizable without exposing the middle digits", () => {
    expect(maskPhoneNumber("+8613800000000")).toBe("+86 138****0000");
    expect(maskPhoneNumber("138 0000 0000")).toBe("138****0000");
  });

  it("preserves an international prefix and handles empty values", () => {
    expect(maskPhoneNumber("+14155552671")).toBe("+141****2671");
    expect(maskPhoneNumber("  ")).toBe("");
  });
});

describe("resolveSidebarAccountIdentity", () => {
  it("uses an authenticated phone session before the legacy email account state", () => {
    const phoneState = {
      configured: true,
      authenticated: true,
      session: {
        id: "moss_phone_session_1",
        user: {
          id: "phone-user-1",
          phoneNumber: "+8613800000000",
          displayName: null,
          role: "member",
          status: "active",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
          lastLoginAt: "2026-07-15T00:00:00.000Z",
        },
        createdAt: "2026-07-15T00:00:00.000Z",
        expiresAt: "2026-08-14T00:00:00.000Z",
        lastSeenAt: "2026-07-15T00:00:00.000Z",
      },
      smsProvider: "aliyun",
      aliyunSmsConfigured: true,
    } as MossAccountSessionState;

    expect(
      resolveSidebarAccountIdentity({
        phoneState,
        state: {
          authenticated: true,
          account: { displayName: "Legacy Email", email: "legacy@example.com" },
        } as MossCloudAccountState,
        accounts: [],
        pending: false,
        unavailable: false,
      }),
    ).toEqual({
      kind: "authenticated",
      label: "+86 138****0000",
      initials: "13",
      title: "+86 138****0000",
      menuLabel: "+8613800000000",
      menuTitle: "+8613800000000",
    });
  });

  it("uses the display name, email title, and two-letter avatar", () => {
    const state = {
      configured: true,
      authenticated: true,
      account: {
        id: "account-1",
        email: "qwer@example.com",
        emailVerified: true,
        displayName: "qwer",
        status: "active",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
        lastLoginAt: "2026-07-12T00:00:00.000Z",
      },
      session: null,
      emailVerificationRequired: false,
      modelGatewayConfigured: true,
      authProvider: "supabase_google",
    } as unknown as MossCloudAccountState;

    expect(
      resolveSidebarAccountIdentity({
        state,
        accounts: [],
        pending: false,
        unavailable: false,
      }),
    ).toEqual({
      kind: "authenticated",
      label: "qwer",
      initials: "QW",
      title: "qwer@example.com",
    });
  });

  it("keeps a saved account selectable without pretending it is signed in", () => {
    const savedAccount = {
      id: "account-1",
      email: "amara@example.com",
      emailVerified: true,
      displayName: null,
      status: "active",
      lastUsedAt: null,
      selected: true,
      sessionAvailable: false,
    } as unknown as MossCloudAccountSummary;

    expect(
      resolveSidebarAccountIdentity({
        state: undefined,
        accounts: [savedAccount],
        pending: false,
        unavailable: false,
      }),
    ).toEqual({
      kind: "saved",
      label: "amara@example.com",
      initials: "AM",
      title: "amara@example.com",
    });
  });

  it("keeps sign-in reachable when the cloud account backend is not configured", () => {
    expect(
      resolveSidebarAccountIdentity({
        state: {
          configured: false,
          authenticated: false,
          account: null,
          session: null,
          emailVerificationRequired: false,
          modelGatewayConfigured: false,
          authProvider: "supabase_google",
          lastAuthFlow: null,
        } as MossCloudAccountState,
        accounts: [],
        pending: false,
        unavailable: false,
      }),
    ).toEqual({ kind: "anonymous", label: "Moss", initials: "M" });
  });
});
