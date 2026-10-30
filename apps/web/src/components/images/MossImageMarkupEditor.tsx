import { useEffect, useRef, useState, type PointerEvent } from "react";
import { MAX_IMAGE_REFERENCE_BYTES } from "~/lib/mossImagesClient";

import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopupBase, MenuTrigger } from "../ui/menu";

type Point = { x: number; y: number };
type Shape = "line" | "arrow" | "rectangle" | "ellipse" | "triangle" | "diamond" | "star" | "heart";
type Tool = "select" | "pen" | "text" | "eraser" | "comment" | Shape;
type Mark = {
  id: string;
  tool: Exclude<Tool, "select">;
  color: string;
  width: number;
  points: readonly Point[];
  text?: string;
};
export type MossImageMarkupDocument = readonly Mark[];
export interface MossImageMarkupResult {
  file: File;
  document: MossImageMarkupDocument;
  comments: string;
}

const SHAPES = [
  ["line", "线条"],
  ["arrow", "箭头"],
  ["rectangle", "矩形"],
  ["ellipse", "椭圆"],
  ["triangle", "三角形"],
  ["diamond", "菱形"],
  ["star", "星形"],
  ["heart", "心形"],
] as const;
const MAX_MARKS = 200;
const MAX_POINTS = 2000;
const MAX_HISTORY = 50;
const EMPTY_DOCUMENT: MossImageMarkupDocument = [];
export const MOSS_IMAGE_SKETCH_SIZES = [
  { label: "1:1", width: 1024, height: 1024 },
  { label: "16:9", width: 1536, height: 864 },
  { label: "9:16", width: 864, height: 1536 },
  { label: "4:3", width: 1152, height: 864 },
] as const;

export type MossImageMarkupEditorProps = (
  | { file: File; blankCanvas?: never }
  | { file?: never; blankCanvas: { width: number; height: number } }
) & {
  initialDocument?: MossImageMarkupDocument;
  onCancel: () => void;
  onApply: (result: MossImageMarkupResult) => Promise<void>;
};

