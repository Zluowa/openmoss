// FILE: BrowserSketchToolbar.tsx
// Purpose: The floating annotation bar under the browser page: select an element; draw
//   with the pen, a shape (line, arrow, rectangle, ellipse, numbered step) or text; pick
//   the ink colour and stroke width; undo, redo, clear; add the marked page to chat;
//   close. It starts compact (select, pen, shapes, text, close) and opens out once a
//   drawing tool is armed.
// Layer: BrowserPanel UI
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
  BROWSER_SKETCH_COLOR_ORDER,
  BROWSER_SKETCH_COLORS,
  BROWSER_SKETCH_SHAPES,
  BROWSER_SKETCH_STROKE_WIDTHS,
  type BrowserSketchColor,
  type BrowserSketchShape,
  type BrowserSketchStrokeWidth,
  type BrowserSketchStyle,
  type BrowserSketchTool,
  DEFAULT_BROWSER_SKETCH_SHAPE,
  DEFAULT_BROWSER_SKETCH_STYLE,
  isBrowserSketchShape,
} from "./browserSketch.logic";

const SHAPE_META: Record<BrowserSketchShape, { labelKey: TranslationKey; icon: LucideIcon }> = {
  line: { labelKey: "browser.sketch.line", icon: SketchLineIcon },
  arrow: { labelKey: "browser.sketch.arrow", icon: SketchArrowIcon },
  rect: { labelKey: "browser.sketch.rectangle", icon: SketchRectangleIcon },
  ellipse: { labelKey: "browser.sketch.ellipse", icon: SketchEllipseIcon },
  step: { labelKey: "browser.sketch.step", icon: SketchStepIcon },
};

const COLOR_LABEL_KEY: Record<BrowserSketchColor, TranslationKey> = {
  red: "browser.sketch.color.red",
  blue: "browser.sketch.color.blue",
  green: "browser.sketch.color.green",
  black: "browser.sketch.color.black",
  white: "browser.sketch.color.white",
};

const WIDTH_LABEL_KEY: Record<BrowserSketchStrokeWidth, TranslationKey> = {
  2: "browser.sketch.width.thin",
  4: "browser.sketch.width.medium",
  8: "browser.sketch.width.thick",
  12: "browser.sketch.width.extraThick",
};

// Bars scaled into the 16px row so all four widths read as one family.
const WIDTH_BAR_HEIGHT_PX: Record<BrowserSketchStrokeWidth, number> = {
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

function ColorSwatch({ color }: { color: BrowserSketchColor }) {
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
      style={{ backgroundColor: BROWSER_SKETCH_COLORS[color] }}
    />
  );
}

function WidthBar({ width }: { width: BrowserSketchStrokeWidth }) {
  return (
    <span
      aria-hidden
      className="inline-block w-6 shrink-0 rounded-full bg-foreground"
      style={{ height: WIDTH_BAR_HEIGHT_PX[width] }}
    />
  );
}

export interface BrowserSketchToolbarProps {
  readonly tool: BrowserSketchTool;
  readonly onToolChange: (tool: BrowserSketchTool) => void;
  readonly selectAvailable: boolean;
  readonly canUndo: boolean;
  readonly canRedo?: boolean;
  readonly hasMarks: boolean;
  /** Full bar (colours, widths, history, Add to chat); the compact bar until then. */
  readonly expanded?: boolean;
  readonly style?: BrowserSketchStyle;
  readonly onStyleChange?: (style: BrowserSketchStyle) => void;
  readonly adding: boolean;
  readonly confirmingDiscard: boolean;
  readonly onUndo: () => void;
  readonly onRedo?: () => void;
  readonly onClear?: () => void;
  readonly onAddToChat: () => void;
  /** Close, which asks first when there are marks (confirmingDiscard). */
  readonly onRequestClose: () => void;
  readonly onCancelDiscard: () => void;
  readonly onDiscard: () => void;
}

