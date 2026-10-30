import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { translateMoss, formatMossTranslation } from "~/localization";
import type {
  ImageGenerationLimitFailure,
  ImageGenerationLimitPresentation,
} from "./imageGenerationLimit.logic";
import { ImageGenerationLimitBanner } from "./ImageGenerationLimitBanner";

const localeState = vi.hoisted(() => ({ locale: "en" as "en" | "zh-CN" }));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localeState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localeState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Record<string, string | number>,
      ) => actual.formatMossTranslation(localeState.locale, key, values),
    }),
  };
});

const failure: ImageGenerationLimitFailure = {
  providerInstanceId: "codex",
  threadId: "thread-image-limit",
  turnId: "turn-image",
  activityId: "activity-image-limit",
  createdAt: "2026-12-01T00:00:00.000Z",
  completionTimeMs: Date.parse("2026-12-01T00:00:00.000Z"),
  resetsAt: Date.parse("2026-12-02T10:30:00.000Z") / 1_000,
  failureIdentity: "codex\u001fthread-image-limit\u001fturn-image\u001factivity-image-limit\u001f1",
};

function presentation(
  variant: ImageGenerationLimitPresentation["variant"],
  action: ImageGenerationLimitPresentation["action"],
): ImageGenerationLimitPresentation {
  return { sourceKind: variant === "managed" ? "moss" : "personal", variant, action };
}

describe("ImageGenerationLimitBanner", () => {
  it("matches the dedicated banner class contract, exact gauge geometry, and button order", () => {
    const markup = renderToStaticMarkup(
      <ImageGenerationLimitBanner
        failure={failure}
        nowMs={Date.parse("2026-12-01T00:00:00.000Z")}
        onDismiss={() => undefined}
        onPrimaryAction={() => undefined}
        presentation={presentation("upgrade-plus", "personal-usage")}
      />,
    );

    expect(markup).toContain(
      "relative isolate flex w-full overflow-hidden rounded-2xl border bg-surface py-2 ps-3 pe-2 text-ui-lg shadow-xs lg:mx-auto electron:border-0 electron:ring-[0.5px] electron:ring-border-strong border-primary-outline text-default items-center gap-4 max-[400px]:items-start max-[400px]:gap-2",
    );
    expect(markup).toContain('aria-hidden="true" class="absolute inset-0 -z-10 bg-primary-soft"');
    expect(markup).toContain('height="20" viewBox="0 0 20 20" width="20"');
    expect(markup).toContain('d="M5.05 15.45a7 7 0 1 1 9.9 0"');
    expect(markup).toContain('d="M10 11.5l2.9-3.4"');
    expect(markup).toContain("Upgrade to ChatGPT Plus");
    expect(markup.indexOf("Upgrade")).toBeLessThan(markup.indexOf("Dismiss"));
    expect(markup).toContain('data-testid="image-generation-limit-primary"');
    expect(markup).toContain('data-testid="image-generation-limit-dismiss"');
    expect(markup).toContain("max-[400px]:flex-col");
    expect(markup).toContain("max-[400px]:hidden");
  });

  it("renders retry and Dismiss only for neutral profile/unknown cases", () => {
    localeState.locale = "zh-CN";
    const markup = renderToStaticMarkup(
      <ImageGenerationLimitBanner
        failure={{ ...failure, resetsAt: null }}
        onDismiss={() => undefined}
        presentation={{ sourceKind: "profile", variant: "retry", action: null }}
      />,
    );
    expect(markup).toContain("图片生成次数已达上限");
    expect(markup).toContain("请稍后重试。");
    expect(markup).toContain("忽略");
    expect(markup).not.toContain('data-testid="image-generation-limit-primary"');
  });

  it("uses Moss-owned managed copy and View usage action", () => {
    localeState.locale = "en";
    const markup = renderToStaticMarkup(
      <ImageGenerationLimitBanner
        failure={failure}
        nowMs={Date.parse("2026-12-01T00:00:00.000Z")}
        onDismiss={() => undefined}
        onPrimaryAction={() => undefined}
        presentation={presentation("managed", "managed-usage")}
      />,
    );
    expect(markup).toContain("Moss image creation limit reached");
    expect(markup).toContain("Moss image creation is temporarily limited");
    expect(markup).toContain("View usage");
    expect(markup).not.toContain("ChatGPT Plus");
    expect(markup).not.toContain("Add Credits");
  });

  it("keeps every user-facing action and reset string typed through localization", () => {
    expect(translateMoss("en", "chat.imageGenerationLimit.action.dismiss")).toBe("Dismiss");
    expect(translateMoss("zh-CN", "chat.imageGenerationLimit.action.dismiss")).toBe("忽略");
    expect(
      formatMossTranslation("en", "chat.imageGenerationLimit.message.retryAt", {
        resetDate: "Dec 2, 2026, 2:30 AM",
      }),
    ).toContain("Dec 2, 2026");
  });
});
