// FILE: McpToolResultDetails.tsx
// Purpose: Render the bounded, non-app MCP result projection.
// Layer: Chat presentation component
// Exports: McpToolResultDetails

import { type ReactNode, useState } from "react";

import type { McpProjectionAnnotations, McpToolResultContentBlock } from "@synara/contracts";
import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { Button } from "../ui/button";
import { CircleAlertIcon, CodeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTrigger,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { AutomaticApprovalReviewDetails } from "./AutomaticApprovalReviewDetails";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { McpCodePane } from "./McpCodePane";

const MCP_CODE_CLASS_NAME =
  "max-h-[min(46vh,30rem)] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/45 bg-background/70 px-3 py-2.5 font-chat-code text-ui-xs leading-relaxed text-foreground";

export function formatMcpJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "null";
  }
}

function formatJsonRepresentation(value: string): string {
  try {
    return formatMcpJson(JSON.parse(value));
  } catch {
    return value;
  }
}

function annotationSummary(
  annotations: McpProjectionAnnotations | undefined,
  labels: {
    readonly audience: string;
    readonly priority: string;
    readonly lastModified: string;
  },
): string | null {
  if (!annotations) return null;
  const audience = Array.isArray(annotations.audience)
    ? annotations.audience.join(", ")
    : annotations.audience;
  const parts = [
    audience ? `${labels.audience}: ${audience}` : null,
    annotations.priority !== undefined ? `${labels.priority}: ${annotations.priority}` : null,
    annotations.lastModified ? `${labels.lastModified}: ${annotations.lastModified}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("; ") : null;
}

function isDuplicateStructuredText(
  block: Extract<McpToolResultContentBlock, { type: "text" }>,
  structuredContent: unknown,
): boolean {
  if (block.annotations || structuredContent === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(block.text)) === JSON.stringify(structuredContent);
  } catch {
    return false;
  }
}

function Section(props: { title: string; children: ReactNode; tone?: "default" | "danger" }) {
  return (
    <section className="space-y-2" data-mcp-section={props.title}>
      <h3
        className={cn(
          "text-ui-xs font-medium text-foreground",
          props.tone === "danger" && "text-rose-700 dark:text-rose-300",
        )}
      >
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function AnnotationLine({ value }: { value: string | null }) {
  return value ? (
    <p className="break-words text-size-chat text-codex-description/80">{value}</p>
  ) : null;
}

function mediaAnnotation(
  annotations: McpProjectionAnnotations | undefined,
  format: (key: "chat.mcpResult.annotationsLine", values: { annotations: string }) => string,
): string | null {
  if (!annotations) return null;
  const parts: string[] = [];
  if (annotations.audience !== undefined) {
    const audience = Array.isArray(annotations.audience)
      ? annotations.audience.join(", ")
      : annotations.audience;
    if (audience.length > 0) {
      parts.push(`audience=${audience}`);
    }
  }
  if (annotations.priority !== undefined) {
    parts.push(`priority=${String(annotations.priority)}`);
  }
  if (annotations.lastModified) {
    parts.push(`lastModified=${annotations.lastModified}`);
  }
  return parts.length > 0
    ? format("chat.mcpResult.annotationsLine", { annotations: parts.join("; ") })
    : null;
}

function LocalArtifactContentBlock({
  block,
  annotation,
  imageAlt,
  unavailable,
  onImageExpand,
}: {
  block: Extract<McpToolResultContentBlock, { type: "local_artifact" }>;
  annotation: string | null;
  imageAlt: string;
  unavailable: string;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const src = resolveWsHttpUrl(`/attachments/${encodeURIComponent(block.attachmentId)}`);
  if (failed) {
    return (
      <div
        className="rounded-lg border border-amber-500/35 bg-amber-500/8 px-3 py-2.5 text-ui-xs text-foreground"
        data-mcp-content-type="local_artifact"
        data-mcp-state="media-unavailable"
        data-mcp-attachment-id={block.attachmentId}
        data-mcp-media-kind={block.mediaKind}
      >
        <p>{unavailable}</p>
      </div>
    );
  }

  const activateImage = () => {
    if (block.mediaKind !== "image") return;
    onImageExpand?.({ images: [{ src, name: block.name }], index: 0 });
  };
  const image = (
    <img
      className="max-h-48 w-max max-w-full gap-0.5 rounded-md object-contain"
      alt={imageAlt}
      src={src}
      onError={() => setFailed(true)}
    />
  );
  const content =
    block.mediaKind === "image" ? (
      onImageExpand ? (
        <button
          type="button"
          className="block w-fit max-w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={imageAlt}
          onClick={activateImage}
        >
          {image}
        </button>
      ) : (
        image
      )
    ) : (
      <audio
        className="w-full gap-0.5"
        controls
        src={src}
        preload="metadata"
        onError={() => setFailed(true)}
      />
    );
  return (
    <div
      className="flex flex-col gap-0.5"
      data-mcp-content-type="local_artifact"
      data-mcp-state="available"
      data-mcp-attachment-id={block.attachmentId}
      data-mcp-media-kind={block.mediaKind}
      data-mcp-size-bytes={String(block.sizeBytes)}
      data-mcp-truncated={block.truncated ? "true" : "false"}
    >
      {content}
      {annotation ? (
        <p className="text-size-chat whitespace-pre-wrap text-codex-description/80">{annotation}</p>
      ) : null}
    </div>
  );
}

function ContentBlockView({
  block,
  labels,
  onImageExpand,
}: {
  block: McpToolResultContentBlock;
  labels: {
    readonly plaintext: string;
    readonly resource: string;
    readonly embedded: string;
    readonly unknown: string;
    readonly binaryDeferred: string;
    readonly uri: string;
    readonly mimeType: string;
    readonly annotations: string;
    readonly content: string;
    readonly audience: string;
    readonly priority: string;
    readonly lastModified: string;
    readonly imageAlt: string;
    readonly mediaUnavailable: string;
  };
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { t, format } = useTranslation();
  const annotations = "annotations" in block ? annotationSummary(block.annotations, labels) : null;
  if (block.type === "text") {
    return (
      <div>
        <div className="relative overflow-clip rounded-lg border border-strong bg-secondary-soft-alpha contain-inline-size">
          <div className="sticky top-0 z-10 flex items-center justify-between py-1 ps-2 pe-2 font-sans text-ui-lg text-codex-description select-none">
            <span className="min-w-0 truncate">{labels.plaintext}</span>
            <div className="flex items-center" />
          </div>
          <div className="max-h-48 overflow-y-auto p-2">
            <pre
              tabIndex={0}
              className="m-0 whitespace-pre-wrap break-words font-sans text-size-chat leading-relaxed text-foreground/70 [&_*]:text-foreground/70"
              data-mcp-content-type="text"
            >
              {block.text}
            </pre>
          </div>
        </div>
        <AnnotationLine value={annotations} />
        {block.truncated ? (
          <p className="text-ui-xs text-foreground" data-mcp-state="truncated">
            {format("chat.mcpResult.truncatedAfter", {
              count: block.originalChars ?? block.text.length,
            })}
          </p>
        ) : null}
      </div>
    );
  }
  if (block.type === "resource_link") {
    const target = block.title ?? block.name ?? block.uri;
    return (
      <div className="flex flex-col gap-0.5 text-size-chat" data-mcp-content-type="resource_link">
        <div className="break-words text-codex-description/80">
          {format("chat.mcpResult.resource.read", { target })}
        </div>
        {annotations ? (
          <div className="break-words whitespace-pre-wrap text-codex-description/80">
            {annotations}
          </div>
        ) : null}
        {block.truncated ? (
          <p className="text-ui-xs text-foreground" data-mcp-state="truncated">
            {t("chat.mcpResult.truncatedShort")}
          </p>
        ) : null}
      </div>
    );
  }
  if (block.type === "embedded_resource") {
    const body = block.text ?? "";
    const hasBody = body !== "";
    return (
      <div
        className="flex flex-col gap-0.5 text-size-chat text-codex-description/80"
        data-mcp-content-type="embedded_resource"
      >
        {block.uri ? (
          <div className="flex gap-1">
            <span className="font-medium text-default">{labels.uri}</span>
            <span className="break-all">{block.uri}</span>
          </div>
        ) : null}
        {block.mimeType ? (
          <div className="flex gap-1">
            <span className="font-medium text-default">{labels.mimeType}</span>
            <span className="break-all">{block.mimeType}</span>
          </div>
        ) : null}
        {annotations ? (
          <div className="flex gap-1">
            <span className="font-medium text-default">{labels.annotations}</span>
            <span className="break-all">{annotations}</span>
          </div>
        ) : null}
        {hasBody ? (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-default">{labels.content}</span>
            <pre
              tabIndex={0}
              className="max-h-48 overflow-auto rounded-md bg-primary-soft px-3 py-2 whitespace-pre-wrap text-foreground dark:text-foreground/80"
            >
              {body}
            </pre>
          </div>
        ) : null}
        {block.truncated ? (
          <p className="text-ui-xs text-foreground" data-mcp-state="truncated">
            {t("chat.mcpResult.truncatedShort")}
          </p>
        ) : null}
      </div>
    );
  }
  if (block.type === "local_artifact") {
    return (
      <LocalArtifactContentBlock
        block={block}
        annotation={mediaAnnotation(block.annotations, format)}
        imageAlt={labels.imageAlt}
        unavailable={labels.mediaUnavailable}
        {...(onImageExpand ? { onImageExpand } : {})}
      />
    );
  }
  if (block.type === "binary_deferred") {
    return (
      <div
        className="rounded-lg border border-amber-500/35 bg-amber-500/8 px-3 py-2.5 text-ui-xs text-foreground"
        data-mcp-content-type="binary_deferred"
        data-mcp-state="binary-deferred"
      >
        <p className="font-medium">{labels.binaryDeferred}</p>
        {block.mimeType ? <p className="mt-1 break-words">{block.mimeType}</p> : null}
        {block.uri ? <p className="mt-1 break-all">{block.uri}</p> : null}
        <AnnotationLine value={annotations} />
        {block.truncated ? (
          <p className="mt-1" data-mcp-state="truncated">
            {t("chat.mcpResult.truncatedShort")}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <Section title={labels.unknown}>
      <pre tabIndex={0} className={MCP_CODE_CLASS_NAME} data-mcp-content-type="unknown">
        {formatJsonRepresentation(block.json)}
      </pre>
      {block.truncated ? (
        <p className="text-ui-xs text-foreground" data-mcp-state="truncated">
          {t("chat.mcpResult.truncatedShort")}
        </p>
      ) : null}
    </Section>
  );
}

export function McpRawDiagnosticAction() {
  const { t } = useTranslation();
  const rawActionLabel = t("chat.mcpResult.raw.open");
  return (
    <div className="inline-flex w-fit self-start" data-mcp-raw-action-wrapper="true">
      <Tooltip>
        <TooltipTrigger
          delay={0}
          render={
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 transition-opacity group-hover/mcp-tool-result-details:opacity-100 group-focus-within/mcp-tool-result-details:opacity-100 focus-visible:opacity-100"
                  aria-label={rawActionLabel}
                  data-mcp-raw-action="true"
                />
              }
            />
          }
        >
          <CodeIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{rawActionLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function McpRawDiagnosticDialog({
  result,
  trigger,
}: {
  result: WorkLogMcpToolResult;
  trigger: ReactNode;
}) {
  const { format } = useTranslation();
  const diagnostic = {
    callId: result.callId,
    invocation: result.arguments,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.result ? { result: result.result } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  return (
    <Dialog>
      {trigger}
      <DialogPopup className="max-h-[min(86vh,760px)] max-w-3xl gap-0 p-0">
        <DialogHeader className="border-b border-border/55 pr-10">
          <DialogTitle>
            {format("chat.mcpResult.raw.title", {
              server: result.server,
              tool: result.tool,
            })}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="max-h-[min(72vh,620px)] px-4 py-4" data-mcp-raw-dialog="true">
          <McpCodePane
            title="json"
            tabIndex={0}
            showCopyButton
            asPre
            codeContainerClassName="max-h-128"
          >
            {formatMcpJson(diagnostic)}
          </McpCodePane>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The review surface is shared by the generic MCP details and the App card.
 * Callers choose the surrounding padding so the App path can keep the reviews
 * above the embedded app without reintroducing generic invocation/result
 * sections below it.
 */
export function McpAutomaticApprovalReviewContent({ result }: { result: WorkLogMcpToolResult }) {
  const { t } = useTranslation();
  const automaticApprovalReviews = result.automaticApprovalReviews ?? [];
  const deniedReviews = automaticApprovalReviews.filter((review) => review.status === "denied");
  const requiresExplicitAuthorization = result.status === "failed" && deniedReviews.length > 0;
  const hasHighRiskDeniedReview = deniedReviews.some((review) => review.riskLevel === "high");

  return (
    <>
      {automaticApprovalReviews.map((review) => (
        <AutomaticApprovalReviewDetails key={review.reviewId} review={review} />
      ))}
      {requiresExplicitAuthorization ? (
        <p
          className="max-w-[80ch] pt-1 text-size-chat leading-relaxed text-text/60 !text-foreground/70"
          data-mcp-explicit-authorization="true"
        >
          {hasHighRiskDeniedReview
            ? t("localConversation.automaticApprovalReview.explicitAuthorizationHighRisk")
            : t("localConversation.automaticApprovalReview.explicitAuthorization")}
        </p>
      ) : null}
    </>
  );
}

export function McpToolResultDetails({
  result,
  onImageExpand,
}: {
  result: WorkLogMcpToolResult;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { t, format } = useTranslation();
  const labels = {
    plaintext: t("chat.mcpResult.plaintext"),
    resource: t("chat.mcpResult.resource"),
    embedded: t("chat.mcpResult.embedded"),
    unknown: t("chat.mcpResult.unknown"),
    binaryDeferred: t("chat.mcpResult.binaryDeferred"),
    uri: t("chat.mcpResult.embedded.uri"),
    mimeType: t("chat.mcpResult.embedded.mimeType"),
    annotations: t("chat.mcpResult.embedded.annotations"),
    content: t("chat.mcpResult.embedded.content"),
    audience: t("chat.mcpResult.annotation.audience"),
    priority: t("chat.mcpResult.annotation.priority"),
    lastModified: t("chat.mcpResult.annotation.lastModified"),
    imageAlt: t("chat.mcpResult.imageAlt"),
    mediaUnavailable: t("chat.mcpResult.mediaUnavailable"),
  };
  const content = result.result?.content ?? [];
  const structuredContent = result.result?.structuredContent;
  const visibleBlocks = content.filter(
    (block) => !(block.type === "text" && isDuplicateStructuredText(block, structuredContent)),
  );
  const contentBlockKeyCounts = new Map<string, number>();
  const hasResultContent = visibleBlocks.length > 0 || structuredContent !== undefined;
  const hasError = result.error !== undefined;
  return (
    <div
      className="group/mcp-tool-result-details flex min-w-0 max-w-full flex-col gap-0.5"
      data-mcp-tool-result-details="true"
    >
      <McpAutomaticApprovalReviewContent result={result} />

      {result.app ? (
        <Section title={t("chat.mcpResult.invocation")}>
          <pre tabIndex={0} className={MCP_CODE_CLASS_NAME} data-mcp-invocation="true">
            {formatMcpJson(result.arguments)}
          </pre>
        </Section>
      ) : null}

      {visibleBlocks.map((block) => {
        const baseKey = `${block.type}:${formatMcpJson(block)}`;
        const occurrence = contentBlockKeyCounts.get(baseKey) ?? 0;
        contentBlockKeyCounts.set(baseKey, occurrence + 1);
        return (
          <ContentBlockView
            key={`${baseKey}:${occurrence}`}
            block={block}
            labels={labels}
            {...(onImageExpand ? { onImageExpand } : {})}
          />
        );
      })}

      {structuredContent !== undefined ? (
        <McpCodePane title="json" tabIndex={0} data-mcp-content-type="structured">
          {formatMcpJson(structuredContent)}
        </McpCodePane>
      ) : null}

      {hasError ? (
        <Section title={t("chat.mcpResult.error")} tone="danger">
          <div
            className="flex min-w-0 items-start gap-2 rounded-lg border border-rose-500/35 bg-rose-500/8 px-3 py-2.5 text-ui-xs text-rose-800 dark:text-rose-100"
            data-mcp-error="true"
          >
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 break-words">{result.error.message}</p>
          </div>
        </Section>
      ) : null}

      {!hasResultContent && !hasError ? (
        <p className="text-codex-description/80" data-mcp-state="no-content">
          {t("chat.mcpResult.noContent")}
        </p>
      ) : null}

      {result.truncation.truncated ? (
        <p
          className="rounded-lg border border-amber-500/35 bg-amber-500/8 px-3 py-2.5 text-ui-xs text-foreground"
          data-mcp-state="truncated"
        >
          {t("chat.mcpResult.truncated")}
          {result.truncation.omittedBlocks
            ? ` (${format("chat.mcpResult.omittedBlocks", { count: result.truncation.omittedBlocks })})`
            : ""}
        </p>
      ) : null}

      <McpRawDiagnosticDialog result={result} trigger={<McpRawDiagnosticAction />} />
    </div>
  );
}
