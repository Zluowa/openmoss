// FILE: useProviderUsageSummary.test.tsx
// Purpose: Verifies how the shared provider-usage summary hook arbitrates live,
// local, OpenUsage, and thread-derived fallback usage signals.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { translateMoss } from "~/localization";
import type { ProviderRateLimit } from "~/lib/rateLimits";
import { openUsageProviderSnapshotQueryOptions } from "~/lib/openUsageReactQuery";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { useProviderUsageSummary } from "./useProviderUsageSummary";

vi.mock("~/lib/openUsageReactQuery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/openUsageReactQuery")>();
  return {
    ...actual,
    openUsageProviderSnapshotQueryOptions: vi.fn(actual.openUsageProviderSnapshotQueryOptions),
  };
});

let testLocale: "en" | "zh-CN" = "en";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: testLocale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss(testLocale, key),
      format: vi.fn(),
    }),
  };
});

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2026-06-09T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    ...input,
  };
}

function fallbackSnapshot(
  input: Partial<ServerProviderUsageSnapshot> = {},
): ServerProviderUsageSnapshot {
  return snapshot({
    limits: [
      {
        window: "Weekly",
        usedPercent: 64,
        resetsAt: "2026-06-15T12:00:00.000Z",
        windowDurationMins: 10080,
      },
    ],
    usageLines: [{ label: "24h", value: "123M tokens", subtitle: "12 recent sessions" }],
    ...input,
  });
}

function renderWithQueryClient(queryClient: QueryClient, node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
}

