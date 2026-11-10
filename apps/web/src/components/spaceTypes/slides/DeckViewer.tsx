// FILE: DeckViewer.tsx
// Purpose: Moss's own deck view, used when the Canvas deck editor cannot load: slide rail,
//          the current slide fitted to the space, speaker notes, present / download / share,
//          the agent's proposed changes with preview · 接受 · 放弃, and a "描述修改或提问"
//          box that sends the current slide to the selected Moss agent.
// Layer: 资料空间 幻灯片

import { applyDeckOps } from "@moss/shared/spaceItems/deckOps";
import {
  bodyText,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type SlidesDeck,
} from "@moss/shared/spaceItems/slidesDeck";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DeckTarget, DeckViewContext } from "~/lib/deckEditorChannel";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import type { DeckDraftView, DeckRun } from "./DeckEditorHost";
import { SlideView } from "./SlideView";

const CHIPS = [
  { label: "润色设计", text: "润色这张幻灯片的版式和视觉层次，保留内容和主题风格。" },
  { label: "突出重点", text: "突出这张幻灯片最重要的一点，其余内容弱化。" },
  {
    label: "加入图示",
    text: "为这张幻灯片加入合适的图示（图表、示意图或图片占位），保留文字内容。",
  },
  { label: "精简内容", text: "精简这张幻灯片的文字，每条要点不超过 20 个字，保留关键信息。" },
];

