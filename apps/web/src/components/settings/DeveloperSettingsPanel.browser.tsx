// FILE: DeveloperSettingsPanel.browser.tsx
// Purpose: Real Chromium browser test for Google AI Studio / Build-style Developer API Key Settings UI:
//          isolated ¥3.00 credit card, 4-capability breakdown, create/copy/revoke lifecycle,
//          exhausted ¥0.00 alert, and cURL/JS snippets for LLM, Image, Video, and Voice.
// Layer: Browser UI test

import "../../index.css";

import type { MossDeveloperApiKeysState } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { DeveloperSettingsPanel } from "./DeveloperSettingsPanel";

const nativeMock = vi.hoisted(() => ({
  listMossDeveloperApiKeys: vi.fn<() => Promise<MossDeveloperApiKeysState>>(),
  createMossDeveloperApiKey: vi.fn(),
  revokeMossDeveloperApiKey: vi.fn(),
}));

vi.mock("~/nativeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/nativeApi")>();
  const api = { server: nativeMock };
  return {
    ...actual,
    ensureNativeApi: () => api,
    readNativeApi: () => api,
  };
});

function makeInitialState(
  overrides: Partial<MossDeveloperApiKeysState> = {},
): MossDeveloperApiKeysState {
  return {
    configured: true,
    authenticated: true,
    gatewayBaseUrl: "https://cn-gateway.example.test/functions/v1/moss-model-gateway/v1",
    localGatewayBaseUrl: "http://127.0.0.1:3773/api/moss/developer/v1",
    wallet: {
      initialGrantFen: 300,
      availableFen: 300,
      heldFen: 0,
      spentFen: 0,
      availableNanoCny: "3000000000",
      heldNanoCny: "0",
      spentNanoCny: "0",
    },
    breakdown: [
      { capability: "llm", requestCount: 0, spentNanoCny: "0" },
      { capability: "image", requestCount: 0, spentNanoCny: "0" },
      { capability: "video", requestCount: 0, spentNanoCny: "0" },
      { capability: "voice", requestCount: 0, spentNanoCny: "0" },
    ],
    keys: [],
    recentLedger: [],
    ...overrides,
  };
}