export function BrowserSketchToolbar(props: BrowserSketchToolbarProps) {
  const { t } = useTranslation();
  const [lastShape, setLastShape] = useState<BrowserSketchShape>(DEFAULT_BROWSER_SKETCH_SHAPE);
  const shape = isBrowserSketchShape(props.tool) ? props.tool : lastShape;
  const ShapeIcon = SHAPE_META[shape].icon;
  const style = props.style ?? DEFAULT_BROWSER_SKETCH_STYLE;
  const expanded = props.expanded ?? true;
  const canRedo = props.canRedo ?? false;
  const hasHistory = props.hasMarks || props.canUndo || canRedo;

  // Pressing the armed tool again goes back to selecting elements.
  const arm = (tool: BrowserSketchTool) => {
    if (isBrowserSketchShape(tool)) setLastShape(tool);
    props.onToolChange(props.tool === tool && tool !== "select" ? "select" : tool);
  };
  const toolButton = (
    tool: BrowserSketchTool,
    label: string,
    Icon: LucideIcon,
    disabled = false,
  ) => (
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
  const shapeArmed = isBrowserSketchShape(props.tool);

  return (
    <div
      role="toolbar"
      aria-label={t("browser.sketch.toolbar")}
      data-browser-sketch-toolbar=""
      data-layout={expanded ? "full" : "compact"}
      className="relative flex items-center gap-0.5 rounded-popover border border-border bg-popover p-1 shadow-lg motion-safe:animate-[moss-sketch-bar-in_120ms_cubic-bezier(.32,.72,0,1)]"
    >
      {props.confirmingDiscard ? (
        <div
          role="alertdialog"
          aria-label={t("browser.sketch.discardTitle")}
          className="flex items-center gap-2 py-0.5 ps-2 pe-0.5 text-ui"
        >
          <span className="text-foreground">{t("browser.sketch.discardTitle")}</span>
          <Button size="xs" variant="ghost" onClick={props.onCancelDiscard}>
            {t("browser.sketch.keepEditing")}
          </Button>
          <Button size="xs" variant="destructive" onClick={props.onDiscard}>
            {t("browser.sketch.discard")}
          </Button>
        </div>
      ) : (
        <>
          {toolButton(
            "select",
            t("browser.sketch.select"),
            SketchSelectIcon,
            !props.selectAvailable,
          )}
          {toolButton("pen", t("browser.sketch.pen"), SketchPenIcon)}
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
                    aria-label={t("browser.sketch.shapes")}
                    title={t("browser.sketch.shapes")}
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
                {BROWSER_SKETCH_SHAPES.map((option) => {
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
          {toolButton("text", t("browser.sketch.text"), SketchTextIcon)}
          {expanded ? (
            <>
              <Divider />
              <Menu modal={false}>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("browser.sketch.colorMenu")}
                      title={t("browser.sketch.colorMenu")}
                      data-sketch-menu="color"
                      className={DROPDOWN_TRIGGER_CLASS_NAME}
                    />
                  }
                >
                  <ColorSwatch color={style.color} />
                  <ChevronDownIcon className="size-3 opacity-70" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="center" side="top" sideOffset={8} className="w-32">
                  {BROWSER_SKETCH_COLOR_ORDER.map((color) => (
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
                      aria-label={t("browser.sketch.widthMenu")}
                      title={t("browser.sketch.widthMenu")}
                      data-sketch-menu="width"
                      className={cn(DROPDOWN_TRIGGER_CLASS_NAME, "gap-1 px-2")}
                    />
                  }
                >
                  <WidthBar width={style.width} />
                  <ChevronDownIcon className="size-3 opacity-70" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="center" side="top" sideOffset={8} className="w-32">
                  {BROWSER_SKETCH_STROKE_WIDTHS.map((width) => (
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
                  {historyButton(t("browser.sketch.undo"), Undo2Icon, !props.canUndo, props.onUndo)}
                  {historyButton(t("browser.sketch.redo"), Redo2Icon, !canRedo, props.onRedo)}
                  {historyButton(t("browser.sketch.clear"), Trash2, !props.hasMarks, props.onClear)}
                </>
              ) : null}
              <Button
                size="xs"
                className="ms-0.5 h-7 rounded-control px-3 text-ui disabled:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] disabled:text-muted-foreground disabled:opacity-100"
                disabled={props.adding || !props.hasMarks}
                data-sketch-add-to-chat=""
                onClick={props.onAddToChat}
              >
                {props.adding ? t("browser.sketch.adding") : t("browser.sketch.addToChat")}
              </Button>
            </>
          ) : (
            <Divider />
          )}
          <IconButton
            label={t("browser.sketch.close")}
            tooltip={t("browser.sketch.closeTooltip")}
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
