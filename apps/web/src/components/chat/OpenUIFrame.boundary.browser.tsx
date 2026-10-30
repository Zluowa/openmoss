// FILE: OpenUIFrame.boundary.browser.tsx
// Purpose: Boundary press-test for the OpenUI native-component track. Renders
//          ambitious programs (dashboard, full form, carousel, deep nesting)
//          plus out-of-catalog probes (Map, CalendarHeatmap) to map exactly
//          where the chat library's capability edge is.
// Layer: Chat UI browser tests

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "../ChatMarkdown";

async function renderMarkdown(text: string, threadId: string, width = 720) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ width }}>
        <ChatMarkdown
          cwd="/workspace"
          text={text}
          isStreaming={false}
          threadId={threadId}
          renderInlineVisualizations
        />
      </div>
    </QueryClientProvider>,
  );
}

async function waitForState(mounted: { baseElement: Element }, state: string) {
  await vi.waitFor(
    () => {
      expect(
        mounted.baseElement.querySelector("[data-openui-state]")?.getAttribute("data-openui-state"),
      ).toBe(state);
    },
    { timeout: 15000 },
  );
}

const DASHBOARD = [
  "root = Card([header, kpis, chart, tbl, btns])",
  'header = CardHeader("经营仪表盘", "2026 年 10 月 · 实时数据")',
  'kpis = OverviewCardBlock([k1, k2, k3], "grid", true)',
  'k1 = OverviewCardItem("rev", k1top, k1m)',
  'k1top = IconText(Icon("circle-dollar-sign", "finance"), "neutral", "m", "总收入", "本月至今", false, "vertical")',
  'k1m = MetricIndicatorInline("¥284,500", "vs 上月", { direction: "up", value: 12.4 })',
  'k2 = OverviewCardItem("users", k2top, k2m)',
  'k2top = IconText(Icon("users", "people"), "neutral", "m", "活跃用户", "MAU", false, "vertical")',
  'k2m = MetricIndicatorInline("47,320", "vs 上月", { direction: "up", value: 6.8 })',
  'k3 = OverviewCardItem("churn", k3top, k3m)',
  'k3top = IconText(Icon("user-minus", "people"), "neutral", "m", "流失率", "月度", false, "vertical")',
  'k3m = MetricIndicatorInline("2.1%", "vs 上月", { direction: "down", value: 0.4 })',
  'chart = LineChart(months, [s1, s2], "natural", "月份", "用户 (k)")',
  'months = ["5月", "6月", "7月", "8月", "9月", "10月"]',
  's1 = Series("DAU", [5.1, 5.4, 5.8, 6.2, 6.7, 7.1])',
  's2 = Series("MAU", [28.4, 30.1, 31.8, 33.5, 35.2, 37.1])',
  "tbl = Table([c1, c2, c3])",
  'c1 = Col("渠道", ["自然搜索", "付费广告", "推荐"], "string")',
  'c2 = Col("线索", [4210, 3180, 2050], "number")',
  'c3 = Col("转化率", ["6.4%", "5.1%", "9.4%"], "string")',
  'btns = Buttons([b1, b2], "row")',
  'b1 = Button("按渠道拆解", { type: "continue_conversation", context: "按渠道拆解收入" }, "primary")',
  'b2 = Button("预测下季度", { type: "continue_conversation", context: "预测下季度" }, "secondary")',
].join("\n");

const FORM = [
  "root = Card([header, form])",
  'header = CardHeader("旅行偏好", "告诉我们你的偏好")',
  'form = Form("trip", formBtns, [fc1, fc2, fc3, fc4])',
  'formBtns = Buttons([submit], "row")',
  'submit = Button("生成方案", { type: "continue_conversation", context: "根据表单生成旅行方案" }, "primary")',
  'fc1 = FormControl("目的地", destInput, "可留空")',
  'destInput = Input("destination", "例如 东京", "text")',
  'fc2 = FormControl("出行日期", datePicker)',
  'datePicker = DatePicker("dates", "range", { required: true })',
  'fc3 = FormControl("预算（每人）", budgetSlider)',
  'budgetSlider = Slider("budget", "discrete", 500, 10000, 500, [2500], "USD")',
  'fc4 = FormControl("住宿偏好", stayChips)',
  'stayChips = Chips("stay", "multiple", [ch1, ch2, ch3])',
  'ch1 = ChipItem("hotel", "酒店")',
  'ch2 = ChipItem("resort", "度假村")',
  'ch3 = ChipItem("bnb", "民宿")',
].join("\n");

