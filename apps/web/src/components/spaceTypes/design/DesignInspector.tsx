// FILE: DesignInspector.tsx
// Purpose: The 设计 editor's right panel: 属性 (artboard, note, element sections: position, size,
//          layout, text, fill, border, effects, link, image), 图层 (artboards and their element
//          tree), 代码 (the element's CSS lines and HTML, or the artboard's source), 调整 (the
//          artboard's tweaks) and 主题 (design system, colours, text styles, light/dark).
// Layer: 资料空间 设计 (web)
// Why: Every field writes inline styles through the editor's editBoard, so the panel, the canvas
//      and the stored source stay one thing; fields typed into in a row merge into one undo step.

import type {
  DesignBoard,
  DesignCanvas,
  DesignComponent,
  DesignNote,
  DesignTweak,
} from "@moss/shared/spaceItems/designCanvas";
import { DESIGN_NOTE_COLORS, DESIGN_PAPER } from "@moss/shared/spaceItems/designCanvas";
import {
  customFontStack,
  DESIGN_FONT_GROUP_LABELS,
  DESIGN_FONTS,
  findDesignFont,
  type DesignFontGroup,
} from "@moss/shared/spaceItems/designFonts";
import {
  BUILT_IN_DESIGN_SYSTEMS,
  type DesignSystemTokens,
} from "@moss/shared/spaceItems/designSystems";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { EyeIcon, EyeSlashIcon, FlipHorizontalIcon, ChevronRightIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { PillTabs } from "../../ui/pill-tabs";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { NOTE_FILLS } from "./DesignCanvasView";
import { textContrast } from "./designColor";
import { COMPONENT_ATTR, instanceRoot } from "./designComponents";
import { linkCardTarget } from "./DesignShapes";
import { fullImageRect, NO_CROP, readCrop, writeCrop } from "./designTransforms";
import { elementAt, layerLabel, layerTree, type DesignLayerNode } from "./designDocument";
import {
  boardRoot,
  computed,
  frameRect,
  isPositioned,
  parseStyleLines,
  replaceStyle,
  setStyle,
  styleLines,
  type StyleLineError,
} from "./designEdits";
import { parseCanvasOrNull, type DesignEditorState } from "./useDesignEditor";

export type DesignPanelTab = "properties" | "layers" | "code" | "tweaks" | "theme";
const TABS: ReadonlyArray<{ id: DesignPanelTab; label: string }> = [
  { id: "properties", label: "属性" },
  { id: "layers", label: "图层" },
  { id: "code", label: "代码" },
  { id: "tweaks", label: "调整" },
  { id: "theme", label: "主题" },
];

export const BOARD_PRESETS = [
  { label: "手机", w: 390, h: 844 },
  { label: "平板", w: 834, h: 1194 },
  { label: "网页", w: 1440, h: 900 },
  { label: "海报", w: 1080, h: 1350 },
  { label: "方图", w: 1080, h: 1080 },
  { label: "竖屏故事", w: 1080, h: 1920 },
  { label: "横屏 16:9", w: 1920, h: 1080 },
] as const;

const FIELD_CLASS =
  "h-6 min-w-0 rounded-control-xs border border-border bg-transparent px-1.5 text-ui-sm text-foreground outline-none focus:border-[var(--color-text-accent)] disabled:opacity-60";

// ─── Field primitives ──────────────────────────────────────────────────────────────────

function Section(props: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-ui-sm font-medium text-foreground">{props.title}</h3>
        {props.actions}
      </div>
      <div className="flex flex-col gap-1.5">{props.children}</div>
    </section>
  );
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-h-6 items-center gap-2">
      <span className="w-[72px] shrink-0 truncate text-ui-sm text-muted-foreground">
        {props.label}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1">{props.children}</span>
    </label>
  );
}

/** A text field that commits on Enter or blur; ↑/↓ step numbers (Shift ×10). */
function TextField(props: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  label: string;
  numeric?: boolean;
  unit?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = (value: string) => {
    if (value !== props.value) props.onCommit(value);
  };
  return (
    <input
      aria-label={props.label}
      value={draft}
      placeholder={props.placeholder}
      disabled={props.disabled}
      className={cn(FIELD_CLASS, "w-full", props.className)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit(draft);
        if (event.key === "Escape") setDraft(props.value);
        if (props.numeric && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          const number = Number.parseFloat(draft) || 0;
          const next = String(
            Math.round(
              (number + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1)) * 100,
            ) / 100,
          );
          setDraft(next);
          props.onCommit(next);
        }
      }}
    />
  );
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      className={cn(FIELD_CLASS, "w-full")}
      onChange={(event) => props.onChange(event.target.value as T)}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** rgb()/rgba() from getComputedStyle → #rrggbb for the colour input. */
