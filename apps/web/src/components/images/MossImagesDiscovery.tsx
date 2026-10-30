import { useState } from "react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  MOSS_IMAGE_STYLES,
  MOSS_IMAGE_TEMPLATES,
  type MossImageStyle,
  type MossImageTemplate,
} from "./mossImagesDiscoveryCatalog";

export interface MossImagesDiscoveryProps {
  readonly resetKey: string;
  readonly disabled?: boolean;
  readonly selectedStyle: MossImageStyle | null;
  readonly onSelectStyle: (style: MossImageStyle | null) => void;
  readonly referenceCount: number;
  readonly supportsReferences: boolean;
  readonly onRequestReference: (source: "upload" | "recent") => void;
  readonly onUseTemplate: (template: MossImageTemplate) => void;
  readonly onGenerateTemplate?: (template: MossImageTemplate, aspectRatio: string) => void;
  readonly aspectRatio?: string;
  readonly canGenerate?: boolean;
  readonly templates?: readonly MossImageTemplate[];
  readonly styles?: readonly MossImageStyle[];
}

function Preview({
  url,
  title,
  compact = false,
}: {
  url: string;
  title: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <div
      className={`relative w-full overflow-hidden bg-muted ${compact ? "aspect-[4/5] rounded-2xl" : "aspect-square rounded-xl"}`}
    >
      {failed ? (
        <div
          role="img"
          aria-label={`${title}预览不可用`}
          className="flex h-full items-center justify-center p-4 text-center text-ui-sm text-muted-foreground"
        >
          预览暂不可用，请参考说明
        </div>
      ) : (
        <img
          key={attempt}
          src={url}
          alt={`${title}模板预览`}
          className="h-full w-full object-cover"
          loading={compact ? "lazy" : "eager"}
          onError={() => setFailed(true)}
        />
      )}
      {failed && !compact && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          重新加载预览
        </Button>
      )}
    </div>
  );
}

function DiscoveryPanel({
  disabled = false,
  selectedStyle,
  onSelectStyle,
  referenceCount,
  supportsReferences,
  onRequestReference,
  onUseTemplate,
  onGenerateTemplate,
  aspectRatio = "1:1",
  canGenerate = true,
  templates = MOSS_IMAGE_TEMPLATES,
  styles = MOSS_IMAGE_STYLES,
}: MossImagesDiscoveryProps) {
  const [section, setSection] = useState<"templates" | "popular">("templates");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [ratio, setRatio] = useState(aspectRatio);
  const preview = templates.find((template) => template.id === previewId);
  const canUse =
    !disabled &&
    canGenerate &&
    preview &&
    (!preview.requiresReference || (supportsReferences && referenceCount > 0));
  return (
    <section aria-label="图片灵感与样式" className="space-y-4 text-ui">
      <div role="tablist" aria-label="图像灵感" className="flex items-center gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={section === "templates"}
          className={`rounded-full px-4 py-2 text-ui-sm ${section === "templates" ? "bg-surface-secondary font-medium" : "text-muted-foreground"}`}
          onClick={() => setSection("templates")}
        >
          模板
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "popular"}
          className={`rounded-full px-4 py-2 text-ui-sm ${section === "popular" ? "bg-surface-secondary font-medium" : "text-muted-foreground"}`}
          onClick={() => setSection("popular")}
        >
          热门
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {section === "templates"
          ? templates.map((template) => (
              <button
                key={template.id}
                type="button"
                aria-label={`预览${template.title}`}
                disabled={disabled}
                className="group relative min-w-0 cursor-pointer overflow-hidden rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                onClick={() => {
                  setRatio(aspectRatio);
                  setPreviewId(template.id);
                }}
              >
                <Preview url={template.previewUrl} title={template.title} compact />
                <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/25 to-transparent px-3 pb-3 pt-10 text-ui-sm font-medium text-white">
                  {template.title}
                </span>
              </button>
            ))
          : styles.map((style) => (
              <button
                key={style.id}
                type="button"
                aria-label={`选择${style.title}样式`}
                aria-pressed={selectedStyle?.id === style.id}
                disabled={disabled || (style.requiresReference && !supportsReferences)}
                className="relative overflow-hidden rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelectStyle(style)}
              >
                <Preview url={style.previewUrl} title={style.title} compact />
                <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/30 to-transparent px-3 pb-3 pt-10 text-ui-sm font-medium text-white">
                  {style.title}
                </span>
              </button>
            ))}
      </div>
      {section === "popular" && selectedStyle && (
        <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
          <span>{selectedStyle.description}</span>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onSelectStyle(null)}>
            清除样式
          </Button>
        </div>
      )}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null);
        }}
      >
        {preview && (
          <DialogPopup className="w-[min(800px,calc(100vw-32px))] max-w-[800px] p-4">
            <div className="grid gap-6 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
              <Preview
                key={`${preview.id}:${preview.previewUrl}`}
                url={preview.previewUrl}
                title={preview.title}
              />
              <div className="flex min-w-0 flex-col gap-5 py-2">
                <DialogTitle className="text-2xl font-semibold">{preview.title}</DialogTitle>
                <DialogDescription>{preview.description}</DialogDescription>
                <Collapsible className="text-ui-sm text-muted-foreground">
                  <CollapsibleTrigger>查看描述</CollapsibleTrigger>
                  <CollapsiblePanel>
                    <p className="mt-3 whitespace-pre-wrap">{preview.prompt}</p>
                  </CollapsiblePanel>
                </Collapsible>
                <div className="flex items-center justify-between gap-3 text-ui-sm">
                  <span>宽高比</span>
                  <Select
                    value={ratio}
                    onValueChange={(value) => {
                      if (typeof value === "string") setRatio(value);
                    }}
                    disabled={disabled}
                  >
                    <SelectTrigger aria-label="模板图像比例" className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup surface="composer">
                      {["auto", "1:1", "2:3", "3:2", "16:9", "9:16"].map((value) => (
                        <SelectItem key={value} value={value}>
                          {value === "auto" ? "自动" : value}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="space-y-2 text-ui-sm">
                  <span>参考照片 {referenceCount > 0 ? `· ${referenceCount}` : ""}</span>
                  {preview.requiresReference && (
                    <p role="status" className="text-muted-foreground">
                      {!supportsReferences
                        ? "当前模型不支持参考图，请先切换模型。"
                        : referenceCount > 0
                          ? "已添加参考图。"
                          : "需要至少一张参考图。"}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled || !supportsReferences}
                      onClick={() => onRequestReference("upload")}
                    >
                      上传参考图
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled || !supportsReferences}
                      onClick={() => onRequestReference("recent")}
                    >
                      从最近图片选择
                    </Button>
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-end gap-2 pt-6">
                  <Button variant="ghost" onClick={() => setPreviewId(null)}>
                    取消
                  </Button>
                  <Button
                    disabled={!canUse}
                    onClick={() => {
                      if (!canUse) return;
                      setPreviewId(null);
                      if (onGenerateTemplate) onGenerateTemplate(preview, ratio);
                      else onUseTemplate(preview);
                    }}
                  >
                    {onGenerateTemplate ? "试一试" : "使用模板"}
                  </Button>
                </div>
              </div>
            </div>
          </DialogPopup>
        )}
      </Dialog>
    </section>
  );
}

export function MossImagesDiscovery(props: MossImagesDiscoveryProps) {
  return <DiscoveryPanel key={props.resetKey} {...props} />;
}
