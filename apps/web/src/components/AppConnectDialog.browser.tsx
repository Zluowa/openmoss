// FILE: AppConnectDialog.browser.tsx
// Purpose: Browser-level app connector/TOS and OAuth launch contract.

import "../index.css";

import type {
  ProviderAppConnectorDetail,
  ProviderAppConnectorTerms,
  ProviderStartAppConnectionInput,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const localizationTestState = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
}));

vi.mock("../localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

import { AppConnectDialog } from "./AppConnectDialog";

describe("AppConnectDialog", () => {
  beforeEach(() => {
    localizationTestState.locale = "en";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reads connector and TOS before starting OAuth with the desktop callback", async () => {
    const connector: ProviderAppConnectorDetail = {
      id: "gmail",
      name: "Gmail",
      status: null,
      authMode: "OAUTH",
      requiresLinkParameters: false,
    };
    const terms: ProviderAppConnectorTerms = {
      blurbs: [{ title: "Permissions", description: "Only what you approve." }],
      personalizationDefault: null,
      personalizationToggleBlurb: null,
    };
    let resolveConnector: ((value: ProviderAppConnectorDetail) => void) | undefined;
    let resolveTerms: ((value: ProviderAppConnectorTerms) => void) | undefined;
    const readConnector = vi.fn(
      () =>
        new Promise<ProviderAppConnectorDetail>((resolve) => {
          resolveConnector = resolve;
        }),
    );
    const readTerms = vi.fn(
      () =>
        new Promise<ProviderAppConnectorTerms>((resolve) => {
          resolveTerms = resolve;
        }),
    );
    const startConnection = vi.fn(
      async (_input: Omit<ProviderStartAppConnectionInput, "provider" | "appId">) => ({
        kind: "oauthStarted" as const,
        redirectUrl: "https://auth.example/start",
      }),
    );
    const onOpenAppUrl = vi.fn(async () => true);
    const screen = await render(
      <AppConnectDialog
        app={{
          id: "gmail",
          name: "Gmail",
          description: "Read and send mail",
          installUrl: "https://chatgpt.com/gpts/editor",
          isAccessible: false,
          logoUrl: null,
          logoUrlDark: null,
        }}
        open
        onOpenChange={vi.fn()}
        readConnector={readConnector}
        readTerms={readTerms}
        startConnection={startConnection}
        onOpenAppUrl={onOpenAppUrl}
        onConnected={vi.fn(async () => undefined)}
      />,
    );
    try {
      await expect.element(page.getByText("Loading connection details...")).toBeInTheDocument();
      resolveConnector?.(connector);
      resolveTerms?.(terms);
      await expect.element(page.getByText("Only what you approve.")).toBeInTheDocument();
      await page.getByRole("button", { name: "Continue to Gmail" }).click();
      expect(startConnection).toHaveBeenCalledWith({
        callbackUrl: "moss-connectors://connector/oauth_callback",
        postAuthUrl:
          "https://chatgpt.com/gpts/editor#settings/Connectors?connector=gmail&product-sku=CODEX&referrer=codex",
        reauthentication: null,
      });
      expect(onOpenAppUrl).toHaveBeenCalledWith("https://auth.example/start");
    } finally {
      await screen.unmount();
    }
  });

  it("connects NONE apps directly and refreshes authoritative app state", async () => {
    const onConnected = vi.fn(async () => undefined);
    const onOpenAppUrl = vi.fn(async () => true);
    const startConnection = vi.fn(async () => ({ kind: "connectedDirectly" as const }));
    const screen = await render(
      <AppConnectDialog
        app={{
          id: "calculator",
          name: "Calculator",
          description: null,
          installUrl: "https://chatgpt.com/gpts/editor",
          isAccessible: false,
          logoUrl: null,
          logoUrlDark: null,
        }}
        open
        onOpenChange={vi.fn()}
        readConnector={async () => ({
          id: "calculator",
          name: "Calculator",
          status: null,
          authMode: "NONE",
          requiresLinkParameters: false,
        })}
        readTerms={async () => ({
          blurbs: [],
          personalizationDefault: null,
          personalizationToggleBlurb: null,
        })}
        startConnection={startConnection}
        onOpenAppUrl={onOpenAppUrl}
        onConnected={onConnected}
      />,
    );
    try {
      await expect.element(page.getByText("Approved by your admin")).toBeInTheDocument();
      await page.getByRole("button", { name: "Connect Calculator" }).click();
      await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
      expect(onOpenAppUrl).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("single-flights connector activation before React can disable the button", async () => {
    let resolveStart: ((value: { readonly kind: "connectedDirectly" }) => void) | undefined;
    const startConnection = vi.fn(
      () =>
        new Promise<{ readonly kind: "connectedDirectly" }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const screen = await render(
      <AppConnectDialog
        app={{
          id: "calculator",
          name: "Calculator",
          description: null,
          installUrl: "https://chatgpt.com/gpts/editor",
          isAccessible: false,
          logoUrl: null,
          logoUrlDark: null,
        }}
        open
        onOpenChange={vi.fn()}
        readConnector={async () => ({
          id: "calculator",
          name: "Calculator",
          status: null,
          authMode: "NONE",
          requiresLinkParameters: false,
        })}
        readTerms={async () => ({
          blurbs: [],
          personalizationDefault: null,
          personalizationToggleBlurb: null,
        })}
        startConnection={startConnection}
        onOpenAppUrl={vi.fn(async () => true)}
        onConnected={vi.fn(async () => undefined)}
      />,
    );
    try {
      await expect.element(page.getByText("Approved by your admin")).toBeInTheDocument();
      const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
        candidate.textContent?.includes("Connect Calculator"),
      );
      expect(button).toBeDefined();
      button?.click();
      button?.click();
      expect(startConnection).toHaveBeenCalledTimes(1);
      resolveStart?.({ kind: "connectedDirectly" });
    } finally {
      await screen.unmount();
    }
  });

  it("uses the ChatGPT browser fallback for link parameters and disables admin-blocked apps", async () => {
    const onOpenAppUrl = vi.fn(async () => true);
    const startConnection = vi.fn(async () => ({
      kind: "oauthStarted" as const,
      redirectUrl: "https://auth.example/start",
    }));
    const target = {
      id: "notion",
      name: "Notion",
      description: null,
      installUrl: "https://chatgpt.com/gpts/editor",
      isAccessible: false,
      logoUrl: null,
      logoUrlDark: null,
    } as const;
    const browserFallback = await render(
      <AppConnectDialog
        app={target}
        open
        onOpenChange={vi.fn()}
        readConnector={async () => ({
          id: "notion",
          name: "Notion",
          status: null,
          authMode: "OAUTH",
          requiresLinkParameters: true,
        })}
        readTerms={async () => ({
          blurbs: [],
          personalizationDefault: null,
          personalizationToggleBlurb: null,
        })}
        startConnection={startConnection}
        onOpenAppUrl={onOpenAppUrl}
        onConnected={vi.fn(async () => undefined)}
      />,
    );
    try {
      await expect
        .element(
          page.getByText("This app needs extra setup fields, so connection continues in browser."),
        )
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Open in browser" }).click();
      expect(onOpenAppUrl).toHaveBeenCalledWith(
        "https://chatgpt.com/gpts/editor#settings/Connectors?connector=notion&add-connector-link=true&product-sku=CODEX&referrer=codex",
      );
      expect(startConnection).not.toHaveBeenCalled();
    } finally {
      await browserFallback.unmount();
    }

    const adminBlocked = await render(
      <AppConnectDialog
        app={target}
        open
        onOpenChange={vi.fn()}
        readConnector={async () => ({
          id: "notion",
          name: "Notion",
          status: "DISABLED_BY_ADMIN",
          authMode: "OAUTH",
          requiresLinkParameters: false,
        })}
        readTerms={async () => ({
          blurbs: [],
          personalizationDefault: null,
          personalizationToggleBlurb: null,
        })}
        startConnection={startConnection}
        onOpenAppUrl={onOpenAppUrl}
        onConnected={vi.fn(async () => undefined)}
      />,
    );
    try {
      await expect.element(page.getByRole("button", { name: "Disabled by admin" })).toBeDisabled();
      await expect.element(page.getByText("Approved by your admin")).not.toBeInTheDocument();
    } finally {
      await adminBlocked.unmount();
    }
  });

  it("localizes the exact 6234 fallback disclosure and connection states in zh-CN", async () => {
    localizationTestState.locale = "zh-CN";
    const screen = await render(
      <AppConnectDialog
        app={{
          id: "github",
          name: "GitHub",
          description: null,
          installUrl: "https://chatgpt.com/gpts/editor",
          isAccessible: false,
          logoUrl: "https://cdn.example/github.png",
          logoUrlDark: null,
        }}
        open
        onOpenChange={vi.fn()}
        readConnector={async () => ({
          id: "github",
          name: "GitHub",
          status: null,
          authMode: "NONE",
          requiresLinkParameters: false,
        })}
        readTerms={async () => ({
          blurbs: [],
          personalizationDefault: null,
          personalizationToggleBlurb: null,
        })}
        startConnection={vi.fn(async () => ({ kind: "connectedDirectly" as const }))}
        onOpenAppUrl={vi.fn(async () => true)}
        onConnected={vi.fn(async () => undefined)}
      />,
    );
    try {
      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(0);
      await expect.element(page.getByRole("heading", { name: "连接 GitHub" })).toBeInTheDocument();
      await expect.element(page.getByAltText("“GitHub”徽标")).toBeInTheDocument();
      await expect.element(page.getByText("始终遵守权限")).toBeInTheDocument();
      await expect
        .element(
          page.getByText("ChatGPT 严格受限于你明确设置的权限。你可以随时禁用访问权限以撤销权限。"),
        )
        .toBeInTheDocument();
      await expect.element(page.getByText("ChatGPT 如何使用数据")).toBeInTheDocument();
      await expect.element(page.getByText("连接器可能会引入风险")).toBeInTheDocument();
      await expect.element(page.getByText("由管理员批准")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "连接 GitHub" })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