export function DeckViewer(props: {
  deck: SlidesDeck;
  title: string;
  readOnly: boolean;
  notice: string | null;
  drafts: readonly DeckDraftView[];
  highlight: ReadonlySet<string>;
  running: readonly DeckRun[];
  aiAvailable: boolean;
  agentLabel: string | null;
  onRequestChange: (instruction: string, target: DeckTarget) => void;
  onAccept: (draftIds: string[]) => void;
  onDiscard: (draftIds: string[]) => void;
  onPresent: (slideId: string | null, surface: "fullscreen" | "presenter") => void;
  onExport: (
    format: "pptx" | "pdf" | "png",
    options: { slideIds?: string[]; slideId?: string; includeNotes?: boolean },
  ) => void;
  onShare: () => void;
  onViewChange: (context: DeckViewContext) => void;
  onRetryEditor: () => void;
}) {
  const { deck } = props;
  const [current, setCurrent] = useState(deck.slides[0]?.id ?? null);
  const [preview, setPreview] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [range, setRange] = useState<"all" | "current">("all");
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 450 });
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setStageSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const previewDeck = useMemo(() => {
    const entry = props.drafts.find((d) => d.draft.id === preview);
    if (!entry) return null;
    try {
      return applyDeckOps(deck, entry.ops);
    } catch {
      return null;
    }
  }, [deck, preview, props.drafts]);
  const shown = previewDeck ?? deck;
  const index = Math.max(
    0,
    shown.slides.findIndex((slide) => slide.id === current),
  );
  const slide = shown.slides[index];
  useEffect(() => {
    if (!deck.slides.some((s) => s.id === current)) setCurrent(deck.slides[0]?.id ?? null);
  }, [current, deck.slides]);
  useEffect(() => {
    const title = slide?.elements.find((e) => e.type === "text" && e.role === "title");
    props.onViewChange({
      mode: "edit",
      slideId: slide?.id ?? null,
      slideIndex: index,
      slideCount: shown.slides.length,
      ...(title && title.type === "text" ? { slideTitle: bodyText(title.body).slice(0, 200) } : {}),
      selected: [],
      selection: [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slide?.id, index, shown.slides.length]);

  const fit = Math.max(
    160,
    Math.min(stageSize.width - 48, ((stageSize.height - 32) * SLIDE_WIDTH) / SLIDE_HEIGHT),
  );
  const send = (text: string) => {
    const words = text.trim();
    if (!words || !slide) return;
    props.onRequestChange(words, { slideIds: [slide.id], elementIds: [] });
    setInstruction("");
  };
  const running = props.running.filter((run) => run.status !== "failed");

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-deck-viewer>
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <span
          className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground"
          title={props.notice ?? undefined}
        >
          {props.notice}
        </span>
        <Button size="xs" variant="ghost" onClick={props.onRetryEditor}>
          重试编辑器
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => props.onPresent(slide?.id ?? null, "fullscreen")}
        >
          演示
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => props.onPresent(slide?.id ?? null, "presenter")}
        >
          演讲者视图
        </Button>
        <span className="relative">
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={downloadOpen}
            onClick={() => setDownloadOpen((open) => !open)}
          >
            下载
          </Button>
          {downloadOpen ? (
            <div
              role="menu"
              data-download-menu
              className="absolute top-full right-0 z-20 mt-1 flex w-56 flex-col gap-0.5 rounded-[10px] border border-border bg-popover p-1 text-ui-sm shadow-md"
            >
              {(
                [
                  ["pdf", "PDF"],
                  ["pptx", "PowerPoint (.pptx)"],
                  ["png", "当前幻灯片 (PNG)"],
                ] as const
              ).map(([format, label]) => (
                <button
                  key={format}
                  type="button"
                  role="menuitem"
                  className="rounded-[6px] px-2.5 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    setDownloadOpen(false);
                    props.onExport(format, {
                      ...(format === "png" && slide ? { slideId: slide.id } : {}),
                      ...(format !== "png" && range === "current" && slide
                        ? { slideIds: [slide.id] }
                        : {}),
                      includeNotes,
                    });
                  }}
                >
                  {label}
                </button>
              ))}
              <div className="my-1 h-px bg-border" />
              <label className="flex items-center gap-2 px-2.5 py-1 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includeNotes}
                  onChange={(event) => setIncludeNotes(event.target.checked)}
                />
                包含备注
              </label>
              <label className="flex items-center gap-2 px-2.5 py-1 text-muted-foreground">
                范围
                <select
                  value={range}
                  onChange={(event) => setRange(event.target.value as "all" | "current")}
                  className="ml-auto rounded-[6px] border border-input bg-background px-1.5 py-0.5"
                >
                  <option value="all">全部幻灯片</option>
                  <option value="current">当前幻灯片</option>
                </select>
              </label>
            </div>
          ) : null}
        </span>
        <Button size="xs" variant="outline" onClick={props.onShare}>
          分享
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="幻灯片"
          className="flex w-44 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border p-3"
        >
          <span className="text-ui-xs text-muted-foreground">{shown.slides.length} 张幻灯片</span>
          {shown.slides.map((item, i) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === slide?.id}
              onClick={() => setCurrent(item.id)}
              className={cn(
                "flex items-start gap-1.5 rounded-control p-1 text-left",
                item.id === slide?.id ? "bg-accent" : "hover:bg-accent/60",
                item.hidden && "opacity-50",
              )}
            >
              <span className="w-4 pt-0.5 text-right text-ui-xs text-muted-foreground tabular-nums">
                {i + 1}
              </span>
              <span className="overflow-hidden rounded-sm border border-border">
                <SlideView slide={item} theme={shown.theme} width={120} />
              </span>
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={stage}
            className="flex min-h-0 flex-1 items-center justify-center bg-muted/40 p-4"
          >
            {slide ? (
              <div className="overflow-hidden rounded-sm shadow-md" data-current-slide={slide.id}>
                <SlideView
                  slide={slide}
                  theme={shown.theme}
                  width={fit}
                  {...(previewDeck ? {} : { highlight: props.highlight })}
                />
              </div>
            ) : null}
          </div>
          {slide?.notes ? (
            <div className="max-h-28 shrink-0 overflow-auto border-t border-border px-4 py-2 text-ui-sm whitespace-pre-wrap text-muted-foreground">
              <span className="mr-2 text-ui-xs">演讲者备注</span>
              {slide.notes}
            </div>
          ) : null}
          {props.drafts.length ? (
            <div
              className="flex shrink-0 flex-col gap-1.5 border-t border-border px-4 py-2"
              data-deck-review
            >
              <div className="flex items-center gap-2 text-ui-sm">
                <span className="font-medium">{props.drafts.length} 处修改建议</span>
                <span className="text-muted-foreground">{props.agentLabel ?? ""}</span>
                <span className="flex-1" />
                <Button
                  size="xs"
                  onClick={() => props.onAccept(props.drafts.map((d) => d.draft.id))}
                >
                  全部接受
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => props.onDiscard(props.drafts.map((d) => d.draft.id))}
                >
                  全部放弃
                </Button>
              </div>
              {props.drafts.map((entry) => (
                <div
                  key={entry.draft.id}
                  className="flex items-center gap-2 text-ui-sm"
                  data-deck-draft={entry.draft.id}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {entry.draft.summary || "修改建议"}
                  </span>
                  <Button
                    size="xs"
                    variant={preview === entry.draft.id ? "secondary" : "ghost"}
                    onClick={() => {
                      setPreview(preview === entry.draft.id ? null : entry.draft.id);
                      const first = entry.target?.slideIds[0];
                      if (first) setCurrent(first);
                    }}
                  >
                    {preview === entry.draft.id ? "看原样" : "预览"}
                  </Button>
                  <Button
                    size="xs"
                    onClick={() => {
                      setPreview(null);
                      props.onAccept([entry.draft.id]);
                    }}
                  >
                    接受
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => props.onDiscard([entry.draft.id])}
                  >
                    放弃
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          {props.aiAvailable && !props.readOnly ? (
            <div className="flex shrink-0 flex-col gap-1.5 border-t border-border px-4 py-2">
              <div className="flex flex-wrap gap-1.5">
                {CHIPS.map((chip) => (
                  <Button
                    key={chip.label}
                    size="xs"
                    variant="outline"
                    onClick={() => send(chip.text)}
                  >
                    {chip.label}
                  </Button>
                ))}
                {running.length ? (
                  <span role="status" className="ml-auto text-ui-xs text-muted-foreground">
                    Moss 正在处理 {running.length} 个请求…
                  </span>
                ) : null}
              </div>
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  send(instruction);
                }}
              >
                <input
                  aria-label="描述修改或提问"
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder={`描述对第 ${index + 1} 张的修改，或提问`}
                  className="h-8 min-w-0 flex-1 rounded-control border border-input bg-background px-2.5 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button size="sm" type="submit" disabled={!instruction.trim()}>
                  提出修改请求
                </Button>
              </form>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
