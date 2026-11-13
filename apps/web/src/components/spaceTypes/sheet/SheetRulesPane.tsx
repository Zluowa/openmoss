// FILE: SheetRulesPane.tsx
// Purpose: The 条件格式 pane beside the grid: the sheet's rules (higher rules win), each with its
//          look and a plain summary, moved, removed or opened to edit; a rule editor for a highlight
//          (conditions joined by 且, a ready-made or own look) or a colour scale; "让 Moss 写规则".
// Layer: 资料空间 电子表格 (side pane)
// Exports: SheetRulesPane.
// Why: Claude's Sheets lets a person make rules by hand as well as by asking; Moss's pane writes
//      the same rule list an agent writes, through the same edit (replaceConditionalFormats).

import { SHEET_HUES, type SheetHue } from "@moss/shared/spaceItems/sheetWorkbook";
import { useState } from "react";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  SparklesIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextStrikeIcon,
  TrashCanIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { Input } from "../../ui/input";
import { SpaceSidePanel } from "../shared/SpaceEditorChrome";
import { Choice } from "./sheetControls";
import {
  CONDITION_CHOICES,
  HIGHLIGHT_PRESETS,
  SCALE_PRESETS,
  conditionChoice,
  conditionFor,
  conditionNeeds,
  describeRule,
  moveRule,
  newColorScaleRule,
  newHighlightRule,
  paneColorHex,
  rulePreview,
  type PaneColor,
  type PaneCondition,
  type PaneFormat,
  type PaneOperand,
  type PaneRule,
  type PaneTest,
} from "./sheetRulesPane.logic";

const MAX_TESTS = 5;
const FILL_SHADES = [100, 200] as const;
const TEXT_SHADES = [600, 800] as const;

function Swatch(props: { readonly rule: PaneRule }) {
  const look = rulePreview(props.rule);
  return (
    <span
      aria-hidden
      className="flex h-6 w-10 shrink-0 items-center justify-center rounded-inline border border-border text-ui-sm tabular-nums"
      style={{
        background: look.gradient ?? look.fill ?? undefined,
        color: look.color ?? undefined,
        fontWeight: look.bold ? 600 : undefined,
        fontStyle: look.italic ? "italic" : undefined,
        textDecoration: look.strike ? "line-through" : undefined,
      }}
    >
      {look.gradient ? "" : "123"}
    </span>
  );
}

function NumberField(props: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  return (
    <Input
      size="sm"
      aria-label={props.label}
      inputMode="decimal"
      value={text}
      className="w-20"
      onChange={(event) => {
        setText(event.target.value);
        const n = Number(event.target.value.replace(/,/gu, ""));
        if (event.target.value.trim() !== "" && Number.isFinite(n)) props.onChange(n);
      }}
    />
  );
}

/** A number, or the same row of another column. */
function OperandField(props: {
  readonly label: string;
  readonly operand: PaneOperand;
  readonly onChange: (operand: PaneOperand) => void;
}) {
  const o = props.operand;
  return (
    <div className="flex items-center gap-1">
      <Choice
        label={`${props.label}的类型`}
        value={o.kind === "sameRowInColumn" ? "column" : "number"}
        options={[
          { value: "number", label: "数字" },
          { value: "column", label: "同一行的列" },
        ]}
        onChange={(kind) =>
          props.onChange(
            kind === "column" ? { kind: "sameRowInColumn", c: "A" } : { kind: "number", number: 0 },
          )
        }
        className="w-28"
      />
      {o.kind === "sameRowInColumn" ? (
        <Input
          size="sm"
          aria-label={`${props.label}：列`}
          value={o.c}
          className="w-14 uppercase"
          onChange={(event) =>
            props.onChange({
              kind: "sameRowInColumn",
              c:
                event.target.value
                  .replace(/[^A-Za-z]/gu, "")
                  .toUpperCase()
                  .slice(0, 3) || "A",
            })
          }
        />
      ) : (
        <NumberField
          label={props.label}
          value={o.kind === "number" ? o.number : 0}
          onChange={(number) => props.onChange({ kind: "number", number })}
        />
      )}
    </div>
  );
}

