// FILE: TemplatePickerDialog.tsx
// Purpose: 从模板开始: a gallery of Moss templates and the user's saved templates for pages,
//          幻灯片, 电子表格, 应用页 (dashboards, trackers, polls) and 设计; picking one creates the item.
// Layer: 资料空间 types stream. space-ui's 创建 menu opens it.

import type {
  PageSpaceId,
  PageTypedItem,
  SpaceId,
  SpaceTemplate,
  SpaceTemplateKind,
} from "@moss/contracts";
import { parseDesignCanvas } from "@moss/shared/spaceItems/designCanvas";
import { isDashboardPayload } from "@moss/shared/spaceItems/dashboard";
import { parseAppItem } from "@moss/shared/spaceItems/itemData";
import { parseSheetWorkbook, readSheetRange } from "@moss/shared/spaceItems/sheetWorkbook";
import { parseSlidesDeck } from "@moss/shared/spaceItems/slidesDeck";
import { BUILT_IN_TEMPLATES } from "@moss/shared/spaceItems/templates";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import {
  DashboardLayoutIcon,
  PaletteIcon,
  PageTextIcon,
  SlideDeckIcon,
  SpreadsheetIcon,
  TrashCanIcon,
  type LucideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { ReadonlyAppItemFrame } from "../app/ReadonlyAppItemFrame";
import { DesignThumbnail } from "../design/DesignThumbnail";
import { DashboardThumbnail } from "../dashboard/DashboardPanels";
import { coverSlide, SlideView } from "../slides/SlideView";
import { createSpaceItem, pageTypesQueryKeys, TEMPLATE_KIND_LABELS } from "../spaceItemTypes";

// Template thumbnails are fixed-scale miniatures (like the slide cover beside them), so their text
// keeps a fixed size instead of following the UI text size from Settings.
const THUMBNAIL_TEXT = { fontSize: 10 } as const;
const THUMBNAIL_TEXT_SMALL = { fontSize: 9 } as const;

const KIND_ICONS: Record<SpaceTemplateKind, LucideIcon> = {
  page: PageTextIcon,
  slides: SlideDeckIcon,
  sheet: SpreadsheetIcon,
  app: DashboardLayoutIcon,
  design: PaletteIcon,
};
const FILTERS: ReadonlyArray<{ id: SpaceTemplateKind | "all"; label: string }> = [
  { id: "all", label: "全部" },
  { id: "page", label: "页面" },
  { id: "slides", label: "幻灯片" },
  { id: "sheet", label: "电子表格" },
  { id: "app", label: "仪表盘" },
  { id: "design", label: "设计" },
];
const builtInData = new Map(BUILT_IN_TEMPLATES.map((template) => [template.id, template]));

export const SPACE_TEMPLATE_LAUNCH_EVENT = "moss:space-template-launch";

/** Structured launch metadata shared by 从模板开始 & 首页「快速开始」. */
export interface SpaceTemplateLaunchMetadata {
  readonly templateId: string;
  readonly kind: SpaceTemplateKind;
  readonly title: string;
  /** Keeps the created canvas/editor open alongside the dock rather than queuing silently. */
  readonly keepItemOpen: true;
  readonly starterPrompt: string;
  readonly prefillPrompt: string;
  readonly autoRun: boolean;
}

export const STARTER_TEMPLATE_PROMPTS: Readonly<
  Record<string, { readonly starterPrompt: string; readonly autoRun?: boolean }>
> = {
  "builtin:meeting-notes": {
    starterPrompt: "根据本次会议议程与参与人，整理核心结论并补充下一步行动清单",
    autoRun: false,
  },
  "builtin:project-brief": {
    starterPrompt: "围绕项目背景、核心目标、里程碑与风险，生成可直接评审的项目简报",
    autoRun: false,
  },
  "builtin:weekly-report-deck": {
    starterPrompt: "根据本周核心进展、关键指标与下周计划，生成一版结构清晰的汇报幻灯片",
    autoRun: false,
  },
  "builtin:pitch-deck": {
    starterPrompt: "按问题陈述、方案亮点、商业模式与路线图完善每页演讲内容与要点",
    autoRun: false,
  },
  "builtin:budget-sheet": {
    starterPrompt: "按月度与费用类别补全预算明细、自动求和公式与超支提醒说明",
    autoRun: false,
  },
  "builtin:task-sheet": {
    starterPrompt: "按优先级、负责人与截止日期梳理任务列表，并补充状态汇总统计",
    autoRun: false,
  },
  "builtin:sales-dashboard": {
    starterPrompt: "分析销售趋势、区域分布与高价值客户指标，提炼三条关键业务洞察",
    autoRun: false,
  },
  "builtin:kpi-dashboard": {
    starterPrompt: "对比本季度目标与实际达成率，标出重点波动指标与改进建议",
    autoRun: false,
  },
  "builtin:tracker": {
    starterPrompt: "按阶段梳理待办追踪状态、潜在阻塞点与下一步推进动作",
    autoRun: false,
  },
  "builtin:poll-signup": {
    starterPrompt: "优化活动报名字段顺序与提交成功提示，方便参与者快速填写",
    autoRun: false,
  },
  "builtin:design-landing": {
    starterPrompt: "优化首屏主标题、卖点模块与行动按钮的视觉层级与留白排版",
    autoRun: false,
  },
};

export function getTemplateLaunchMetadata(
  template: Pick<SpaceTemplate, "id" | "kind" | "title" | "description">,
  options?: { autoRun?: boolean },
): SpaceTemplateLaunchMetadata {
  const preset = STARTER_TEMPLATE_PROMPTS[template.id];
  const fallback = template.description?.trim()
    ? `基于「${template.title}」模板继续完善：${template.description.trim()}`
    : `帮我完善「${template.title}」的内容结构与关键细节`;
  const starterPrompt = preset?.starterPrompt ?? fallback;
  return {
    templateId: template.id,
    kind: template.kind,
    title: template.title,
    keepItemOpen: true,
    starterPrompt,
    prefillPrompt: starterPrompt,
    autoRun: options?.autoRun ?? preset?.autoRun ?? false,
  };
}

export function dispatchSpaceTemplateLaunch(detail: {
  item: PageTypedItem;
  launch: SpaceTemplateLaunchMetadata;
}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SPACE_TEMPLATE_LAUNCH_EVENT, { detail }));
}
function builtInApp(id: string) {
  const data = builtInData.get(id)?.data;
  try {
    return data ? parseAppItem(data) : null;
  } catch {
    return null;
  }
}