export function toHex(color: string): string {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/u.exec(color);
  if (!match) return color.startsWith("#") ? color.slice(0, 7) : "";
  if (match[4] !== undefined && Number(match[4]) === 0) return "";
  return `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

function ColorField(props: {
  label: string;
  value: string;
  tokens: DesignSystemTokens | null;
  onChange: (value: string, coalesce?: boolean) => void;
  allowNone?: boolean;
}) {
  const hex = toHex(props.value);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1">
        <input
          type="color"
          aria-label={`${props.label}：取色`}
          value={hex || "#000"}
          className="h-6 w-7 shrink-0 cursor-pointer rounded-control-xs border border-border bg-transparent p-0.5"
          onChange={(event) => props.onChange(event.target.value, true)}
        />
        <TextField
          label={props.label}
          value={props.value.startsWith("var(") ? props.value : hex || props.value}
          placeholder="无"
          onCommit={(value) => props.onChange(value)}
        />
        {props.allowNone !== false ? (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 px-1.5 text-muted-foreground"
            onClick={() => props.onChange("")}
          >
            无
          </Button>
        ) : null}
      </span>
      {props.tokens?.colors.length ? (
        <span className="flex flex-wrap gap-1">
          {props.tokens.colors.slice(0, 16).map((token) => (
            <Button
              key={token.name}
              size="icon-xs"
              variant="ghost"
              aria-label={`${props.label}：${token.label}`}
              title={`${token.label}（--ds-${token.name}）`}
              className={cn(
                "size-5 rounded-full border border-border p-0",
                props.value === `var(--ds-${token.name})` &&
                  "ring-2 ring-[var(--color-text-accent)]",
              )}
              style={{
                background: `var(--ds-${token.name}, ${token.light})`,
                backgroundColor: token.light,
              }}
              onClick={() => props.onChange(`var(--ds-${token.name})`)}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}

const FONT_GROUPS: readonly DesignFontGroup[] = ["system", "bundled", "chinese", "latin"];

/** Fonts that load with no network (Moss-bundled or system), or any installed font by name. */
function FontField(props: { value: string; onChange: (stack: string) => void }) {
  const known = props.value ? findDesignFont(props.value) : undefined;
  const [custom, setCustom] = useState(false);
  const typed = !known && props.value !== "";
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <select
        aria-label="字体"
        value={known?.id ?? (typed || custom ? "custom" : "")}
        className={cn(FIELD_CLASS, "w-full")}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => {
          const id = event.target.value;
          if (id === "custom") return setCustom(true);
          setCustom(false);
          props.onChange(DESIGN_FONTS.find((font) => font.id === id)?.stack ?? "");
        }}
      >
        <option value="">继承</option>
        {FONT_GROUPS.map((group) => (
          <optgroup key={group} label={DESIGN_FONT_GROUP_LABELS[group]}>
            {DESIGN_FONTS.filter((font) => font.group === group).map((font) => (
              <option key={font.id} value={font.id}>
                {font.label}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="custom">电脑里已安装的其它字体…</option>
      </select>
      {typed || custom ? (
        <TextField
          label="字体名称"
          value={typed ? props.value.split(",")[0]!.replace(/["']/gu, "").trim() : ""}
          placeholder="输入已安装的字体名称"
          onCommit={(name) => {
            const stack = customFontStack(name);
            if (stack) props.onChange(stack);
          }}
        />
      ) : null}
    </span>
  );
}

const SIDE_LABELS = ["上", "右", "下", "左"] as const;

/** A CSS shorthand (padding, margin, radius) with its four sides one click away. */
function SidesField(props: {
  label: string;
  value: string;
  sides: readonly [string, string, string, string];
  sideLabels?: readonly string[];
  read: (name: string) => string;
  onShorthand: (value: string) => void;
  onSide: (name: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1">
        <TextField label={props.label} value={props.value} onCommit={props.onShorthand} />
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          className="shrink-0 px-1.5 text-muted-foreground"
          onClick={() => setOpen((shown) => !shown)}
        >
          {open ? "合并" : "分别"}
        </Button>
      </span>
      {open ? (
        <span className="grid grid-cols-4 gap-1">
          {props.sides.map((name, index) => {
            const side = (props.sideLabels ?? SIDE_LABELS)[index] ?? name;
            return (
              <TextField
                key={name}
                label={`${props.label}：${side}`}
                numeric
                placeholder={side}
                value={String(Number.parseFloat(props.read(name)) || 0)}
                onCommit={(next) => {
                  const trimmed = next.trim();
                  props.onSide(name, /^-?\d+(\.\d+)?$/u.test(trimmed) ? `${trimmed}px` : trimmed);
                }}
              />
            );
          })}
        </span>
      ) : null}
    </span>
  );
}

function ChoiceRow<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <span
      role="radiogroup"
      aria-label={props.label}
      className="flex min-w-0 flex-1 gap-px rounded-control-xs border border-border p-px"
    >
      {props.options.map((option) => (
        <Button
          key={option.value}
          role="radio"
          aria-checked={option.value === props.value}
          size="xs"
          variant="ghost"
          className={cn(
            "h-5 min-w-0 flex-1 px-1 text-ui-xs",
            option.value === props.value
              ? "bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] text-foreground"
              : "text-muted-foreground",
          )}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </span>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────────────────

export function DesignInspector(props: {
  editor: DesignEditorState;
  tab: DesignPanelTab;
  onTab: (tab: DesignPanelTab) => void;
  scopeSpaceId: Parameters<ReturnType<typeof ensureNativeApi>["pages"]["list"]>[0]["scopeSpaceId"];
  selfPageId: string;
  onAsk: () => void;
  onExportBoard: (board: DesignBoard) => void;
  onReplaceImage: (boardId: string, path: string) => void;
  onOpenLink: (note: DesignNote) => void;
}) {
  const { editor } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-design-inspector="">
      <div className="border-b border-border px-2 py-1.5">
        <PillTabs
          ariaLabel="面板内容"
          tabs={TABS}
          selected={props.tab}
          onSelect={props.onTab}
          testId="design-panel-tabs"
          compact
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-design-scrollable="">
        {props.tab === "properties" ? (
          <PropertiesTab {...props} />
        ) : props.tab === "layers" ? (
          <LayersTab editor={editor} />
        ) : props.tab === "code" ? (
          <CodeTab editor={editor} />
        ) : props.tab === "tweaks" ? (
          <TweaksTab editor={editor} onAsk={props.onAsk} />
        ) : (
          <ThemeTab
            editor={editor}
            scopeSpaceId={props.scopeSpaceId}
            selfPageId={props.selfPageId}
          />
        )}
      </div>
    </div>
  );
}

function Empty(props: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-ui-sm text-muted-foreground">{props.children}</p>;
}

// ─── 属性 ──────────────────────────────────────────────────────────────────────────────

function PropertiesTab(props: Parameters<typeof DesignInspector>[0]) {
  const { editor } = props;
  const { selection } = editor;
  if (selection.element) return <ElementProperties {...props} />;
  if (selection.boards.length === 1 && !selection.notes.length) {
    const board = editor.boardById(selection.boards[0]!);
    if (board)
      return (
        <BoardProperties
          editor={editor}
          board={board}
          onExport={() => props.onExportBoard(board)}
        />
      );
  }
  if (selection.notes.length === 1 && !selection.boards.length) {
    const note = editor.canvas.notes.find((entry) => entry.id === selection.notes[0]);
    if (note) return <NoteProperties editor={editor} note={note} onOpenLink={props.onOpenLink} />;
  }
  if (selection.boards.length + selection.notes.length > 1)
    return (
      <Section title={`已选中 ${selection.boards.length + selection.notes.length} 项`}>
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="outline" onClick={editor.duplicateSelection}>
            复制一份
          </Button>
          <Button size="xs" variant="outline" onClick={editor.deleteSelection}>
            删除
          </Button>
        </div>
      </Section>
    );
  return (
    <>
      <Section title="页面">
        <Row label="名称">
          <TextField
            label="页面名称"
            value={editor.page.name}
            onCommit={(value) => editor.renamePage(editor.page.id, value)}
          />
        </Row>
        <Row label="主题">
          <ChoiceRow
            label="主题"
            value={editor.canvas.theme ?? "light"}
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onChange={(theme) => editor.apply([{ op: "setTheme", theme }])}
          />
        </Row>
        <Row label="设计系统">
          <span className="truncate text-ui-sm text-foreground">
            {editor.canvas.system?.name ?? "未使用"}
          </span>
        </Row>
        <p className="text-ui-xs text-muted-foreground">
          这一页有 {editor.pageBoards.length} 个画板。在画布上点选画板或元素，在这里调整它。按住
          Ctrl 拖动可以框选画板里的元素。
        </p>
        {!editor.readOnly ? (
          <div className="flex flex-wrap gap-1">
            {BOARD_PRESETS.slice(0, 4).map((preset) => (
              <Button
                key={preset.label}
                size="xs"
                variant="outline"
                onClick={() => editor.addBoard(undefined, preset.label) && undefined}
              >
                + {preset.label}
              </Button>
            ))}
          </div>
        ) : null}
      </Section>
      <ComponentsLibrary editor={editor} boardId={editor.pageBoards[0]?.id ?? null} />
    </>
  );
}

/** The design's components (and its design system's), ready to place in an artboard. */
function ComponentsLibrary(props: { editor: DesignEditorState; boardId: string | null }) {
  const { editor } = props;
  const own = new Set((editor.canvas.components ?? []).map((component) => component.id));
  if (!editor.components.length)
    return (
      <Section title="组件">
        <p className="text-ui-xs text-muted-foreground">
          选中画板里的一个元素，在属性里点“做成组件”，就可以在各个画板里重复使用，改一处处处跟着变。
        </p>
      </Section>
    );
  return (
    <Section title="组件">
      {editor.components.map((component) => (
        <div
          key={component.id}
          className="flex min-h-6 items-center gap-1"
          data-design-component-row={component.id}
        >
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
            {component.name}
            {own.has(component.id) ? null : (
              <span className="text-ui-xs text-muted-foreground"> · 设计系统</span>
            )}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={!props.boardId || editor.readOnly}
            onClick={() =>
              props.boardId && editor.placeComponent(component.id, props.boardId, { x: 24, y: 24 })
            }
          >
            放进画板
          </Button>
          {own.has(component.id) && !editor.readOnly ? (
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => {
                editor.apply([{ op: "deleteComponent", id: component.id }]);
                toastManager.add({ type: "info", title: "已删除组件；已放好的实例保留原样" });
              }}
            >
              删除
            </Button>
          ) : null}
        </div>
      ))}
    </Section>
  );
}

function BoardProperties(props: {
  editor: DesignEditorState;
  board: DesignBoard;
  onExport: () => void;
}) {
  const { editor, board } = props;
  const set = (patch: Partial<DesignBoard>, key?: string) =>
    editor.apply([{ op: "upsertBoard", board: { id: board.id, ...patch } }], key);
  const frame = (key: "x" | "y" | "w" | "h") => (value: string) => {
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) return;
    editor.apply(
      [{ op: "moveBoard", id: board.id, [key]: Math.round(number) }],
      `board:${board.id}:${key}`,
    );
  };
  return (
    <>
      <Section title="画板">
        <Row label="名称">
          <TextField
            label="画板名称"
            value={board.name}
            onCommit={(name) => name.trim() && set({ name: name.trim() })}
          />
        </Row>
        <Row label="位置">
          <TextField label="X" numeric value={String(board.x)} onCommit={frame("x")} />
          <TextField label="Y" numeric value={String(board.y)} onCommit={frame("y")} />
        </Row>
        <Row label="尺寸">
          <TextField label="宽" numeric value={String(board.w)} onCommit={frame("w")} />
          <TextField label="高" numeric value={String(board.h)} onCommit={frame("h")} />
        </Row>
        <Row label="预设">
          <SelectField
            label="画板尺寸预设"
            value={
              BOARD_PRESETS.find((preset) => preset.w === board.w && preset.h === board.h)?.label ??
              "自定义"
            }
            options={[
              { value: "自定义", label: "自定义" },
              ...BOARD_PRESETS.map((preset) => ({
                value: preset.label,
                label: `${preset.label} ${preset.w}×${preset.h}`,
              })),
            ]}
            onChange={(label) => {
              const preset = BOARD_PRESETS.find((entry) => entry.label === label);
              if (preset)
                editor.apply([{ op: "moveBoard", id: board.id, w: preset.w, h: preset.h }]);
            }}
          />
        </Row>
        <Row label="版式">
          <ChoiceRow
            label="版式"
            value={board.layout ?? "fixed"}
            options={[
              { value: "fixed", label: "固定尺寸" },
              { value: "page", label: "网页" },
            ]}
            onChange={(layout) => set({ layout })}
          />
        </Row>
        <Row label="可交互">
          <Switch
            checked={board.interactive === true}
            aria-label="可交互原型"
            onCheckedChange={(checked) => set({ interactive: checked === true })}
          />
          <span className="text-ui-xs text-muted-foreground">有播放按钮，链接可以点</span>
        </Row>
        <Row label="圆角">
          <TextField
            label="画板圆角"
            numeric
            value={String(board.radius ?? 0)}
            onCommit={(value) => set({ radius: Math.max(0, Number.parseFloat(value) || 0) })}
          />
        </Row>
        <Row label="打印">
          <ChoiceRow
            label="打印方式"
            value={board.print ?? "page"}
            options={[
              { value: "page", label: "一页" },
              { value: "flow", label: "按纸张分页" },
            ]}
            onChange={(print) =>
              editor.apply([
                {
                  op: "upsertBoard",
                  board:
                    print === "flow"
                      ? { ...board, print: "flow", paper: board.paper ?? "a4" }
                      : (({ print: _print, paper: _paper, ...rest }) => rest)(board),
                  replace: true,
                },
              ])
            }
          />
        </Row>
        {board.print === "flow" ? (
          <Row label="纸张">
            <ChoiceRow
              label="纸张"
              value={board.paper ?? "a4"}
              options={[
                { value: "a4", label: DESIGN_PAPER.a4.label },
                { value: "letter", label: DESIGN_PAPER.letter.label },
              ]}
              onChange={(paper) => set({ paper })}
            />
          </Row>
        ) : null}
        <div className="flex flex-wrap gap-1 pt-1">
          <Button size="xs" variant="outline" onClick={() => editor.fitBoardHeight(board.id)}>
            高度适应内容
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={editor.canvas.thumbnailBoardId === board.id}
            onClick={() => {
              editor.apply([{ op: "setThumbnail", id: board.id }]);
              toastManager.add({ type: "success", title: `“${board.name}”现在是封面` });
            }}
          >
            {editor.canvas.thumbnailBoardId === board.id ? "已是封面" : "设为封面"}
          </Button>
          <Button size="xs" variant="outline" onClick={props.onExport}>
            导出
          </Button>
          <Button size="xs" variant="outline" onClick={() => set({ hidden: !board.hidden })}>
            {board.hidden ? "显示" : "隐藏"}
          </Button>
        </div>
      </Section>
      <GuidesSection editor={editor} board={board} />
      <ComponentsLibrary editor={editor} boardId={board.id} />
    </>
  );
}

function GuidesSection(props: { editor: DesignEditorState; board: DesignBoard }) {
  const guides = props.board.guides ?? [];
  const write = (next: DesignBoard["guides"]) =>
    props.editor.apply([{ op: "upsertBoard", board: { id: props.board.id, guides: next ?? [] } }]);
  return (
    <Section
      title="布局网格"
      actions={
        guides.length < 6 ? (
          <SelectField
            label="添加布局网格"
            value={"" as string}
            options={[
              { value: "", label: "添加…" },
              { value: "columns", label: "12 列" },
              { value: "rows", label: "行" },
              { value: "grid", label: "8 像素网格" },
            ]}
            onChange={(kind) => {
              if (kind === "grid") write([...guides, { kind: "grid", size: 8 }]);
              else if (kind === "columns" || kind === "rows")
                write([
                  ...guides,
                  {
                    kind,
                    count: kind === "columns" ? 12 : 8,
                    gutter: 24,
                    margin: kind === "columns" ? 80 : 0,
                  },
                ]);
            }}
          />
        ) : null
      }
    >
      {guides.length === 0 ? (
        <p className="text-ui-xs text-muted-foreground">按 Shift+G 显示或隐藏所有布局网格。</p>
      ) : null}
      {guides.map((guide, index) => (
        <div key={index} className="flex items-center gap-1 text-ui-sm">
          <span className="flex-1 truncate">
            {guide.kind === "grid"
              ? `${guide.size} 像素网格`
              : `${guide.count} ${guide.kind === "columns" ? "列" : "行"}，间距 ${guide.gutter}，边距 ${guide.margin}`}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={guide.hidden ? "显示网格" : "隐藏网格"}
            onClick={() =>
              write(
                guides.map((entry, i) =>
                  i === index ? { ...entry, hidden: !entry.hidden } : entry,
                ),
              )
            }
          >
            {guide.hidden ? <EyeSlashIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => write(guides.filter((_, i) => i !== index))}
          >
            移除
          </Button>
        </div>
      ))}
    </Section>
  );
}

function NoteProperties(props: {
  editor: DesignEditorState;
  note: DesignNote;
  onOpenLink: (note: DesignNote) => void;
}) {
  const { editor, note } = props;
  const set = (patch: Partial<DesignNote>) =>
    editor.apply([{ op: "upsertNote", note: { ...note, ...patch } }]);
  if (note.kind === "link")
    return (
      <Section title="链接卡片">
        <Row label="标题">
          <TextField label="链接卡片标题" value={note.text} onCommit={(text) => set({ text })} />
        </Row>
        <Row label="说明">
          <TextField
            label="链接卡片说明"
            value={note.subtitle ?? ""}
            placeholder={linkCardTarget(note.href ?? "")}
            onCommit={(subtitle) =>
              editor.apply([
                {
                  op: "upsertNote",
                  note: subtitle.trim()
                    ? { ...note, subtitle: subtitle.trim() }
                    : (({ subtitle: _drop, ...rest }) => rest)(note),
                  replace: true,
                },
              ])
            }
          />
        </Row>
        <Row label="地址">
          <TextField
            label="链接地址"
            value={note.href ?? ""}
            onCommit={(href) => {
              const trimmed = href.trim();
              if (!/^(moss:\/\/space-page\/\S+|https?:\/\/\S+)$/u.test(trimmed))
                return void toastManager.add({
                  type: "info",
                  title: "请填写 https:// 网址，或资料空间条目的 moss://space-page/ 链接",
                });
              set({ href: trimmed });
            }}
          />
        </Row>
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="outline" onClick={() => props.onOpenLink(note)}>
            打开
          </Button>
        </div>
      </Section>
    );
  if (note.kind === "shape")
    return (
      <Section title={SHAPE_LABELS[note.shape ?? "rect"]}>
        {note.shape !== "line" && note.shape !== "arrow" && note.shape !== "image" ? (
          <Row label="填充">
            <ColorField
              label="形状填充"
              value={note.fill ?? ""}
              tokens={null}
              onChange={(fill) =>
                editor.apply([
                  {
                    op: "upsertNote",
                    note: fill ? { ...note, fill } : (({ fill: _drop, ...rest }) => rest)(note),
                    replace: true,
                  },
                ])
              }
            />
          </Row>
        ) : null}
        {note.shape !== "image" ? (
          <>
            <Row label="描边">
              <ColorField
                label="形状描边"
                value={note.stroke ?? ""}
                tokens={null}
                onChange={(stroke) =>
                  editor.apply([
                    {
                      op: "upsertNote",
                      note: stroke
                        ? { ...note, stroke }
                        : (({ stroke: _drop, ...rest }) => rest)(note),
                      replace: true,
                    },
                  ])
                }
              />
            </Row>
            <Row label="粗细">
              <TextField
                label="描边粗细"
                numeric
                value={String(
                  note.strokeWidth ?? (note.shape === "rect" || note.shape === "oval" ? 0 : 2),
                )}
                onCommit={(value) =>
                  set({ strokeWidth: Math.max(0, Math.min(200, Number.parseFloat(value) || 0)) })
                }
              />
            </Row>
          </>
        ) : null}
        {note.shape === "rect" || note.shape === "oval" ? (
          <Row label="文字">
            <TextField label="形状里的文字" value={note.text} onCommit={(text) => set({ text })} />
          </Row>
        ) : null}
        <Row label="位置">
          <TextField
            label="X"
            numeric
            value={String(note.x)}
            onCommit={(value) => set({ x: Math.round(Number.parseFloat(value) || 0) })}
          />
          <TextField
            label="Y"
            numeric
            value={String(note.y)}
            onCommit={(value) => set({ y: Math.round(Number.parseFloat(value) || 0) })}
          />
        </Row>
        {note.shape !== "line" && note.shape !== "arrow" ? (
          <Row label="尺寸">
            <TextField
              label="宽"
              numeric
              value={String(note.w ?? 120)}
              onCommit={(value) =>
                set({ w: Math.max(1, Math.round(Number.parseFloat(value) || 1)) })
              }
            />
            <TextField
              label="高"
              numeric
              value={String(note.h ?? 120)}
              onCommit={(value) =>
                set({ h: Math.max(1, Math.round(Number.parseFloat(value) || 1)) })
              }
            />
          </Row>
        ) : null}
        <p className="text-ui-xs text-muted-foreground">
          这是画布上的形状，不在任何画板里；导出画板时不会带上它。
        </p>
      </Section>
    );
  return (
    <Section title={note.kind === "title" ? "标题" : "便签"}>
      <Row label="类型">
        <ChoiceRow
          label="类型"
          value={note.kind}
          options={[
            { value: "sticky", label: "便签" },
            { value: "title", label: "标题" },
          ]}
          onChange={(kind) => set({ kind, w: kind === "title" ? 1200 : 240 })}
        />
      </Row>
      {note.kind === "sticky" ? (
        <Row label="颜色">
          <span className="flex flex-wrap gap-1">
            {DESIGN_NOTE_COLORS.map((color) => (
              <Button
                key={color}
                size="icon-xs"
                variant="ghost"
                aria-label={`便签颜色 ${color}`}
                className={cn(
                  "size-5 rounded-full border border-border p-0",
                  (note.color ?? "yellow") === color && "ring-2 ring-[var(--color-text-accent)]",
                )}
                style={{ background: NOTE_FILLS[color] }}
                onClick={() => set({ color })}
              />
            ))}
          </span>
        </Row>
      ) : null}
      <Row label="宽度">
        <TextField
          label="宽度"
          numeric
          value={String(note.w ?? (note.kind === "title" ? 1200 : 240))}
          onCommit={(value) => set({ w: Math.max(80, Number.parseFloat(value) || 240) })}
        />
      </Row>
      <Row label="粗体">
        <Switch
          checked={note.bold === true}
          aria-label="粗体"
          onCheckedChange={(checked) => set({ bold: checked === true })}
        />
      </Row>
    </Section>
  );
}

const ALIGN_OPTIONS = [
  { value: "flex-start", label: "起点" },
  { value: "center", label: "居中" },
  { value: "flex-end", label: "终点" },
  { value: "stretch", label: "拉伸" },
] as const;
const JUSTIFY_OPTIONS = [
  { value: "flex-start", label: "起点" },
  { value: "center", label: "居中" },
  { value: "flex-end", label: "终点" },
  { value: "space-between", label: "两端" },
] as const;
const SHAPE_LABELS: Record<NonNullable<DesignNote["shape"]>, string> = {
  rect: "矩形",
  oval: "椭圆",
  line: "线条",
  arrow: "箭头",
  path: "路径",
  image: "图片",
};
const BLEND_MODES = [
  { value: "", label: "正常" },
  { value: "multiply", label: "正片叠底" },
  { value: "screen", label: "滤色" },
  { value: "overlay", label: "叠加" },
  { value: "darken", label: "变暗" },
  { value: "lighten", label: "变亮" },
  { value: "color-dodge", label: "颜色减淡" },
  { value: "color-burn", label: "颜色加深" },
  { value: "soft-light", label: "柔光" },
  { value: "hard-light", label: "强光" },
  { value: "difference", label: "差值" },
  { value: "exclusion", label: "排除" },
  { value: "hue", label: "色相" },
  { value: "saturation", label: "饱和度" },
  { value: "color", label: "颜色" },
  { value: "luminosity", label: "明度" },
] as const;

/** `linear-gradient(<angle>deg, a, b)` / `radial-gradient(a, b)` as fields. */
function readGradient(
  value: string,
): { kind: "linear" | "radial"; angle: number; from: string; to: string } | null {
  const linear = /^linear-gradient\(\s*(-?[\d.]+)deg\s*,\s*(.+?)\s*,\s*([^,]+?)\s*\)$/u.exec(value);
  if (linear) return { kind: "linear", angle: Number(linear[1]), from: linear[2]!, to: linear[3]! };
  const radial = /^radial-gradient\(\s*(.+?)\s*,\s*([^,]+?)\s*\)$/u.exec(value);
  if (radial) return { kind: "radial", angle: 0, from: radial[1]!, to: radial[2]! };
  return null;
}
function writeGradient(gradient: {
  kind: "linear" | "radial";
  angle: number;
  from: string;
  to: string;
}) {
  return gradient.kind === "linear"
    ? `linear-gradient(${gradient.angle}deg, ${gradient.from}, ${gradient.to})`
    : `radial-gradient(${gradient.from}, ${gradient.to})`;
}

function ElementProperties(props: Parameters<typeof DesignInspector>[0]) {
  const { editor } = props;
  const current = editor.selectedElements();
  // Re-read after each edit.
  void editor.layoutTick;
  if (!current) return <Empty>选中的元素还在载入。</Empty>;
  const { boardId, elements } = current;
  const first = elements[0]!;
  const root = boardRoot(current.body);
  const style = computed(first)!;
  const inline = (name: string) => first.style.getPropertyValue(name);
  const value = (name: string) => inline(name) || style.getPropertyValue(name);
  const tokens = editor.canvas.system?.tokens ?? null;
  const set = (name: string, next: string, coalesce = false) =>
    editor.editBoard(
      boardId,
      () => {
        for (const element of elements) setStyle(element, name, next);
        return undefined;
      },
      coalesce ? `${boardId}:${editor.selection.element?.paths.join(",")}:${name}` : undefined,
    );
  const setMany = (values: Record<string, string>) =>
    editor.editBoard(boardId, () => {
      for (const element of elements)
        for (const [name, next] of Object.entries(values)) setStyle(element, name, next);
      return undefined;
    });
  const px = (name: string) => (next: string) => {
    const trimmed = next.trim();
    set(name, trimmed === "" || /[a-z%]$/iu.test(trimmed) ? trimmed : `${trimmed}px`);
  };
  const free = elements.every(isPositioned);
  const isRoot = first === root;
  const display = style.display;
  const layout = display.includes("grid")
    ? "grid"
    : display.includes("flex")
      ? style.flexDirection.startsWith("column")
        ? "column"
        : "row"
      : "none";
  const hasText = (first.textContent ?? "").trim().length > 0 && first.tagName !== "IMG";
  const label = elements.length > 1 ? `${elements.length} 个元素` : layerLabel(first);
  const rotate = /rotate\((-?[\d.]+)deg\)/u.exec(first.style.transform)?.[1] ?? "0";
  return (
    <>
      <Section
        title={label}
        actions={
          <span className="text-ui-xs text-muted-foreground">{first.tagName.toLowerCase()}</span>
        }
      >
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="outline" onClick={props.onAsk}>
            让 Moss 修改这里
          </Button>
          {!isRoot ? (
            <>
              <Button size="xs" variant="ghost" onClick={editor.duplicateSelection}>
                复制一份
              </Button>
              <Button size="xs" variant="ghost" onClick={editor.deleteSelection}>
                删除
              </Button>
            </>
          ) : null}
        </div>
      </Section>
      {!isRoot ? <ComponentSection editor={editor} element={first} /> : null}
      {!isRoot ? (
        <Section title="位置">
          <Row label="放置">
            <ChoiceRow
              label="放置方式"
              value={free ? "free" : "flow"}
              options={[
                { value: "flow", label: "随布局" },
                { value: "free", label: "自由放置" },
              ]}
              onChange={(mode) =>
                editor.editBoard(boardId, () => {
                  for (const element of elements) {
                    if (mode === "free") {
                      const left = element.offsetLeft;
                      const top = element.offsetTop;
                      const parent = element.offsetParent as HTMLElement | null;
                      if (parent && computed(parent)?.position === "static")
                        setStyle(parent, "position", "relative");
                      setStyle(element, "position", "absolute");
                      setStyle(element, "left", `${left}px`);
                      setStyle(element, "top", `${top}px`);
                    } else
                      for (const name of ["position", "left", "top", "right", "bottom"])
                        setStyle(element, name, "");
                  }
                  return undefined;
                })
              }
            />
          </Row>
          {free ? (
            <Row label="X / Y">
              <TextField
                label="X"
                numeric
                value={String(parseFloat(value("left")) || 0)}
                onCommit={px("left")}
              />
              <TextField
                label="Y"
                numeric
                value={String(parseFloat(value("top")) || 0)}
                onCommit={px("top")}
              />
            </Row>
          ) : null}
          <Row label="旋转">
            <TextField
              label="旋转角度"
              numeric
              value={rotate}
              onCommit={(next) => {
                const degrees = Number.parseFloat(next) || 0;
                const rest = first.style.transform.replace(/rotate\([^)]*\)\s*/u, "").trim();
                set("transform", `${degrees ? `rotate(${degrees}deg) ` : ""}${rest}`.trim());
              }}
            />
            <span className="text-ui-xs text-muted-foreground">度</span>
          </Row>
          <Row label="层级">
            <TextField
              label="层级"
              numeric
              value={inline("z-index")}
              placeholder="自动"
              onCommit={(next) => set("z-index", next)}
            />
          </Row>
          <Row label="缩放">
            <TextField
              label="缩放比例"
              numeric
              value="100"
              onCommit={(next) => {
                const percent = Number.parseFloat(next);
                if (Number.isFinite(percent) && percent > 0 && percent !== 100)
                  editor.scaleSelection(percent / 100);
              }}
            />
            <span className="text-ui-xs text-muted-foreground">%（K）</span>
          </Row>
          <div className="flex flex-wrap gap-1">
            <Button size="xs" variant="ghost" onClick={() => editor.flipSelection("x")}>
              <FlipHorizontalIcon className="size-4" /> 水平翻转
            </Button>
            <Button size="xs" variant="ghost" onClick={() => editor.flipSelection("y")}>
              垂直翻转
            </Button>
            <Button size="xs" variant="ghost" onClick={() => editor.reorderSelection("front")}>
              移到最前
            </Button>
            <Button size="xs" variant="ghost" onClick={() => editor.reorderSelection("back")}>
              移到最后
            </Button>
          </div>
        </Section>
      ) : null}
      <Section title="尺寸">
        <Row label="宽 / 高">
          <TextField
            label="宽"
            value={inline("width") || `${Math.round(first.getBoundingClientRect().width)}`}
            onCommit={px("width")}
          />
          <TextField
            label="高"
            value={inline("height") || `${Math.round(first.getBoundingClientRect().height)}`}
            onCommit={px("height")}
          />
        </Row>
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setMany({ width: "auto", height: "auto" })}
          >
            适应内容
          </Button>
          <Button size="xs" variant="ghost" onClick={() => set("width", "100%")}>
            填满宽度
          </Button>
        </div>
      </Section>
      <Section title="布局">
        <Row label="排列">
          <ChoiceRow
            label="排列方式"
            value={layout}
            options={[
              { value: "none", label: "无" },
              { value: "row", label: "横向" },
              { value: "column", label: "纵向" },
              { value: "grid", label: "网格" },
            ]}
            onChange={(next) =>
              next === "none"
                ? setMany({ display: "", "flex-direction": "", "grid-template-columns": "" })
                : next === "grid"
                  ? setMany({
                      display: "grid",
                      "flex-direction": "",
                      "grid-template-columns": "repeat(2, minmax(0, 1fr))",
                      gap: inline("gap") || "12px",
                    })
                  : setMany({
                      display: "flex",
                      "flex-direction": next,
                      gap: inline("gap") || "12px",
                    })
            }
          />
        </Row>
        {layout !== "none" ? (
          <>
            <Row label="间距">
              <TextField
                label="间距"
                numeric
                value={String(parseFloat(value("gap")) || 0)}
                onCommit={px("gap")}
              />
            </Row>
            {layout === "grid" ? (
              <Row label="列数">
                <TextField
                  label="列数"
                  numeric
                  value={String(
                    /repeat\((\d+)/u.exec(value("grid-template-columns"))?.[1] ??
                      style.gridTemplateColumns.split(" ").filter(Boolean).length,
                  )}
                  onCommit={(next) => {
                    const count = Math.max(
                      1,
                      Math.min(24, Math.round(Number.parseFloat(next) || 1)),
                    );
                    set("grid-template-columns", `repeat(${count}, minmax(0, 1fr))`);
                  }}
                />
              </Row>
            ) : (
              <>
                <Row label="对齐">
                  <SelectField
                    label="交叉轴对齐"
                    value={
                      (style.alignItems === "normal"
                        ? "stretch"
                        : style.alignItems) as (typeof ALIGN_OPTIONS)[number]["value"]
                    }
                    options={ALIGN_OPTIONS}
                    onChange={(next) => set("align-items", next)}
                  />
                </Row>
                <Row label="分布">
                  <SelectField
                    label="主轴分布"
                    value={
                      (style.justifyContent === "normal"
                        ? "flex-start"
                        : style.justifyContent) as (typeof JUSTIFY_OPTIONS)[number]["value"]
                    }
                    options={JUSTIFY_OPTIONS}
                    onChange={(next) => set("justify-content", next)}
                  />
                </Row>
                <Row label="换行">
                  <Switch
                    checked={style.flexWrap === "wrap"}
                    aria-label="换行"
                    onCheckedChange={(checked) => set("flex-wrap", checked ? "wrap" : "")}
                  />
                </Row>
              </>
            )}
          </>
        ) : null}
        <Row label="内边距">
          <SidesField
            label="内边距"
            value={inline("padding") || style.padding}
            sides={["padding-top", "padding-right", "padding-bottom", "padding-left"]}
            read={(name) => style.getPropertyValue(name)}
            onShorthand={(next) =>
              set("padding", /^\d+(\.\d+)?$/u.test(next.trim()) ? `${next.trim()}px` : next)
            }
            onSide={(name, next) => set(name, next)}
          />
        </Row>
        <Row label="外边距">
          <SidesField
            label="外边距"
            value={inline("margin") || style.margin}
            sides={["margin-top", "margin-right", "margin-bottom", "margin-left"]}
            read={(name) => style.getPropertyValue(name)}
            onShorthand={(next) =>
              set("margin", /^\d+(\.\d+)?$/u.test(next.trim()) ? `${next.trim()}px` : next)
            }
            onSide={(name, next) => set(name, next)}
          />
        </Row>
      </Section>
      {hasText ? (
        <Section title="文字">
          {tokens?.text.length ? (
            <Row label="文字样式">
              <SelectField
                label="文字样式"
                value={
                  (tokens.text.find(
                    (entry) => inline("font-size") === `var(--ds-text-${entry.name}-size)`,
                  )?.name ?? "") as string
                }
                options={[
                  { value: "", label: "自定义" },
                  ...tokens.text.map((entry) => ({
                    value: entry.name,
                    label: `${entry.label} ${entry.size}/${entry.lineHeight}`,
                  })),
                ]}
                onChange={(name) => {
                  const entry = tokens.text.find((text) => text.name === name);
                  if (entry)
                    setMany({
                      "font-family": `var(--ds-font-${entry.family})`,
                      "font-size": `var(--ds-text-${entry.name}-size)`,
                      "line-height": `var(--ds-text-${entry.name}-line)`,
                      "font-weight": `var(--ds-text-${entry.name}-weight)`,
                    });
                }}
              />
            </Row>
          ) : null}
          <Row label="字体">
            <FontField
              value={inline("font-family")}
              onChange={(next) => set("font-family", next)}
            />
          </Row>
          <Row label="字重 / 字号">
            <SelectField
              label="字重"
              value={String(Math.round(Number(style.fontWeight) / 100) * 100)}
              options={["300", "400", "500", "600", "700"].map((weight) => ({
                value: weight,
                label: { "300": "细", "400": "常规", "500": "中等", "600": "半粗", "700": "粗" }[
                  weight
                ]!,
              }))}
              onChange={(next) => set("font-weight", next)}
            />
            <TextField
              label="字号"
              numeric
              value={String(parseFloat(style.fontSize) || 16)}
              onCommit={px("font-size")}
              className="w-14"
            />
          </Row>
          <Row label="行高 / 字距">
            <TextField
              label="行高"
              value={inline("line-height") || style.lineHeight}
              onCommit={(next) => set("line-height", next)}
            />
            <TextField
              label="字距"
              numeric
              value={String(parseFloat(style.letterSpacing) || 0)}
              onCommit={px("letter-spacing")}
            />
          </Row>
          <Row label="对齐">
            <ChoiceRow
              label="文字对齐"
              value={
                (["left", "center", "right", "justify"].includes(style.textAlign)
                  ? style.textAlign
                  : "left") as string
              }
              options={[
                { value: "left", label: "左" },
                { value: "center", label: "中" },
                { value: "right", label: "右" },
                { value: "justify", label: "两端" },
              ]}
              onChange={(next) => set("text-align", next)}
            />
          </Row>
          <Row label="颜色">
            <ColorField
              label="文字颜色"
              value={inline("color") || style.color}
              tokens={tokens}
              allowNone={false}
              onChange={(next, coalesce) => set("color", next, coalesce)}
            />
          </Row>
          <ContrastLine element={first} />
          <Row label="样式">
            <ChoiceRow
              label="大小写"
              value={(style.textTransform === "none" ? "none" : style.textTransform) as string}
              options={[
                { value: "none", label: "原样" },
                { value: "uppercase", label: "大写" },
                { value: "lowercase", label: "小写" },
              ]}
              onChange={(next) => set("text-transform", next === "none" ? "" : next)}
            />
          </Row>
          <Row label="装饰">
            <ChoiceRow
              label="文字装饰"
              value={
                (style.textDecorationLine.includes("underline")
                  ? "underline"
                  : style.textDecorationLine.includes("line-through")
                    ? "line-through"
                    : "none") as string
              }
              options={[
                { value: "none", label: "无" },
                { value: "underline", label: "下划线" },
                { value: "line-through", label: "删除线" },
              ]}
              onChange={(next) => set("text-decoration", next === "none" ? "" : next)}
            />
          </Row>
        </Section>
      ) : null}
      <Section title="填充">
        <Row label="背景">
          <ColorField
            label="背景颜色"
            value={inline("background-color") || inline("background") || style.backgroundColor}
            tokens={tokens}
            onChange={(next, coalesce) =>
              next === ""
                ? setMany({ background: "", "background-color": "" })
                : set("background-color", next, coalesce)
            }
          />
        </Row>
        <GradientRows
          value={inline("background-image")}
          tokens={tokens}
          onChange={(next, coalesce) => set("background-image", next, coalesce)}
        />
      </Section>
      <Section title="边框">
        <Row label="粗细 / 样式">
          <TextField
            label="边框粗细"
            numeric
            value={String(parseFloat(style.borderTopWidth) || 0)}
            onCommit={(next) =>
              set("border-width", Number.parseFloat(next) ? `${Number.parseFloat(next)}px` : "")
            }
          />
          <SelectField
            label="边框样式"
            value={(style.borderTopStyle === "none" ? "none" : style.borderTopStyle) as string}
            options={[
              { value: "none", label: "无" },
              { value: "solid", label: "实线" },
              { value: "dashed", label: "虚线" },
              { value: "dotted", label: "点线" },
            ]}
            onChange={(next) =>
              next === "none"
                ? setMany({ border: "", "border-style": "", "border-width": "" })
                : setMany({
                    "border-style": next,
                    "border-width": parseFloat(style.borderTopWidth) ? style.borderTopWidth : "1px",
                  })
            }
          />
        </Row>
        <Row label="颜色">
          <ColorField
            label="边框颜色"
            value={inline("border-color") || style.borderTopColor}
            tokens={tokens}
            onChange={(next, coalesce) => set("border-color", next, coalesce)}
          />
        </Row>
        <Row label="圆角">
          <SidesField
            label="圆角"
            value={inline("border-radius") || String(parseFloat(style.borderTopLeftRadius) || 0)}
            sides={[
              "border-top-left-radius",
              "border-top-right-radius",
              "border-bottom-right-radius",
              "border-bottom-left-radius",
            ]}
            sideLabels={["左上", "右上", "右下", "左下"]}
            read={(name) => style.getPropertyValue(name)}
            onShorthand={(next) =>
              set("border-radius", /^\d+(\.\d+)?$/u.test(next.trim()) ? `${next.trim()}px` : next)
            }
            onSide={(name, next) => set(name, next)}
          />
        </Row>
      </Section>
      <Section title="效果">
        <Row label="不透明度">
          <TextField
            label="不透明度"
            numeric
            value={String(Math.round(Number(style.opacity) * 100))}
            onCommit={(next) => {
              const n = Math.max(0, Math.min(100, Number.parseFloat(next) || 0));
              set("opacity", n === 100 ? "" : String(n / 100));
            }}
          />
          <span className="text-ui-xs text-muted-foreground">%</span>
        </Row>
        <Row label="阴影">
          <SelectField
            label="阴影"
            value={
              (inline("box-shadow")
                ? inline("box-shadow").startsWith("var(")
                  ? inline("box-shadow")
                  : "custom"
                : "") as string
            }
            options={[
              { value: "", label: "无" },
              { value: "0 1px 3px rgba(0, 0, 0, 0.08)", label: "轻" },
              {
                value: "0 2px 6px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.12)",
                label: "浮起",
              },
              { value: "inset 0 1px 3px rgba(0, 0, 0, 0.16)", label: "内阴影" },
              ...(tokens?.shadows ?? []).map((shadow) => ({
                value: `var(--ds-shadow-${shadow.name})`,
                label: `设计系统：${shadow.name}`,
              })),
              { value: "custom", label: "自定义（在代码里改）" },
            ]}
            onChange={(next) => next !== "custom" && set("box-shadow", next)}
          />
        </Row>
        <Row label="混合">
          <SelectField
            label="混合模式"
            value={inline("mix-blend-mode") as string}
            options={BLEND_MODES}
            onChange={(next) => set("mix-blend-mode", next)}
          />
        </Row>
        <Row label="模糊">
          <TextField
            label="图层模糊"
            numeric
            value={/blur\(([\d.]+)px\)/u.exec(inline("filter"))?.[1] ?? "0"}
            onCommit={(next) =>
              set("filter", Number.parseFloat(next) ? `blur(${Number.parseFloat(next)}px)` : "")
            }
          />
          <TextField
            label="背景模糊"
            numeric
            value={/blur\(([\d.]+)px\)/u.exec(inline("backdrop-filter"))?.[1] ?? "0"}
            onCommit={(next) =>
              set(
                "backdrop-filter",
                Number.parseFloat(next) ? `blur(${Number.parseFloat(next)}px)` : "",
              )
            }
          />
        </Row>
      </Section>
      {first.tagName === "A" ? (
        <LinkSection editor={editor} boardId={boardId} element={first} />
      ) : null}
      {first.tagName === "IMG" ? (
        <Section title="图片">
          <Row label="替代文字">
            <TextField
              label="替代文字"
              value={first.getAttribute("alt") ?? ""}
              onCommit={(next) =>
                editor.editBoard(boardId, () => void first.setAttribute("alt", next))
              }
            />
          </Row>
          <Row label="填充方式">
            <ChoiceRow
              label="填充方式"
              value={
                (style.objectFit === "contain"
                  ? "contain"
                  : style.objectFit === "fill"
                    ? "fill"
                    : "cover") as string
              }
              options={[
                { value: "cover", label: "裁切填满" },
                { value: "contain", label: "完整显示" },
                { value: "fill", label: "拉伸" },
              ]}
              onChange={(next) => set("object-fit", next)}
            />
          </Row>
          <div className="flex flex-wrap gap-1">
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                editor.selection.element &&
                props.onReplaceImage(boardId, editor.selection.element.paths[0]!)
              }
            >
              替换图片…
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={editor.readOnly}
              onClick={() =>
                editor.selection.element &&
                editor.setCropping({ boardId, path: editor.selection.element.paths[0]! })
              }
            >
              裁切
            </Button>
            {first.style.getPropertyValue("object-view-box") ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  editor.editBoard(boardId, () => {
                    const box = frameRect(first);
                    const full = fullImageRect(box, readCrop(first));
                    writeCrop(first, NO_CROP, full, {
                      box,
                      left: first.offsetLeft,
                      top: first.offsetTop,
                      free: isPositioned(first),
                    });
                    return undefined;
                  })
                }
              >
                还原裁切
              </Button>
            ) : null}
          </div>
        </Section>
      ) : null}
      {first.tagName === "VIDEO" ? (
        <VideoSection editor={editor} boardId={boardId} element={first} />
      ) : null}
    </>
  );
}

/** Text contrast against what is behind it, with a plain verdict. */
function ContrastLine(props: { element: HTMLElement }) {
  const readout = textContrast(props.element);
  if (!readout) return null;
  return (
    <p
      data-design-contrast={readout.verdict}
      className={cn(
        "pl-[80px] text-ui-xs",
        readout.verdict === "low" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {readout.label}
    </p>
  );
}

/** Solid fill stays in 背景; a gradient layers over it. */
function GradientRows(props: {
  value: string;
  tokens: DesignSystemTokens | null;
  onChange: (value: string, coalesce?: boolean) => void;
}) {
  const gradient = readGradient(props.value);
  const kind = gradient?.kind ?? (props.value ? "custom" : "none");
  const current = gradient ?? { kind: "linear" as const, angle: 180, from: "white", to: "black" };
  return (
    <>
      <Row label="渐变">
        <ChoiceRow
          label="渐变"
          value={kind}
          options={[
            { value: "none", label: "无" },
            { value: "linear", label: "线性" },
            { value: "radial", label: "径向" },
            ...(kind === "custom" ? [{ value: "custom" as const, label: "自定义" }] : []),
          ]}
          onChange={(next) =>
            next === "none"
              ? props.onChange("")
              : next === "custom"
                ? undefined
                : props.onChange(writeGradient({ ...current, kind: next }))
          }
        />
      </Row>
      {gradient ? (
        <>
          <Row label="起点">
            <ColorField
              label="渐变起点颜色"
              value={gradient.from}
              tokens={props.tokens}
              allowNone={false}
              onChange={(from, coalesce) =>
                props.onChange(writeGradient({ ...gradient, from }), coalesce)
              }
            />
          </Row>
          <Row label="终点">
            <ColorField
              label="渐变终点颜色"
              value={gradient.to}
              tokens={props.tokens}
              allowNone={false}
              onChange={(to, coalesce) =>
                props.onChange(writeGradient({ ...gradient, to }), coalesce)
              }
            />
          </Row>
          {gradient.kind === "linear" ? (
            <Row label="角度">
              <TextField
                label="渐变角度"
                numeric
                value={String(gradient.angle)}
                onCommit={(next) =>
                  props.onChange(
                    writeGradient({ ...gradient, angle: Math.round(Number.parseFloat(next) || 0) }),
                  )
                }
              />
              <span className="text-ui-xs text-muted-foreground">度</span>
            </Row>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Make a component from the element, or manage the instance it belongs to. */
function ComponentSection(props: { editor: DesignEditorState; element: HTMLElement }) {
  const { editor } = props;
  const instance = instanceRoot(props.element);
  const id = instance?.getAttribute(COMPONENT_ATTR) ?? null;
  const component = id ? editor.components.find((entry) => entry.id === id) : undefined;
  const own = Boolean(id && editor.canvas.components?.some((entry) => entry.id === id));
  if (editor.readOnly && !instance) return null;
  return (
    <Section title="组件">
      {instance ? (
        <>
          <Row label="实例">
            <span className="truncate text-ui-sm text-foreground">
              {component?.name ?? "（组件已删除）"}
            </span>
          </Row>
          {!editor.readOnly ? (
            <div className="flex flex-wrap gap-1">
              {own ? (
                <Button size="xs" variant="outline" onClick={editor.pushInstanceToComponent}>
                  用这个实例更新组件
                </Button>
              ) : null}
              {component ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    const count = editor.syncComponent(component);
                    toastManager.add({
                      type: "info",
                      title: count ? `已把组件写回 ${count} 个实例` : "实例已经和组件一致",
                    });
                  }}
                >
                  恢复成组件样子
                </Button>
              ) : null}
              <Button size="xs" variant="ghost" onClick={editor.detachSelection}>
                分离实例
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <Button size="xs" variant="outline" onClick={() => editor.createComponent()}>
          做成组件
        </Button>
      )}
    </Section>
  );
}

/** A video: where it plays from, its cover, and how it plays. */
function VideoSection(props: { editor: DesignEditorState; boardId: string; element: HTMLElement }) {
  const { element } = props;
  const attribute = (name: string, on: boolean) =>
    props.editor.editBoard(props.boardId, () => {
      if (on) element.setAttribute(name, "");
      else element.removeAttribute(name);
      // Autoplay only works muted in every browser.
      if (name === "autoplay" && on) element.setAttribute("muted", "");
    });
  const url = (name: "src" | "poster") => (next: string) => {
    const trimmed = next.trim();
    if (trimmed && !/^(https:\/\/|data:(video|image)\/|blob:)/iu.test(trimmed))
      return void toastManager.add({ type: "info", title: "请填写 https:// 开头的地址" });
    props.editor.editBoard(props.boardId, () => {
      if (trimmed) element.setAttribute(name, trimmed);
      else element.removeAttribute(name);
    });
  };
  const src = element.getAttribute("src") ?? "";
  return (
    <Section title="视频">
      <Row label="地址">
        <TextField
          label="视频地址"
          value={src.startsWith("data:") ? "（已放入的小视频）" : src}
          placeholder="https://…/video.mp4"
          onCommit={url("src")}
        />
      </Row>
      <Row label="封面">
        <TextField
          label="视频封面地址"
          value={
            (element.getAttribute("poster") ?? "").startsWith("data:")
              ? "（已放入）"
              : (element.getAttribute("poster") ?? "")
          }
          placeholder="https://…/cover.jpg"
          onCommit={url("poster")}
        />
      </Row>
      {(
        [
          ["autoplay", "自动播放"],
          ["loop", "循环"],
          ["muted", "静音"],
          ["controls", "播放控件"],
        ] as const
      ).map(([name, label]) => (
        <Row key={name} label={label}>
          <Switch
            checked={element.hasAttribute(name)}
            aria-label={label}
            onCheckedChange={(checked) => attribute(name, checked === true)}
          />
        </Row>
      ))}
      <p className="text-ui-xs text-muted-foreground">
        视频不存进设计里（太大）；请填网址。小于 300 KB 的短片可以直接拖进画板。
      </p>
    </Section>
  );
}

function LinkSection(props: { editor: DesignEditorState; boardId: string; element: HTMLElement }) {
  const href = props.element.getAttribute("href") ?? "";
  const target = href.startsWith("board:") ? href.slice(6) : "";
  const write = (next: string) =>
    props.editor.editBoard(props.boardId, () => {
      if (next) props.element.setAttribute("href", next);
      else props.element.removeAttribute("href");
    });
  return (
    <Section title="链接">
      <Row label="跳到画板">
        <SelectField
          label="跳到画板"
          value={target}
          options={[
            { value: "", label: "不跳转画板" },
            ...props.editor.canvas.boards
              .filter((board) => board.id !== props.boardId)
              .map((board) => ({ value: board.id, label: board.name })),
          ]}
          onChange={(id) => write(id ? `board:${id}` : "")}
        />
      </Row>
      <Row label="网址">
        <TextField
          label="链接地址"
          value={target ? "" : href}
          placeholder="https://… 或 #区块"
          onCommit={(next) => {
            const trimmed = next.trim();
            if (trimmed && !/^(https?:\/\/|#|mailto:|tel:)/iu.test(trimmed)) {
              toastManager.add({
                type: "info",
                title: "请输入 https:// 开头的网址、#区块、mailto: 或 tel:",
              });
              return;
            }
            write(trimmed);
          }}
        />
      </Row>
      <p className="text-ui-xs text-muted-foreground">播放原型时，点击这个链接会跳到所选画板。</p>
    </Section>
  );
}

// ─── 图层 ──────────────────────────────────────────────────────────────────────────────

function LayersTab(props: { editor: DesignEditorState }) {
  const { editor } = props;
  void editor.layoutTick;
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        editor.selection.element ? [editor.selection.element.boardId] : editor.selection.boards,
      ),
  );
  useEffect(() => {
    const id = editor.selection.element?.boardId;
    if (id) setOpen((current) => (current.has(id) ? current : new Set([...current, id])));
  }, [editor.selection.element?.boardId]);
  if (!editor.pageBoards.length) return <Empty>这一页还没有画板。</Empty>;
  return (
    <ul className="py-1 text-ui-sm" role="tree" aria-label="图层">
      {[...editor.pageBoards].reverse().map((board) => {
        const expanded = open.has(board.id);
        const body = expanded ? editor.frames.current.get(board.id)?.body() : null;
        const selected = editor.selection.boards.includes(board.id);
        return (
          <li key={board.id} role="treeitem" aria-expanded={expanded} aria-selected={selected}>
            <LayerRow
              depth={0}
              label={board.name}
              selected={selected}
              hidden={board.hidden === true}
              expandable
              expanded={expanded}
              onToggle={() =>
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(board.id)) next.delete(board.id);
                  else next.add(board.id);
                  return next;
                })
              }
              onSelect={() => editor.setSelection({ boards: [board.id], notes: [], element: null })}
              onHide={() =>
                editor.apply([
                  {
                    op: "upsertBoard",
                    board: { id: board.id, hidden: board.hidden ? false : true },
                  },
                ])
              }
            />
            {body ? (
              <LayerNodes editor={editor} boardId={board.id} nodes={layerTree(body)} depth={1} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function LayerNodes(props: {
  editor: DesignEditorState;
  boardId: string;
  nodes: readonly DesignLayerNode[];
  depth: number;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const selected =
    props.editor.selection.element?.boardId === props.boardId
      ? props.editor.selection.element.paths
      : [];
  return (
    <ul role="group">
      {props.nodes.map((node) => (
        <li key={node.path} role="treeitem" aria-selected={selected.includes(node.path)}>
          <LayerRow
            depth={props.depth}
            label={node.label}
            selected={selected.includes(node.path)}
            hidden={node.hidden}
            expandable={node.children.length > 0}
            expanded={!closed.has(node.path)}
            onToggle={() =>
              setClosed((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
            onSelect={(add) =>
              props.editor.setSelection({
                boards: [],
                notes: [],
                element: {
                  boardId: props.boardId,
                  paths: add ? [...new Set([...selected, node.path])] : [node.path],
                },
              })
            }
            onHover={(on) =>
              props.editor.setHover(on ? { boardId: props.boardId, path: node.path } : null)
            }
            onHide={() =>
              props.editor.editBoard(props.boardId, (body) => {
                const element = elementAt(body, node.path);
                if (element) setStyle(element, "display", node.hidden ? "" : "none");
                return undefined;
              })
            }
            onRename={(name) =>
              props.editor.editBoard(props.boardId, (body) => {
                const element = elementAt(body, node.path);
                if (!element) return undefined;
                if (name.trim()) element.setAttribute("data-name", name.trim().slice(0, 60));
                else element.removeAttribute("data-name");
                return undefined;
              })
            }
          />
          {node.children.length && !closed.has(node.path) ? (
            <LayerNodes
              editor={props.editor}
              boardId={props.boardId}
              nodes={node.children}
              depth={props.depth + 1}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LayerRow(props: {
  depth: number;
  label: string;
  selected: boolean;
  hidden: boolean;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (add: boolean) => void;
  onHide: () => void;
  onHover?: (on: boolean) => void;
  onRename?: (name: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  return (
    <div
      className={cn(
        "group/layer flex h-7 items-center gap-1 rounded-row pr-1",
        props.selected
          ? "bg-[color-mix(in_srgb,var(--color-text-accent)_12%,transparent)] text-foreground"
          : "hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)]",
        props.hidden && "text-muted-foreground",
      )}
      style={{ paddingLeft: 4 + props.depth * 12 }}
      onMouseEnter={() => props.onHover?.(true)}
      onMouseLeave={() => props.onHover?.(false)}
    >
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={props.expanded ? "收起" : "展开"}
        className={cn("size-5 shrink-0 text-muted-foreground", !props.expandable && "invisible")}
        onClick={props.onToggle}
      >
        <ChevronRightIcon
          className={cn("size-3 transition-transform", props.expanded && "rotate-90")}
        />
      </Button>
      {renaming ? (
        <input
          autoFocus
          aria-label="图层名称"
          defaultValue={props.label}
          className={cn(FIELD_CLASS, "flex-1")}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" || event.key === "Escape")
              (event.target as HTMLInputElement).blur();
          }}
          onBlur={(event) => {
            setRenaming(false);
            if (event.target.value !== props.label) props.onRename?.(event.target.value);
          }}
        />
      ) : (
        <Button
          variant="ghost"
          size="xs"
          className="h-6 min-w-0 flex-1 justify-start truncate px-1 font-normal"
          onClick={(event) => props.onSelect(event.shiftKey)}
          onDoubleClick={() => props.onRename && setRenaming(true)}
        >
          <span className="truncate">{props.label}</span>
        </Button>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={props.hidden ? "显示" : "隐藏"}
        className={cn(
          "size-5 shrink-0 text-muted-foreground",
          !props.hidden && "opacity-0 group-hover/layer:opacity-100",
        )}
        onClick={props.onHide}
      >
        {props.hidden ? <EyeSlashIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

// ─── 代码 ──────────────────────────────────────────────────────────────────────────────

function CodeTab(props: { editor: DesignEditorState }) {
  const { editor } = props;
  void editor.layoutTick;
  const current = editor.selectedElements();
  const board = current
    ? editor.boardById(current.boardId)
    : editor.selection.boards.length === 1
      ? editor.boardById(editor.selection.boards[0]!)
      : undefined;
  if (current && current.elements.length === 1)
    return <ElementCode editor={editor} boardId={current.boardId} element={current.elements[0]!} />;
  if (board && !current) return <BoardCode editor={editor} board={board} />;
  return <Empty>点选设计里的一个元素，在这里看和改它的样式与 HTML。</Empty>;
}

function ErrorList(props: { errors: readonly StyleLineError[] }) {
  return props.errors.length ? (
    <ul className="text-ui-xs text-[var(--color-text-danger)]" role="alert">
      {props.errors.map((error) => (
        <li key={error.line}>
          第 {error.line} 行：{error.message}
        </li>
      ))}
    </ul>
  ) : null;
}

function ElementCode(props: { editor: DesignEditorState; boardId: string; element: HTMLElement }) {
  const css = styleLines(props.element);
  const html = props.element.outerHTML;
  const [draft, setDraft] = useState(css);
  const [errors, setErrors] = useState<StyleLineError[]>([]);
  const [markup, setMarkup] = useState(html);
  useEffect(() => setDraft(css), [css]);
  useEffect(() => setMarkup(html), [html]);
  const applyCss = () => {
    const parsed = parseStyleLines(draft);
    setErrors(parsed.errors);
    if (parsed.errors.length) return;
    props.editor.editBoard(props.boardId, () => void replaceStyle(props.element, parsed.values));
  };
  const applyHtml = () => {
    const template = props.element.ownerDocument.createElement("template");
    template.innerHTML = markup.trim();
    const replacement = template.content.firstElementChild;
    if (!replacement || template.content.children.length !== 1) {
      toastManager.add({ type: "error", title: "HTML 需要正好是一个元素" });
      return;
    }
    props.editor.editBoard(props.boardId, (body) => {
      props.element.replaceWith(replacement);
      void body;
      return undefined;
    });
  };
  return (
    <div className="flex flex-col gap-3 p-3">
      <Section title="样式">
        <textarea
          aria-label="元素样式"
          spellCheck={false}
          value={draft}
          rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
          className="w-full resize-y rounded-control-xs border border-border bg-transparent p-2 font-mono text-ui-xs text-foreground outline-none focus:border-[var(--color-text-accent)]"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) applyCss();
          }}
          onBlur={applyCss}
        />
        <ErrorList errors={errors} />
      </Section>
      <Section
        title="HTML"
        actions={
          <Button size="xs" variant="ghost" onClick={applyHtml}>
            应用
          </Button>
        }
      >
        <textarea
          aria-label="元素 HTML"
          spellCheck={false}
          value={markup}
          rows={10}
          className="w-full resize-y rounded-control-xs border border-border bg-transparent p-2 font-mono text-ui-xs text-foreground outline-none focus:border-[var(--color-text-accent)]"
          onChange={(event) => setMarkup(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) applyHtml();
          }}
        />
      </Section>
    </div>
  );
}

function BoardCode(props: { editor: DesignEditorState; board: DesignBoard }) {
  const [draft, setDraft] = useState(props.board.html);
  useEffect(() => setDraft(props.board.html), [props.board.html]);
  return (
    <div className="p-3">
      <Section
        title={`“${props.board.name}”的 HTML`}
        actions={
          <Button
            size="xs"
            variant="ghost"
            disabled={draft === props.board.html}
            onClick={() =>
              props.editor.apply([
                { op: "upsertBoard", board: { id: props.board.id, html: draft } },
              ])
            }
          >
            应用
          </Button>
        }
      >
        <textarea
          aria-label="画板 HTML"
          spellCheck={false}
          value={draft}
          rows={24}
          className="w-full resize-y rounded-control-xs border border-border bg-transparent p-2 font-mono text-ui-xs text-foreground outline-none focus:border-[var(--color-text-accent)]"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </Section>
    </div>
  );
}

// ─── 调整 ──────────────────────────────────────────────────────────────────────────────

function TweaksTab(props: { editor: DesignEditorState; onAsk: () => void }) {
  const { editor } = props;
  const boardId =
    editor.selection.element?.boardId ??
    (editor.selection.boards.length === 1 ? editor.selection.boards[0] : undefined);
  const board = boardId ? editor.boardById(boardId) : undefined;
  if (!board) return <Empty>点选画布上的一个画板，在这里看它的可调整项。</Empty>;
  if (!board.tweaks?.length)
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <p className="text-ui-sm text-muted-foreground">
          这个画板还没有可调整项。告诉 Moss 你想调整什么（比如强调色、密度），它会加上。
        </p>
        <Button size="xs" variant="outline" onClick={props.onAsk}>
          让 Moss 添加
        </Button>
      </div>
    );
  const write = (tweak: DesignTweak, next: string | number | boolean) =>
    editor.apply(
      [
        {
          op: "upsertBoard",
          board: { id: board.id, tweakValues: { ...board.tweakValues, [tweak.name]: next } },
        },
      ],
      `tweak:${board.id}:${tweak.name}`,
    );
  return (
    <Section
      title={`“${board.name}”的调整项`}
      actions={
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() =>
            editor.apply([{ op: "upsertBoard", board: { id: board.id, tweakValues: {} } }])
          }
        >
          恢复默认
        </Button>
      }
    >
      {board.tweaks.map((tweak) => {
        const value = board.tweakValues?.[tweak.name] ?? tweak.default;
        return (
          <Row key={tweak.name} label={tweak.label}>
            {tweak.editor === "boolean" ? (
              <Switch
                checked={value === true}
                aria-label={tweak.label}
                onCheckedChange={(checked) => write(tweak, checked === true)}
              />
            ) : tweak.editor === "enum" ? (
              <SelectField
                label={tweak.label}
                value={String(value)}
                options={(tweak.options ?? []).map((option) => ({ value: option, label: option }))}
                onChange={(next) => write(tweak, next)}
              />
            ) : tweak.editor === "range" ? (
              <>
                <input
                  type="range"
                  aria-label={tweak.label}
                  min={tweak.min ?? 0}
                  max={tweak.max ?? 100}
                  step={tweak.step ?? 1}
                  value={Number(value)}
                  className="min-w-0 flex-1 accent-[var(--color-text-accent)]"
                  onChange={(event) => write(tweak, Number(event.target.value))}
                />
                <span className="w-12 text-right text-ui-xs text-muted-foreground">
                  {String(value)}
                  {tweak.unit ?? ""}
                </span>
              </>
            ) : tweak.editor === "color" ? (
              <ColorField
                label={tweak.label}
                value={String(value)}
                tokens={null}
                allowNone={false}
                onChange={(next) => next && write(tweak, next)}
              />
            ) : (
              <TextField
                label={tweak.label}
                value={String(value)}
                onCommit={(next) => write(tweak, next)}
              />
            )}
          </Row>
        );
      })}
    </Section>
  );
}

// ─── 主题 ──────────────────────────────────────────────────────────────────────────────

function ThemeTab(props: {
  editor: DesignEditorState;
  scopeSpaceId: Parameters<typeof DesignInspector>[0]["scopeSpaceId"];
  selfPageId: string;
}) {
  const { editor } = props;
  const system = editor.canvas.system;
  const itemSystems = useQuery({
    queryKey: ["design-systems", props.scopeSpaceId],
    queryFn: async () => {
      const api = ensureNativeApi();
      const pages = (await api.pages.list({ scopeSpaceId: props.scopeSpaceId })).pages
        .filter(
          (page) =>
            page.kind === "design" && page.trashedAt === null && page.id !== props.selfPageId,
        )
        .slice(0, 40);
      const found: {
        id: string;
        name: string;
        tokens: DesignSystemTokens;
        components: readonly DesignComponent[];
      }[] = [];
      for (const page of pages) {
        const item = await api.pageTypes
          .read({ scopeSpaceId: props.scopeSpaceId, pageId: page.id })
          .catch(() => null);
        const canvas = item?.data ? parseCanvasOrNull(item.data) : null;
        if (canvas?.ownSystem)
          found.push({
            id: page.id,
            name: page.title,
            tokens: canvas.ownSystem,
            components: canvas.components ?? [],
          });
      }
      return found;
    },
    staleTime: 30_000,
  });
  const choices = useMemo(
    () => [
      ...BUILT_IN_DESIGN_SYSTEMS.map((entry) => ({
        source: `builtin:${entry.id}`,
        name: entry.name,
        description: entry.description,
        tokens: entry.tokens,
        components: [] as readonly DesignComponent[],
      })),
      ...(itemSystems.data ?? []).map((entry) => ({
        source: `page:${entry.id}`,
        name: entry.name,
        description: entry.components.length
          ? `资料空间里的设计系统 · ${entry.components.length} 个组件`
          : "资料空间里的设计系统",
        tokens: entry.tokens,
        components: entry.components,
      })),
    ],
    [itemSystems.data],
  );
  const install = (choice: (typeof choices)[number] | null) =>
    editor.commit(
      choice
        ? {
            ...editor.canvas,
            system: {
              source: choice.source,
              name: choice.name.slice(0, 80),
              tokens: choice.tokens,
              copiedAt: new Date().toISOString(),
              ...(choice.components.length ? { components: choice.components } : {}),
            },
          }
        : { ...editor.canvas, system: null },
    );
  const target = editor.selectedElements();
  const [use, setUse] = useState<"color" | "background-color" | "border-color">("color");
  const applyToken = (cssValue: string, property: string) => {
    if (!target) {
      toastManager.add({ type: "info", title: "先在画布上选中一个元素" });
      return;
    }
    editor.editBoard(target.boardId, () => {
      for (const element of target.elements) setStyle(element, property, cssValue);
      return undefined;
    });
  };
  const ownSystem = editor.canvas.ownSystem;
  return (
    <>
      <Section title="设计系统">
        <SelectField
          label="设计系统"
          value={system?.source ?? ""}
          options={[
            { value: "", label: "不使用" },
            ...choices.map((choice) => ({ value: choice.source, label: choice.name })),
          ]}
          onChange={(source) => install(choices.find((choice) => choice.source === source) ?? null)}
          disabled={editor.readOnly}
        />
        {system?.tokens.readme ? (
          <p className="text-ui-xs text-muted-foreground whitespace-pre-wrap">
            {system.tokens.readme}
          </p>
        ) : null}
        {system &&
        choices.find(
          (choice) =>
            choice.source === system.source &&
            JSON.stringify(choice.tokens) !== JSON.stringify(system.tokens),
        ) ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => install(choices.find((choice) => choice.source === system.source)!)}
          >
            更新到设计系统的最新版本
          </Button>
        ) : null}
        <Row label="主题">
          <ChoiceRow
            label="主题"
            value={editor.canvas.theme ?? "light"}
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onChange={(theme) => editor.apply([{ op: "setTheme", theme }])}
          />
        </Row>
      </Section>
      {system ? (
        <>
          <Section
            title="颜色"
            actions={
              <SelectField
                label="颜色用于"
                value={use}
                options={[
                  { value: "color", label: "用于文字" },
                  { value: "background-color", label: "用于填充" },
                  { value: "border-color", label: "用于边框" },
                ]}
                onChange={setUse}
              />
            }
          >
            <div className="grid grid-cols-2 gap-1">
              {system.tokens.colors.map((token) => (
                <Button
                  key={token.name}
                  variant="ghost"
                  size="xs"
                  className="h-8 justify-start gap-2 px-1 font-normal"
                  title={token.usage ?? token.label}
                  onClick={() => applyToken(`var(--ds-${token.name})`, use)}
                >
                  <span
                    className="size-5 shrink-0 rounded-full border border-border"
                    style={{
                      background:
                        editor.canvas.theme === "dark" ? (token.dark ?? token.light) : token.light,
                    }}
                  />
                  <span className="min-w-0 truncate">{token.label}</span>
                </Button>
              ))}
            </div>
          </Section>
          <Section title="文字样式">
            {system.tokens.text.length === 0 ? (
              <p className="text-ui-xs text-muted-foreground">这个设计系统没有文字样式。</p>
            ) : null}
            {system.tokens.text.map((style) => (
              <Button
                key={style.name}
                variant="ghost"
                className="h-auto justify-between gap-2 px-1.5 py-1 text-left font-normal"
                onClick={() => {
                  if (!target)
                    return void toastManager.add({ type: "info", title: "先在画布上选中一段文字" });
                  editor.editBoard(target.boardId, () => {
                    for (const element of target.elements) {
                      setStyle(element, "font-family", `var(--ds-font-${style.family})`);
                      setStyle(element, "font-size", `var(--ds-text-${style.name}-size)`);
                      setStyle(element, "line-height", `var(--ds-text-${style.name}-line)`);
                      setStyle(element, "font-weight", `var(--ds-text-${style.name}-weight)`);
                    }
                    return undefined;
                  });
                }}
              >
                <span
                  className="truncate"
                  style={{
                    fontSize: Math.min(22, style.size),
                    fontWeight: style.weight >= 600 ? 500 : 400,
                  }}
                >
                  {style.label}
                </span>
                <span className="shrink-0 text-ui-xs text-muted-foreground">
                  {style.size}/{style.lineHeight}
                </span>
              </Button>
            ))}
          </Section>
        </>
      ) : null}
      <Section title="把这份设计作为设计系统">
        <Row label="设计系统">
          <Switch
            checked={ownSystem !== undefined}
            aria-label="作为设计系统"
            disabled={editor.readOnly || (!ownSystem && !system)}
            onCheckedChange={(checked) => {
              const { ownSystem: _drop, ...rest } = editor.canvas;
              editor.commit(
                checked && system ? { ...rest, ownSystem: system.tokens } : (rest as DesignCanvas),
              );
            }}
          />
        </Row>
        <p className="text-ui-xs text-muted-foreground">
          打开后，同一资料空间里的其他设计可以在这里选用它的颜色和文字样式。也可以让 Moss
          从你的代码仓库读出颜色、字体和组件，生成一个设计系统。
        </p>
      </Section>
    </>
  );
}
