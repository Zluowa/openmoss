import "../../index.css";

import {
  type CodexModelOptions,
  type ModelSlug,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  ThreadId,
} from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import { STARRED_MODELS_STORAGE_KEY, type StarredModel } from "../../lib/starredModels";
import { type ProviderModelOption } from "../../providerModelOptions";
import {
  deriveComposerContextWindowLabel,
  deriveContextWindowSelectionStatus,
  deriveSelectedContextWindowSnapshot,
} from "../../lib/contextWindow";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { type ProviderModelPickerInstance } from "./ProviderModelPicker";

// Moss defaults the bare localization context to zh-CN; these assertions use the
// English copy, so pin the locale the same way the other picker suites do.
const localizationTestState = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
}));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
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

const THREAD_ID = ThreadId.makeUnsafe("thread-composer-model-picker");
const GPT_5_5 = "gpt-5.5" as ModelSlug;
const GPT_5_4 = "gpt-5.4" as ModelSlug;
const SONNET = "claude-sonnet-4-6" as ModelSlug;

const EMPTY_BY_PROVIDER: Record<ProviderKind, never[]> = {
  claudeAgent: [],
  codex: [],
  cursor: [],
  devin: [],
  antigravity: [],
  gemini: [],
  grok: [],
  droid: [],
  kilo: [],
  hermes: [],
  omp: [],
  kimi: [],
  minimax: [],
  zcode: [],
  opencode: [],
  pi: [],
};

const MODEL_OPTIONS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<ProviderModelOption>> = {
  ...EMPTY_BY_PROVIDER,
  codex: [
    { slug: GPT_5_5, name: "GPT-5.5", description: "Frontier agentic coding" },
    { slug: GPT_5_4, name: "GPT-5.4", description: "Previous generation" },
  ],
  claudeAgent: [{ slug: SONNET, name: "Claude Sonnet 4.6" }],
};

function readyProvider(provider: ProviderKind): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-04-10T10:00:00.000Z",
  };
}

const GPT_5_WORK = "gpt-5-work" as ModelSlug;

// A default Codex account plus a second one, each with its own model catalog.
const CODEX_ACCOUNTS: ReadonlyArray<ProviderModelPickerInstance> = [
  { instanceId: "codex", provider: "codex", label: "Codex", enabled: true, isDefault: true },
  { instanceId: "codex_work", provider: "codex", label: "Work", enabled: true, isDefault: false },
];
const WORK_ACCOUNT_STATUS: ServerProviderStatus = {
  ...readyProvider("codex"),
  instanceId: "codex_work",
  displayName: "Work",
};
const WORK_ACCOUNT_MODELS = {
  codex_work: [{ slug: GPT_5_WORK, name: "GPT-5 Work" }],
};

type HarnessProps = {
  providers?: ReadonlyArray<ServerProviderStatus>;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  modelOptionsByProviderInstance?: React.ComponentProps<
    typeof ComposerModelPicker
  >["modelOptionsByProviderInstance"];
  lockedProvider?: ProviderKind | null;
  boundProviderInstance?: React.ComponentProps<typeof ComposerModelPicker>["boundProviderInstance"];
  modelOptionsByProvider?: React.ComponentProps<
    typeof ComposerModelPicker
  >["modelOptionsByProvider"];
  effortControl?: "menu" | "slider";
  onProviderModelChange?: React.ComponentProps<typeof ComposerModelPicker>["onProviderModelChange"];
  onRefreshModels?: React.ComponentProps<typeof ComposerModelPicker>["onRefreshModels"];
};

