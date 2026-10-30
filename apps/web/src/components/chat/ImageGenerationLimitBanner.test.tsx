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
    expect(markup).toContain(
      'd="M10.8343 12.0693C10.0371 12.5295 9.01783 12.2564 8.55759 11.4592C8.09735 10.6621 8.37048 9.64276 9.16763 9.18253C10.1299 8.62697 14.0533 7.64478 14.3311 8.1259C14.6089 8.60703 11.7966 11.5137 10.8343 12.0693Z"',
    );
    expect(markup).toContain(
      'd="M16.585 10.25C16.585 6.6132 13.6368 3.66504 10 3.66504C6.3632 3.66504 3.41504 6.6132 3.41504 10.25C3.41504 12.4001 4.44494 14.31 6.04102 15.5127L6.36719 15.7432L6.47168 15.8291C6.68974 16.0482 6.73203 16.3973 6.55469 16.665C6.3772 16.9328 6.03875 17.0306 5.75195 16.915L5.63281 16.8516L5.24023 16.5752C3.32482 15.1316 2.08496 12.8355 2.08496 10.25C2.08496 5.87867 5.62867 2.33496 10 2.33496C14.3713 2.33496 17.915 5.87867 17.915 10.25C17.915 13.0079 16.5037 15.4356 14.3672 16.8516L14.248 16.915C13.9612 17.0306 13.6228 16.9328 13.4453 16.665C13.2425 16.3589 13.3267 15.946 13.6328 15.7432L13.959 15.5127C15.5551 14.31 16.585 12.4001 16.585 10.25Z"',
    );
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
