// FILE: designTemplates.ts
// Purpose: Built-in 设计 templates (landing page, phone app, poster, social post, wireframes,
//          a design-system starter) as ready DesignCanvas payloads.
// Layer: Shared model (templates.ts lists them; the server instantiates them for people and agents)
// Why: Every artboard reads the installed design system through `var(--ds-*)` with a fallback, so a
//      template looks right on its own and follows another system once one is installed.

import type { DesignBoard, DesignCanvas, DesignNote } from "./designCanvas";
import { BUILT_IN_DESIGN_SYSTEMS } from "./designSystems";

export interface DesignTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly canvas: DesignCanvas;
}

const PAGE = "page-1";
const moss = BUILT_IN_DESIGN_SYSTEMS[0]!;
const system = (copiedAt = "2026-11-13T00:00:00.000Z") => ({
  source: `builtin:${moss.id}`,
  name: moss.name,
  tokens: moss.tokens,
  copiedAt,
});
const board = (input: Omit<DesignBoard, "page"> & { page?: string }): DesignBoard => ({
  page: PAGE,
  ...input,
});
const canvas = (
  boards: DesignBoard[],
  notes: DesignNote[] = [],
  extra: Partial<DesignCanvas> = {},
): DesignCanvas => ({
  version: 1,
  pages: [{ id: PAGE, name: "页面 1" }],
  boards,
  notes,
  system: system(),
  ...extra,
});

const FONT = "font-family: var(--ds-font-sans, system-ui, sans-serif)";
const INK = "var(--ds-ink, #141413)";
const INK2 = "var(--ds-ink-secondary, #72726f)";
const PAPER = "var(--ds-paper, #fcfcfb)";
const PANEL = "var(--ds-panel, #fdfdfc)";
const LINE = "var(--ds-line, #ececeb)";
const ACCENT = "var(--ds-accent, #2a78d6)";
const FILL = "var(--ds-fill, #f3f3f2)";

const LANDING_HTML = `<div style="${FONT}; min-height: 100%; background: ${PAPER}; color: ${INK}">
<header style="max-width: 1200px; margin: 0 auto; padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap">
<strong style="font-size: 18px; font-weight: 500">[品牌名]</strong>
<nav style="display: flex; gap: 24px; font-size: 14px; color: ${INK2}; flex-wrap: wrap"><a href="#features" style="color: inherit; text-decoration: none">功能</a><a href="#pricing" style="color: inherit; text-decoration: none">价格</a><a href="#faq" style="color: inherit; text-decoration: none">常见问题</a></nav>
<a href="#start" style="padding: 8px 16px; border-radius: var(--ds-radius-control, 8px); background: ${INK}; color: ${PAPER}; font-size: 14px; text-decoration: none">免费开始</a>
</header>
<section style="max-width: 1200px; margin: 0 auto; padding: 96px 40px 72px; display: flex; flex-direction: column; gap: 20px; align-items: flex-start">
<span style="font-size: 13px; color: ${ACCENT}">[一句标签]</span>
<h1 style="margin: 0; font-size: 56px; line-height: 64px; font-weight: 500; max-width: 760px">[用一句话说清产品带来的结果]</h1>
<p style="margin: 0; font-size: 18px; line-height: 28px; color: ${INK2}; max-width: 620px">[补充两句：给谁用、解决什么问题、和现在的做法比好在哪里。]</p>
<div style="display: flex; gap: 12px; flex-wrap: wrap"><a href="#start" style="padding: 12px 20px; border-radius: var(--ds-radius-control, 8px); background: ${ACCENT}; color: #ffffff; text-decoration: none; font-size: 15px">免费开始</a><a href="#demo" style="padding: 12px 20px; border-radius: var(--ds-radius-control, 8px); border: 1px solid ${LINE}; color: ${INK}; text-decoration: none; font-size: 15px">看演示</a></div>
</section>
<section id="features" style="max-width: 1200px; margin: 0 auto; padding: 24px 40px 96px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px">
<div style="padding: 24px; border: 1px solid ${LINE}; border-radius: var(--ds-radius-card, 12px); background: ${PANEL}; display: flex; flex-direction: column; gap: 8px"><h3 style="margin: 0; font-size: 17px; font-weight: 500">[功能一]</h3><p style="margin: 0; font-size: 14px; line-height: 22px; color: ${INK2}">[这项功能为用户做了什么。]</p></div>
<div style="padding: 24px; border: 1px solid ${LINE}; border-radius: var(--ds-radius-card, 12px); background: ${PANEL}; display: flex; flex-direction: column; gap: 8px"><h3 style="margin: 0; font-size: 17px; font-weight: 500">[功能二]</h3><p style="margin: 0; font-size: 14px; line-height: 22px; color: ${INK2}">[这项功能为用户做了什么。]</p></div>
<div style="padding: 24px; border: 1px solid ${LINE}; border-radius: var(--ds-radius-card, 12px); background: ${PANEL}; display: flex; flex-direction: column; gap: 8px"><h3 style="margin: 0; font-size: 17px; font-weight: 500">[功能三]</h3><p style="margin: 0; font-size: 14px; line-height: 22px; color: ${INK2}">[这项功能为用户做了什么。]</p></div>
</section>
</div>`;