function Harness(props: HarnessProps) {
  const prompt = useComposerThreadDraft(THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: THREAD_ID,
    selectedProvider: "codex",
    threadModelSelection: null,
    projectModelSelection: null,
    customModelsByProvider: EMPTY_BY_PROVIDER,
  });
  return (
    <ComposerModelPicker
      provider="codex"
      model={(selectedModel ?? GPT_5_5) as ModelSlug}
      lockedProvider={props.lockedProvider ?? null}
      boundProviderInstance={props.boundProviderInstance ?? null}
      effortControl={props.effortControl ?? "menu"}
      providers={props.providers ?? [readyProvider("codex"), readyProvider("claudeAgent")]}
      {...(props.providerInstances ? { providerInstances: props.providerInstances } : {})}
      {...(props.selectedProviderInstanceId
        ? { selectedProviderInstanceId: props.selectedProviderInstanceId }
        : {})}
      {...(props.modelOptionsByProviderInstance
        ? { modelOptionsByProviderInstance: props.modelOptionsByProviderInstance }
        : {})}
      modelOptionsByProvider={props.modelOptionsByProvider ?? MODEL_OPTIONS_BY_PROVIDER}
      onProviderModelChange={props.onProviderModelChange ?? vi.fn()}
      {...(props.onRefreshModels ? { onRefreshModels: props.onRefreshModels } : {})}
      threadId={THREAD_ID}
      modelOptions={modelOptions?.codex}
      prompt={prompt}
      onPromptChange={(next) => setPrompt(THREAD_ID, next)}
    />
  );
}

async function mountPicker(
  harnessProps: HarnessProps = {},
  options?: CodexModelOptions,
  starred?: ReadonlyArray<StarredModel>,
) {
  if (starred) {
    localStorage.setItem(STARRED_MODELS_STORAGE_KEY, JSON.stringify(starred));
  }
  useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
    provider: "codex",
    model: GPT_5_5,
    ...(options ? { options } : {}),
  });
  const screen = await render(<Harness {...harnessProps} />);
  await page.getByRole("button", { name: "Change model and reasoning" }).click();
  return screen;
}

function readStoredStars(): unknown {
  return JSON.parse(localStorage.getItem(STARRED_MODELS_STORAGE_KEY) ?? "[]");
}

// The source row names the provider serving the listed models and opens into every
// source the user can switch to.
function sourceTrigger() {
  return page.getByRole("menuitem", { name: /^Provider: / });
}

function sourceOption(name: string | RegExp) {
  return page.getByRole("menuitemradio", { name, exact: typeof name === "string" });
}

async function openSources() {
  await sourceTrigger().click();
  await expect.element(page.getByRole("menu", { name: "Provider" })).toBeVisible();
}

async function selectSource(name: string) {
  await openSources();
  await sourceOption(name).click();
}

async function expectActiveSource(name: string) {
  await expect.element(sourceTrigger()).toHaveAccessibleName(`Provider: ${name}`);
}

