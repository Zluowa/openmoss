// FILE: MarkupToolbar.tsx
// Purpose: Moss's one floating markup bar, shared by the browser panel and the composer's
//   attachment preview: optionally select an element (browser only); draw with the pen, a
//   shape (line, arrow, rectangle, ellipse, numbered step) or text; pick the ink colour
//   and stroke width; undo, redo, clear; the host's main action (Add to chat, Save); close.
//   It can start compact (select, pen, shapes, text, close) and open out once a drawing
//   tool is armed.
// Layer: Shared markup UI
// Spec: docs/design/annotate-and-comment/SPEC.md, "Floating tool bar".

import { useState } from "react";

import {
  CheckIcon,
  ChevronDownIcon,
  type LucideIcon,
  Redo2Icon,
  SketchArrowIcon,
  SketchEllipseIcon,
  SketchLineIcon,
  SketchPenIcon,
  SketchRectangleIcon,
  SketchSelectIcon,
  SketchStepIcon,
  SketchTextIcon,
  Trash2,
  Undo2Icon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation, type TranslationKey } from "~/localization";

import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import {
  MARKUP_COLOR_ORDER,
  MARKUP_COLORS,
  MARKUP_SHAPES,
  MARKUP_STROKE_WIDTHS,
  type MarkupColor,
  type MarkupShape,
  type MarkupStrokeWidth,
  type MarkupStyle,
  type MarkupTool,
  DEFAULT_MARKUP_SHAPE,
  DEFAULT_MARKUP_STYLE,
  isMarkupShape,
} from "./markup.logic";

const SHAPE_META: Record<MarkupShape, { labelKey: TranslationKey; icon: LucideIcon }> = {
  line: { labelKey: "markup.line", icon: SketchLineIcon },
  arrow: { labelKey: "markup.arrow", icon: SketchArrowIcon },
  rect: { labelKey: "markup.rectangle", icon: SketchRectangleIcon },
  ellipse: { labelKey: "markup.ellipse", icon: SketchEllipseIcon },
  step: { labelKey: "markup.step", icon: SketchStepIcon },
};

const COLOR_LABEL_KEY: Record<MarkupColor, TranslationKey> = {
  red: "markup.color.red",
  blue: "markup.color.blue",
  green: "markup.color.green",
  black: "markup.color.black",
  white: "markup.color.white",
};

const WIDTH_LABEL_KEY: Record<MarkupStrokeWidth, TranslationKey> = {
  2: "markup.width.thin",
  4: "markup.width.medium",
  8: "markup.width.thick",
  12: "markup.width.extraThick",
};

// Bars scaled into the 16px row so all four widths read as one family.
const WIDTH_BAR_HEIGHT_PX: Record<MarkupStrokeWidth, number> = {
  2: 2,
  4: 3.5,
  8: 6,
  12: 8.5,
};

// 28px ghost controls with 16px glyphs, as in the compact scale. The armed tool takes the
// accent: a faint accent fill and accent ink.
const TOOL_BUTTON_CLASS_NAME =
  "size-7 rounded-control text-foreground/80 transition-colors duration-[60ms] hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground data-pressed:bg-[color-mix(in_srgb,var(--color-text-accent)_13%,transparent)]! data-pressed:text-[var(--color-text-accent)]! [&_[data-slot=central-icon]]:size-4";
// A dropdown trigger (colour, width): its face plus a 12px chevron, one pill.
const DROPDOWN_TRIGGER_CLASS_NAME =
  "flex h-7 min-w-0 items-center gap-0.5 rounded-control px-1.5 text-foreground/80 outline-none transition-colors duration-[60ms] hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)]";
// The current colour or width carries an accent check at the row's end.
function MenuCheck({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className="ms-auto flex size-4 shrink-0 items-center justify-center">
      {checked ? <CheckIcon className="size-4 text-[var(--color-text-accent)]" /> : null}
    </span>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

function ColorSwatch({ color }: { color: MarkupColor }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-4 shrink-0 rounded-full",
        // White needs an edge to show at all; the others a faint one so they sit on any fill.
        color === "white"
          ? "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--foreground)_45%,transparent)]"
          : "shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]",
      )}
      style={{ backgroundColor: MARKUP_COLORS[color] }}
    />
  );
}

function WidthBar({ width }: { width: MarkupStrokeWidth }) {
  return (
    <span
      aria-hidden
      className="inline-block w-6 shrink-0 rounded-full bg-foreground"
      style={{ height: WIDTH_BAR_HEIGHT_PX[width] }}
    />
  );
}

/** The bar's main button: Add to chat in the browser, Save on an attachment. */
export interface MarkupToolbarAction {
  readonly label: string;
  /** Shown while `busy`. */
  readonly busyLabel: string;
  readonly busy: boolean;
  readonly onClick: () => void;
}