function readProviderUsageSummary(input: {
  queryClient: QueryClient;
  provider?: ServerProviderUsageSnapshot["provider"];
  providerInstanceId?: ServerProviderUsageSnapshot["providerInstanceId"];
  accountRef?: string;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  providerSnapshot?: ServerProviderUsageSnapshot | undefined;
  fetchOpenUsageData?: boolean;
}) {
  // Capture into a ref-style holder: the hook only runs inside the closure, so a
  // plain `let` would narrow to `never` after the guard (TS can't see <Probe/> run).
  const captured: { current: ReturnType<typeof useProviderUsageSummary> | null } = {
    current: null,
  };

  function Probe() {
    captured.current = useProviderUsageSummary({
      provider: input.provider ?? "claudeAgent",
      ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
      ...(input.accountRef ? { accountRef: input.accountRef } : {}),
      threads: [],
      threadRateLimits: input.threadRateLimits,
      providerSnapshot: input.providerSnapshot,
      fetchOpenUsageData: input.fetchOpenUsageData,
    });
    return <span />;
  }

  renderWithQueryClient(input.queryClient, <Probe />);

  if (!captured.current) {
    throw new Error("Provider usage summary probe did not render.");
  }
  return captured.current;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

describe("useProviderUsageSummary", () => {
  it.each(["providerInstanceId", "instanceId"] as const)(
    "discovers %s identity without rendering bootstrap or prior-account archive usage",
    (identityField) => {
      const queryClient = createQueryClient();
      const providerInstanceId = "codex_work" as NonNullable<
        ServerProviderUsageSnapshot["providerInstanceId"]
      >;
      queryClient.setQueryData(serverQueryKeys.allProviderUsage(providerInstanceId, "acct_old"), [
        snapshot({
          provider: "codex",
          [identityField]: providerInstanceId,
          accountRef: "acct_old",
          usageLines: [{ label: "Lifetime", value: "old-account" }],
        }),
      ]);
      queryClient.setQueryData(
        serverQueryKeys.providerUsage("codex", providerInstanceId),
        fallbackSnapshot({
          provider: "codex",
          [identityField]: providerInstanceId,
          accountRef: "acct_old",
          limits: [],
          usageLines: [{ label: "Lifetime", value: "old-archive" }],
        }),
      );

      const bootstrapping = readProviderUsageSummary({
        queryClient,
        provider: "codex",
        providerInstanceId,
        fetchOpenUsageData: false,
      });
      expect(bootstrapping.rateLimits).toEqual([]);
      expect(bootstrapping.usageLines).toEqual([]);
      const unscopedArchiveQuery = queryClient.getQueryCache().find({
        queryKey: serverQueryKeys.providerUsage("codex", providerInstanceId),
      });
      expect(
        (unscopedArchiveQuery?.options as { readonly enabled?: boolean } | undefined)?.enabled,
      ).toBe(false);

      queryClient.setQueryData(serverQueryKeys.allProviderUsage(providerInstanceId), [
        snapshot({
          provider: "codex",
          [identityField]: providerInstanceId,
          accountRef: "acct_new",
          usageLines: [{ label: "Lifetime", value: "identity-only" }],
        }),
      ]);
      const identityDiscovered = readProviderUsageSummary({
        queryClient,
        provider: "codex",
        providerInstanceId,
        fetchOpenUsageData: false,
      });
      expect(identityDiscovered.rateLimits).toEqual([]);
      expect(identityDiscovered.usageLines).toEqual([]);

      queryClient.setQueryData(serverQueryKeys.allProviderUsage(providerInstanceId, "acct_new"), [
        snapshot({
          provider: "codex",
          [identityField]: providerInstanceId,
          accountRef: "acct_new",
          usageLines: [{ label: "Lifetime", value: "current-account" }],
        }),
      ]);
      const resolved = readProviderUsageSummary({
        queryClient,
        provider: "codex",
        providerInstanceId,
        fetchOpenUsageData: false,
      });
      expect(resolved.usageLines).toEqual([{ label: "Lifetime", value: "current-account" }]);
    },
  );

  it("can keep OpenUsage polling disabled while using the server batch query", () => {
    const queryClient = createQueryClient();

    readProviderUsageSummary({ queryClient, fetchOpenUsageData: false });

    expect(openUsageProviderSnapshotQueryOptions).toHaveBeenCalledWith("claudeAgent", {
      enabled: false,
    });
    expect(
      queryClient.getQueryCache().find({ queryKey: serverQueryKeys.allProviderUsage() }),
    ).toBeDefined();
  });

  it("does not promote a renderer Codex home into the authoritative archive query", () => {
    const queryClient = createQueryClient();

    function Probe() {
      useProviderUsageSummary({
        provider: "codex",
        threads: [],
        codexHomePath: "/client-controlled/archive-root",
        fetchOpenUsageData: false,
      });
      return <span />;
    }

    renderWithQueryClient(queryClient, <Probe />);

    const query = queryClient
      .getQueryCache()
      .find({ queryKey: serverQueryKeys.providerUsage("codex") });
    expect(query).toBeDefined();
    expect(JSON.stringify(query?.queryKey)).not.toContain("client-controlled");
  });

  it("does not show local fallback rows when the live batch reports a non-ok status", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({ status: "needs-auth", detail: "Sign in with claude to see usage." }),
    ]);
    queryClient.setQueryData(serverQueryKeys.providerUsage("claudeAgent"), fallbackSnapshot());

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([]);
  });

  it("shows an explicitly labeled lower bound when the server attached it to an unavailable read", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({
        status: "error",
        usageAuthority: "lower-bound",
        detail: "Authoritative usage is unavailable; local totals are a lower bound.",
        usageLines: [{ label: "7d", value: "≥42 tokens" }],
      }),
    ]);

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([{ label: "7d", value: "≥42 tokens" }]);
    expect(summary.usageNotice).toContain("lower bound");
  });

  it("still uses local fallback rows when no live snapshot exists", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(serverQueryKeys.providerUsage("claudeAgent"), fallbackSnapshot());

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.rateLimits[0]?.limits?.[0]?.window).toBe("Weekly");
    expect(summary.usageLines).toEqual([
      { label: "24h", value: "123M tokens", subtitle: "12 recent sessions" },
    ]);
  });

  it.each(["en", "zh-CN"] as const)(
    "surfaces the typed %s partial-archive notice when it uses local lower-bound rows",
    (locale) => {
      testLocale = locale;
      const queryClient = createQueryClient();
      queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
      queryClient.setQueryData(
        serverQueryKeys.providerUsage("claudeAgent"),
        fallbackSnapshot({
          detail: "Local archive totals are lower bounds because the bounded scan was incomplete.",
          archiveScan: {
            complete: false,
            filesDiscovered: 10,
            filesSelected: 8,
            filesResolved: 7,
            filesIncomplete: 3,
            bytesRead: 4096,
            recordsInspected: 20,
          },
        }),
      );

      const summary = readProviderUsageSummary({ queryClient });

      expect(summary.usageLines).toEqual([
        { label: "24h", value: "123M tokens", subtitle: "12 recent sessions" },
      ]);
      expect(summary.usageNotice).toBe(translateMoss(locale, "settings.usage.archiveIncomplete"));
    },
  );

  it("accepts precomputed thread fallback rows from aggregate provider surfaces", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);

    const summary = readProviderUsageSummary({
      queryClient,
      threadRateLimits: [
        {
          provider: "claudeAgent",
          updatedAt: "2026-06-09T12:00:00.000Z",
          limits: [
            {
              window: "5h",
              usedPercent: 12,
              resetsAt: "2026-06-09T17:00:00.000Z",
              windowDurationMins: 300,
            },
          ],
        },
      ],
    });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.rateLimits[0]?.limits?.[0]?.window).toBe("5h");
    expect(summary.rateLimits[0]?.limits?.[0]?.usedPercent).toBe(12);
  });

  it("surfaces the throttle notice from an ok snapshot that carries a detail", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({
        status: "ok",
        detail: "Anthropic is rate-limiting usage checks — showing your last values.",
        limits: [
          {
            window: "Weekly",
            usedPercent: 64,
            resetsAt: "2026-06-15T12:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      }),
    ]);

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.usageNotice).toContain("rate-limiting");
  });

  it.each(["en", "zh-CN"] as const)(
    "keeps provider throttle detail beside the localized %s lower-bound notice",
    (locale) => {
      testLocale = locale;
      const throttleDetail = "Anthropic is rate-limiting usage checks — showing your last values.";
      const queryClient = createQueryClient();
      queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
        snapshot({
          status: "ok",
          detail: throttleDetail,
          usageLines: [{ label: "24h", value: "≥123M tokens" }],
          archiveScan: {
            complete: false,
            filesDiscovered: 10,
            filesSelected: 8,
            filesResolved: 7,
            filesIncomplete: 3,
            bytesRead: 4096,
            recordsInspected: 20,
          },
        }),
      ]);

      const summary = readProviderUsageSummary({ queryClient });
      const archiveNotice = translateMoss(locale, "settings.usage.archiveIncomplete");

      expect(summary.usageNotice).toContain(throttleDetail);
      expect(summary.usageNotice).toContain(archiveNotice);
      expect(summary.usageNotice?.split(throttleDetail)).toHaveLength(2);
      expect(summary.usageNotice?.split(archiveNotice)).toHaveLength(2);
    },
  );

  it("has no notice when the live snapshot is non-ok", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({ status: "error", detail: "Usage is currently unavailable." }),
    ]);

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.usageNotice).toBeUndefined();
  });

  it("does not show fallback rows when an explicit provider card snapshot is non-ok", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(serverQueryKeys.providerUsage("claudeAgent"), fallbackSnapshot());

    const summary = readProviderUsageSummary({
      queryClient,
      providerSnapshot: snapshot({ status: "error", detail: "Usage is currently unavailable." }),
    });

    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([]);
  });
});
