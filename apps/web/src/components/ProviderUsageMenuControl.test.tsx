// FILE: ProviderUsageMenuControl.test.tsx
// Purpose: Keeps the chat-header Usage entry visible for honest archive-only usage data.

import { renderToStaticMarkup } from "react-dom/server";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { useProviderUsageSummary as UseProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { translateMoss } from "~/localization";
import {
  ProviderUsageMenuControl,
  ProviderUsageMenuPanel,
  useProviderUsageMenuModel,
} from "./ProviderUsageMenuControl";

const usageSummaryMock = vi.fn<typeof UseProviderUsageSummary>();

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        selectedCodexAccountId: "default",
      },
    }),
  };
});

vi.mock("~/hooks/useProviderUsageSummary", () => ({
  useProviderUsageSummary: (...args: Parameters<typeof UseProviderUsageSummary>) =>
    usageSummaryMock(...args),
}));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "en",
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("en", key),
      format: vi.fn(),
    }),
  };
});

vi.mock("~/store", () => ({ useStore: () => [] }));
vi.mock("~/storeSelectors", () => ({
  createAccountRateLimitThreadsSelector: () => () => [],
}));

vi.mock("./chat/ComposerPickerMenuPopup", () => ({
  ComposerPickerMenuPopup: ({
    children,
  }: {
    children?: ReactNode;
    align?: string;
    side?: string;
    className?: string;
  }) => <div data-usage-popup="true">{children}</div>,
}));

vi.mock("./chat/chatHeaderControls", () => ({
  ChatHeaderButton: ({
    tone: _tone,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: string }) => <button {...props} />,
}));

vi.mock("./ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => (
    <span data-provider-icon={provider} aria-hidden="true" />
  ),
}));

vi.mock("./ui/menu", async () => {
  const { cloneElement } = await import("react");
  return {
    Menu: ({ children }: { children?: ReactNode; modal?: boolean }) => (
      <div data-menu="true">{children}</div>
    ),
    MenuTrigger: ({
      render,
      children,
    }: {
      render: ReactElement<{ children?: ReactNode }>;
      children?: ReactNode;
    }) => cloneElement(render, undefined, children),
  };
});

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: ({ side: _side, ...props }: HTMLAttributes<HTMLDivElement> & { side?: string }) => (
    <div {...props} />
  ),
}));

function readMenuModel(
  provider: "claudeAgent" | "codex",
): ReturnType<typeof useProviderUsageMenuModel> {
  const captured: { current: ReturnType<typeof useProviderUsageMenuModel> | null } = {
    current: null,
  };

  function Probe() {
    captured.current = useProviderUsageMenuModel(provider);
    return <span />;
  }

  renderToStaticMarkup(<Probe />);
  return captured.current!;
}

beforeEach(() => {
  usageSummaryMock.mockReset();
});

describe("ProviderUsageMenuControl usage model contract", () => {
  it("keeps a Claude usage-lines-only snapshot in rows without inventing a limit", () => {
    usageSummaryMock.mockReturnValue({
      resetCredits: undefined,
      isLoading: false,
      learnMoreHref: null,
      rateLimits: [],
      usageLines: [{ label: "24h", value: "321 tokens", subtitle: "1 recent session" }],
      usageNotice: undefined,
    });

    const model = readMenuModel("claudeAgent");

    expect(model).not.toBeNull();
    expect(model.rateLimits).toEqual([]);
    expect(model.rows).toEqual([]);
    expect(model.usageLines[0]?.value).toBe("321 tokens");
    expect(model.primaryRow).toBeNull();
    const markup = renderToStaticMarkup(
      <ProviderUsageMenuPanel provider="claudeAgent" model={model} showUsageLines />,
    );
    expect(markup).toContain("24h");
    expect(markup).toContain("321 tokens");
    expect(markup).not.toContain(translateMoss("en", "settings.usage.noLocalData"));

    const controlMarkup = renderToStaticMarkup(<ProviderUsageMenuControl provider="claudeAgent" />);
    expect(controlMarkup).toBe("");
  });

  it("keeps partial Codex archive lines and their lower-bound notice in the model", () => {
    const notice =
      "The bounded local archive scan could not inspect every eligible entry, so totals are lower bounds.";
    usageSummaryMock.mockReturnValue({
      resetCredits: undefined,
      isLoading: false,
      learnMoreHref: null,
      rateLimits: [],
      usageLines: [{ label: "30d", value: "≥42 tokens", subtitle: "≥1 recent session" }],
      usageNotice: notice,
    });

    const model = readMenuModel("codex");

    expect(model.rateLimits).toEqual([]);
    expect(model.rows).toEqual([]);
    expect(model.primaryRow).toBeNull();
    expect(model.notice).toBe(notice);
    const markup = renderToStaticMarkup(
      <ProviderUsageMenuPanel provider="codex" model={model} showUsageLines />,
    );
    expect(markup).toContain("≥42 tokens");
    expect(markup).toContain(notice);

    const controlMarkup = renderToStaticMarkup(<ProviderUsageMenuControl provider="codex" />);
    expect(controlMarkup).toBe("");
  });

  it("keeps a real rate limit primary when limits and archive lines both exist", () => {
    usageSummaryMock.mockReturnValue({
      resetCredits: undefined,
      isLoading: false,
      learnMoreHref: null,
      rateLimits: [
        {
          provider: "claudeAgent",
          updatedAt: "2026-08-12T08:00:00.000Z",
          limits: [{ window: "5h", usedPercent: 25 }],
        },
      ],
      usageLines: [{ label: "24h", value: "321 tokens" }],
      usageNotice: undefined,
    });

    const model = readMenuModel("claudeAgent");

    expect(model.rows).toHaveLength(1);
    expect(model.primaryRow).toEqual(model.rows[0]);
    expect(model.primaryRow).toMatchObject({
      id: "claudeAgent-5h",
      label: "5h",
      remainingLabel: "75%",
      remainingPercent: 75,
    });
    expect(model.rateLimits).toHaveLength(1);
  });

  it("stays hidden when neither limits nor usage lines are available", () => {
    usageSummaryMock.mockReturnValue({
      resetCredits: undefined,
      isLoading: false,
      learnMoreHref: null,
      rateLimits: [],
      usageLines: [],
      usageNotice: undefined,
    });

    const model = readMenuModel("claudeAgent");
    expect(model.rows).toEqual([]);
    expect(model.primaryRow).toBeNull();
    expect(renderToStaticMarkup(<ProviderUsageMenuControl provider="claudeAgent" />)).toBe("");
  });
});