const phone = (
  title: string,
  body: string,
  nav: string,
) => `<div style="${FONT}; width: 390px; height: 844px; box-sizing: border-box; background: ${PAPER}; color: ${INK}; display: flex; flex-direction: column">
<header style="padding: 56px 20px 12px; display: flex; flex-direction: column; gap: 4px"><h1 style="margin: 0; font-size: 28px; line-height: 34px; font-weight: 500">${title}</h1></header>
<main style="flex: 1; padding: 8px 20px; display: flex; flex-direction: column; gap: 12px; overflow: hidden">${body}</main>
<nav style="height: 84px; box-sizing: border-box; padding: 10px 24px 28px; border-top: 1px solid ${LINE}; display: flex; justify-content: space-around; font-size: 12px; color: ${INK2}">${nav}</nav>
</div>`;
const tab = (label: string, target: string, active: boolean) =>
  `<a href="board:${target}" style="display: flex; align-items: center; justify-content: center; min-width: 64px; min-height: 44px; text-decoration: none; color: ${active ? ACCENT : INK2}">${label}</a>`;
const phoneNav = (active: string) =>
  [
    tab("首页", "home", active === "home"),
    tab("详情", "detail", active === "detail"),
    tab("我的", "profile", active === "profile"),
  ].join("");
const listItem = (title: string, meta: string) =>
  `<a href="board:detail" style="display: flex; flex-direction: column; gap: 4px; padding: 16px; border-radius: var(--ds-radius-card, 12px); background: ${FILL}; color: inherit; text-decoration: none"><strong style="font-size: 16px; font-weight: 500">${title}</strong><span style="font-size: 13px; color: ${INK2}">${meta}</span></a>`;

const POSTER_HTML = `<div style="font-family: var(--ds-font-serif, Georgia, serif); width: 1080px; height: 1350px; box-sizing: border-box; padding: 96px; background: var(--ds-paper, #f7f3ea); color: var(--ds-ink, #2a241c); display: flex; flex-direction: column; justify-content: space-between">
<div style="display: flex; flex-direction: column; gap: 24px"><span style="${FONT}; font-size: 24px; letter-spacing: 4px; color: var(--ds-accent, #9a3412)">[活动类型]</span><h1 style="margin: 0; font-size: 120px; line-height: 128px; font-weight: 500">[活动名称]</h1><p style="${FONT}; margin: 0; font-size: 32px; line-height: 46px; max-width: 760px">[一句话说明这场活动值得来的理由。]</p></div>
<div style="${FONT}; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px; font-size: 26px; line-height: 38px; border-top: 2px solid currentColor; padding-top: 40px"><div><div style="font-size: 20px; opacity: 0.7">时间</div>[日期 时间]</div><div><div style="font-size: 20px; opacity: 0.7">地点</div>[地点]</div><div><div style="font-size: 20px; opacity: 0.7">报名</div>[报名方式]</div></div>
</div>`;

const SOCIAL_HTML = `<div style="${FONT}; width: 1080px; height: 1080px; box-sizing: border-box; padding: 88px; background: ${INK}; color: ${PAPER}; display: flex; flex-direction: column; justify-content: space-between">
<span style="font-size: 28px; opacity: 0.7">[账号名]</span>
<h1 style="margin: 0; font-size: 96px; line-height: 108px; font-weight: 500">[一句足够短、能被记住的观点]</h1>
<div style="display: flex; align-items: center; justify-content: space-between; font-size: 28px"><span>[补充一句]</span><span style="padding: 12px 24px; border-radius: 999px; background: ${ACCENT}; color: #ffffff">[行动]</span></div>
</div>`;

const wire = (
  title: string,
  rows: string,
) => `<div style="font-family: system-ui, sans-serif; width: 1280px; height: 800px; box-sizing: border-box; background: #ffffff; color: #333333; display: flex; flex-direction: column">
<div style="height: 56px; border-bottom: 2px solid #cccccc; display: flex; align-items: center; gap: 24px; padding: 0 32px"><div style="width: 96px; height: 20px; background: #dddddd"></div><div style="flex: 1"></div><div style="width: 64px; height: 14px; background: #e6e6e6"></div><div style="width: 64px; height: 14px; background: #e6e6e6"></div></div>
<div style="flex: 1; display: flex; flex-direction: column; gap: 24px; padding: 40px 32px"><h2 style="margin: 0; font-size: 28px; font-weight: 500">${title}</h2>${rows}</div>
</div>`;
const box = (h: number, label: string) =>
  `<div style="height: ${h}px; border: 2px dashed #bbbbbb; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 14px; color: #888888">${label}</div>`;