function bounds(mark: Mark) {
  const xs = mark.points.map((p) => p.x),
    ys = mark.points.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  if (mark.tool === "comment") return { x: x - 12, y: y - 12, width: 24, height: 24 };
  // Text hit areas use the same font metrics as the renderer.
  if (mark.tool === "text") {
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${mark.width * 5}px sans-serif`;
    return {
      x,
      y,
      width: Math.max(16, context.measureText(mark.text ?? "").width),
      height: mark.width * 6,
    };
  }
  return {
    x,
    y,
    width: Math.max(1, Math.max(...xs) - x),
    height: Math.max(1, Math.max(...ys) - y),
  };
}

function drawMark(context: CanvasRenderingContext2D, mark: Mark, commentNumber: number) {
  const first = mark.points[0];
  if (!first) return;
  const last = mark.points.at(-1)!;
  const { x, y, width: w, height: h } = bounds(mark);
  context.save();
  context.strokeStyle = mark.color;
  context.fillStyle = mark.color;
  context.lineWidth = mark.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (mark.tool === "text") {
    context.font = `${mark.width * 5}px sans-serif`;
    context.textBaseline = "top";
    context.fillText(mark.text ?? "", x, y);
  } else if (mark.tool === "comment") {
    context.arc(x + 12, y + 12, 12, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "bold 14px sans-serif";
    context.textBaseline = "middle";
    context.textAlign = "center";
    context.fillText(String(commentNumber), x + 12, y + 12);
  } else if (mark.tool === "rectangle") context.strokeRect(x, y, w, h);
  else if (mark.tool === "ellipse") {
    context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    context.stroke();
  } else if (["triangle", "diamond", "star", "heart"].includes(mark.tool)) {
    if (mark.tool === "heart") {
      context.moveTo(x + w / 2, y + h);
      context.bezierCurveTo(x - w / 2, y + h / 3, x + w / 8, y - h / 2, x + w / 2, y + h / 4);
      context.bezierCurveTo(
        x + (w * 7) / 8,
        y - h / 2,
        x + (w * 3) / 2,
        y + h / 3,
        x + w / 2,
        y + h,
      );
    } else {
      const vertices = mark.tool === "triangle" ? 3 : mark.tool === "diamond" ? 4 : 10;
      for (let i = 0; i < vertices; i++) {
        const angle = -Math.PI / 2 + (i * Math.PI * 2) / vertices;
        const radius = mark.tool === "star" && i % 2 ? 0.45 : 1;
        const px = x + w / 2 + ((Math.cos(angle) * w) / 2) * radius;
        const py = y + h / 2 + ((Math.sin(angle) * h) / 2) * radius;
        if (i === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      }
      context.closePath();
    }
    context.stroke();
  } else {
    if (mark.tool === "eraser") context.globalCompositeOperation = "destination-out";
    context.moveTo(first.x, first.y);
    for (const point of mark.points.slice(1)) context.lineTo(point.x, point.y);
    if (mark.points.length === 1) context.lineTo(first.x + 0.01, first.y);
    context.stroke();
    if (mark.tool === "arrow") {
      const angle = Math.atan2(last.y - first.y, last.x - first.x),
        length = mark.width * 5;
      context.beginPath();
      context.moveTo(last.x, last.y);
      context.lineTo(
        last.x - length * Math.cos(angle - Math.PI / 6),
        last.y - length * Math.sin(angle - Math.PI / 6),
      );
      context.moveTo(last.x, last.y);
      context.lineTo(
        last.x - length * Math.cos(angle + Math.PI / 6),
        last.y - length * Math.sin(angle + Math.PI / 6),
      );
      context.stroke();
    }
  }
  context.restore();
}

function paint(
  canvas: HTMLCanvasElement,
  source: ImageBitmap,
  marks: MossImageMarkupDocument,
  requireVisibleInk = false,
) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法准备图像标注。");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const overlay = document.createElement("canvas");
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  const ink = overlay.getContext("2d")!;
  ink.scale(
    Math.max(canvas.width, canvas.height) / 1024,
    Math.max(canvas.width, canvas.height) / 1024,
  );
  for (const mark of marks) if (mark.tool !== "comment") drawMark(ink, mark, 0);
  // Comment pins carry instructions and remain selectable; the ink eraser never removes them.
  let commentNumber = 0;
  for (const mark of marks) if (mark.tool === "comment") drawMark(ink, mark, ++commentNumber);
  try {
    if (requireVisibleInk) {
      const pixels = ink.getImageData(0, 0, overlay.width, overlay.height).data;
      let visible = false;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i]! > 0) {
          visible = true;
          break;
        }
      }
      if (!visible) throw new Error("草图为空，请先画出内容。");
    }
    // Erasing affects the annotation layer only; original pixels never become transparent.
    context.drawImage(overlay, 0, 0);
  } finally {
    overlay.width = overlay.height = 1;
  }
}

interface Gesture {
  pointerId: number;
  start: Point;
  before: MossImageMarkupDocument;
  after: MossImageMarkupDocument;
  mark: Mark;
  kind: "draw" | "move" | "resize";
}

/** Builds a marked reference for the existing composer. No provider request or asset write. */
export function MossImageMarkupEditor({
  file,
  blankCanvas,
  initialDocument = EMPTY_DOCUMENT,
  onCancel,
  onApply,
}: MossImageMarkupEditorProps) {
  const [blankSize, setBlankSize] = useState(blankCanvas);
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [history, setHistory] = useState<readonly MossImageMarkupDocument[]>([initialDocument]);
  const [cursor, setCursor] = useState(0);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#dc2626");
  const [width, setWidth] = useState(4);
  const [text, setText] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [draft, setDraft] = useState<MossImageMarkupDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mounted = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const marks = history[cursor]!;
  const visibleMarks = draft ?? marks;
  const selected = visibleMarks.find((mark) => mark.id === selection);
  const surface = source
    ? {
        width: (source.width * 1024) / Math.max(source.width, source.height),
        height: (source.height * 1024) / Math.max(source.width, source.height),
      }
    : null;

  useEffect(() => {
    mounted.current = true;
    let live = true;
    let decoded: ImageBitmap | undefined;
    setSource(null);
    const decode = async () => {
      if (file) return createImageBitmap(file);
      if (
        !MOSS_IMAGE_SKETCH_SIZES.some(
          (size) => size.width === blankSize?.width && size.height === blankSize.height,
        )
      ) {
        throw new Error("请选择支持的草图尺寸。");
      }
      const blank = document.createElement("canvas");
      blank.width = blankSize!.width;
      blank.height = blankSize!.height;
      try {
        const context = blank.getContext("2d");
        if (!context) throw new Error("无法准备草图画布。");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, blank.width, blank.height);
        return await createImageBitmap(blank);
      } finally {
        blank.width = blank.height = 1;
      }
    };
    void decode()
      .then((bitmap) => {
        decoded = bitmap;
        if (!live) return bitmap.close();
        if (
          bitmap.width <= 0 ||
          bitmap.height <= 0 ||
          bitmap.width > 16_384 ||
          bitmap.height > 16_384 ||
          bitmap.width * bitmap.height > 20_000_000
        ) {
          bitmap.close();
          setError("图像过大，标注最多支持 2000 万像素。");
          return;
        }
        setSource(bitmap);
      })
      .catch((cause) => {
        if (live)
          setError(!file && cause instanceof Error ? cause.message : "无法读取此图片，请重试。");
      });
    return () => {
      live = false;
      mounted.current = false;
      decoded?.close();
    };
  }, [file, blankSize?.width, blankSize?.height]);

  useEffect(() => {
    if (!source || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const scale = 1024 / Math.max(source.width, source.height);
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    paint(canvas, source, visibleMarks);
    if (selected) {
      const context = canvas.getContext("2d")!,
        box = bounds(selected);
      context.strokeStyle = "#2563eb";
      context.lineWidth = 1;
      context.setLineDash([4, 3]);
      context.strokeRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8);
      if (!["comment", "text", "eraser"].includes(selected.tool)) {
        context.fillStyle = "#2563eb";
        context.fillRect(box.x + box.width - 5, box.y + box.height - 5, 10, 10);
      }
    }
  }, [source, visibleMarks, selected]);

  const commit = (next: MossImageMarkupDocument) => {
    const nextHistory = [...history.slice(0, cursor + 1), next].slice(-MAX_HISTORY);
    setHistory(nextHistory);
    setCursor(nextHistory.length - 1);
    setError(null);
  };
  const undoRedo = (index: number) => {
    if (applying || gesture.current || !history[index]) return;
    setCursor(index);
    setSelection(null);
    setError(null);
  };
  const cancel = () => {
    if (applying) return;
    if (marks !== initialDocument || gesture.current) setConfirmDiscard(true);
    else onCancel();
  };
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(surface!.width, ((event.clientX - rect.left) / rect.width) * surface!.width),
      ),
      y: Math.max(
        0,
        Math.min(surface!.height, ((event.clientY - rect.top) / rect.height) * surface!.height),
      ),
    };
  };
  const apply = async () => {
    if (!source || applying || gesture.current || !marks.some((mark) => mark.tool !== "eraser"))
      return;
    setApplying(true);
    setError(null);
    const canvas = document.createElement("canvas");
    try {
      canvas.width = source.width;
      canvas.height = source.height;
      paint(canvas, source, marks, Boolean(blankCanvas));
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("无法准备图像标注。"))),
          "image/png",
        ),
      );
      if (!mounted.current) return;
      if (blob.size > MAX_IMAGE_REFERENCE_BYTES) {
        throw new Error("参考图超过 4 MiB，请减少内容后重试。");
      }
      const comments = marks
        .filter((mark) => mark.tool === "comment")
        .map(
          (mark, index) =>
            `${index + 1}. (x: ${((mark.points[0]!.x / surface!.width) * 100).toFixed(1)}%, y: ${((mark.points[0]!.y / surface!.height) * 100).toFixed(1)}%) ${mark.text}`,
        )
        .join("\n");
      await onApply({
        file: new File([blob], blankCanvas ? "image-sketch.png" : "image-markup-preview.png", {
          type: "image/png",
        }),
        document: marks,
        comments,
      });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "无法准备图像标注。");
    } finally {
      canvas.width = canvas.height = 1;
      if (mounted.current) setApplying(false);
    }
  };
  const chooseTool = (next: Tool) => {
    setTool(next);
    setSelection(null);
    setError(null);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogPopup
        className="w-[min(96vw,1100px)] max-w-none"
        showCloseButton={false}
        onKeyDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("input,textarea,[contenteditable=true]")
          )
            return;
          if (event.key === "Delete" && selection && !applying) {
            event.preventDefault();
            commit(marks.filter((mark) => mark.id !== selection));
            setSelection(null);
          }
          const key = event.key.toLowerCase();
          if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y")) {
            event.preventDefault();
            undoRedo(cursor + (key === "y" || event.shiftKey ? 1 : -1));
          }
        }}
      >
        <DialogTitle className="px-4 pt-4">{blankCanvas ? "绘制草图" : "标注图像"}</DialogTitle>
        <DialogDescription className="px-4 pb-3">
          {blankCanvas
            ? "画出你的想法，完成后将草图添加为参考图。"
            : "用画笔、文字或评论表达修改意图。完成标注后，在输入框中发送编辑请求。"}
        </DialogDescription>
        {blankCanvas && (
          <div
            role="group"
            aria-label="草图尺寸"
            className="flex flex-wrap items-center justify-center gap-2 px-4 pb-3"
          >
            {MOSS_IMAGE_SKETCH_SIZES.map((size) => (
              <Button
                key={size.label}
                variant="ghost"
                size="sm"
                aria-pressed={blankSize?.width === size.width && blankSize.height === size.height}
                disabled={applying || marks.length > 0 || Boolean(draft)}
                onClick={() => {
                  setBlankSize(size);
                  setHistory([EMPTY_DOCUMENT]);
                  setCursor(0);
                  setSelection(null);
                  setError(null);
                }}
              >
                {size.label}
              </Button>
            ))}
            <span className="text-ui-xs text-muted-foreground">
              绘画后若需改尺寸，请先撤销全部笔画。
            </span>
          </div>
        )}
        <div
          role="toolbar"
          aria-label="图像标注工具"
          className="flex flex-wrap items-center justify-center gap-1 border-y border-border px-3 py-2"
        >
          {(
            [
              ["select", "选择"],
              ["pen", "画笔"],
              ["text", "文字"],
              ["comment", "评论"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={tool === value}
              disabled={applying}
              onClick={() => chooseTool(value)}
            >
              {label}
            </Button>
          ))}
          <Menu>
            <MenuTrigger disabled={applying} render={<Button variant="ghost" size="sm" />}>
              形状
            </MenuTrigger>
            <MenuPopupBase>
              {SHAPES.map(([value, label]) => (
                <MenuItem key={value} onClick={() => chooseTool(value)}>
                  {label}
                </MenuItem>
              ))}
            </MenuPopupBase>
          </Menu>
          <label className="mx-2 flex items-center gap-2 text-ui-sm">
            颜色
            <input
              type="color"
              aria-label="标注颜色"
              value={color}
              disabled={applying}
              onChange={(event) => setColor(event.target.value)}
            />
          </label>
          <label className="mx-2 flex items-center gap-2 text-ui-sm">
            {tool === "text" ? "字号" : "粗细"}
            <input
              type="range"
              aria-label="标注粗细"
              min="2"
              max="24"
              value={width}
              disabled={applying}
              onChange={(event) => setWidth(Number(event.target.value))}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            aria-label="擦除标注"
            aria-pressed={tool === "eraser"}
            disabled={applying}
            onClick={() => chooseTool("eraser")}
          >
            橡皮
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={cursor === 0 || applying || Boolean(draft)}
            onClick={() => undoRedo(cursor - 1)}
          >
            撤销
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={cursor >= history.length - 1 || applying || Boolean(draft)}
            onClick={() => undoRedo(cursor + 1)}
          >
            重做
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!selected || applying}
            onClick={() => {
              commit(marks.filter((mark) => mark.id !== selection));
              setSelection(null);
            }}
          >
            删除标注
          </Button>
        </div>
        {(tool === "text" ||
          tool === "comment" ||
          selected?.tool === "comment" ||
          selected?.tool === "text") && (
          <div className="flex gap-2 p-3">
            <Input
              aria-label={
                tool === "comment" || selected?.tool === "comment" ? "评论内容" : "标注文字"
              }
              placeholder="输入内容，再点击图像放置"
              value={text}
              maxLength={500}
              disabled={applying}
              onChange={(event) => setText(event.target.value)}
            />
            {selected && (
              <Button
                disabled={applying || !text.trim()}
                onClick={() =>
                  commit(
                    marks.map((mark) =>
                      mark.id === selection ? { ...mark, text: text.trim() } : mark,
                    ),
                  )
                }
              >
                保存文字
              </Button>
            )}
          </div>
        )}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-secondary p-4">
          {source ? (
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="图像标注画布"
              tabIndex={0}
              className="block max-h-[55vh] max-w-full object-contain outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ touchAction: "none", cursor: tool === "select" ? "default" : "crosshair" }}
              onPointerDown={(event) => {
                if (applying || event.button !== 0 || gesture.current) return;
                const start = point(event);
                event.currentTarget.focus();
                if (tool === "select") {
                  const hit = marks.findLast((mark) => {
                    const b = bounds(mark);
                    return (
                      mark.tool !== "eraser" &&
                      start.x >= b.x - 8 &&
                      start.y >= b.y - 8 &&
                      start.x <= b.x + b.width + 8 &&
                      start.y <= b.y + b.height + 8
                    );
                  });
                  setSelection(hit?.id ?? null);
                  if (!hit) return;
                  setText(hit.text ?? "");
                  const box = bounds(hit);
                  const resize =
                    hit.id === selection &&
                    !["text", "comment", "eraser"].includes(hit.tool) &&
                    Math.abs(start.x - box.x - box.width) < 10 &&
                    Math.abs(start.y - box.y - box.height) < 10;
                  gesture.current = {
                    pointerId: event.pointerId,
                    start,
                    before: marks,
                    after: marks,
                    mark: hit,
                    kind: resize ? "resize" : "move",
                  };
                } else {
                  if (marks.length >= MAX_MARKS) {
                    setError("标注数量已达上限，请删除不需要的标注。");
                    return;
                  }
                  if ((tool === "text" || tool === "comment") && !text.trim()) {
                    setError("请先输入文字。");
                    return;
                  }
                  const mark: Mark = {
                    id: crypto.randomUUID(),
                    tool,
                    color,
                    width,
                    points: [start],
                    ...(["text", "comment"].includes(tool) ? { text: text.trim() } : {}),
                  };
                  if (tool === "text" || tool === "comment") {
                    commit([...marks, mark]);
                    return;
                  }
                  gesture.current = {
                    pointerId: event.pointerId,
                    start,
                    before: marks,
                    after: [...marks, mark],
                    mark,
                    kind: "draw",
                  };
                  setDraft([...marks, mark]);
                }
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const active = gesture.current;
                if (!active || active.pointerId !== event.pointerId) return;
                const next = point(event);
                if (active.kind === "draw") {
                  const points =
                    active.mark.tool === "pen" || active.mark.tool === "eraser"
                      ? [...active.mark.points.slice(0, MAX_POINTS - 1), next]
                      : [active.start, next];
                  active.mark = { ...active.mark, points };
                  active.after = [...active.before, active.mark];
                  setDraft(active.after);
                } else {
                  const box = bounds(active.mark);
                  const dx = Math.max(
                    -box.x,
                    Math.min(surface!.width - box.x - box.width, next.x - active.start.x),
                  );
                  const dy = Math.max(
                    -box.y,
                    Math.min(surface!.height - box.y - box.height, next.y - active.start.y),
                  );
                  const points = active.mark.points.map((p) =>
                    active.kind === "move"
                      ? { x: p.x + dx, y: p.y + dy }
                      : {
                          x: box.x + ((p.x - box.x) * Math.max(1, next.x - box.x)) / box.width,
                          y: box.y + ((p.y - box.y) * Math.max(1, next.y - box.y)) / box.height,
                        },
                  );
                  active.after = active.before.map((mark) =>
                    mark.id === active.mark.id ? { ...mark, points } : mark,
                  );
                  setDraft(active.after);
                }
              }}
              onPointerUp={(event) => {
                if (!gesture.current || gesture.current.pointerId !== event.pointerId) return;
                if (gesture.current.after !== gesture.current.before) commit(gesture.current.after);
                gesture.current = null;
                setDraft(null);
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onLostPointerCapture={() => {
                gesture.current = null;
                setDraft(null);
              }}
            />
          ) : (
            <p role="status" className="text-ui-sm">
              {error ? "无法打开图片" : blankCanvas ? "正在准备画布…" : "正在读取图片…"}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="px-4 pt-3 text-ui-sm text-destructive">
            {error}
          </p>
        )}
        {confirmDiscard ? (
          <div className="flex items-center gap-3 p-4" role="alert">
            <span className="flex-1 text-ui-sm">
              {blankCanvas ? "放弃此次未完成的草图？" : "放弃此次未完成的标注？"}
            </span>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              {blankCanvas ? "继续绘制" : "继续标注"}
            </Button>
            <Button onClick={onCancel}>{blankCanvas ? "放弃草图" : "放弃标注"}</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-4">
            <span className="flex-1 text-ui-xs text-muted-foreground">
              {blankCanvas ? "完成后添加为参考图，不会立即生成" : "橡皮仅擦除标注，不移除图像内容"}
            </span>
            <Button variant="ghost" disabled={applying} onClick={cancel}>
              取消
            </Button>
            <Button
              disabled={
                !source ||
                applying ||
                Boolean(draft) ||
                !marks.some((mark) => mark.tool !== "eraser")
              }
              onClick={() => void apply()}
            >
              {applying ? "正在准备…" : blankCanvas ? "完成草图" : "完成标注"}
            </Button>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}
