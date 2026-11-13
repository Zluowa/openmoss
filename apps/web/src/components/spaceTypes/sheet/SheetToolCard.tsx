// FILE: SheetToolCard.tsx
// Purpose: The 电子表格 tool card that floats over the bottom of the grid: font looks, colours,
//          alignment and wrap, number formats and decimals, borders, merge, insert and delete,
//          sort and filter, charts, the rest under 更多, and the "让 Moss 修改" field.
// Layer: 资料空间 电子表格 (types stream)
// Exports: SheetToolCard, SheetToolState, SheetToolActions, SheetBorderEdges, NUMBER_FORMAT_CHOICES.
// Why: The tools follow the selection, sit where the hand already is, and leave the grid's
//      full height to the cells.

import {
  SHEET_HUES,
  SHEET_PALETTE,
  SHEET_SHADES,
  type SheetBorderStyle,
  type SheetChartKind,
} from "@moss/shared/spaceItems/sheetWorkbook";
import { formatSheetNumber, SHEET_NUMBER_FORMATS } from "@moss/shared/spaceItems/sheetValues";
import { useState, type ReactNode } from "react";

import {
  AlignBottomIcon,
  AlignCenterIcon,
  AlignLeftIcon,
  AlignMiddleIcon,
  AlignRightIcon,
  AlignTopIcon,
  ArrowUpIcon,
  ChartBarIcon,
  ChartLineIcon,
  ChartPieIcon,
  ChartStackedIcon,
  CheckboxCheckedIcon,
  ChevronDownIcon,
  EllipsisIcon,
  EraserIcon,
  FillColorIcon,
  FilterIcon,
  ListBulletsIcon,
  PercentIcon,
  SheetBorderAllIcon,
  SheetBorderBottomIcon,
  SheetBorderHorizontalIcon,
  SheetBorderInnerIcon,
  SheetBorderLeftIcon,
  SheetBorderNoneIcon,
  SheetBorderOuterIcon,
  SheetBorderRightIcon,
  SheetBorderTopIcon,
  SheetBorderVerticalIcon,
  SheetColumnInsertLeftIcon,
  SheetColumnInsertRightIcon,
  SheetDecimalLessIcon,
  SheetDecimalMoreIcon,
  SheetFreezeIcon,
  SheetMergeIcon,
  SheetRowDeleteIcon,
  SheetRowInsertAboveIcon,
  SheetRowInsertBelowIcon,
  SheetUnmergeIcon,
  SortAscendingIcon,
  SortDescendingIcon,
  SparklesIcon,
  TableIcon,
  TextBoldIcon,
  TextColorIcon,
  TextItalicIcon,
  TextSizeIcon,
  TextStrikeIcon,
  TextUnderlineIcon,
  TextWrapIcon,
  type LucideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SHEET_INK, SHEET_WHITE } from "~/theme/sheetPalette";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../../chat/chatHeaderControls";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../../chat/ComposerPickerMenuPopup";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { SpaceToolbarButton, SpaceToolbarDivider } from "../shared/SpaceEditorChrome";

export type SheetBorderEdges =
  | "all"
  | "outer"
  | "inner"
  | "innerHorizontal"
  | "innerVertical"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "none";

export interface SheetToolState {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly size: number | null;
  readonly align: "left" | "center" | "right" | null;
  readonly valign: "top" | "middle" | "bottom";
  readonly wrap: boolean;
  readonly format: string;
  readonly isMerged: boolean;
  readonly canMerge: boolean;
  readonly hasTable: boolean;
  readonly gridlinesHidden: boolean;
  /** The row / column group the selection sits in, if any. */
  readonly rowGroup: { readonly collapsed: boolean } | null;
  readonly columnGroup: { readonly collapsed: boolean } | null;
  readonly frozenRows: number;
  readonly frozenColumns: number;
  readonly hasFilter: boolean;
  readonly mossLabel: string | null;
  readonly mossBusy: boolean;
}