describe("ComposerModelPicker", () => {
  it("hides a globally disabled provider's tabs and starred models, including the active default", async () => {
    const screen = await mountPicker(
      {
        providers: [
          { ...readyProvider("codex"), enabled: false, available: false },
          readyProvider("claudeAgent"),
        ],
        providerInstances: CODEX_ACCOUNTS.map((instance) => ({ ...instance, enabled: false })),
      },
      undefined,
      [{ provider: "codex", model: GPT_5_5, effort: null, fastMode: null, thinking: null }],
    );
    try {
      await expect.element(page.getByRole("menuitem", { name: /Claude Sonnet/u })).toBeVisible();
      await openSources();
      expect(sourceOption(/^Codex/u).elements()).toHaveLength(0);
      await sourceOption("Starred").click();
      expect(page.getByRole("menuitem", { name: /GPT-5\.5/u }).elements()).toHaveLength(0);
      expect(readStoredStars()).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("checks the viewed account silently and offers retry only after failure", async () => {
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onRefreshModels = vi.fn().mockReturnValueOnce(promise);
    const screen = await mountPicker({ onRefreshModels });
    try {
      await vi.waitFor(() =>
        expect(onRefreshModels).toHaveBeenCalledExactlyOnceWith("codex", "codex", "if-stale"),
      );
      expect(page.getByRole("button", { name: "Refresh models" }).elements()).toHaveLength(0);
      expect(page.getByRole("status").elements()).toHaveLength(0);
      await expect.element(page.getByRole("menuitem", { name: /GPT-5.5/u }).first()).toBeVisible();
      finish();
      await promise;
      expect(page.getByRole("button", { name: "Refresh models" }).elements()).toHaveLength(0);

      onRefreshModels.mockRejectedValueOnce(new Error("offline"));
      await selectSource("Claude");
      await expect.element(page.getByText("Couldn’t update models.")).toBeVisible();
      expect(onRefreshModels).toHaveBeenLastCalledWith("claudeAgent", "claudeAgent", "if-stale");
      let finishRetry!: () => void;
      onRefreshModels.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishRetry = resolve;
        }),
      );
      const retryButton = page.getByRole("button", { name: "Retry" });
      await retryButton.click();
      await expect.element(retryButton).toBeDisabled();
      expect(onRefreshModels).toHaveBeenLastCalledWith("claudeAgent", "claudeAgent", "now");
      finishRetry();
      await expect.element(retryButton).not.toBeInTheDocument();
      expect(page.getByRole("status").elements()).toHaveLength(0);
      await selectSource("Starred");
      expect(onRefreshModels).toHaveBeenCalledTimes(3);
    } finally {
      await screen.unmount();
    }
  });

  it("does not restart a pending check when the refresh callback changes", async () => {
    let finish!: () => void;
    const onRefreshModels = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const screen = await mountPicker({ onRefreshModels });
    try {
      await vi.waitFor(() => expect(onRefreshModels).toHaveBeenCalledTimes(1));
      await screen.rerender(<Harness onRefreshModels={(...args) => onRefreshModels(...args)} />);
      expect(page.getByRole("status").elements()).toHaveLength(0);
      finish();
      expect(onRefreshModels).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    localStorage.removeItem(STARRED_MODELS_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("opens on the active provider tab and commits a clicked model", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ onProviderModelChange });
    try {
      await expectActiveSource("Codex");
      await page.getByRole("menuitem", { name: /GPT-5\.4/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, { instanceId: "codex" });
    } finally {
      await screen.unmount();
    }
  });

  it("switches provider tabs and filters rows with search", async () => {
    const screen = await mountPicker();
    try {
      await selectSource("Claude");
      await expect.element(page.getByRole("menuitem", { name: /Claude Sonnet/u })).toBeVisible();

      await selectSource("Codex");
      await page.getByRole("searchbox", { name: "Search models" }).fill("5.4");
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.4/u })).toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: /GPT-5\.5/u }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("picks the Nth row with mod+digit", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ onProviderModelChange });
    try {
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.4/u })).toBeVisible();
      await userEvent.keyboard("{Control>}2{/Control}");
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, { instanceId: "codex" });
    } finally {
      await screen.unmount();
    }
  });

  it("leads the codex model list with an undecorated default row that commits the recommended model", async () => {
    const onProviderModelChange = vi.fn();
    const ASTRA = "gpt-6-astra" as ModelSlug;
    const screen = await mountPicker({
      onProviderModelChange,
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        codex: [
          { slug: ASTRA, name: "6 Astra" },
          { slug: GPT_5_5, name: "GPT-5.5" },
        ],
      },
    });
    try {
      // Codex's model view carries a plain "Select model" heading.
      await expect.element(page.getByText("Select model")).toBeVisible();
      const defaultRow = page.getByRole("menuitem", { name: /Default/u });
      await expect.element(defaultRow).toBeVisible();
      await expect.element(defaultRow).toHaveTextContent("Recommended set of models");
      // The default row is undecorated: unlike the model rows it cannot be starred.
      await expect
        .element(page.getByRole("button", { name: /Star Default/u }))
        .not.toBeInTheDocument();
      // The recommended model is not active yet, so nothing reads as current.
      await expect.element(defaultRow).not.toHaveAttribute("aria-current", "true");
      await defaultRow.click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", ASTRA, { instanceId: "codex" });
    } finally {
      await screen.unmount();
    }
  });

  it("checks the default row instead of its aliased model row when the recommended model is active", async () => {
    const ASTRA = "gpt-6-astra" as ModelSlug;
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: ASTRA,
    });
    const screen = await render(
      <Harness
        modelOptionsByProvider={{
          ...MODEL_OPTIONS_BY_PROVIDER,
          codex: [
            { slug: ASTRA, name: "6 Astra" },
            { slug: GPT_5_5, name: "GPT-5.5" },
          ],
        }}
      />,
    );
    await page.getByRole("button", { name: "Change model and reasoning" }).click();
    try {
      await expect
        .element(page.getByRole("menuitem", { name: /Default/u }))
        .toHaveAttribute("aria-current", "true");
      await expect
        .element(page.getByRole("menuitem", { name: /6 Astra/u }))
        .not.toHaveAttribute("aria-current", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the default row out of catalogs that do not advertise the recommended model", async () => {
    const screen = await mountPicker();
    try {
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.5/u })).toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: /Default/u }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("picks a model and its effort from the row's hover side block", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ onProviderModelChange }, { reasoningEffort: "medium" });
    try {
      await page.getByRole("menuitem", { name: /GPT-5\.4/u }).hover();
      await page.getByRole("menuitemradio", { name: /^High/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, {
        modelOptions: { reasoningEffort: "high" },
        instanceId: "codex",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("stars a model together with the traits composed in the footer rows", async () => {
    const screen = await mountPicker({}, { reasoningEffort: "medium" });
    try {
      await page.getByRole("menuitem", { name: /^Effort/u }).click();
      await page.getByRole("menuitemradio", { name: /^High/u }).click();
      await page
        .getByRole("button", { name: "Star GPT-5.5 with its current effort and speed" })
        .click();

      expect(readStoredStars()).toEqual([
        { provider: "codex", model: GPT_5_5, effort: "high", fastMode: false, thinking: null },
      ]);

      await selectSource("Starred");
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.5.*High/u })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("opens on starred presets and restores model + traits in one click", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ onProviderModelChange }, { reasoningEffort: "medium" }, [
      { provider: "codex", model: GPT_5_4, effort: "low", fastMode: true, thinking: null },
    ]);
    try {
      await expectActiveSource("Starred");
      await page.getByRole("menuitem", { name: /GPT-5\.4.*Low · Fast/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, {
        modelOptions: { reasoningEffort: "low", fastMode: true },
        instanceId: "codex",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows the star on every starred model of the provider tab, whatever its traits", async () => {
    const screen = await mountPicker({}, { reasoningEffort: "medium" }, [
      { provider: "codex", model: GPT_5_5, effort: "high", fastMode: false, thinking: null },
      { provider: "codex", model: GPT_5_4, effort: "low", fastMode: true, thinking: null },
    ]);
    try {
      await selectSource("Codex");
      await expect
        .element(page.getByRole("button", { name: "Remove GPT-5.5 from starred" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Remove GPT-5.4 from starred" }).click();

      expect(readStoredStars()).toEqual([
        { provider: "codex", model: GPT_5_5, effort: "high", fastMode: false, thinking: null },
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps retired presets removable while blocking clicks and shortcuts", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker(
      {
        onProviderModelChange,
        modelOptionsByProvider: {
          ...MODEL_OPTIONS_BY_PROVIDER,
          codex: [{ slug: GPT_5_5, name: "GPT-5.5" }],
        },
      },
      undefined,
      [{ provider: "codex", model: GPT_5_4, effort: "low", fastMode: null, thinking: null }],
    );
    try {
      const retired = page.getByRole("menuitem", { name: /GPT-5\.4.*Unavailable/u });
      await expect.element(retired).toHaveAttribute("aria-disabled", "true");
      retired.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await userEvent.keyboard("{Control>}1{/Control}");
      expect(onProviderModelChange).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Remove GPT-5.4 from starred" }).click();
      expect(readStoredStars()).toEqual([]);
      expect(onProviderModelChange).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("enables a saved custom preset when its catalog becomes available", async () => {
    const onProviderModelChange = vi.fn();
    const model = "private-model" as ModelSlug;
    const preset: StarredModel = {
      provider: "codex",
      model,
      effort: null,
      fastMode: null,
      thinking: null,
    };
    const screen = await mountPicker(
      { onProviderModelChange, modelOptionsByProvider: EMPTY_BY_PROVIDER },
      undefined,
      [preset],
    );
    try {
      await expect
        .element(page.getByRole("menuitem", { name: /Private Model.*Unavailable/u }))
        .toHaveAttribute("aria-disabled", "true");
      expect(readStoredStars()).toEqual([preset]);

      await screen.rerender(
        <Harness
          onProviderModelChange={onProviderModelChange}
          modelOptionsByProvider={{
            ...EMPTY_BY_PROVIDER,
            codex: [{ slug: model, name: "Private Model" }],
          }}
        />,
      );
      const available = page.getByRole("menuitem", { name: /Private Model/u });
      await expect.element(available).not.toHaveAttribute("aria-disabled", "true");
      await available.click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", model, { instanceId: "codex" });
    } finally {
      await screen.unmount();
    }
  });

  it("renders the effort ladder as a footer slider and commits keyboard steps", async () => {
    const screen = await mountPicker({ effortControl: "slider" }, { reasoningEffort: "medium" });
    try {
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
      // The slider card owns effort and speed, so their rows are gone.
      expect(page.getByRole("menuitem", { name: /^Effort/u }).elements()).toHaveLength(0);
      expect(page.getByRole("menuitem", { name: /^Speed/u }).elements()).toHaveLength(0);

      await slider.element().focus();
      await userEvent.keyboard("{ArrowRight}");

      await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
        provider: "codex",
        options: { reasoningEffort: "high" },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("warns about faster usage only above the model's default effort tier", async () => {
    const high = await mountPicker({ effortControl: "slider" }, { reasoningEffort: "high" });
    try {
      await expect
        .element(page.getByRole("slider", { name: "Reasoning effort" }))
        .toHaveAttribute("aria-valuetext", "High");
      await expect.element(page.getByText("Consumes usage limits faster")).toBeVisible();
    } finally {
      await high.unmount();
    }

    const standard = await mountPicker({ effortControl: "slider" }, { reasoningEffort: "medium" });
    try {
      await expect
        .element(page.getByRole("slider", { name: "Reasoning effort" }))
        .toHaveAttribute("aria-valuetext", "Medium");
      await expect.element(page.getByText("Consumes usage limits faster")).not.toBeInTheDocument();
    } finally {
      await standard.unmount();
    }
  });

  it("renders the Codex picker copy through the zh-CN localization", async () => {
    localizationTestState.locale = "zh-CN";
    try {
      const ASTRA = "gpt-6-astra" as ModelSlug;
      const screen = await mountPicker(
        {
          effortControl: "slider",
          modelOptionsByProvider: {
            ...MODEL_OPTIONS_BY_PROVIDER,
            codex: [
              { slug: ASTRA, name: "6 Astra" },
              { slug: GPT_5_5, name: "GPT-5.5" },
            ],
          },
        },
        { reasoningEffort: "high" },
      );
      try {
        await expect.element(page.getByText("选择模型")).toBeVisible();
        await expect
          .element(page.getByRole("menuitem", { name: /默认/u }))
          .toHaveTextContent("推荐模型集");
        await expect.element(page.getByText("更快消耗使用额度")).toBeVisible();
        await expect.element(page.getByRole("slider", { name: "推理强度" })).toBeVisible();
      } finally {
        await screen.unmount();
      }
    } finally {
      localizationTestState.locale = "en";
    }
  });

  it("keeps the panel open after switching model in slider mode so the slider stays usable", async () => {
    // Mirror the app: a picked model lands in the draft store and flows back as props.
    const onProviderModelChange = vi.fn((_provider: ProviderKind, model: ModelSlug) => {
      useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
        provider: "codex",
        model,
        options: { reasoningEffort: "medium" },
      });
    });
    const screen = await mountPicker(
      { effortControl: "slider", onProviderModelChange },
      { reasoningEffort: "medium" },
    );
    try {
      const otherModel = page.getByRole("menuitem", { name: /GPT-5\.4/u });
      // Slider mode drops the per-row effort side block: the footer slider owns effort.
      await otherModel.hover();
      expect(page.getByRole("menuitemradio").elements()).toHaveLength(0);

      await otherModel.click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_4, { instanceId: "codex" });
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(slider).toBeVisible();
      await expect.element(otherModel).toHaveAttribute("aria-current", "true");

      // Picking the model that is already current is the "done" gesture.
      await otherModel.click();
      await expect.element(slider).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the trigger's size while the slider panel is open", async () => {
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: GPT_5_5,
      options: { reasoningEffort: "medium" },
    });
    const screen = await render(<Harness effortControl="slider" />);
    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" });
      const closedWidth = trigger.element().getBoundingClientRect().width;
      await trigger.click();

      // The covered label keeps sizing the pill; a resize under the cursor would make
      // Base UI cancel the open on mouseup.
      await expect.element(page.getByText("Select effort")).toBeVisible();
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(slider).toBeVisible();
      expect(trigger.element().getBoundingClientRect().width).toBeCloseTo(closedWidth, 1);

      // The panel still settles its own focus right after open and can steal it
      // back mid-typing, so step the thumb directly; each step must commit before
      // the next, since back-to-back keydowns would read the stale value.
      slider
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
      slider
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await expect.element(slider).toHaveAttribute("aria-valuetext", "Extra High");
      expect(trigger.element().getBoundingClientRect().width).toBeCloseTo(closedWidth, 1);
    } finally {
      await screen.unmount();
    }
  });

  it("toggles fast mode and resets both controls from the slider card", async () => {
    const screen = await mountPicker({ effortControl: "slider" }, { reasoningEffort: "xhigh" });
    try {
      const fastToggle = page.getByRole("button", { name: "Fast mode" });
      await fastToggle.click();
      await expect.element(fastToggle).toHaveAttribute("aria-pressed", "true");

      const reset = page.getByRole("button", { name: "Reset effort and speed" });
      await reset.click();

      await expect
        .element(page.getByRole("slider", { name: "Reasoning effort" }))
        .toHaveAttribute("aria-valuetext", "Medium");
      await expect.element(fastToggle).toHaveAttribute("aria-pressed", "false");
      await expect.element(reset).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a started thread on its provider", async () => {
    const screen = await mountPicker({ lockedProvider: "codex" }, undefined, [
      { provider: "claudeAgent", model: SONNET, effort: null, fastMode: null, thinking: null },
    ]);
    try {
      await openSources();
      expect(sourceOption("Claude").elements()).toHaveLength(0);
      await sourceOption("Starred").click();
      expect(page.getByRole("menuitem", { name: /Claude Sonnet/u }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});

describe("ComposerModelPicker with several accounts", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    localStorage.removeItem(STARRED_MODELS_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  const multiAccount: HarnessProps = {
    providers: [readyProvider("codex"), WORK_ACCOUNT_STATUS, readyProvider("claudeAgent")],
    providerInstances: CODEX_ACCOUNTS,
    modelOptionsByProviderInstance: WORK_ACCOUNT_MODELS,
  };

  it("lists each enabled account as its own named source", async () => {
    const screen = await mountPicker({
      ...multiAccount,
      providerInstances: [
        ...CODEX_ACCOUNTS,
        {
          instanceId: "codex_old",
          provider: "codex",
          label: "Old",
          enabled: false,
          isDefault: false,
        },
      ],
    });
    try {
      await expectActiveSource("Codex");
      await openSources();
      await expect.element(sourceOption("Codex")).toHaveAttribute("aria-checked", "true");
      // A local CLI sign-in says so beside its name.
      expect(sourceOption("Codex · Work").element().textContent).toContain("Local");
      // A disabled account is managed in settings, not offered in the picker.
      expect(sourceOption(/Old/u).elements()).toHaveLength(0);
      await expect.element(sourceOption("Claude")).toBeVisible();
      await sourceOption("Codex · Work").click();
      await expectActiveSource("Codex · Work");
    } finally {
      await screen.unmount();
    }
  });

  it("lists the account's own models and commits them with its id", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ ...multiAccount, onProviderModelChange });
    try {
      await selectSource("Codex · Work");
      await expect
        .element(page.getByRole("menuitem", { name: /GPT-5\.5/u }))
        .not.toBeInTheDocument();
      await page.getByRole("menuitem", { name: /GPT-5 Work/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_WORK, {
        instanceId: "codex_work",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("names the composer's account on the trigger and dots it with its accent color", async () => {
    const screen = await mountPicker({
      ...multiAccount,
      selectedProviderInstanceId: "codex_work",
      providerInstances: [CODEX_ACCOUNTS[0]!, { ...CODEX_ACCOUNTS[1]!, accentColor: "#16a34a" }],
    });
    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" }).element();
      const dot = trigger.querySelector<HTMLElement>("[data-accent]");
      expect(dot?.dataset.accent).toBe("#16a34a");
      // The account's name is written before the model.
      expect(trigger.textContent).toContain("Work");
    } finally {
      await screen.unmount();
    }
  });

  it("dots a lone account that has an accent color without naming it", async () => {
    const screen = await mountPicker({
      providerInstances: [{ ...CODEX_ACCOUNTS[0]!, accentColor: "#2563eb" }],
    });
    try {
      await openSources();
      const option = sourceOption("Codex").element();
      expect(option.textContent).not.toContain("Work");
      expect(option.querySelector<HTMLElement>("[data-accent]")?.dataset.accent).toBe("#2563eb");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a started thread on its account and explains the closed sibling", async () => {
    const screen = await mountPicker({ ...multiAccount, lockedProvider: "codex" });
    try {
      await openSources();
      const workSource = sourceOption("Codex · Work");
      await expect.element(workSource).toHaveAttribute("aria-disabled", "true");
      await expect
        .element(workSource)
        .toHaveAttribute(
          "title",
          "Codex · Work is unavailable in this thread. Start a new thread to switch accounts.",
        );
      await workSource.click({ force: true });
      await expectActiveSource("Codex");
      expect(sourceOption("Claude").elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("opens other providers for a handoff but keeps the thread's account", async () => {
    const screen = await mountPicker({
      ...multiAccount,
      boundProviderInstance: { provider: "codex", instanceId: "codex" },
    });
    try {
      await openSources();
      // Another provider is pickable: choosing it hands the thread off.
      await expect.element(sourceOption("Claude")).not.toHaveAttribute("aria-disabled", "true");
      // A sibling account of the thread's own provider stays closed.
      await expect.element(sourceOption("Codex · Work")).toHaveAttribute("aria-disabled", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("lists Moss first, says how each source is reached, and links to model management", async () => {
    const screen = await mountPicker({
      providers: [
        readyProvider("codex"),
        { ...readyProvider("codex"), instanceId: "codex_moss", displayName: "Moss" },
        readyProvider("claudeAgent"),
      ],
      providerInstances: [
        CODEX_ACCOUNTS[0]!,
        {
          instanceId: "codex_moss",
          provider: "codex",
          label: "Moss",
          enabled: true,
          isDefault: false,
        },
      ],
    });
    try {
      await openSources();
      const options = page.getByRole("menuitemradio").elements();
      expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
        null,
        "Moss · Codex",
        "Codex",
        "Claude",
      ]);
      expect(sourceOption("Moss · Codex").element().textContent).toContain("Personal");
      expect(sourceOption("Codex").element().textContent).toContain("Local");
      await expect.element(page.getByRole("menuitem", { name: "Manage models" })).toBeVisible();

      await sourceOption("Moss · Codex").click();
      await expectActiveSource("Moss · Codex");
    } finally {
      await screen.unmount();
    }
  });

  it("offers a started thread only its own account's starred presets", async () => {
    const screen = await mountPicker({ ...multiAccount, lockedProvider: "codex" }, undefined, [
      { provider: "codex", model: GPT_5_4, effort: null, fastMode: null, thinking: null },
      {
        provider: "codex",
        instanceId: "codex_work",
        model: GPT_5_WORK,
        effort: null,
        fastMode: null,
        thinking: null,
      },
    ]);
    try {
      await selectSource("Starred");
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.4/u })).toBeVisible();
      expect(page.getByRole("menuitem", { name: /GPT-5 Work/u }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("invites the user to set up an account that is not signed in", async () => {
    const screen = await mountPicker({
      ...multiAccount,
      providers: [
        readyProvider("codex"),
        {
          ...WORK_ACCOUNT_STATUS,
          authStatus: "unauthenticated",
          message: "Run codex login.",
        },
        readyProvider("claudeAgent"),
      ],
    });
    try {
      await selectSource("Codex · Work");
      await expect
        .element(page.getByText("Open provider setup to sign in to this account."))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Open provider setup" })).toBeVisible();
      // Its catalog is not offered while it cannot run.
      expect(page.getByRole("menuitem", { name: /GPT-5 Work/u }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("names the account on each starred preset", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await mountPicker({ ...multiAccount, onProviderModelChange }, undefined, [
      { provider: "codex", model: GPT_5_4, effort: null, fastMode: null, thinking: null },
      {
        provider: "codex",
        instanceId: "codex_work",
        model: GPT_5_WORK,
        effort: null,
        fastMode: null,
        thinking: null,
      },
    ]);
    try {
      await expect.element(page.getByRole("menuitem", { name: /GPT-5\.4.*Codex/u })).toBeVisible();
      await page.getByRole("menuitem", { name: /GPT-5 Work.*Work/u }).click();
      expect(onProviderModelChange).toHaveBeenCalledWith("codex", GPT_5_WORK, {
        instanceId: "codex_work",
      });
    } finally {
      await screen.unmount();
    }
  });
});

describe("Claude composer budget suffix", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });
  it.each([
    ["claude-fable-5-1", "Fable 5.1", "high", "(1M)", false, "Fable 5.1High(1M)"],
    ["claude-opus-4-7", "Opus", undefined, "(1M)", false, "OpusHigh(1M)"],
    ["claude-fable-5-1", "Fable 5.1", "high", "(1M)", true, "Fable 5.1High(1M)"],
  ] as const)(
    "renders %s %s %s %s compact=%s",
    async (slug, name, effort, label, compact, expected) => {
      const snapshot = {
        ...deriveSelectedContextWindowSnapshot("1m")!,
        maxTokens: 967000,
        claudeCache: {
          model: `${slug}[1m]`,
          observedAt: "2026-09-17T00:00:00.000Z",
          state: "unknown" as const,
          source: "request-usage" as const,
        },
      };
      const runtimeLabel = deriveComposerContextWindowLabel({
        provider: "claudeAgent",
        model: slug,
        snapshot,
        status: deriveContextWindowSelectionStatus({
          activeSnapshot: snapshot,
          appliedValue: "1m",
          selectedValue: "1m",
        }),
      });
      const screen = await render(
        <ComposerModelPicker
          provider="claudeAgent"
          model={slug as ModelSlug}
          lockedProvider={null}
          modelOptionsByProvider={{
            ...EMPTY_BY_PROVIDER,
            claudeAgent: [{ slug: slug as ModelSlug, name }],
          }}
          onProviderModelChange={vi.fn()}
          threadId={THREAD_ID}
          modelOptions={{ ...(effort ? { effort } : {}), fastMode: true }}
          prompt=""
          onPromptChange={vi.fn()}
          contextWindowLabel={label === "(1M)" ? runtimeLabel : label}
          hideModelLabel={compact}
          hideStatusLabel={compact}
        />,
      );
      const button = page.getByRole("button", { name: "Change model and reasoning" });
      expect(button.element().textContent).toBe(expected);
      if (compact) {
        await expect.element(button).toHaveAttribute("title", `Fable 5.1 · High · ${label}`);
        expect(button.element().getBoundingClientRect().width).toBeLessThan(150);
      }
      await screen.unmount();
    },
  );
});