export interface MarkupToolbarProps {
  readonly tool: MarkupTool;
  readonly onToolChange: (tool: MarkupTool) => void;
  /**
   * Whether Select element can run now. Leave it out where there is nothing to select
   * (an image): the bar then has no Select button and an armed tool stays armed.
   */
  readonly selectAvailable?: boolean;
  readonly canUndo: boolean;
  readonly canRedo?: boolean;
  readonly hasMarks: boolean;
  /** Full bar (colours, widths, history, Add to chat); the compact bar until then. */
  readonly expanded?: boolean;
  readonly style?: MarkupStyle;
  readonly onStyleChange?: (style: MarkupStyle) => void;
  readonly action: MarkupToolbarAction;
  readonly confirmingDiscard: boolean;
  readonly onUndo: () => void;
  readonly onRedo?: () => void;
  readonly onClear?: () => void;
  /** Close, which asks first when there are marks (confirmingDiscard). */
  readonly onRequestClose: () => void;
  readonly onCancelDiscard: () => void;
  readonly onDiscard: () => void;
}

export function MarkupToolbar(props: MarkupToolbarProps) {
  const { t } = useTranslation();
  const [lastShape, setLastShape] = useState<MarkupShape>(DEFAULT_MARKUP_SHAPE);
  const shape = isMarkupShape(props.tool) ? props.tool : lastShape;
  const ShapeIcon = SHAPE_META[shape].icon;
  const style = props.style ?? DEFAULT_MARKUP_STYLE;
  const expanded = props.expanded ?? true;
  const canRedo = props.canRedo ?? false;
  const hasHistory = props.hasMarks || props.canUndo || canRedo;
  const hasSelect = props.selectAvailable !== undefined;

  // Pressing the armed tool again goes back to selecting elements, where there is Select.
  const arm = (tool: MarkupTool) => {
    if (isMarkupShape(tool)) setLastShape(tool);
    props.onToolChange(hasSelect && props.tool === tool && tool !== "select" ? "select" : tool);
  };
  const toolButton = (tool: MarkupTool, label: string, Icon: LucideIcon, disabled = false) => (
    <IconButton
      label={label}
      tooltip={label}
      tooltipSide="top"
      className={TOOL_BUTTON_CLASS_NAME}
      disabled={disabled}
      aria-pressed={props.tool === tool}
      data-pressed={props.tool === tool ? "" : undefined}
      data-sketch-tool={tool}
      onClick={() => arm(tool)}
    >
      <Icon />
    </IconButton>
  );
  const historyButton = (
    label: string,
    Icon: LucideIcon,
    disabled: boolean,
    onClick: (() => void) | undefined,
  ) => (
    <IconButton
      label={label}
      tooltip={label}
      tooltipSide="top"
      className={TOOL_BUTTON_CLASS_NAME}
      disabled={disabled || !onClick}
      onClick={onClick}
    >
      <Icon />
    </IconButton>
  );
  const shapeLabel = t(SHAPE_META[shape].labelKey);
  const shapeArmed = isMarkupShape(props.tool);

  return (
    <div
      role="toolbar"
      aria-label={t("markup.toolbar")}
      data-markup-toolbar=""
      data-layout={expanded ? "full" : "compact"}
      className="relative flex items-center gap-0.5 rounded-popover border border-border bg-popover p-1 shadow-lg motion-safe:animate-[moss-sketch-bar-in_120ms_cubic-bezier(.32,.72,0,1)]"
    >
      {props.confirmingDiscard ? (
        <div
          role="alertdialog"
          aria-label={t("markup.discardTitle")}
          className="flex items-center gap-2 py-0.5 ps-2 pe-0.5 text-ui"
        >
          <span className="text-foreground">{t("markup.discardTitle")}</span>
          <Button size="xs" variant="ghost" onClick={props.onCancelDiscard}>
            {t("markup.keepEditing")}
          </Button>
          <Button size="xs" variant="destructive" onClick={props.onDiscard}>
            {t("markup.discard")}
          </Button>
        </div>
      ) : (
        <>
          {hasSelect
            ? toolButton(
                "select",
                t("browser.sketch.select"),
                SketchSelectIcon,
                !props.selectAvailable,
              )
            : null}
          {toolButton("pen", t("markup.pen"), SketchPenIcon)}
          <div
            className={cn(
              "flex items-center rounded-control",
              shapeArmed &&
                "bg-[color-mix(in_srgb,var(--color-text-accent)_13%,transparent)] text-[var(--color-text-accent)]",
            )}
          >
            <IconButton
              label={shapeLabel}
              tooltip={shapeLabel}
              tooltipSide="top"
              className={cn(
                TOOL_BUTTON_CLASS_NAME,
                "w-6 rounded-e-none data-pressed:bg-transparent!",
              )}
              aria-pressed={props.tool === shape}
              data-pressed={props.tool === shape ? "" : undefined}
              data-sketch-tool={shape}
              onClick={() => arm(shape)}
            >
              <ShapeIcon />
            </IconButton>
            <Menu modal={false}>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    aria-label={t("markup.shapes")}
                    title={t("markup.shapes")}
                    data-sketch-menu="shape"
                    className={cn(
                      "h-7 w-5 min-w-0 rounded-s-none rounded-e-control px-0 opacity-75 hover:opacity-100 data-[popup-open]:bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)] [&_[data-slot=central-icon]]:size-3",
                      shapeArmed ? "text-[var(--color-text-accent)]" : "text-foreground/80",
                    )}
                  >
                    <ChevronDownIcon />
                  </Button>
                }
              />
              <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="w-44">
                {MARKUP_SHAPES.map((option) => {
                  const OptionIcon = SHAPE_META[option].icon;
                  return (
                    <MenuItem
                      key={option}
                      data-sketch-shape={option}
                      onClick={() => {
                        setLastShape(option);
                        props.onToolChange(option);
                      }}
                    >
                      <OptionIcon className="size-4" />
                      <span className="flex-1">{t(SHAPE_META[option].labelKey)}</span>
                    </MenuItem>
                  );
                })}
              </ComposerPickerMenuPopup>
            </Menu>
          </div>
          {toolButton("text", t("markup.text"), SketchTextIcon)}
          {expanded ? (
            <>
              <Divider />
              <Menu modal={false}>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("markup.colorMenu")}
                      title={t("markup.colorMenu")}
                      data-sketch-menu="color"
                      className={DROPDOWN_TRIGGER_CLASS_NAME}
                    />
                  }
                >
                  <ColorSwatch color={style.color} />
                  <ChevronDownIcon className="size-3 opacity-70" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="center" side="top" sideOffset={8} className="w-32">
                  {MARKUP_COLOR_ORDER.map((color) => (
                    <MenuItem
                      key={color}
                      aria-label={t(COLOR_LABEL_KEY[color])}
                      data-sketch-color={color}
                      onClick={() => props.onStyleChange?.({ ...style, color })}
                    >
                      <ColorSwatch color={color} />
                      <span className="sr-only">{t(COLOR_LABEL_KEY[color])}</span>
                      <MenuCheck checked={style.color === color} />
                    </MenuItem>
                  ))}
                </ComposerPickerMenuPopup>
              </Menu>
              <Menu modal={false}>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("markup.widthMenu")}
                      title={t("markup.widthMenu")}
                      data-sketch-menu="width"
                      className={cn(DROPDOWN_TRIGGER_CLASS_NAME, "gap-1 px-2")}
                    />
                  }
                >
                  <WidthBar width={style.width} />
                  <ChevronDownIcon className="size-3 opacity-70" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="center" side="top" sideOffset={8} className="w-32">
                  {MARKUP_STROKE_WIDTHS.map((width) => (
                    <MenuItem
                      key={width}
                      aria-label={t(WIDTH_LABEL_KEY[width])}
                      data-sketch-width={width}
                      onClick={() => props.onStyleChange?.({ ...style, width })}
                    >
                      <WidthBar width={width} />
                      <span className="sr-only">{t(WIDTH_LABEL_KEY[width])}</span>
                      <MenuCheck checked={style.width === width} />
                    </MenuItem>
                  ))}
                </ComposerPickerMenuPopup>
              </Menu>
              <Divider />
              {hasHistory ? (
                <>
                  {historyButton(t("markup.undo"), Undo2Icon, !props.canUndo, props.onUndo)}
                  {historyButton(t("markup.redo"), Redo2Icon, !canRedo, props.onRedo)}
                  {historyButton(t("markup.clear"), Trash2, !props.hasMarks, props.onClear)}
                </>
              ) : null}
              <Button
                size="xs"
                className="ms-0.5 h-7 rounded-control px-3 text-ui disabled:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] disabled:text-muted-foreground disabled:opacity-100"
                disabled={props.action.busy || !props.hasMarks}
                data-markup-action=""
                onClick={props.action.onClick}
              >
                {props.action.busy ? props.action.busyLabel : props.action.label}
              </Button>
            </>
          ) : (
            <Divider />
          )}
          <IconButton
            label={t("markup.close")}
            tooltip={t("markup.closeTooltip")}
            tooltipSide="top"
            className={cn(TOOL_BUTTON_CLASS_NAME, expanded && "ms-0.5")}
            onClick={props.onRequestClose}
          >
            <XIcon />
          </IconButton>
        </>
      )}
    </div>
  );
}