export interface SheetToolActions {
  toggle(look: "bold" | "italic" | "underline" | "strike"): void;
  fontSize(points: number): void;
  color(kind: "text" | "fill", hex: string | null): void;
  align(horizontal: "left" | "center" | "right" | null): void;
  valign(vertical: "top" | "middle" | "bottom"): void;
  wrap(on: boolean): void;
  numberFormat(pattern: string): void;
  decimals(step: 1 | -1): void;
  borders(edges: SheetBorderEdges, style: SheetBorderStyle, color: string | null): void;
  merge(on: boolean): void;
  insert(kind: "rowAbove" | "rowBelow" | "columnLeft" | "columnRight"): void;
  remove(kind: "rows" | "columns"): void;
  sort(direction: "ascending" | "descending", scope: "range" | "table"): void;
  filter(): void;
  chart(kind: SheetChartKind): void;
  freeze(kind: "rows" | "columns" | "none"): void;
  clearFormatting(): void;
  table(on: boolean): void;
  dropdown(): void;
  checkbox(): void;
  gridlines(hidden: boolean): void;
  /** Opens the 条件格式 pane. */
  rules(): void;
  /** Asks Moss for a number format described in words. */
  describeFormat(): void;
  /** Groups the selected rows or columns, folds or unfolds the group there, or ungroups it. */
  group(axis: "row" | "column", how: "group" | "toggle" | "ungroup"): void;
  askMoss(text: string): void;
}

export const NUMBER_FORMAT_CHOICES: readonly {
  readonly label: string;
  readonly pattern: string;
  readonly sample: number;
}[] = [
  { label: "常规", pattern: SHEET_NUMBER_FORMATS.general, sample: 1234.5 },
  { label: "数字", pattern: SHEET_NUMBER_FORMATS.number, sample: 1234.5 },
  { label: "数字（取整）", pattern: SHEET_NUMBER_FORMATS.numberRounded, sample: 1234.5 },
  { label: "数字（负数加括号）", pattern: SHEET_NUMBER_FORMATS.numberParentheses, sample: -1234.5 },
  { label: "人民币", pattern: SHEET_NUMBER_FORMATS.currency, sample: 1234.5 },
  { label: "人民币（取整）", pattern: SHEET_NUMBER_FORMATS.currencyRounded, sample: 1234.5 },
  { label: "美元", pattern: SHEET_NUMBER_FORMATS.currencyDollar, sample: 1234.5 },
  { label: "百分比", pattern: SHEET_NUMBER_FORMATS.percent, sample: 0.1234 },
  { label: "百分比（取整）", pattern: SHEET_NUMBER_FORMATS.percentRounded, sample: 0.1234 },
  { label: "科学计数", pattern: SHEET_NUMBER_FORMATS.scientific, sample: 1234.5 },
  { label: "分数", pattern: SHEET_NUMBER_FORMATS.fraction, sample: 1.5 },
  { label: "日期", pattern: SHEET_NUMBER_FORMATS.date, sample: 46096 },
  { label: "长日期", pattern: SHEET_NUMBER_FORMATS.dateLong, sample: 46096 },
  { label: "时间", pattern: SHEET_NUMBER_FORMATS.time, sample: 0.6041667 },
  { label: "日期和时间", pattern: SHEET_NUMBER_FORMATS.dateTime, sample: 46096.6041667 },
  { label: "时长", pattern: SHEET_NUMBER_FORMATS.duration, sample: 1.0416667 },
  { label: "纯文本", pattern: SHEET_NUMBER_FORMATS.text, sample: 1234.5 },
];

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 36] as const;
const BORDER_EDGES: readonly { edges: SheetBorderEdges; label: string; icon: LucideIcon }[] = [
  { edges: "all", label: "全部边框", icon: SheetBorderAllIcon },
  { edges: "outer", label: "外边框", icon: SheetBorderOuterIcon },
  { edges: "inner", label: "内边框", icon: SheetBorderInnerIcon },
  { edges: "innerHorizontal", label: "内部横线", icon: SheetBorderHorizontalIcon },
  { edges: "innerVertical", label: "内部竖线", icon: SheetBorderVerticalIcon },
  { edges: "top", label: "上边框", icon: SheetBorderTopIcon },
  { edges: "bottom", label: "下边框", icon: SheetBorderBottomIcon },
  { edges: "left", label: "左边框", icon: SheetBorderLeftIcon },
  { edges: "right", label: "右边框", icon: SheetBorderRightIcon },
  { edges: "none", label: "清除边框", icon: SheetBorderNoneIcon },
];
const BORDER_STYLES: readonly { style: SheetBorderStyle; label: string }[] = [
  { style: "thin", label: "细线" },
  { style: "medium", label: "中等" },
  { style: "thick", label: "粗线" },
  { style: "dashed", label: "虚线" },
  { style: "dotted", label: "点线" },
  { style: "double", label: "双线" },
];
const HUE_NAMES: Record<(typeof SHEET_HUES)[number], string> = {
  gray: "灰",
  red: "红",
  orange: "橙",
  yellow: "黄",
  green: "绿",
  teal: "青",
  blue: "蓝",
  purple: "紫",
  magenta: "品红",
};