function TemplatePreview({ template }: { template: SpaceTemplate }) {
  const source = builtInData.get(template.id);
  const Icon = KIND_ICONS[template.kind];
  const preview = useMemo(() => {
    try {
      if (!source) return null;
      if (source.kind === "slides" && source.data) {
        const deck = parseSlidesDeck(source.data);
        const cover = coverSlide(deck);
        return cover ? <SlideView slide={cover} theme={deck.theme} width={232} /> : null;
      }
      if (source.kind === "sheet" && source.data) {
        const read = readSheetRange(parseSheetWorkbook(source.data), undefined, "A1:D6");
        return (
          <table
            className="w-full table-fixed border-collapse leading-tight"
            style={THUMBNAIL_TEXT_SMALL}
          >
            <tbody>
              {read.values.map((row, r) => (
                <tr key={r}>
                  {row.map((value, c) => (
                    <td
                      key={c}
                      className={cn(
                        "truncate border border-border/70 px-1 py-0.5",
                        r === 0 && "bg-[var(--color-background-elevated-secondary)] font-medium",
                      )}
                    >
                      {value === null ? (read.formulas[r]?.[c] ? "ƒx" : "") : String(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      if (source.kind === "app" && source.data && isDashboardPayload(source.data)) {
        return <DashboardThumbnail />;
      }
      if (source.kind === "app" && source.data) {
        const app = parseAppItem(source.data);
        return (
          <div className="pointer-events-none h-[130px] w-full overflow-hidden">
            <ReadonlyAppItemFrame
              context={{
                audience: "template",
                document: {
                  source: { sourceKind: "template-preview", templateId: template.id },
                  html: app.html,
                  publicMetadata: { title: template.title, revision: null },
                },
              }}
              className="h-[520px] w-[928px] origin-top-left scale-25 border-0"
            />
          </div>
        );
      }
      if (source.kind === "design" && source.data) {
        return (
          <DesignThumbnail
            canvas={parseDesignCanvas(source.data)}
            className="flex h-[130px] w-full items-center justify-center overflow-hidden"
          />
        );
      }
      if (source.kind === "page" && source.content) {
        return (
          <div
            className="w-full space-y-1 self-stretch p-3 text-left leading-snug text-muted-foreground"
            style={THUMBNAIL_TEXT}
          >
            {source.content
              .split("\n")
              .filter((line) => line.trim())
              .slice(0, 7)
              .map((line, index) => (
                <p
                  key={index}
                  className={cn("truncate", line.startsWith("#") && "font-medium text-foreground")}
                >
                  {line.replace(/^#+\s*/u, "").replaceAll("**", "")}
                </p>
              ))}
          </div>
        );
      }
    } catch {
      return null;
    }
    return null;
  }, [source, template.title]);
  return (
    <div className="flex h-[130px] items-center justify-center overflow-hidden rounded-control bg-[var(--color-background-elevated-secondary)]">
      {preview ?? <Icon className="size-6 text-muted-foreground" aria-hidden />}
    </div>
  );
}

export function TemplatePickerDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: string;
  scopeSpaceId: SpaceId | null;
  spaceId?: PageSpaceId | null;
  /** Preselects a kind (the 创建 menu's 幻灯片 → 从模板开始, for example). */
  initialKind?: SpaceTemplateKind;
  onCreated: (item: PageTypedItem, launch?: SpaceTemplateLaunchMetadata) => void;
  onLaunchTemplate?: (payload: {
    item: PageTypedItem;
    launch: SpaceTemplateLaunchMetadata;
  }) => void;
  /**
   * Saves a dashboard template as a real 应用页 (apps-runtime) and opens it. Without it, a
   * dashboard becomes a typed `app` item previewed in a sandbox.
   */
  createAppPage?: (input: {
    title: string;
    html: string;
    capabilities: readonly string[];
  }) => Promise<void>;
}) {
  const client = useQueryClient();
  const [filter, setFilter] = useState<SpaceTemplateKind | "all">(props.initialKind ?? "all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each opening starts from the kind it was opened for, not the last filter used.
  useEffect(() => {
    if (props.open) setFilter(props.initialKind ?? "all");
  }, [props.open, props.initialKind]);
  const templatesKey = pageTypesQueryKeys.templates(props.account, props.scopeSpaceId);
  const query = useQuery({
    queryKey: templatesKey,
    queryFn: () => ensureNativeApi().pageTypes.templates.list({ scopeSpaceId: props.scopeSpaceId }),
    enabled: props.open,
  });
  const templates = (query.data?.templates ?? []).filter(
    (template) => filter === "all" || template.kind === filter,
  );
  const personal = templates.filter((template) => !template.builtIn);
  const builtIn = templates.filter((template) => template.builtIn);

  const pick = async (template: SpaceTemplate) => {
    setBusy(template.id);
    setError(null);
    try {
      const launch = getTemplateLaunchMetadata(template);
      const app = template.kind === "app" ? builtInApp(template.id) : null;
      if (app && props.createAppPage) {
        await props.createAppPage({
          title: template.title,
          html: app.html,
          capabilities: app.capabilities,
        });
        props.onOpenChange(false);
        return;
      }
      const item = await createSpaceItem(ensureNativeApi(), {
        scopeSpaceId: props.scopeSpaceId,
        kind: template.kind,
        title: template.title,
        templateId: template.id,
        spaceId: props.spaceId ?? null,
      });
      dispatchSpaceTemplateLaunch({ item, launch });
      props.onOpenChange(false);
      props.onCreated(item, launch);
      props.onLaunchTemplate?.({ item, launch });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法从这个模板创建。");
    } finally {
      setBusy(null);
    }
  };
  const remove = async (template: SpaceTemplate) => {
    try {
      await ensureNativeApi().pageTypes.templates.delete({
        scopeSpaceId: props.scopeSpaceId,
        templateId: template.id,
      });
      await client.invalidateQueries({ queryKey: templatesKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法删除这个模板。");
    }
  };

  const grid = (items: readonly SpaceTemplate[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-3">
      {items.map((template) => {
        const Icon = KIND_ICONS[template.kind];
        return (
          <div key={template.id} className="group relative">
            <button
              type="button"
              data-template-id={template.id}
              disabled={busy !== null}
              onClick={() => void pick(template)}
              className="flex w-full flex-col gap-2 rounded-card border border-border p-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <TemplatePreview template={template} />
              <span className="flex items-center gap-1.5 px-1">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-ui font-medium">{template.title}</span>
                {busy === template.id ? (
                  <span className="ml-auto text-ui-xs text-muted-foreground">正在创建…</span>
                ) : null}
              </span>
              <span className="line-clamp-1 px-1 pb-0.5 text-ui-xs text-muted-foreground">
                {template.description || TEMPLATE_KIND_LABELS[template.kind]}
              </span>
            </button>
            {template.builtIn ? null : (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`删除模板 ${template.title}`}
                className="absolute top-3 right-3 bg-background opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => void remove(template)}
              >
                <TrashCanIcon />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-[880px]" data-template-picker>
        <div className="flex max-h-[80vh] flex-col gap-4 p-5">
          <DialogTitle>从模板开始</DialogTitle>
          <div className="flex gap-1" role="tablist" aria-label="模板类型">
            {FILTERS.map((entry) => (
              <Button
                key={entry.id}
                role="tab"
                aria-selected={filter === entry.id}
                size="xs"
                variant={filter === entry.id ? "secondary" : "ghost"}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            {query.isLoading ? (
              <p role="status" className="text-muted-foreground">
                正在载入模板…
              </p>
            ) : null}
            {personal.length ? (
              <section className="space-y-2">
                <h3 className="text-ui-sm font-medium text-muted-foreground">我的模板</h3>
                {grid(personal)}
              </section>
            ) : null}
            {builtIn.length ? (
              <section className="space-y-2">
                <h3 className="text-ui-sm font-medium text-muted-foreground">Moss 模板</h3>
                {grid(builtIn)}
              </section>
            ) : null}
            {!query.isLoading && templates.length === 0 ? (
              <p className="text-ui-sm text-muted-foreground">
                这一类还没有模板。打开任意条目，选“存为模板”即可添加。
              </p>
            ) : null}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
