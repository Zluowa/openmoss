// FILE: McpToolResultDetails.tsx
// Purpose: Render the bounded, non-app MCP result projection on the shared parts: each block a
//          card (code in the 13 px code role), notes as one muted line, an error as one line in
//          the error colour, images at the card radius.
// Layer: Chat presentation component
// Exports: McpToolResultDetails

import { type ReactNode, useState } from "react";

import type { McpProjectionAnnotations, McpToolResultContentBlock } from "@moss/contracts";
import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { HitArea } from "~/components/ui/hit-area";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
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
import { resolveAttachmentPreviewUrl } from "~/lib/wsHttpUrl";
import { McpCodePane } from "./McpCodePane";

/** A code block inside a card: the 13 px code role, scrolling when long. */
const MCP_CODE_CLASS_NAME =
  "m-0 max-h-[min(46vh,30rem)] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-chat-code text-chat-code text-foreground";
/** A note under a block (annotation, truncation, no content): one muted footnote line. */
const MCP_NOTE_CLASS_NAME = "break-words text-ui-sm text-muted-foreground";

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

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-ui-gap-xs" data-mcp-section={props.title}>
      <h3 className="text-ui-sm text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function AnnotationLine({ value }: { value: string | null }) {
  return value ? <p className={MCP_NOTE_CLASS_NAME}>{value}</p> : null;
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
  // The thread's attachment route; a shared conversation's guest page loads it through the share.
  const src = resolveAttachmentPreviewUrl(block.attachmentId);
  if (failed) {
    return (
      <div
        className={MCP_NOTE_CLASS_NAME}
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
      className="max-h-48 w-max max-w-full rounded-card border border-[color:var(--color-border)] object-contain"
      alt={imageAlt}
      src={src}
      onError={() => setFailed(true)}
    />
  );
  const content =
    block.mediaKind === "image" ? (
      onImageExpand ? (
        <HitArea
          type="button"
          className="block w-fit max-w-full cursor-zoom-in rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={imageAlt}
          onClick={activateImage}
        >
          {image}
        </HitArea>
      ) : (
        image
      )
    ) : (
      <audio
        className="w-full"
        controls
        src={src}
        preload="metadata"
        onError={() => setFailed(true)}
      />
    );
  return (
    <div
      className="flex flex-col gap-ui-gap-xs"
      data-mcp-content-type="local_artifact"
      data-mcp-state="available"
      data-mcp-attachment-id={block.attachmentId}
      data-mcp-media-kind={block.mediaKind}
      data-mcp-size-bytes={String(block.sizeBytes)}
      data-mcp-truncated={block.truncated ? "true" : "false"}
    >
      {content}
      {annotation ? (
        <p className={cn(MCP_NOTE_CLASS_NAME, "whitespace-pre-wrap")}>{annotation}</p>
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
      <div className="flex flex-col gap-ui-gap-xs">
        <Card className="contain-inline-size">
          <div className="truncate px-3 pt-2 text-ui-sm text-muted-foreground select-none">
            {labels.plaintext}
          </div>
          <div className="max-h-48 overflow-y-auto px-3 pt-1 pb-2">
            <pre
              tabIndex={0}
              className="m-0 whitespace-pre-wrap break-words font-sans text-ui text-muted-foreground"
              data-mcp-content-type="text"
            >
              {block.text}
            </pre>
          </div>
        </Card>
        <AnnotationLine value={annotations} />
        {block.truncated ? (
          <p className={MCP_NOTE_CLASS_NAME} data-mcp-state="truncated">
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
      <div className="flex flex-col gap-ui-gap-xs" data-mcp-content-type="resource_link">
        <div className={MCP_NOTE_CLASS_NAME}>
          {format("chat.mcpResult.resource.read", { target })}
        </div>
        {annotations ? (
          <div className={cn(MCP_NOTE_CLASS_NAME, "whitespace-pre-wrap")}>{annotations}</div>
        ) : null}
        {block.truncated ? (
          <p className={MCP_NOTE_CLASS_NAME} data-mcp-state="truncated">
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
        className="flex flex-col gap-ui-gap-xs text-ui-sm text-muted-foreground"
        data-mcp-content-type="embedded_resource"
      >
        {block.uri ? (
          <div className="flex gap-1">
            <span className="font-medium text-foreground">{labels.uri}</span>
            <span className="break-all">{block.uri}</span>
          </div>
        ) : null}
        {block.mimeType ? (
          <div className="flex gap-1">
            <span className="font-medium text-foreground">{labels.mimeType}</span>
            <span className="break-all">{block.mimeType}</span>
          </div>
        ) : null}
        {annotations ? (
          <div className="flex gap-1">
            <span className="font-medium text-foreground">{labels.annotations}</span>
            <span className="break-all">{annotations}</span>
          </div>
        ) : null}
        {hasBody ? (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground">{labels.content}</span>
            <Card>
              <pre tabIndex={0} className={cn(MCP_CODE_CLASS_NAME, "max-h-48")}>
                {body}
              </pre>
            </Card>
          </div>
        ) : null}
        {block.truncated ? (
          <p className={MCP_NOTE_CLASS_NAME} data-mcp-state="truncated">
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
        className="flex flex-col gap-0.5 text-ui-sm text-muted-foreground"
        data-mcp-content-type="binary_deferred"
        data-mcp-state="binary-deferred"
      >
        <p>{labels.binaryDeferred}</p>
        {block.mimeType ? <p className="break-words">{block.mimeType}</p> : null}
        {block.uri ? <p className="break-all">{block.uri}</p> : null}
        <AnnotationLine value={annotations} />
        {block.truncated ? (
          <p data-mcp-state="truncated">{t("chat.mcpResult.truncatedShort")}</p>
        ) : null}
      </div>
    );
  }
  return (
    <Section title={labels.unknown}>
      <Card>
        <pre tabIndex={0} className={MCP_CODE_CLASS_NAME} data-mcp-content-type="unknown">
          {formatJsonRepresentation(block.json)}
        </pre>
      </Card>
      {block.truncated ? (
        <p className={MCP_NOTE_CLASS_NAME} data-mcp-state="truncated">
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
          <CodeIcon />
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
          className="max-w-[80ch] pt-1 text-ui-sm text-muted-foreground"
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
  // Codex sends every optional field, so a tool without structured content arrives as
  // `structuredContent: null`; that is "none", not a JSON value worth a code pane.
  const structuredContent = result.result?.structuredContent ?? undefined;
  const visibleBlocks = content.filter(
    (block) => !(block.type === "text" && isDuplicateStructuredText(block, structuredContent)),
  );
  const contentBlockKeyCounts = new Map<string, number>();
  const hasResultContent = visibleBlocks.length > 0 || structuredContent !== undefined;
  const hasError = result.error !== undefined;
  return (
    <div
      className="group/mcp-tool-result-details flex min-w-0 max-w-full flex-col gap-ui-gap-xs"
      data-mcp-tool-result-details="true"
    >
      <McpAutomaticApprovalReviewContent result={result} />

      {result.app ? (
        <Section title={t("chat.mcpResult.invocation")}>
          <Card>
            <pre tabIndex={0} className={MCP_CODE_CLASS_NAME} data-mcp-invocation="true">
              {formatMcpJson(result.arguments)}
            </pre>
          </Card>
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
        <div
          className="flex min-w-0 items-start gap-ui-gap-xs text-ui-sm text-destructive"
          data-mcp-error="true"
        >
          <CircleAlertIcon aria-hidden className="mt-0.5 size-ui-icon-sm shrink-0" />
          <p className="min-w-0 break-words">
            <span className="sr-only">{t("chat.mcpResult.error")}: </span>
            {result.error.message}
          </p>
        </div>
      ) : null}

      {!hasResultContent && !hasError ? (
        <p className={MCP_NOTE_CLASS_NAME} data-mcp-state="no-content">
          {t("chat.mcpResult.noContent")}
        </p>
      ) : null}

      {result.truncation.truncated ? (
        <p className={MCP_NOTE_CLASS_NAME} data-mcp-state="truncated">
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
