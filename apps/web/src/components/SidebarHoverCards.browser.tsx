import "../index.css";

import { ThreadId } from "@moss/contracts";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { computedColorAlpha, installGlassOverlayCutout } from "~/lib/glassOverlayCutout";

import {
  createProjectHoverCardAnchor,
  createThreadHoverCardAnchor,
} from "./sidebarHoverCardAnchors";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import { ThreadHoverCardContent } from "./ThreadHoverCardContent";
import { providerModelsQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function HoverCards({
  kind,
  onOpen,
}: {
  kind: "thread" | "project";
  onOpen: (id: string) => void;
}) {
  const Card = kind === "thread" ? Tooltip : PreviewCard;
  const Trigger = kind === "thread" ? TooltipTrigger : PreviewCardTrigger;
  const Popup = kind === "thread" ? TooltipPopup : PreviewCardPopup;
  return (
    <div data-slot="sidebar-container" className="w-72 p-2">
      {["First", "Second"].map((id) => (
        <Card key={id} onOpenChange={(open) => open && onOpen(id)}>
          <Trigger
            {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
            render={
              <button
                type="button"
                className="mb-1 block h-9 w-full text-left"
                data-thread-hover-anchor={id}
                data-project-hover-anchor={id}
              />
            }
          >
            {id} row
          </Trigger>
          <Popup
            {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
            anchor={
              kind === "thread" ? createThreadHoverCardAnchor(id) : createProjectHoverCardAnchor(id)
            }
            className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
          >
            <button type="button" className="w-full p-4">
              {id} card action
            </button>
          </Popup>
        </Card>
      ))}
    </div>
  );
}

describe.each(["thread", "project"] as const)("sidebar %s hover cards", (kind) => {
  it.each(["sidebar", "window"])(
    "keeps the app's clipping stable while hovering in %s glass",
    async (scope) => {
      await page.viewport(1280, 800);
      const html = document.documentElement;
      const previousMaterial = html.dataset.windowMaterial;
      const previousScope = html.dataset.windowTranslucency;
      html.dataset.windowMaterial = "translucent";
      html.dataset.windowTranslucency = scope;
      const root = document.createElement("div");
      root.style.cssText = "position:fixed;inset:0";
      document.body.append(root);
      // The preceding case finishes with its pointer over the second card.
      // Move onto the empty backdrop before mounting new hover triggers.
      await page.elementLocator(root).hover({ position: { x: 900, y: 650 } });
      const dispose = installGlassOverlayCutout(root);
      const opened: string[] = [];
      const mounted = await render(<HoverCards kind={kind} onOpen={(id) => opened.push(id)} />, {
        container: root,
      });
      const clips: string[] = [];
      const observer = new MutationObserver(() => clips.push(root.style.clipPath));
      observer.observe(root, { attributes: true, attributeFilter: ["style"] });
      try {
        for (const name of ["First", "Second"]) {
          await page.getByRole("button", { name: `${name} row`, exact: true }).hover();
          const action = page.getByRole("button", { name: `${name} card action`, exact: true });
          await expect.element(action).toBeVisible();
          // Cover the fade and scale transition, including intermediate root clips.
          await new Promise((resolve) => window.setTimeout(resolve, 400));
          await action.hover();
          await expect.element(action).toBeVisible();
          const popup = action.element().closest<HTMLElement>(".app-popup-surface")!;
          expect(
            computedColorAlpha(getComputedStyle(popup).backgroundColor),
          ).toBeGreaterThanOrEqual(0.95);
          expect(getComputedStyle(popup, "::before").backdropFilter).toBe("none");
          expect(root.style.clipPath).toBe("");
          expect(clips.filter(Boolean)).toEqual([]);
        }
        expect(opened).toEqual(["First", "Second"]);
      } finally {
        observer.disconnect();
        await mounted.unmount();
        dispose();
        root.remove();
        if (previousMaterial === undefined) delete html.dataset.windowMaterial;
        else html.dataset.windowMaterial = previousMaterial;
        if (previousScope === undefined) delete html.dataset.windowTranslucency;
        else html.dataset.windowTranslucency = previousScope;
      }
    },
  );
});

// A provider can name a chat after its whole first message. The hover card must stay
// the compact summary (title, time, status, project, model), not show that prompt.
const PASTED_PROMPT_TITLE = [
  "以下是一次会话(session_id: 7f3c2a1e-58b4-4d0e-9a61-2c7e0d4b9f13)的会话摘要与段摘要，请根据这些内容继续完成用户的任务。",
  "会话摘要：用户希望把一个旧的 Node 服务迁移到新的部署平台，并在迁移后验证所有接口仍然可用。",
  "段摘要 1：确认了项目结构，找到了入口文件 server.js 与 cron.js。",
  "段摘要 2：梳理了环境变量，发现配置分散在三个 .env 文件里，需要合并。",
  "请先阅读上面的摘要，再继续下一步。",
].join("\n\n");

describe("sidebar thread hover card content", () => {
  it("clamps a pasted-prompt title to two lines at the shared card width", async () => {
    await page.viewport(1280, 800);
    const mounted = await render(
      <div className="w-72 p-2">
        <Tooltip open>
          <TooltipTrigger render={<div data-thread-hover-anchor="long" className="h-9 w-full" />}>
            Long title row
          </TooltipTrigger>
          <TooltipPopup
            {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
            viewportClassName="[--viewport-inline-padding:0px] py-0"
            anchor={createThreadHoverCardAnchor("long")}
            className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
          >
            <ThreadHoverCardContent
              threadId={ThreadId.makeUnsafe("hover-long-title")}
              title={PASTED_PROMPT_TITLE}
              timeLabel="1m"
              projectName="Moss"
              projectCwd={null}
              projectAppearance={null}
              sourceProjectName={null}
              branch={null}
              worktreeName={null}
              pullRequest={null}
              onOpenPullRequest={() => {}}
              model={null}
              modelCatalogQueryOptions={providerModelsQueryOptions({
                provider: "codex",
                instanceId: "codex",
              })}
              status={{
                label: "Connecting",
                colorClass: "text-sky-600",
                dotClass: "bg-sky-500",
                pulse: true,
              }}
            />
          </TooltipPopup>
        </Tooltip>
      </div>,
    );
    try {
      const title = page.getByText(/^以下是一次会话/u);
      await expect.element(title).toBeVisible();
      await expect.element(page.getByText("Connecting", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Moss", { exact: true })).toBeVisible();
      const titleElement = title.element() as HTMLElement;
      const lineHeight = Number.parseFloat(getComputedStyle(titleElement).lineHeight);
      expect(getComputedStyle(titleElement).webkitLineClamp).toBe("2");
      expect(titleElement.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight * 2 + 1);
      const popup = titleElement.closest<HTMLElement>(".app-popup-surface")!;
      const card = popup.getBoundingClientRect();
      const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      expect(card.width).toBeCloseTo(16 * rootFontSize, 0);
      // Title (two lines) plus three compact rows, nowhere near a screenful.
      expect(card.height).toBeLessThan(140);
    } finally {
      await mounted.unmount();
    }
  });
});