/** A toolbar button that opens a menu: same 28 px chrome as SpaceToolbarButton. */
function ToolMenu(props: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  children: ReactNode;
  testId?: string;
  width?: string;
}) {
  const Icon = props.icon;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            size="icon-xs"
            variant="chrome"
            label={props.label}
            tooltip={props.label}
            tooltipSide="top"
            disabled={props.disabled}
            data-testid={props.testId}
            className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "text-muted-foreground")}
          >
            <Icon className="size-4" aria-hidden />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup side="top" align="center" className={props.width ?? "w-56"}>
        {props.children}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function ColorPicker(props: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onPick: (hex: string | null) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const Icon = props.icon;
  const pick = (hex: string | null) => {
    setOpen(false);
    props.onPick(hex);
  };
  const neutrals = [
    SHEET_WHITE,
    ...SHEET_SHADES.map((shade) => SHEET_PALETTE.gray[shade]),
    SHEET_INK,
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            size="icon-xs"
            variant="chrome"
            label={props.label}
            tooltip={props.label}
            tooltipSide="top"
            disabled={props.disabled}
            data-testid={props.testId}
            className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "text-muted-foreground")}
          >
            <Icon className="size-4" aria-hidden />
          </IconButton>
        }
      />
      <PopoverPopup side="top" className="w-64 p-3" data-sheet-color-picker={props.testId}>
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="justify-start gap-2 font-normal"
            onClick={() => pick(null)}
          >
            <span
              aria-hidden
              className="size-4 rounded-inline border border-border bg-background"
            />
            {props.testId.includes("fill") ? "无填充" : "默认颜色"}
          </Button>
          <div className="grid grid-cols-8 gap-1" role="group" aria-label="中性色">
            {neutrals.map((hex) => (
              <Button
                key={hex}
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={hex}
                title={hex}
                className="size-6 rounded-inline border border-border"
                style={{ background: hex }}
                onClick={() => pick(hex)}
              />
            ))}
          </div>
          <div className="grid grid-cols-6 gap-1" role="group" aria-label="颜色">
            {SHEET_HUES.filter((hue) => hue !== "gray").flatMap((hue) =>
              SHEET_SHADES.map((shade) => (
                <Button
                  key={`${hue}-${shade}`}
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`${HUE_NAMES[hue]} ${shade}`}
                  title={`${HUE_NAMES[hue]} ${shade}`}
                  className="h-6 w-full rounded-inline border border-transparent hover:border-border"
                  style={{ background: SHEET_PALETTE[hue][shade] }}
                  onClick={() => pick(SHEET_PALETTE[hue][shade])}
                />
              )),
            )}
          </div>
          <label className="flex items-center gap-2 text-ui-sm text-muted-foreground">
            自定义
            <input
              type="color"
              aria-label="自定义颜色"
              className="h-6 w-10 cursor-pointer rounded-inline border border-border bg-transparent"
              onChange={(event) => pick(event.target.value.toUpperCase())}
            />
          </label>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function SheetToolCard(props: {
  state: SheetToolState;
  actions: SheetToolActions;
  readOnly: boolean;
  /** Shown above the card: the empty-sheet offer, or Moss's last change. */
  above?: ReactNode;
}) {
  const s = props.state;
  const a = props.actions;
  const [ask, setAsk] = useState("");
  const [borderStyle, setBorderStyle] = useState<SheetBorderStyle>("thin");
  const off = props.readOnly;
  const formatLabel =
    NUMBER_FORMAT_CHOICES.find((choice) => choice.pattern === s.format)?.label ?? "自定义";
  const send = () => {
    const text = ask.trim();
    if (!text || s.mossBusy) return;
    a.askMoss(text);
    setAsk("");
  };
  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex flex-col items-center gap-2"
      data-sheet-foot
    >
      {props.above}
      <div
        role="toolbar"
        aria-label="工具"
        data-sheet-tools
        className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-card border border-border bg-popover p-1 shadow-xl backdrop-blur-sm [scrollbar-width:none]"
      >
        <SpaceToolbarButton
          icon={TextBoldIcon}
          label="加粗"
          shortcut="Ctrl+B"
          pressed={s.bold}
          disabled={off}
          onClick={() => a.toggle("bold")}
          testId="sheet-tool-bold"
        />
        <SpaceToolbarButton
          icon={TextItalicIcon}
          label="斜体"
          shortcut="Ctrl+I"
          pressed={s.italic}
          disabled={off}
          onClick={() => a.toggle("italic")}
          testId="sheet-tool-italic"
        />
        <SpaceToolbarButton
          icon={TextUnderlineIcon}
          label="下划线"
          shortcut="Ctrl+U"
          pressed={s.underline}
          disabled={off}
          onClick={() => a.toggle("underline")}
          testId="sheet-tool-underline"
        />
        <SpaceToolbarButton
          icon={TextStrikeIcon}
          label="删除线"
          shortcut="Ctrl+Shift+X"
          pressed={s.strike}
          disabled={off}
          onClick={() => a.toggle("strike")}
          testId="sheet-tool-strike"
        />
        <SpaceToolbarDivider />
        <ColorPicker
          icon={TextColorIcon}
          label="文字颜色"
          disabled={off}
          onPick={(hex) => a.color("text", hex)}
          testId="sheet-tool-text-color"
        />
        <ColorPicker
          icon={FillColorIcon}
          label="单元格颜色"
          disabled={off}
          onPick={(hex) => a.color("fill", hex)}
          testId="sheet-tool-fill"
        />
        <SpaceToolbarDivider />
        <ToolMenu
          icon={
            s.align === "center"
              ? AlignCenterIcon
              : s.align === "right"
                ? AlignRightIcon
                : AlignLeftIcon
          }
          label="对齐"
          disabled={off}
          testId="sheet-tool-align"
        >
          <MenuGroup>
            <MenuGroupLabel>水平</MenuGroupLabel>
            <MenuItem onClick={() => a.align("left")}>
              <AlignLeftIcon aria-hidden /> 左对齐
            </MenuItem>
            <MenuItem onClick={() => a.align("center")}>
              <AlignCenterIcon aria-hidden /> 居中
            </MenuItem>
            <MenuItem onClick={() => a.align("right")}>
              <AlignRightIcon aria-hidden /> 右对齐
            </MenuItem>
            <MenuItem onClick={() => a.align(null)}>按内容对齐</MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>垂直</MenuGroupLabel>
            <MenuItem onClick={() => a.valign("top")}>
              <AlignTopIcon aria-hidden /> 顶端
            </MenuItem>
            <MenuItem onClick={() => a.valign("middle")}>
              <AlignMiddleIcon aria-hidden /> 居中
            </MenuItem>
            <MenuItem onClick={() => a.valign("bottom")}>
              <AlignBottomIcon aria-hidden /> 底端
            </MenuItem>
          </MenuGroup>
        </ToolMenu>
        <SpaceToolbarButton
          icon={TextWrapIcon}
          label={s.wrap ? "取消自动换行" : "自动换行"}
          pressed={s.wrap}
          disabled={off}
          onClick={() => a.wrap(!s.wrap)}
          testId="sheet-tool-wrap"
        />
        <SpaceToolbarDivider />
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                data-testid="sheet-tool-format"
                disabled={off}
                aria-label={`数字格式：${formatLabel}`}
                className="shrink-0 gap-1 font-normal text-muted-foreground"
              />
            }
          >
            <PercentIcon className="size-4" aria-hidden />
            <span className="max-w-20 truncate">{formatLabel}</span>
            <ChevronDownIcon className="size-3" aria-hidden />
          </MenuTrigger>
          <ComposerPickerMenuPopup
            side="top"
            align="center"
            className="max-h-96 w-64 overflow-y-auto"
          >
            <MenuGroup>
              {NUMBER_FORMAT_CHOICES.map((choice) => (
                <MenuItem
                  key={choice.pattern}
                  onClick={() => a.numberFormat(choice.pattern)}
                  data-checked={choice.pattern === s.format ? "" : undefined}
                >
                  {choice.label}
                  <span className="ms-auto ps-3 text-ui-sm text-muted-foreground tabular-nums">
                    {choice.pattern === "@"
                      ? "文本"
                      : formatSheetNumber(choice.pattern, choice.sample)}
                  </span>
                </MenuItem>
              ))}
            </MenuGroup>
            {s.mossLabel ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => a.describeFormat()} data-testid="sheet-format-describe">
                  <SparklesIcon aria-hidden /> 描述一个格式…
                </MenuItem>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
        <SpaceToolbarButton
          icon={SheetDecimalLessIcon}
          label="减少小数位数"
          disabled={off}
          onClick={() => a.decimals(-1)}
          testId="sheet-tool-decimal-less"
        />
        <SpaceToolbarButton
          icon={SheetDecimalMoreIcon}
          label="增加小数位数"
          disabled={off}
          onClick={() => a.decimals(1)}
          testId="sheet-tool-decimal-more"
        />
        <SpaceToolbarDivider />
        <ToolMenu
          icon={SheetBorderAllIcon}
          label="边框"
          disabled={off}
          testId="sheet-tool-borders"
          width="w-60"
        >
          <div className="grid grid-cols-5 gap-1 p-1" role="group" aria-label="边框位置">
            {BORDER_EDGES.map((edge) => (
              <MenuItem
                key={edge.edges}
                aria-label={edge.label}
                title={edge.label}
                className="justify-center px-0"
                onClick={() => a.borders(edge.edges, borderStyle, null)}
              >
                <edge.icon aria-hidden />
              </MenuItem>
            ))}
          </div>
          <MenuSeparator />
          <MenuSub>
            <MenuSubTrigger>
              线条：{BORDER_STYLES.find((b) => b.style === borderStyle)?.label}
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="w-40">
              {BORDER_STYLES.map((b) => (
                <MenuItem
                  key={b.style}
                  closeOnClick={false}
                  onClick={() => setBorderStyle(b.style)}
                  data-checked={b.style === borderStyle ? "" : undefined}
                >
                  {b.label}
                </MenuItem>
              ))}
            </ComposerPickerMenuSubPopup>
          </MenuSub>
        </ToolMenu>
        <SpaceToolbarButton
          icon={s.isMerged ? SheetUnmergeIcon : SheetMergeIcon}
          label={s.isMerged ? "取消合并" : "合并单元格"}
          disabled={off || (!s.isMerged && !s.canMerge)}
          {...(off ? {} : { disabledReason: "选择两个或更多单元格后才能合并。" })}
          onClick={() => a.merge(!s.isMerged)}
          testId="sheet-tool-merge"
        />
        <ToolMenu
          icon={SheetRowInsertBelowIcon}
          label="插入和删除"
          disabled={off}
          testId="sheet-tool-insert"
        >
          <MenuItem onClick={() => a.insert("rowAbove")}>
            <SheetRowInsertAboveIcon aria-hidden /> 在上方插入行
          </MenuItem>
          <MenuItem onClick={() => a.insert("rowBelow")}>
            <SheetRowInsertBelowIcon aria-hidden /> 在下方插入行
          </MenuItem>
          <MenuItem onClick={() => a.insert("columnLeft")}>
            <SheetColumnInsertLeftIcon aria-hidden /> 在左侧插入列
          </MenuItem>
          <MenuItem onClick={() => a.insert("columnRight")}>
            <SheetColumnInsertRightIcon aria-hidden /> 在右侧插入列
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => a.remove("rows")}>
            <SheetRowDeleteIcon aria-hidden /> 删除所选行
          </MenuItem>
          <MenuItem onClick={() => a.remove("columns")}>删除所选列</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => a.dropdown()}>
            <ListBulletsIcon aria-hidden /> 下拉菜单…
          </MenuItem>
          <MenuItem onClick={() => a.checkbox()}>
            <CheckboxCheckedIcon aria-hidden /> 复选框
          </MenuItem>
        </ToolMenu>
        <ToolMenu icon={FilterIcon} label="排序和筛选" disabled={off} testId="sheet-tool-sort">
          <MenuItem onClick={() => a.sort("ascending", "range")}>
            <SortAscendingIcon aria-hidden /> 所选区域升序排列
          </MenuItem>
          <MenuItem onClick={() => a.sort("descending", "range")}>
            <SortDescendingIcon aria-hidden /> 所选区域降序排列
          </MenuItem>
          <MenuItem onClick={() => a.sort("ascending", "table")}>
            <ArrowUpIcon aria-hidden /> 按此列给表格排序（升序）
          </MenuItem>
          <MenuItem onClick={() => a.sort("descending", "table")}>
            按此列给表格排序（降序）
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => a.filter()} data-checked={s.hasFilter ? "" : undefined}>
            <FilterIcon aria-hidden /> {s.hasFilter ? "关闭筛选" : "筛选"}
          </MenuItem>
        </ToolMenu>
        <ToolMenu icon={ChartBarIcon} label="插入图表" disabled={off} testId="sheet-tool-chart">
          <MenuItem onClick={() => a.chart("bar")}>
            <ChartBarIcon aria-hidden /> 柱状图
          </MenuItem>
          <MenuItem onClick={() => a.chart("stackedBar")}>
            <ChartStackedIcon aria-hidden /> 堆积柱状图
          </MenuItem>
          <MenuItem onClick={() => a.chart("line")}>
            <ChartLineIcon aria-hidden /> 折线图
          </MenuItem>
          <MenuItem onClick={() => a.chart("pie")}>
            <ChartPieIcon aria-hidden /> 饼图
          </MenuItem>
        </ToolMenu>
        <ToolMenu
          icon={EllipsisIcon}
          label="更多"
          disabled={off}
          testId="sheet-tool-more"
          width="w-60"
        >
          <MenuSub>
            <MenuSubTrigger>
              <TextSizeIcon aria-hidden /> 字号{s.size ? `：${s.size}` : ""}
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="w-32">
              {FONT_SIZES.map((size) => (
                <MenuItem
                  key={size}
                  onClick={() => a.fontSize(size)}
                  data-checked={size === (s.size ?? 10) ? "" : undefined}
                >
                  {size}
                </MenuItem>
              ))}
            </ComposerPickerMenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>
              <SheetFreezeIcon aria-hidden /> 冻结
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="w-48">
              <MenuItem onClick={() => a.freeze("rows")}>冻结到当前行</MenuItem>
              <MenuItem onClick={() => a.freeze("columns")}>冻结到当前列</MenuItem>
              <MenuItem
                disabled={!s.frozenRows && !s.frozenColumns}
                onClick={() => a.freeze("none")}
              >
                取消冻结
              </MenuItem>
            </ComposerPickerMenuSubPopup>
          </MenuSub>
          <MenuItem onClick={() => a.table(!s.hasTable)}>
            <TableIcon aria-hidden /> {s.hasTable ? "取消表格样式" : "设为表格"}
          </MenuItem>
          <MenuItem onClick={() => a.gridlines(!s.gridlinesHidden)}>
            {s.gridlinesHidden ? "显示网格线" : "隐藏网格线"}
          </MenuItem>
          <MenuItem onClick={() => a.rules()} data-testid="sheet-tool-rules">
            条件格式…
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger>组合</MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="w-48">
              <MenuItem onClick={() => a.group("row", "group")}>组合所选行</MenuItem>
              <MenuItem onClick={() => a.group("column", "group")}>组合所选列</MenuItem>
              {s.rowGroup ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={() => a.group("row", "toggle")}>
                    {s.rowGroup.collapsed ? "展开这组行" : "收起这组行"}
                  </MenuItem>
                  <MenuItem onClick={() => a.group("row", "ungroup")}>取消组合这些行</MenuItem>
                </>
              ) : null}
              {s.columnGroup ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={() => a.group("column", "toggle")}>
                    {s.columnGroup.collapsed ? "展开这组列" : "收起这组列"}
                  </MenuItem>
                  <MenuItem onClick={() => a.group("column", "ungroup")}>取消组合这些列</MenuItem>
                </>
              ) : null}
            </ComposerPickerMenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          <MenuItem onClick={() => a.clearFormatting()}>
            <EraserIcon aria-hidden /> 清除格式
          </MenuItem>
        </ToolMenu>
        {s.mossLabel ? (
          <>
            <SpaceToolbarDivider />
            <form
              className="flex h-7 w-56 shrink-0 items-center rounded-control border border-border bg-background px-2"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <input
                aria-label="让 Moss 修改"
                data-testid="sheet-ask-moss"
                value={ask}
                maxLength={2_000}
                disabled={off || s.mossBusy}
                placeholder={s.mossBusy ? "Moss 正在修改…" : "让 Moss 修改这些单元格…"}
                onChange={(event) => setAsk(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                className="min-w-0 flex-1 bg-transparent text-ui-sm outline-none placeholder:text-muted-foreground"
              />
            </form>
          </>
        ) : null}
      </div>
    </div>
  );
}
