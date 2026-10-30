// FILE: useRetainedManagedProviderModelOptions.browser.tsx
// Purpose: Verifies committed hook retention across real React rerenders.
// Layer: Web browser hook tests

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render, renderHook } from "vitest-browser-react";

import { DEFAULT_LOCALE_OVERRIDE } from "../appSettings";
import {
  ProviderModelPicker,
  type ProviderModelPickerInstance,
} from "../components/chat/ProviderModelPicker";
import { MossLocalizationProvider, translateMoss } from "../localization";
import { serverQueryKeys } from "../lib/serverReactQuery";
import type { ProviderModelOption } from "../providerModelOptions";
import {
  type ProviderModelCatalogInstance,
  type ProviderModelOptionsByInstance,
  useRetainedManagedProviderModelOptions,
} from "./useRetainedManagedProviderModelOptions";

// The browser suite pins localeOverride "en" at the storage boundary
// (src/test/browserLocaleSetup.ts); this case asserts the zh-CN product copy,
// so pin the settings hook the same way the other zh-CN surface tests do.
vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: "zh-CN",
        selectedCodexAccountId: "default",
      },
    }),
  };
});

interface RetentionProps {
  readonly providerInstances: ReadonlyArray<ProviderModelCatalogInstance>;
  readonly modelOptionsByProviderInstance: ProviderModelOptionsByInstance;
}

const MODELS: ReadonlyArray<ProviderModelOption> = [
  { slug: "claude-opus-4-8", name: "Claude Opus 4.8" },
];
const EMPTY_MODEL_OPTIONS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<ProviderModelOption>> = {
  codex: [],
  claudeAgent: [],
  cursor: [],
  gemini: [],
  antigravity: [],
  grok: [],
  droid: [],
  kilo: [],
  devin: [],
  opencode: [],
  pi: [],
  hermes: [],
  omp: [],
  kimi: [],
  minimax: [],
  zcode: [],
};
const MANAGED_CLAUDE_INSTANCE: ProviderModelPickerInstance = {
  instanceId: "claude_moss",
  provider: "claudeAgent",
  label: "Moss Claude",
  enabled: true,
  isDefault: false,
};

function renderRetention(initialProps: RetentionProps) {
  return renderHook(
    (props?: RetentionProps) => useRetainedManagedProviderModelOptions(props ?? initialProps),
    { initialProps },
  );
}

function providerStatus(overrides: Partial<ServerProviderStatus> = {}): ServerProviderStatus {
  return {
    provider: "claudeAgent",
    instanceId: "claude_moss",
    driver: "claudeAgent",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function RetainedManagedPicker(props: {
  readonly status: ServerProviderStatus;
  readonly currentOptions: ReadonlyArray<ProviderModelOption>;
}) {
  const modelOptionsByProviderInstance = useRetainedManagedProviderModelOptions({
    providerInstances: [MANAGED_CLAUDE_INSTANCE],
    modelOptionsByProviderInstance: { claude_moss: props.currentOptions },
  });
  return (
    <ProviderModelPicker
      provider="claudeAgent"
      model="claude-opus-4-8"
      lockedProvider="claudeAgent"
      providers={[props.status]}
      providerStatusesResolved
      modelOptionsByProvider={EMPTY_MODEL_OPTIONS_BY_PROVIDER}
      modelOptionsByProviderInstance={modelOptionsByProviderInstance}
      providerInstances={[MANAGED_CLAUDE_INSTANCE]}
      selectedProviderInstanceId="claude_moss"
      separateAgentPicker
      showProviderInstanceChoices={false}
      open
      onProviderModelChange={() => undefined}
    />
  );
}

describe("useRetainedManagedProviderModelOptions", () => {
  it("retains a managed catalog until its instance is committed as removed", async () => {
    const managedInstance = { instanceId: "claude_moss", provider: "claudeAgent" } as const;
    const hook = await renderRetention({
      providerInstances: [managedInstance],
      modelOptionsByProviderInstance: { claude_moss: MODELS },
    });

    await hook.rerender({
      providerInstances: [managedInstance],
      modelOptionsByProviderInstance: { claude_moss: [] },
    });
    expect(hook.result.current.claude_moss).toBe(MODELS);

    await hook.rerender({ providerInstances: [], modelOptionsByProviderInstance: {} });
    expect(hook.result.current.claude_moss).toBeUndefined();

    await hook.rerender({
      providerInstances: [managedInstance],
      modelOptionsByProviderInstance: { claude_moss: [] },
    });
    expect(hook.result.current.claude_moss).toEqual([]);
    await hook.unmount();
  });

  it("never falls back for a personal provider instance", async () => {
    const personalInstance: ProviderModelCatalogInstance = {
      instanceId: "codex" as ProviderInstanceId,
      provider: "codex" as ProviderKind,
    };
    const hook = await renderRetention({
      providerInstances: [personalInstance],
      modelOptionsByProviderInstance: { codex: MODELS },
    });

    await hook.rerender({
      providerInstances: [personalInstance],
      modelOptionsByProviderInstance: { codex: [] },
    });
    expect(hook.result.current.codex).toEqual([]);
    await hook.unmount();
  });

  it("keeps managed models visible beside unavailable status after a catalog refresh empties", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
    const renderPicker = (
      status: ServerProviderStatus,
      currentOptions: ReadonlyArray<ProviderModelOption>,
    ) => (
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <RetainedManagedPicker status={status} currentOptions={currentOptions} />
        </MossLocalizationProvider>
      </QueryClientProvider>
    );
    const mounted = await render(renderPicker(providerStatus(), MODELS));

    try {
      await expect
        .element(page.getByRole("menuitemradio", { name: "Claude Opus 4.8" }))
        .toBeVisible();

      await mounted.rerender(
        renderPicker(
          providerStatus({ status: "error", available: false, authStatus: "unknown" }),
          [],
        ),
      );

      await expect
        .element(
          page.getByText(translateMoss(DEFAULT_LOCALE_OVERRIDE, "chat.modelSource.unavailable"), {
            exact: true,
          }),
        )
        .toBeVisible();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Claude Opus 4.8" }))
        .toBeVisible();
    } finally {
      await mounted.unmount();
      queryClient.clear();
    }
  });
});