function TestEditor(props: {
  readonly index: number;
  readonly test: PaneTest;
  readonly onChange: (test: PaneTest) => void;
  readonly onRemove: (() => void) | null;
}) {
  const { test } = props;
  const choice = conditionChoice(test.condition);
  const needs = conditionNeeds(choice);
  const c = test.condition;
  const setCondition = (condition: PaneCondition) => props.onChange({ ...test, condition });
  return (
    <div className="flex flex-col gap-1.5 rounded-control border border-border p-2" data-rule-test>
      <div className="flex items-center gap-1.5">
        <span className="w-6 shrink-0 text-ui-sm text-muted-foreground">
          {props.index === 0 ? "当" : "且"}
        </span>
        <Choice
          label="检查"
          value={test.tested.kind === "sameRowInColumn" ? "column" : "cell"}
          options={[
            { value: "cell", label: "单元格本身" },
            { value: "column", label: "同一行的列" },
          ]}
          onChange={(kind) =>
            props.onChange({
              ...test,
              tested:
                kind === "column" ? { kind: "sameRowInColumn", c: "A" } : { kind: "theCellItself" },
            })
          }
          className="flex-1"
        />
        {test.tested.kind === "sameRowInColumn" ? (
          <Input
            size="sm"
            aria-label="检查的列"
            value={test.tested.c}
            className="w-14 uppercase"
            onChange={(event) =>
              props.onChange({
                ...test,
                tested: {
                  kind: "sameRowInColumn",
                  c:
                    event.target.value
                      .replace(/[^A-Za-z]/gu, "")
                      .toUpperCase()
                      .slice(0, 3) || "A",
                },
              })
            }
          />
        ) : null}
        {props.onRemove ? (
          <IconButton size="icon-xs" variant="ghost" label="去掉这个条件" onClick={props.onRemove}>
            <TrashCanIcon aria-hidden />
          </IconButton>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-7">
        <Choice
          label="条件"
          value={choice}
          options={CONDITION_CHOICES}
          onChange={(next) => setCondition(conditionFor(next, c))}
          className="w-32"
        />
        {needs === "text" && "text" in c ? (
          <Input
            size="sm"
            aria-label="文字"
            value={c.text}
            className="min-w-0 flex-1"
            onChange={(event) => setCondition({ ...c, text: event.target.value } as PaneCondition)}
          />
        ) : null}
        {needs === "operand" && c.kind === "numberIs" ? (
          <OperandField
            label="值"
            operand={c.operand}
            onChange={(operand) => setCondition({ ...c, operand })}
          />
        ) : null}
        {needs === "between" &&
        (c.kind === "numberIsBetween" || c.kind === "numberIsNotBetween") ? (
          <>
            <OperandField
              label="从"
              operand={c.oneEnd}
              onChange={(oneEnd) => setCondition({ ...c, oneEnd })}
            />
            <span className="text-ui-sm text-muted-foreground">到</span>
            <OperandField
              label="到"
              operand={c.otherEnd}
              onChange={(otherEnd) => setCondition({ ...c, otherEnd })}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function ColorRow(props: {
  readonly label: string;
  readonly shades: readonly (100 | 200 | 600 | 800)[];
  readonly value: PaneColor | undefined;
  readonly onChange: (color: PaneColor) => void;
}) {
  const current = paneColorHex(props.value);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-ui-sm text-muted-foreground">{props.label}</span>
      <div className="flex flex-wrap gap-1" role="group" aria-label={props.label}>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-pressed={!current}
          className={cn("h-6 px-1.5 text-ui-sm", !current && "ring-1 ring-border")}
          onClick={() => props.onChange({ kind: "none" })}
        >
          无
        </Button>
        {props.shades.flatMap((shade) =>
          SHEET_HUES.map((hue: SheetHue) => {
            const color: PaneColor = { kind: "standard", hue, shade: shade as never };
            const hex = paneColorHex(color);
            const on = hex === current;
            return (
              <Button
                key={`${hue}-${shade}`}
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`${hue} ${shade}`}
                aria-pressed={on}
                className={cn(
                  "size-6 rounded-inline border border-border",
                  on && "ring-2 ring-ring",
                )}
                style={{ background: hex ?? undefined }}
                onClick={() => props.onChange(color)}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}

function FormatEditor(props: {
  readonly format: PaneFormat;
  readonly onChange: (format: PaneFormat) => void;
}) {
  const f = props.format;
  const font = f.font ?? {};
  const setFont = (patch: NonNullable<PaneFormat["font"]>) =>
    props.onChange({ ...f, font: { ...font, ...patch } });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label="现成的样式">
        {HIGHLIGHT_PRESETS.map((preset) => {
          const look = rulePreview({
            cells: [],
            effect: { kind: "formatWhere", allOf: [], format: preset.format },
          });
          return (
            <Button
              key={preset.label}
              type="button"
              size="xs"
              variant="outline"
              title={preset.label}
              aria-label={preset.label}
              className="h-7 px-2"
              style={{
                background: look.fill ?? undefined,
                color: look.color ?? undefined,
                fontWeight: look.bold ? 600 : undefined,
                textDecoration: look.strike ? "line-through" : undefined,
              }}
              onClick={() => props.onChange(preset.format)}
            >
              123
            </Button>
          );
        })}
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="字形">
        {(
          [
            ["bold", "加粗", TextBoldIcon],
            ["italic", "斜体", TextItalicIcon],
            ["strikethrough", "删除线", TextStrikeIcon],
          ] as const
        ).map(([key, label, Mark]) => (
          <Button
            key={key}
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            aria-pressed={font[key] === true}
            className={cn("size-7", font[key] === true && "bg-accent text-foreground")}
            onClick={() =>
              setFont(
                key === "bold"
                  ? { bold: font.bold !== true }
                  : key === "italic"
                    ? { italic: font.italic !== true }
                    : { strikethrough: font.strikethrough !== true },
              )
            }
          >
            <Mark className="size-4" aria-hidden />
          </Button>
        ))}
      </div>
      <ColorRow
        label="填充颜色"
        shades={FILL_SHADES}
        value={f.fillColor}
        onChange={(fillColor) => props.onChange({ ...f, fillColor })}
      />
      <ColorRow
        label="文字颜色"
        shades={TEXT_SHADES}
        value={font.color}
        onChange={(color) => setFont({ color })}
      />
    </div>
  );
}

function RuleEditor(props: {
  readonly rule: PaneRule;
  readonly isNew: boolean;
  readonly selection: string | null;
  readonly onSave: (rule: PaneRule) => void;
  readonly onRemove: () => void;
  readonly onBack: () => void;
}) {
  const [rule, setRule] = useState<PaneRule>(props.rule);
  const [cellsText, setCellsText] = useState(props.rule.cells.join(", "));
  const cells = cellsText
    .split(/[,，;；\s]+/u)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  const cellsOk =
    cells.length > 0 && cells.every((part) => /^[A-Z]{1,3}\d+(:[A-Z]{1,3}\d+)?$/u.test(part));
  const kind = rule.effect.kind;
  const highlight = rule.effect.kind === "formatWhere" ? rule.effect : null;
  const setTests = (allOf: readonly PaneTest[]) => {
    if (highlight) setRule({ ...rule, effect: { ...highlight, allOf } });
  };
  return (
    <div className="flex flex-col gap-4 p-3" data-sheet-rule-editor>
      <Button type="button" size="xs" variant="ghost" className="self-start" onClick={props.onBack}>
        ← 返回所有规则
      </Button>
      <div
        role="radiogroup"
        aria-label="规则类型"
        className="flex h-7 items-center gap-px self-start rounded-control border border-border p-px"
      >
        {(
          [
            ["formatWhere", "突出显示"],
            ["colorScale", "色阶"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            size="xs"
            variant="ghost"
            role="radio"
            aria-checked={kind === value}
            className={cn(
              "h-6 px-2.5",
              kind === value ? "bg-accent text-foreground" : "text-muted-foreground",
            )}
            onClick={() => {
              if (value === kind) return;
              const first = cells[0] ?? "A1";
              setRule(value === "colorScale" ? newColorScaleRule(first) : newHighlightRule(first));
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-ui-sm text-muted-foreground">应用于</span>
        <div className="flex items-center gap-1">
          <Input
            size="sm"
            aria-label="应用于"
            aria-invalid={!cellsOk}
            value={cellsText}
            placeholder="例如 D2:D15"
            className="min-w-0 flex-1"
            onChange={(event) => setCellsText(event.target.value)}
          />
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!props.selection}
            onClick={() => props.selection && setCellsText(props.selection)}
          >
            使用选区
          </Button>
        </div>
        {cellsOk ? null : (
          <span className="text-ui-sm text-destructive">请输入单元格，例如 D2:D15。</span>
        )}
      </div>
      {highlight ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm text-muted-foreground">条件</span>
            {highlight.allOf.map((test, i) => (
              <TestEditor
                key={i}
                index={i}
                test={test}
                onChange={(next) => setTests(highlight.allOf.map((t, j) => (j === i ? next : t)))}
                onRemove={
                  highlight.allOf.length > 1
                    ? () => setTests(highlight.allOf.filter((_, j) => j !== i))
                    : null
                }
              />
            ))}
            {highlight.allOf.length < MAX_TESTS ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="self-start"
                onClick={() =>
                  setTests([
                    ...highlight.allOf,
                    { tested: { kind: "theCellItself" }, condition: { kind: "isNotBlank" } },
                  ])
                }
              >
                <PlusIcon aria-hidden /> 添加条件
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm text-muted-foreground">样式</span>
            <FormatEditor
              format={highlight.format}
              onChange={(format) => setRule({ ...rule, effect: { ...highlight, format } })}
            />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5" role="group" aria-label="色阶">
          <span className="text-ui-sm text-muted-foreground">色阶</span>
          {SCALE_PRESETS.map((preset) => {
            const look = rulePreview({ cells: [], effect: { kind: "colorScale", ...preset } });
            const on =
              rule.effect.kind === "colorScale" &&
              JSON.stringify([rule.effect.lowest, rule.effect.middle, rule.effect.highest]) ===
                JSON.stringify([preset.lowest, preset.middle, preset.highest]);
            return (
              <Button
                key={preset.label}
                type="button"
                size="xs"
                variant="ghost"
                aria-pressed={on}
                className={cn("h-8 justify-start gap-2", on && "ring-1 ring-border")}
                onClick={() =>
                  setRule({
                    cells: rule.cells,
                    effect: {
                      kind: "colorScale",
                      lowest: preset.lowest,
                      middle: preset.middle,
                      highest: preset.highest,
                    },
                  })
                }
              >
                <span
                  aria-hidden
                  className="h-4 w-16 rounded-inline border border-border"
                  style={{ background: look.gradient ?? undefined }}
                />
                {preset.label}
              </Button>
            );
          })}
          <span className="text-ui-sm text-muted-foreground">
            最小的数取第一种颜色，最大的数取最后一种。
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!cellsOk}
          onClick={() => props.onSave({ ...rule, cells } as PaneRule)}
        >
          {props.isNew ? "添加规则" : "保存规则"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={props.onBack}>
          取消
        </Button>
        {props.isNew ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive"
            onClick={props.onRemove}
          >
            删除规则
          </Button>
        )}
      </div>
    </div>
  );
}

export function SheetRulesPane(props: {
  readonly sheetName: string;
  readonly rules: readonly PaneRule[];
  /** The selection as cells ("B2:D9"), for 使用选区 and a new rule. */
  readonly selection: string | null;
  readonly readOnly: boolean;
  /** Writes the sheet's whole rule list; false if it was refused (the editor shows why). */
  readonly onSave: (rules: readonly PaneRule[]) => boolean;
  /** Asks Moss to write rules from the person's words. */
  readonly onAskMoss: ((text: string) => void) | null;
  readonly onClose: () => void;
}) {
  const [editing, setEditing] = useState<{ index: number | null; rule: PaneRule } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const save = (rules: readonly PaneRule[]) => {
    if (props.onSave(rules)) setEditing(null);
  };
  return (
    <SpaceSidePanel
      title="条件格式"
      closeLabel="关闭条件格式"
      onClose={props.onClose}
      testId="sheet-rules-pane"
    >
      {editing ? (
        <RuleEditor
          key={editing.index ?? "new"}
          rule={editing.rule}
          isNew={editing.index === null}
          selection={props.selection}
          onBack={() => setEditing(null)}
          onRemove={() =>
            editing.index !== null && save(props.rules.filter((_, i) => i !== editing.index))
          }
          onSave={(rule) =>
            save(
              editing.index === null
                ? [...props.rules, rule]
                : props.rules.map((r, i) => (i === editing.index ? rule : r)),
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-3 p-3">
          {props.readOnly ? null : (
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="outline"
                data-testid="sheet-rule-new"
                onClick={() =>
                  setEditing({ index: null, rule: newHighlightRule(props.selection ?? "A1") })
                }
              >
                <PlusIcon aria-hidden /> 新建规则
              </Button>
              {props.onAskMoss ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-pressed={asking !== null}
                  onClick={() => setAsking((now) => (now === null ? "" : null))}
                >
                  <SparklesIcon aria-hidden /> 让 Moss 写规则
                </Button>
              ) : null}
            </div>
          )}
          {asking !== null && props.onAskMoss ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (!asking.trim()) return;
                props.onAskMoss?.(asking.trim());
                setAsking(null);
              }}
            >
              <Input
                size="sm"
                autoFocus
                aria-label="想要什么样的规则"
                placeholder="例如：实际超过预算时标红"
                value={asking}
                className="min-w-0 flex-1"
                onChange={(event) => setAsking(event.target.value)}
              />
              <Button type="submit" size="xs" disabled={!asking.trim()}>
                发送
              </Button>
            </form>
          ) : null}
          {props.rules.length ? (
            <>
              <span className="text-ui-sm text-muted-foreground">
                “{props.sheetName}”有 {props.rules.length} 条规则。排在上面的规则优先。
              </span>
              <ol className="flex flex-col gap-1" data-sheet-rules>
                {props.rules.map((rule, i) => (
                  <li
                    key={`${i}-${describeRule(rule)}`}
                    className="group flex items-center gap-2 rounded-control px-1.5 py-1 hover:bg-accent"
                  >
                    <Swatch rule={rule} />
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={props.readOnly}
                      className="h-auto min-w-0 flex-1 justify-start whitespace-normal px-1 py-0.5 text-left font-normal"
                      onClick={() => setEditing({ index: i, rule })}
                    >
                      {describeRule(rule)}
                    </Button>
                    {props.readOnly ? null : (
                      <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                        <IconButton
                          size="icon-xs"
                          variant="ghost"
                          label="上移"
                          disabled={i === 0}
                          onClick={() => save(moveRule(props.rules, i, -1))}
                        >
                          <ArrowUpIcon aria-hidden />
                        </IconButton>
                        <IconButton
                          size="icon-xs"
                          variant="ghost"
                          label="下移"
                          disabled={i === props.rules.length - 1}
                          onClick={() => save(moveRule(props.rules, i, 1))}
                        >
                          <ArrowDownIcon aria-hidden />
                        </IconButton>
                        <IconButton
                          size="icon-xs"
                          variant="ghost"
                          label="删除规则"
                          onClick={() => save(props.rules.filter((_, j) => j !== i))}
                        >
                          <TrashCanIcon aria-hidden />
                        </IconButton>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <span className="text-ui-sm text-muted-foreground">
              这张工作表还没有条件格式。规则会按单元格的值改变它的样子，比如把超过预算的数标红。
            </span>
          )}
        </div>
      )}
    </SpaceSidePanel>
  );
}