const CAROUSEL = [
  "root = Card([header, cards])",
  'header = CardHeader("巴黎地标", "滑动浏览")',
  'cards = VisualCardBlock([v1, v2], "carousel", true, { type: "continue_conversation", context: "讲讲这个地标" })',
  'v1 = VisualCardItem(v1b, "eiffel", "https://picsum.photos/seed/eiffel/800/500", v1t, "埃菲尔铁塔")',
  'v1b = BoldText("text", "埃菲尔铁塔", "每日 9:00–24:00")',
  'v1t = Tag("必看", Icon("star", "shapes"), "sm", "info")',
  'v2 = VisualCardItem(v2b, "louvre", "https://picsum.photos/seed/louvre/800/500", v2t, "卢浮宫")',
  'v2b = BoldText("text", "卢浮宫", "世界最大艺术博物馆")',
  'v2t = Tag("890 万访客/年", Icon("trending-up", "charts"), "sm", "success")',
].join("\n");

const DEEP_NESTED = [
  "root = Card([header, sections])",
  'header = CardHeader("深度嵌套报告", "SectionBlock > Tabs > 图表+表格")',
  "sections = SectionBlock([sec1, sec2], false)",
  'sec1 = SectionItem("trends", "趋势", [tabs1])',
  "tabs1 = Tabs([t1a, t1b])",
  't1a = TabItem("bar", "柱状图", [bar])',
  'bar = BarChart(["Q1", "Q2", "Q3"], [bs1, bs2], "grouped", "季度", "收入 ($k)")',
  'bs1 = Series("去年", [82.4, 68.1, 54.6])',
  'bs2 = Series("今年", [92.4, 78.1, 64.6])',
  't1b = TabItem("pie", "占比", [pie])',
  'pie = PieChart(["直销", "渠道", "线上"], [45, 30, 25], "donut")',
  'sec2 = SectionItem("detail", "明细", [acc])',
  "acc = Accordion([a1])",
  'a1 = AccordionItem("faq", "补充说明", [md])',
  'md = MarkDownRenderer("支持 **markdown** 与 `代码`。", "card")',
].join("\n");

it("renders a full dashboard (KPI cards + line chart + table + buttons)", async () => {
  const mounted = await renderMarkdown(
    `\`\`\`openui\n${DASHBOARD}\n\`\`\``,
    "openui-boundary-dash",
  );
  try {
    await expect.element(mounted.getByText("经营仪表盘")).toBeInTheDocument();
    await expect.element(mounted.getByText("¥284,500")).toBeInTheDocument();
    await expect.element(mounted.getByText("自然搜索")).toBeInTheDocument();
    await expect.element(mounted.getByText("按渠道拆解")).toBeInTheDocument();
    await waitForState(mounted, "ready");
    expect(mounted.baseElement.querySelector("iframe")).toBeNull();
  } finally {
    await mounted.unmount();
  }
});

it("renders a full form (input + date range + slider + chips)", async () => {
  const mounted = await renderMarkdown(`\`\`\`openui\n${FORM}\n\`\`\``, "openui-boundary-form");
  try {
    await expect.element(mounted.getByText("旅行偏好")).toBeInTheDocument();
    await expect.element(mounted.getByText("生成方案")).toBeInTheDocument();
    await expect.element(mounted.getByText("度假村")).toBeInTheDocument();
    await waitForState(mounted, "ready");
  } finally {
    await mounted.unmount();
  }
});

