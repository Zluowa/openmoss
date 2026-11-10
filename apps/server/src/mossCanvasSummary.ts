// A bounded, read-only description of one conversation's Moss Canvas for agents.
// It reads the same durable Canvas store the embedded editor uses and never
// writes to it: no snapshot, lease-owned file or asset is changed here.
import type { MossMediaIdentity } from "./mossMediaJobsService";
import type { MossCanvasWorkspace } from "./mossCanvasWorkspace";
import { mossCanvasStorageExists, mossCanvasStorageFor } from "./mossCanvasStorage";

const MAX_SHAPES = 60;
const MAX_TEXT = 280;
const MAX_ITEMS = 40;
const MAX_VISITED_RECORDS = 20_000;

export interface MossCanvasShapeSummary {
  readonly type: string;
  readonly text?: string;
  readonly assetName?: string;
  /** For a media card: what it holds and how it was made. */
  readonly media?: {
    readonly kind: string;
    readonly prompt?: string;
    readonly modelId?: string;
    readonly jobId?: string;
    readonly status?: string;
  };
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface MossCanvasMediaItemSummary {
  readonly jobId: string;
  readonly kind: "image" | "video";
  readonly status: string;
  readonly prompt?: string;
  readonly modelId?: string;
  readonly outputs: number;
}

export interface MossCanvasSummary {
  /** False until Canvas or a generation first created this conversation's Canvas. */
  readonly exists: boolean;
  readonly title: string;
  readonly shapeCounts: Readonly<Record<string, number>>;
  readonly shapes: readonly MossCanvasShapeSummary[];
  readonly truncated: boolean;
  /** Generated images/videos from this conversation that Canvas shows. */
  readonly media: readonly MossCanvasMediaItemSummary[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function clip(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > MAX_TEXT ? `${normalized.slice(0, MAX_TEXT - 1)}…` : normalized;
}

/** Plain text from a tldraw rich-text document or a legacy text prop. */
function shapeText(props: Record<string, unknown>): string | undefined {
  if (typeof props.text === "string" && props.text.trim()) return clip(props.text);
  const parts: string[] = [];
  let budget = 2_000;
  const walk = (node: unknown) => {
    if (budget <= 0) return;
    budget -= 1;
    const item = record(node);
    if (!item) return;
    if (typeof item.text === "string") parts.push(item.text);
    if (Array.isArray(item.content)) for (const child of item.content) walk(child);
  };
  walk(props.richText);
  const text = parts.join(" ");
  return text.trim() ? clip(text) : undefined;
}

/**
 * The Canvas editor names its own shapes after the project it came from; agents
 * repeat type names to people, so they read as Moss's.
 */
function shapeTypeName(type: string): string {
  return type.replace(/^hoola-/u, "moss-").slice(0, 40);
}

/** A Canvas media card keeps its page as JSON: what it shows and the job that made it. */
function cardMedia(props: Record<string, unknown>): MossCanvasShapeSummary["media"] | undefined {
  if (typeof props.pageJson !== "string" || props.pageJson.length > 256 * 1024) return undefined;
  let page: Record<string, unknown> | null;
  try {
    page = record(JSON.parse(props.pageJson));
  } catch {
    return undefined;
  }
  if (!page || typeof page.pageType !== "string") return undefined;
  const generation = record(page.imageGeneration) ?? record(page.videoGeneration);
  const prompt =
    typeof page.prompt === "string" && page.prompt.trim()
      ? page.prompt
      : typeof generation?.prompt === "string"
        ? generation.prompt
        : undefined;
  const modelId = typeof generation?.modelId === "string" ? generation.modelId : undefined;
  return {
    kind: page.pageType.toLowerCase().slice(0, 20),
    ...(prompt?.trim() ? { prompt: clip(prompt) } : {}),
    ...(modelId ? { modelId: modelId.slice(0, 128) } : {}),
    ...(typeof page.generationJobId === "string"
      ? { jobId: page.generationJobId.slice(0, 133) }
      : {}),
    ...(typeof page.generationStatus === "string"
      ? { status: page.generationStatus.slice(0, 40) }
      : {}),
  };
}

/**
 * Collect tldraw records from a project snapshot. Snapshots come as
 * `{ store: {...} }`, `{ document: { store: {...} } }` or a record array; the
 * walk is bounded so an unexpected document cannot stall the gateway.
 */
function snapshotRecords(snapshot: unknown): Record<string, unknown>[] {
  const root = record(snapshot);
  const candidates = [
    record(root?.store),
    record(record(root?.document)?.store),
    record(record(root?.snapshot)?.store),
    record(record(record(root?.snapshot)?.document)?.store),
  ];
  const store = candidates.find((candidate) => candidate !== null);
  const values: unknown[] = store
    ? Object.values(store)
    : Array.isArray(root?.records)
      ? (root.records as unknown[])
      : [];
  const records: Record<string, unknown>[] = [];
  for (const value of values.slice(0, MAX_VISITED_RECORDS)) {
    const item = record(value);
    if (item) records.push(item);
  }
  return records;
}

export function summarizeMossCanvasSnapshot(snapshot: unknown): {
  readonly shapeCounts: Readonly<Record<string, number>>;
  readonly shapes: readonly MossCanvasShapeSummary[];
  readonly truncated: boolean;
} {
  const records = snapshotRecords(snapshot);
  const assets = new Map<string, string>();
  for (const item of records) {
    if (item.typeName !== "asset" || typeof item.id !== "string") continue;
    const props = record(item.props);
    const name = typeof props?.name === "string" ? props.name : undefined;
    if (name) assets.set(item.id, clip(name));
  }
  const shapeCounts: Record<string, number> = {};
  const shapes: MossCanvasShapeSummary[] = [];
  let truncated = false;
  for (const item of records) {
    if (item.typeName !== "shape" || typeof item.type !== "string") continue;
    const type = shapeTypeName(item.type);
    shapeCounts[type] = (shapeCounts[type] ?? 0) + 1;
    if (shapes.length >= MAX_SHAPES) {
      truncated = true;
      continue;
    }
    const props = record(item.props) ?? {};
    const card = cardMedia(props);
    const text = shapeText(props);
    const assetName = typeof props.assetId === "string" ? assets.get(props.assetId) : undefined;
    const x = finite(item.x);
    const y = finite(item.y);
    const width = finite(props.w);
    const height = finite(props.h);
    shapes.push({
      type,
      ...(text ? { text } : {}),
      ...(assetName ? { assetName } : {}),
      ...(card ? { media: card } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
  }
  return { shapeCounts, shapes, truncated };
}

export function summarizeMossCanvasConversation(value: unknown): MossCanvasMediaItemSummary[] {
  const items = record(value)?.items;
  if (!Array.isArray(items)) return [];
  const summaries: MossCanvasMediaItemSummary[] = [];
  for (const raw of items.slice(-MAX_ITEMS)) {
    const item = record(raw);
    if (!item || typeof item.jobId !== "string") continue;
    const operation = typeof item.operation === "string" ? item.operation : "";
    summaries.push({
      jobId: item.jobId,
      kind: operation === "video" || item.kind === "video" ? "video" : "image",
      status: typeof item.status === "string" ? item.status : "unknown",
      ...(typeof item.prompt === "string" && item.prompt.trim()
        ? { prompt: clip(item.prompt) }
        : {}),
      ...(typeof item.modelId === "string" ? { modelId: item.modelId } : {}),
      outputs: Array.isArray(item.outputs) ? item.outputs.length : 0,
    });
  }
  return summaries;
}

/** Read this conversation's Canvas. A Canvas that does not exist yet is reported, not created. */
export async function readMossCanvasSummary(input: {
  readonly stateDirectory: string;
  readonly identity: MossMediaIdentity;
  readonly workspace: MossCanvasWorkspace;
}): Promise<MossCanvasSummary> {
  const empty = {
    title: input.workspace.title,
    shapeCounts: {},
    shapes: [],
    truncated: false,
    media: [],
  } satisfies Omit<MossCanvasSummary, "exists">;
  if (!(await mossCanvasStorageExists(input.stateDirectory, input.identity, input.workspace)))
    return { exists: false, ...empty };
  const store = await mossCanvasStorageFor(input.stateDirectory, input.identity, input.workspace);
  const conversation = await store.request("workspace.conversationJobs");
  const active = record(await store.request("projects.active"));
  const relativePath =
    typeof active?.relativePath === "string"
      ? active.relativePath
      : typeof record(conversation)?.relativePath === "string"
        ? (record(conversation)!.relativePath as string)
        : null;
  const project = relativePath
    ? record(await store.request("projects.read", { relativePath }))
    : null;
  const entry = record(project?.entry);
  return {
    exists: true,
    ...empty,
    ...(typeof entry?.title === "string" && entry.title.trim() ? { title: clip(entry.title) } : {}),
    ...summarizeMossCanvasSnapshot(project?.snapshot),
    media: summarizeMossCanvasConversation(conversation),
  };
}