const swatch = (name: string, label: string) =>
  `<div style="display: flex; flex-direction: column; gap: 8px"><div style="height: 72px; border-radius: var(--ds-radius-card, 12px); border: 1px solid ${LINE}; background: var(--ds-${name})"></div><strong style="font-size: 13px; font-weight: 500">${label}</strong><code style="font-size: 12px; color: ${INK2}">--ds-${name}</code></div>`;
const typeRow = (name: string, label: string) =>
  `<div style="display: flex; align-items: baseline; gap: 24px; padding: 16px 0; border-bottom: 1px solid ${LINE}"><span style="width: 120px; flex-shrink: 0; font-size: 12px; color: ${INK2}">${label}</span><span style="font-size: var(--ds-text-${name}-size); line-height: var(--ds-text-${name}-line); font-weight: var(--ds-text-${name}-weight)">安静、清楚的文字 Quiet type</span></div>`;

export const DESIGN_TEMPLATES: readonly DesignTemplate[] = [
  {
    id: "builtin:design-landing",
    title: "落地页",
    description: "网站首屏、功能区，手机上自动换行",
    canvas: canvas([
      board({
        id: "landing",
        name: "落地页",
        x: 0,
        y: 0,
        w: 1280,
        h: 900,
        html: LANDING_HTML,
        layout: "page",
        interactive: true,
      }),
    ]),
  },
  {
    id: "builtin:design-phone-app",
    title: "手机应用",
    description: "三屏可点击原型：首页、详情、我的",
    canvas: canvas(
      [
        board({
          id: "home",
          name: "首页",
          x: 0,
          y: 0,
          w: 390,
          h: 844,
          interactive: true,
          html: phone(
            "[应用名]",
            listItem("[第一项]", "[一行说明]") +
              listItem("[第二项]", "[一行说明]") +
              listItem("[第三项]", "[一行说明]"),
            phoneNav("home"),
          ),
        }),
        board({
          id: "detail",
          name: "详情",
          x: 470,
          y: 0,
          w: 390,
          h: 844,
          interactive: true,
          html: phone(
            "[详情标题]",
            `<div style="height: 220px; border-radius: var(--ds-radius-card, 12px); background: ${FILL}"></div><p style="margin: 0; font-size: 15px; line-height: 24px; color: ${INK2}">[这里写详情的内容。]</p><a href="board:home" style="margin-top: auto; display: flex; align-items: center; justify-content: center; min-height: 48px; border-radius: var(--ds-radius-control, 8px); background: ${ACCENT}; color: #ffffff; text-decoration: none; font-size: 16px">[主要操作]</a>`,
            phoneNav("detail"),
          ),
        }),
        board({
          id: "profile",
          name: "我的",
          x: 940,
          y: 0,
          w: 390,
          h: 844,
          interactive: true,
          html: phone(
            "我的",
            `<div style="display: flex; align-items: center; gap: 12px"><div style="width: 56px; height: 56px; border-radius: 999px; background: ${FILL}"></div><div style="display: flex; flex-direction: column; gap: 2px"><strong style="font-size: 17px; font-weight: 500">[昵称]</strong><span style="font-size: 13px; color: ${INK2}">[一行介绍]</span></div></div>` +
              listItem("设置", "通知、隐私、账号") +
              listItem("帮助与反馈", "常见问题、联系我们"),
            phoneNav("profile"),
          ),
        }),
      ],
      [
        {
          id: "flow-title",
          page: PAGE,
          kind: "title",
          x: 0,
          y: -260,
          w: 1330,
          text: "[应用名] 主要流程",
        },
      ],
      { launch: { view: "canvas" } },
    ),
  },
  {
    id: "builtin:design-poster",
    title: "活动海报",
    description: "1080×1350 竖版海报，衬线大标题",
    canvas: {
      ...canvas([
        board({ id: "poster", name: "海报", x: 0, y: 0, w: 1080, h: 1350, html: POSTER_HTML }),
      ]),
      system: {
        ...system(),
        source: "builtin:editorial",
        name: BUILT_IN_DESIGN_SYSTEMS[1]!.name,
        tokens: BUILT_IN_DESIGN_SYSTEMS[1]!.tokens,
      },
    },
  },
  {
    id: "builtin:design-social",
    title: "社交图文",
    description: "1080×1080 方图，一句观点加行动",
    canvas: canvas([
      board({ id: "post", name: "方图", x: 0, y: 0, w: 1080, h: 1080, html: SOCIAL_HTML }),
    ]),
  },
  {
    id: "builtin:design-wireframe",
    title: "线框图",
    description: "三张低保真页面，先定结构再上样式",
    canvas: canvas(
      [
        board({
          id: "wire-list",
          name: "列表页",
          x: 0,
          y: 0,
          w: 1280,
          h: 800,
          html: wire("[列表页]", box(48, "筛选栏") + box(420, "列表")),
        }),
        board({
          id: "wire-detail",
          name: "详情页",
          x: 1360,
          y: 0,
          w: 1280,
          h: 800,
          html: wire("[详情页]", box(300, "主图") + box(180, "说明")),
        }),
        board({
          id: "wire-form",
          name: "表单页",
          x: 2720,
          y: 0,
          w: 1280,
          h: 800,
          html: wire(
            "[表单页]",
            box(64, "字段") + box(64, "字段") + box(64, "字段") + box(48, "提交"),
          ),
        }),
      ],
      [
        {
          id: "wire-note",
          page: PAGE,
          kind: "sticky",
          x: 0,
          y: 920,
          w: 280,
          text: "先在这里确认页面结构，再让 Moss 按设计系统出高保真稿。",
          color: "yellow",
        },
      ],
    ),
  },
  {
    id: "builtin:design-system",
    title: "设计系统",
    description: "颜色、文字和组件预览；其他设计可以使用它",
    canvas: canvas(
      [
        board({
          id: "colors",
          name: "颜色",
          x: 0,
          y: 0,
          w: 960,
          h: 520,
          html: `<div style="${FONT}; width: 960px; height: 520px; box-sizing: border-box; padding: 48px; background: ${PAPER}; color: ${INK}; display: flex; flex-direction: column; gap: 24px"><h1 style="margin: 0; font-size: 22px; font-weight: 500">颜色</h1><div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px">${moss.tokens.colors
            .slice(0, 8)
            .map((token) => swatch(token.name, token.label))
            .join("")}</div></div>`,
        }),
        board({
          id: "type",
          name: "文字",
          x: 1040,
          y: 0,
          w: 960,
          h: 520,
          html: `<div style="${FONT}; width: 960px; height: 520px; box-sizing: border-box; padding: 48px; background: ${PAPER}; color: ${INK}; display: flex; flex-direction: column"><h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 500">文字</h1>${moss.tokens.text
            .slice(0, 6)
            .map((style) => typeRow(style.name, style.label))
            .join("")}</div>`,
        }),
        board({
          id: "components",
          name: "组件",
          x: 0,
          y: 640,
          w: 960,
          h: 420,
          html: `<div style="${FONT}; width: 960px; height: 420px; box-sizing: border-box; padding: 48px; background: ${PAPER}; color: ${INK}; display: flex; flex-direction: column; gap: 24px"><h1 style="margin: 0; font-size: 22px; font-weight: 500">组件</h1><div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap"><button style="height: 32px; padding: 0 14px; border: 0; border-radius: var(--ds-radius-control, 8px); background: ${INK}; color: ${PAPER}; font-size: 14px">主要按钮</button><button style="height: 32px; padding: 0 14px; border: 1px solid ${LINE}; border-radius: var(--ds-radius-control, 8px); background: transparent; color: ${INK}; font-size: 14px">次要按钮</button><label style="display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: ${INK2}">输入框<input placeholder="请输入" style="height: 32px; width: 220px; box-sizing: border-box; padding: 0 10px; border: 1px solid ${LINE}; border-radius: var(--ds-radius-control, 8px); font-size: 14px; color: ${INK}; background: ${PANEL}"></label></div><div style="padding: 16px; border: 1px solid ${LINE}; border-radius: var(--ds-radius-card, 12px); background: ${PANEL}; max-width: 360px; display: flex; flex-direction: column; gap: 6px"><strong style="font-size: 15px; font-weight: 500">卡片标题</strong><span style="font-size: 13px; line-height: 20px; color: ${INK2}">卡片里的说明文字，用次要文字颜色。</span></div></div>`,
        }),
      ],
      [
        {
          id: "readme",
          page: PAGE,
          kind: "sticky",
          x: 1040,
          y: 640,
          w: 360,
          text: moss.tokens.readme ?? "",
          color: "gray",
        },
      ],
      { ownSystem: moss.tokens },
    ),
  },
];

export const designTemplateData = (template: DesignTemplate) => JSON.stringify(template.canvas);
export const findDesignTemplate = (id: string) =>
  DESIGN_TEMPLATES.find((template) => template.id === id);