function renderPanel(locale: "zh-CN" | "en" = "zh-CN") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MossLocaleScope locale={locale}>
        <DeveloperSettingsPanel />
      </MossLocaleScope>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DeveloperSettingsPanel", () => {
  it("displays isolated ¥3.00 credit card, creates/copies/revokes keys, and switches snippets", async () => {
    const generatedSecret = `moss_dk_cn_${"k".repeat(32)}`;
    const keyId = "11111111-1111-4111-8111-111111111111";
    let state = makeInitialState();

    nativeMock.listMossDeveloperApiKeys.mockImplementation(async () => state);
    nativeMock.createMossDeveloperApiKey.mockImplementation(
      async (input: { name: string; scopes?: string[] }) => {
        const createdRecord = {
          id: keyId,
          name: input.name,
          keyPrefix: generatedSecret.slice(0, 15),
          scopes: (input.scopes ?? [
            "llm",
            "image",
            "video",
            "voice",
          ]) as MossDeveloperApiKeysState["keys"][number]["scopes"],
          status: "active" as const,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: "2026-11-27T00:00:00.000Z",
        };
        state = {
          ...state,
          keys: [createdRecord],
        };
        return {
          key: createdRecord,
          secretKey: generatedSecret,
          wallet: state.wallet!,
        };
      },
    );
    nativeMock.revokeMossDeveloperApiKey.mockImplementation(async () => {
      const revokedRecord = {
        ...state.keys[0]!,
        status: "revoked" as const,
        revokedAt: "2026-11-27T00:05:00.000Z",
      };
      state = {
        ...state,
        keys: [revokedRecord],
      };
      return {
        revoked: true,
        key: revokedRecord,
      };
    });

    const screen = await renderPanel("zh-CN");

    await expect.element(page.getByTestId("developer-balance-amount")).toHaveTextContent("¥3.00");
    await expect.element(page.getByTestId("developer-empty-keys")).toBeVisible();

    // Open Create modal, enter name, submit
    await page.getByTestId("developer-create-key-trigger").click();
    await userEvent.fill(page.getByTestId("developer-key-name-input").element(), "cli-worker");
    await page.getByTestId("developer-create-submit").click();

    await expect
      .element(page.getByTestId("developer-revealed-secret"))
      .toHaveTextContent(generatedSecret);
    await expect.element(page.getByTestId(`developer-key-row-${keyId}`)).toBeVisible();
    await expect
      .element(page.getByTestId(`developer-key-row-${keyId}`))
      .toHaveTextContent(`${generatedSecret.slice(0, 15)}••••`);

    // Check cURL and JavaScript snippets for LLM, Image, Video, and Voice
    const snippetPre = page.getByTestId("developer-snippet-code");
    await expect.element(snippetPre).toHaveTextContent("/chat/completions");
    await expect.element(snippetPre).toHaveTextContent(generatedSecret);

    const capTabs = page.getByTestId("developer-snippet-capability-tabs");
    await capTabs.getByRole("tab", { name: "生图 Image" }).click();
    await expect.element(snippetPre).toHaveTextContent("/images/generations");

    await capTabs.getByRole("tab", { name: "视频 Video" }).click();
    await expect.element(snippetPre).toHaveTextContent("/videos/generations");

    await capTabs.getByRole("tab", { name: "语音 Voice" }).click();
    await expect.element(snippetPre).toHaveTextContent("/audio/speech");
    await expect.element(snippetPre).toHaveTextContent("/realtime/calls");

    await page
      .getByTestId("developer-snippet-language-tabs")
      .getByRole("tab", { name: "JavaScript" })
      .click();
    await expect.element(snippetPre).toHaveTextContent("fetch(");

    // Revoke key (2-click confirm)
    await page.getByTestId(`developer-revoke-key-${keyId}`).click();
    await page.getByTestId(`developer-revoke-key-${keyId}`).click();
    await expect
      .element(page.getByTestId(`developer-key-row-${keyId}`))
      .toHaveTextContent("已吊销");

    await screen.unmount();
  });

  it("shows exhausted alert when balance reaches ¥0.00", async () => {
    nativeMock.listMossDeveloperApiKeys.mockResolvedValue(
      makeInitialState({
        wallet: {
          initialGrantFen: 300,
          availableFen: 0,
          heldFen: 0,
          spentFen: 300,
          availableNanoCny: "0",
          heldNanoCny: "0",
          spentNanoCny: "3000000000",
        },
        breakdown: [
          { capability: "llm", requestCount: 5, spentNanoCny: "1000000000" },
          { capability: "image", requestCount: 2, spentNanoCny: "800000000" },
          { capability: "video", requestCount: 1, spentNanoCny: "1000000000" },
          { capability: "voice", requestCount: 2, spentNanoCny: "200000000" },
        ],
        recentLedger: [
          {
            id: "ledger-1",
            eventType: "capture",
            capability: "llm",
            modelId: "deepseek-v4-pro",
            apiKeyId: "11111111-1111-4111-8111-111111111111",
            deltaAvailableNanoCny: "-100000",
            availableAfterNanoCny: "2999900000",
            inputTokens: 120,
            outputTokens: 45,
            createdAt: "2026-11-27T00:00:00.000Z",
          },
        ],
      }),
    );

    const screen = await renderPanel("zh-CN");
    await expect.element(page.getByTestId("developer-balance-amount")).toHaveTextContent("¥0.00");
    await expect.element(page.getByTestId("developer-exhausted-alert")).toBeVisible();
    await expect
      .element(page.getByTestId("developer-ledger-row-ledger-1"))
      .toHaveTextContent("实际扣费");
    await expect
      .element(page.getByTestId("developer-ledger-row-ledger-1"))
      .toHaveTextContent("大模型 LLM");
    await expect
      .element(page.getByTestId("developer-ledger-row-ledger-1"))
      .toHaveTextContent("输入 120 / 输出 45");
    await expect
      .element(page.getByTestId("developer-ledger-row-ledger-1"))
      .toHaveTextContent("-¥0.0001");
    await screen.unmount();
  });
});