it("renders an image carousel with tags", async () => {
  const mounted = await renderMarkdown(
    `\`\`\`openui\n${CAROUSEL}\n\`\`\``,
    "openui-boundary-carousel",
  );
  try {
    await expect.element(mounted.getByText("巴黎地标")).toBeInTheDocument();
    await expect.element(mounted.getByText("埃菲尔铁塔")).toBeInTheDocument();
    await waitForState(mounted, "ready");
  } finally {
    await mounted.unmount();
  }
});

it("renders deep nesting (SectionBlock > Tabs > charts, Accordion > markdown)", async () => {
  const mounted = await renderMarkdown(
    `\`\`\`openui\n${DEEP_NESTED}\n\`\`\``,
    "openui-boundary-nested",
  );
  try {
    await expect.element(mounted.getByText("深度嵌套报告")).toBeInTheDocument();
    await expect.element(mounted.getByText("柱状图")).toBeInTheDocument();
    await waitForState(mounted, "ready");
  } finally {
    await mounted.unmount();
  }
});

// Full-absorption layer: charts the package ships but the stock chat library
// never registered, plus Modal/Stack from the generic library. These prove the
// Moss extension bindings wire real React components end to end.
const FULL_ABSORPTION = [
  "root = Card([header, funnel, heat, seg, mini, cal])",
  'header = CardHeader("转化分析", "漏斗 + 矩阵 + 占比 + 迷你图 + 日历热力")',
  'funnel = FunnelChart(["访问", "注册", "激活", "付费"], [1000, 420, 260, 90], "vertical")',
  'heat = HeatmapChart(["周一", "周二", "周三"], ["上午", "下午"], [[12, 5], [20, 9], [7, 3]])',
  'seg = SegmentedBar(["直销", "渠道", "线上"], [45, 30, 25])',
  "mini = MiniLineChart([3, 5, 4, 8, 7, 12, 10])",
  'cal = CalendarHeatmap(["2026-01-01", "2026-01-02", "2026-01-05"], [2, 5, 1])',
].join("\n");

it("renders the full-absorption charts (funnel, heatmap, segmented, mini, calendar)", async () => {
  const mounted = await renderMarkdown(
    `\`\`\`openui\n${FULL_ABSORPTION}\n\`\`\``,
    "openui-boundary-absorption",
  );
  try {
    await expect.element(mounted.getByText("转化分析")).toBeInTheDocument();
    // Five charts render their own container elements; funnel/heatmap/segmented
    // labels live in SVG text nodes that getByText does not match, so assert on
    // the per-chart container classes instead.
    await vi.waitFor(
      () => {
        const frame = mounted.baseElement.querySelector("[data-openui-state]");
        for (const marker of [
          "openui-funnel-chart-container",
          "openui-heatmap-chart-container",
          "openui-segmented-bar-container",
          "openui-mini-chart",
          "openui-calendar-heatmap-container",
        ]) {
          expect(frame?.querySelector(`[class*='${marker}']`), marker).not.toBeNull();
        }
      },
      { timeout: 15000 },
    );
    expect(mounted.baseElement.querySelector("[data-openui-state='error']")).toBeNull();
    expect(mounted.baseElement.querySelector("iframe")).toBeNull();
  } finally {
    await mounted.unmount();
  }
});

// Out-of-catalog probes: genuinely unregistered component names must fail
// gracefully — an error card naming the component, never a blank frame.
// (CalendarHeatmap used to be a probe here; it is now a registered component
// and has a positive test below.)
it.each([
  ["Map", 'root = Card([m])\nm = Map("Paris", 48.8566, 2.3522)'],
  ["VideoPlayer", 'root = Card([v])\nv = VideoPlayer("https://example.com/x.mp4")'],
])("out-of-catalog component %s degrades gracefully", async (name, program) => {
  const mounted = await renderMarkdown(
    `\`\`\`openui\n${program}\n\`\`\``,
    `openui-boundary-${name}`,
  );
  try {
    // The unknown component must surface as an error card naming the component
    // — never a silent blank frame.
    await vi.waitFor(
      () => {
        const errorCard = mounted.baseElement.querySelector("[data-openui-state='error']");
        expect(errorCard?.textContent ?? "").toContain(name);
      },
      { timeout: 15000 },
    );
  } finally {
    await mounted.unmount();
  }
});
