// FILE: ThreadHoverCardContent.browser.tsx
// Purpose: Verifies sidebar thread hover metadata: catalog-driven effort/Fast updates and locale-following effort labels.
// Layer: Browser UI test

import "../index.css";

import { ThreadId, type ProviderModelDescriptor } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
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

import { providerModelsQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { translateMoss } from "../localization";
import { ThreadHoverCardContent } from "./ThreadHoverCardContent";

// Known only from an account's runtime catalog (no static model entry describes it), so its
// effort and Fast labels must wait for that account's catalog.
const runtimeModel: ProviderModelDescriptor = {
  slug: "gpt-runtime-only",
  name: "GPT Runtime Only",
  supportedReasoningEfforts: [
    { value: "medium", label: "Medium" },
    { value: "xhigh", label: "Extra High" },
  ],
  defaultReasoningEffort: "medium",
  supportsFastMode: true,
};

it("updates hover effort and Fast from the selected account's cached catalog", async () => {
  const client = new QueryClient();
  const catalog = providerModelsQueryOptions({ provider: "codex", instanceId: "codex_work" });
  client.setQueryData(
    providerModelsQueryOptions({ provider: "codex", instanceId: "codex_personal" }).queryKey,
    { models: [runtimeModel], source: "codex", cached: true },
  );
  const renderCard = (instanceId: string) => (
    <QueryClientProvider client={client}>
      <div className="w-64">
        <ThreadHoverCardContent
          threadId={ThreadId.makeUnsafe("hover-model")}
          title="Review hover metadata"
          timeLabel="now"
          projectName={null}
          projectCwd={null}
          projectAppearance={null}
          sourceProjectName={null}
          branch={null}
          worktreeName={null}
          pullRequest={null}
          onOpenPullRequest={() => {}}
          status={null}
          model={{
            provider: "codex",
            instanceId,
            model: runtimeModel.slug,
            options: { reasoningEffort: "xhigh", fastMode: true },
          }}
          modelCatalogQueryOptions={providerModelsQueryOptions({ provider: "codex", instanceId })}
        />
      </div>
    </QueryClientProvider>
  );
  const screen = await render(renderCard("codex_work"));
  try {
    await expect.element(screen.getByText("Extra High")).not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("Fast mode")).not.toBeInTheDocument();
    client.setQueryData(catalog.queryKey, {
      models: [runtimeModel],
      source: "codex",
      cached: true,
    });
    await expect.element(screen.getByText("Extra High")).toBeVisible();
    await expect.element(screen.getByLabelText("Fast mode")).toBeVisible();
    await screen.rerender(renderCard("codex_other"));
    await expect
      .element(screen.getByText("Extra High"), { timeout: 1_000 })
      .not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("Fast mode")).not.toBeInTheDocument();
    expect(client.isFetching()).toBe(0);
  } finally {
    await screen.unmount();
    client.clear();
  }
});

describe("ThreadHoverCardContent locale", () => {
  afterEach(() => {
    localizationTestState.locale = "en";
    document.body.innerHTML = "";
  });

  async function renderHoverCard(locale: "en" | "zh-CN") {
    localizationTestState.locale = locale;
    const client = new QueryClient();
    return render(
      <QueryClientProvider client={client}>
        <ThreadHoverCardContent
          threadId={ThreadId.makeUnsafe("hover-locale")}
          title="Localized thread"
          timeLabel={null}
          projectName={null}
          projectCwd={null}
          sourceProjectName={null}
          branch={null}
          worktreeName={null}
          projectAppearance={null}
          pullRequest={null}
          onOpenPullRequest={() => {}}
          model={{
            provider: "codex",
            instanceId: "codex",
            model: "gpt-5.5",
            options: { reasoningEffort: "high" },
          }}
          modelCatalogQueryOptions={providerModelsQueryOptions({
            provider: "codex",
            instanceId: "codex",
          })}
          status={null}
        />
      </QueryClientProvider>,
    );
  }

  it("renders the model effort in English", async () => {
    const screen = await renderHoverCard("en");
    await expect.element(screen.getByText(translateMoss("en", "chat.effort.high"))).toBeVisible();
  });

  it("renders the model effort in Chinese", async () => {
    const screen = await renderHoverCard("zh-CN");
    await expect
      .element(screen.getByText(translateMoss("zh-CN", "chat.effort.high")))
      .toBeVisible();
  });
});
