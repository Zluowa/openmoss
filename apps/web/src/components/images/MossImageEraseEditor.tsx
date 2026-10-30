import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";

type Point = { x: number; y: number };
type Stroke = { width: number; points: readonly Point[] };
type Selection = readonly Stroke[];
const EMPTY_SELECTION: Selection = [];

export interface MossImageEraseSelection {
  readonly source: File;
  readonly mask: File;
}

function drawSelection(context: CanvasRenderingContext2D, strokes: Selection) {
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    const first = stroke.points[0];
    if (!first) continue;
    context.lineWidth = stroke.width;
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
    if (stroke.points.length === 1) context.lineTo(first.x + 0.01, first.y);
    context.stroke();
  }
}

function png(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob || blob.size >= 4 * 1024 * 1024) {
        reject(new Error("原图或选区 PNG 超过 4 MiB，无法按原尺寸编辑。请选择较小的原图。"));
      } else resolve(new File([blob], name, { type: "image/png" }));
    }, "image/png"),
  );
}

/** The tinted selection is a preview. Only the provider produces the edited image. */
export function MossImageEraseEditor({
  file,
  onCancel,
  onApply,
}: {
  file: File;
  onCancel: () => void;
  onApply: (selection: MossImageEraseSelection) => Promise<void>;
}) {
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [history, setHistory] = useState<readonly Selection[]>([EMPTY_SELECTION]);
  const [cursor, setCursor] = useState(0);
  const [width, setWidth] = useState(40);
  const [draft, setDraft] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mounted = useRef(false);
  const drawing = useRef<{ pointerId: number; before: Selection; stroke: Stroke } | null>(null);
  const strokes = history[cursor]!;
  const visible = draft ?? strokes;
  const surface = source
    ? {
        width: (source.width * 1024) / Math.max(source.width, source.height),
        height: (source.height * 1024) / Math.max(source.width, source.height),
      }
    : null;

  useEffect(() => {
    mounted.current = true;
    let live = true;
    let bitmap: ImageBitmap | undefined;
    void createImageBitmap(file)
      .then((image) => {
        bitmap = image;
        if (!live) return image.close();
        if (
          !image.width ||
          !image.height ||
          image.width > 8192 ||
          image.height > 8192 ||
          image.width * image.height > 20_000_000
        ) {
          image.close();
          setError("此图像超过编辑尺寸上限，无法保持原尺寸编辑。");
          return;
        }
        setSource(image);
      })
      .catch(() => {
        if (live) setError("无法读取此图片，请重试。");
      });
    return () => {
      live = false;
      mounted.current = false;
      bitmap?.close();
    };
  }, [file]);

  useEffect(() => {
    if (!source || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const scale = 1024 / Math.max(source.width, source.height);
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext("2d")!;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    context.strokeStyle = "rgba(168, 85, 247, 0.6)";
    drawSelection(context, visible);
  }, [source, visible]);

  const commit = (next: Selection) => {
    const updated = [...history.slice(0, cursor + 1), next].slice(-50);
    setHistory(updated);
    setCursor(updated.length - 1);
    setError(null);
  };
  const apply = async () => {
    if (!source || applying || drawing.current || !strokes.length) return;
    setApplying(true);
    setError(null);
    try {
      const original = document.createElement("canvas");
      original.width = source.width;
      original.height = source.height;
      original.getContext("2d")!.drawImage(source, 0, 0);
      const mask = document.createElement("canvas");
      mask.width = source.width;
      mask.height = source.height;
      const context = mask.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, mask.width, mask.height);
      context.scale(
        Math.max(source.width, source.height) / 1024,
        Math.max(source.width, source.height) / 1024,
      );
      context.globalCompositeOperation = "destination-out";
      drawSelection(context, strokes);
      const [sourceFile, maskFile] = await Promise.all([
        png(original, "image-edit-source.png"),
        png(mask, "image-edit-mask.png"),
      ]);
      original.width = original.height = mask.width = mask.height = 1;
      if (!mounted.current) return;
      if (sourceFile.size + maskFile.size > 5 * 1024 * 1024)
        throw new Error("原图与选区总大小超过 5 MiB，无法按原尺寸编辑。");
      await onApply({ source: sourceFile, mask: maskFile });
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "无法提交擦除请求，请重试。");
    } finally {
      if (mounted.current) setApplying(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !applying) onCancel();
      }}
    >
      <DialogPopup className="w-[min(96vw,1100px)] max-w-none" showCloseButton={false}>
        <DialogTitle className="px-4 pt-4">擦除图像内容</DialogTitle>
        <DialogDescription className="px-4 pb-3">
          涂抹需要移除的区域，再提交生成编辑后的图像。
        </DialogDescription>
        <div
          role="toolbar"
          aria-label="擦除选区工具"
          className="flex items-center justify-center gap-2 border-y border-border p-3"
        >
          <label className="flex items-center gap-2 text-ui-sm">
            画笔大小
            <input
              aria-label="擦除画笔大小"
              type="range"
              min="8"
              max="160"
              value={width}
              disabled={applying}
              onChange={(event) => setWidth(Number(event.target.value))}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            disabled={applying || Boolean(draft) || cursor === 0}
            onClick={() => setCursor(cursor - 1)}
          >
            撤销
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={applying || Boolean(draft) || cursor === history.length - 1}
            onClick={() => setCursor(cursor + 1)}
          >
            重做
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={applying || Boolean(draft) || !strokes.length}
            onClick={() => commit(EMPTY_SELECTION)}
          >
            清除选区
          </Button>
        </div>
        <div className="flex min-h-0 items-center justify-center overflow-auto bg-surface-secondary p-4">
          {source ? (
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="擦除选区画布"
              className="block max-h-[55vh] max-w-full object-contain"
              style={{ touchAction: "none", cursor: "crosshair" }}
              onPointerDown={(event) => {
                if (applying || drawing.current || event.button !== 0 || !surface) return;
                if (strokes.length >= 200) {
                  setError("选区笔画已达上限，请清除不需要的选区。");
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                const point = {
                  x: ((event.clientX - rect.left) / rect.width) * surface.width,
                  y: ((event.clientY - rect.top) / rect.height) * surface.height,
                };
                drawing.current = {
                  pointerId: event.pointerId,
                  before: strokes,
                  stroke: { width, points: [point] },
                };
                setDraft([...strokes, drawing.current.stroke]);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const active = drawing.current;
                if (!active || active.pointerId !== event.pointerId || !surface) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const point = {
                  x: Math.max(
                    0,
                    Math.min(
                      surface.width,
                      ((event.clientX - rect.left) / rect.width) * surface.width,
                    ),
                  ),
                  y: Math.max(
                    0,
                    Math.min(
                      surface.height,
                      ((event.clientY - rect.top) / rect.height) * surface.height,
                    ),
                  ),
                };
                active.stroke = {
                  ...active.stroke,
                  points: [...active.stroke.points.slice(0, 1999), point],
                };
                setDraft([...active.before, active.stroke]);
              }}
              onPointerUp={(event) => {
                const active = drawing.current;
                if (!active || active.pointerId !== event.pointerId) return;
                commit([...active.before, active.stroke]);
                drawing.current = null;
                setDraft(null);
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onLostPointerCapture={() => {
                drawing.current = null;
                setDraft(null);
              }}
            />
          ) : (
            <p role="status" className="text-ui-sm">
              {error ? "无法打开图片" : "正在读取图片…"}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="px-4 pt-3 text-ui-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 p-4">
          <span className="flex-1 text-ui-xs text-muted-foreground">
            选区预览不会修改原图，提交后按所选模型生成。
          </span>
          <Button variant="ghost" disabled={applying} onClick={onCancel}>
            取消
          </Button>
          <Button
            disabled={!source || applying || Boolean(draft) || !strokes.length}
            onClick={() => void apply()}
          >
            {applying ? "正在提交…" : "移除选区"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
