// Shared by the Node broker and deployable gateway. Parse media once, before
// either adapter can discard an alias, a nested option, or a caller's intent.
import { decodeCanvasInlineImage } from "./canvasInlineImage.ts";

const MEDIA_ARRAYS = new Set([
  "images",
  "imageurls",
  "imagelist",
  "imagewithroles",
  "referenceimages",
  "referencepaths",
  "subjectreferenceimages",
  "referencevideos",
  "referencevideourls",
  "referencevideodurations",
  "referenceaudios",
  "referenceaudiourls",
  "referenceaudiodurations",
  "referencecardids",
  "videourls",
  "videolist",
  "audiourls",
  "inputassetids",
  "content",
  "media",
  "elements",
  "storyboard",
]);
const MEDIA_URLS = new Set([
  "image",
  "imageurl",
  "video",
  "videourl",
  "audio",
  "audiourl",
  "startframe",
  "startframeurl",
  "endframe",
  "endframeurl",
  "firstframe",
  "firstframeurl",
  "lastframe",
  "lastframeurl",
  "tailimage",
  "sourcevideo",
  "sourcevideourl",
  "referencevideo",
  "referenceaudio",
  "motioncontrolimageurl",
  "motioncontrolvideourl",
]);
const VIDEO_MODES: Readonly<Record<string, readonly string[]>> = {
  generationmode: ["normal", "standard"],
  klingomnimode: ["none"],
  wanxiang27mode: ["auto"],
  seedancemode: ["standard"],
};
const VIDEO_SWITCHES = new Set([
  "motioncontrolenabled",
  "keeporiginalsound",
  "hasinputvideo",
  "watermark",
  "isprivate",
]);
const VIDEO_CONTAINERS = new Set([
  "motioncontrol",
  "videoreference",
  "seedance",
  "wanxiang27",
  "advanced",
  "videooptions",
]);

export type CanvasVideoInputError = "invalid_video_options" | "unsupported_video_options";

export interface CanvasVideoInputPolicy {
  readonly modelId?: string;
  /** Only the CLI file reader may consume local paths before broker creation. */
  readonly allowLocalReferencePaths?: boolean;
}

export type CanvasVideoMode =
  | "normal"
  | "first-frame"
  | "last-frame"
  | "start-end"
  | "reference"
  | "video-edit";

export interface CanvasVideoInput {
  readonly generationMode: CanvasVideoMode;
  readonly startFrameUrl?: string;
  readonly endFrameUrl?: string;
  readonly referenceImages: readonly string[];
  readonly referencePaths: readonly string[];
  readonly referenceVideos: readonly string[];
  readonly referenceVideoDurations: readonly number[];
  readonly referenceAudios: readonly string[];
  readonly referenceAudioDurations: readonly number[];
  readonly sourceVideoUrl?: string;
  readonly sourceVideoDuration?: number;
}

const WAN_MODELS = new Set(["wan3.0-video", "wan3.0-video-prime"]);
const H3_MODELS = new Set(["MiniMax-H3", "MiniMax-H3-Max"]);
const REFERENCE_MODELS = new Set([
  ...WAN_MODELS,
  ...H3_MODELS,
  "doubao-seedance-2.5",
  "happyhorse",
  "happyhorse-video-edit",
]);

/** One model limit shared by browser/native admission and local file promotion. */
export function canvasVideoReferenceImageLimit(modelId: string): number {
  if (modelId === "doubao-seedance-2.5") return 30;
  if (WAN_MODELS.has(modelId)) return 10;
  if (modelId === "happyhorse-video-edit") return 5;
  return H3_MODELS.has(modelId) || modelId === "happyhorse" ? 9 : 0;
}
const ROOT_MEDIA_KEYS = new Set([
  "startframe",
  "startframeurl",
  "firstframe",
  "firstframeurl",
  "endframe",
  "endframeurl",
  "lastframe",
  "lastframeurl",
  "referenceimages",
  "referencepaths",
  "referencevideos",
  "referencevideourls",
  "referencevideodurations",
  "referenceaudios",
  "referenceaudiourls",
  "referenceaudiodurations",
  "sourcevideo",
  "sourcevideourl",
  "sourcevideoduration",
]);

function normalizedKey(name: string): string {
  return name.replaceAll("_", "").toLowerCase();
}

function invalidVideo(): never {
  throw new Error("invalid_video_options");
}

function unsupportedVideo(): never {
  throw new Error("unsupported_video_options");
}

function alias(input: Record<string, unknown>, keys: readonly string[]): unknown {
  const values = Object.entries(input)
    .filter(([key, value]) => value !== undefined && keys.includes(normalizedKey(key)))
    .map(([, value]) => (typeof value === "string" ? value.trim() : value));
  if (values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]))) invalidVideo();
  return values[0];
}

function mediaUrl(value: unknown, image: boolean): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 7 * 1024 * 1024) invalidVideo();
  const url = value.trim();
  if (!url) return undefined;
  if (image && url.startsWith("data:")) {
    try {
      const decoded = decodeCanvasInlineImage(url);
      if (!["image/png", "image/jpeg", "image/webp"].includes(decoded.mimeType)) invalidVideo();
      const bytes = decoded.bytes;
      const signature =
        decoded.mimeType === "image/png"
          ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
          : decoded.mimeType === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
              new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
      if (!signature) invalidVideo();
    } catch {
      invalidVideo();
    }
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || url.length > 4096)
      invalidVideo();
  } catch {
    invalidVideo();
  }
  return url;
}

function mediaUrls(value: unknown, image: boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidVideo();
  return value.map((item) => mediaUrl(item, image) ?? invalidVideo());
}

function durations(value: unknown, count: number, minimum: number, maximum: number): number[] {
  if (count === 0 && value === undefined) return [];
  if (!Array.isArray(value) || value.length !== count) invalidVideo();
  const result = value.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item) || item < minimum || item > maximum)
      invalidVideo();
    return item;
  });
  if (result.reduce((total, item) => total + item, 0) > maximum) invalidVideo();
  return result;
}

/** Canonical, bounded references shared by every admission and provider path. */
export function normalizeCanvasVideoInput(
  input: Record<string, unknown>,
  modelId: string,
  allowLocalReferencePaths = false,
): CanvasVideoInput {
  const supported = REFERENCE_MODELS.has(modelId);
  const error = scanCanvasVideoInput(input, supported);
  if (error) throw new Error(error);
  const startFrameUrl = mediaUrl(
    alias(input, ["startframe", "startframeurl", "firstframe", "firstframeurl"]),
    true,
  );
  const endFrameUrl = mediaUrl(
    alias(input, ["endframe", "endframeurl", "lastframe", "lastframeurl"]),
    true,
  );
  const referenceImages = mediaUrls(alias(input, ["referenceimages"]), true);
  const paths = alias(input, ["referencepaths"]);
  if (
    paths !== undefined &&
    (!Array.isArray(paths) ||
      paths.some(
        (item) =>
          typeof item !== "string" || !item.trim() || item.length > 4096 || item.includes("\0"),
      ))
  )
    invalidVideo();
  const referencePaths = (paths as string[] | undefined)?.map((item) => item.trim()) ?? [];
  if (referencePaths.length && !allowLocalReferencePaths) unsupportedVideo();
  const referenceVideos = mediaUrls(alias(input, ["referencevideos", "referencevideourls"]), false);
  const referenceAudios = mediaUrls(alias(input, ["referenceaudios", "referenceaudiourls"]), false);
  const sourceVideoUrl = mediaUrl(alias(input, ["sourcevideo", "sourcevideourl"]), false);
  const sourceDuration = alias(input, ["sourcevideoduration"]);
  if (
    sourceDuration !== undefined &&
    (typeof sourceDuration !== "number" || !Number.isFinite(sourceDuration))
  )
    invalidVideo();
  const sourceVideoDuration = sourceDuration as number | undefined;
  const seedance = modelId === "doubao-seedance-2.5";
  const maxSeconds = seedance ? 30 : 15;
  const referenceVideoDurations = durations(
    alias(input, ["referencevideodurations"]),
    referenceVideos.length,
    WAN_MODELS.has(modelId) ? 1 : 2,
    maxSeconds,
  );
  const referenceAudioDurations = durations(
    alias(input, ["referenceaudiodurations"]),
    referenceAudios.length,
    WAN_MODELS.has(modelId) ? 1 : 2,
    maxSeconds,
  );
  const imageCount = referenceImages.length + referencePaths.length;
  const referenceCount = imageCount + referenceVideos.length + referenceAudios.length;
  const maxImages = canvasVideoReferenceImageLimit(modelId);
  const maxVideos = seedance ? 10 : WAN_MODELS.has(modelId) ? 5 : 3;
  const maxAudios = seedance ? 10 : WAN_MODELS.has(modelId) ? 5 : 3;
  if (
    imageCount > maxImages ||
    referenceVideos.length > maxVideos ||
    referenceAudios.length > maxAudios ||
    (H3_MODELS.has(modelId) && referenceCount > 12)
  )
    invalidVideo();
  // H3's all-modal reference mode requires a visual asset with audio. Keep
  // native/CLI admission consistent with the original Canvas model contract.
  // https://www.minimax.cn/news/minimax-h3-open-source
  if (
    H3_MODELS.has(modelId) &&
    referenceAudios.length > 0 &&
    !imageCount &&
    !referenceVideos.length
  )
    invalidVideo();
  if (!supported && (startFrameUrl || endFrameUrl || referenceCount || sourceVideoUrl))
    unsupportedVideo();
  if ((startFrameUrl || endFrameUrl) && referenceCount) invalidVideo();
  if (endFrameUrl && !startFrameUrl && !H3_MODELS.has(modelId)) invalidVideo();
  if (
    modelId === "happyhorse" &&
    (endFrameUrl || referenceVideos.length || referenceAudios.length || sourceVideoUrl)
  )
    unsupportedVideo();
  if (modelId !== "happyhorse-video-edit" && (sourceVideoUrl || sourceVideoDuration !== undefined))
    unsupportedVideo();
  if (
    modelId === "happyhorse-video-edit" &&
    (!sourceVideoUrl ||
      sourceVideoDuration === undefined ||
      sourceVideoDuration < 3 ||
      sourceVideoDuration > 60 ||
      startFrameUrl ||
      endFrameUrl ||
      referenceVideos.length ||
      referenceAudios.length)
  )
    invalidVideo();
  const inferred: CanvasVideoMode = sourceVideoUrl
    ? "video-edit"
    : startFrameUrl && endFrameUrl
      ? "start-end"
      : startFrameUrl
        ? "first-frame"
        : endFrameUrl
          ? "last-frame"
          : referenceCount
            ? "reference"
            : "normal";
  const rawMode = alias(input, ["generationmode"]);
  const mode =
    rawMode === "all-reference" ? "reference" : rawMode === "standard" ? "normal" : rawMode;
  if (mode !== undefined && mode !== inferred) invalidVideo();
  const encodedSize = [startFrameUrl, endFrameUrl, ...referenceImages].reduce(
    (sum, item) => sum + (item?.length ?? 0),
    0,
  );
  if (encodedSize > 7 * 1024 * 1024) invalidVideo();
  return {
    generationMode: inferred,
    ...(startFrameUrl ? { startFrameUrl } : {}),
    ...(endFrameUrl ? { endFrameUrl } : {}),
    referenceImages,
    referencePaths,
    referenceVideos,
    referenceVideoDurations,
    referenceAudios,
    referenceAudioDurations,
    ...(sourceVideoUrl && sourceVideoDuration !== undefined
      ? { sourceVideoUrl, sourceVideoDuration }
      : {}),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canvasVideoInputError(
  input: Record<string, unknown>,
  policy: CanvasVideoInputPolicy = {},
): CanvasVideoInputError | undefined {
  if (!policy.modelId) return scanCanvasVideoInput(input, false);
  try {
    normalizeCanvasVideoInput(input, policy.modelId, policy.allowLocalReferencePaths);
    return undefined;
  } catch (error) {
    return error instanceof Error && error.message === "unsupported_video_options"
      ? "unsupported_video_options"
      : "invalid_video_options";
  }
}

function scanCanvasVideoInput(
  input: Record<string, unknown>,
  supportsReferences: boolean,
): CanvasVideoInputError | undefined {
  function visit(value: Record<string, unknown>, depth: number): CanvasVideoInputError | undefined {
    if (depth > 16) return "invalid_video_options";
    for (const [name, option] of Object.entries(value)) {
      if (option === undefined) continue;
      // The original Canvas contracts use both camelCase and snake_case.
      const key = normalizedKey(name);
      if (supportsReferences && depth === 0 && ROOT_MEDIA_KEYS.has(key)) {
        // The canonical parser consumes every allowed root field below.
      } else if (MEDIA_ARRAYS.has(key)) {
        if (!Array.isArray(option)) return "invalid_video_options";
        if (option.length) return "unsupported_video_options";
      } else if (MEDIA_URLS.has(key)) {
        if (option !== null && typeof option !== "string") return "invalid_video_options";
        if (typeof option === "string" && option.trim()) return "unsupported_video_options";
      } else if (Object.hasOwn(VIDEO_MODES, key)) {
        if (typeof option !== "string") return "invalid_video_options";
        if (
          key === "generationmode" &&
          supportsReferences &&
          depth === 0 &&
          [
            "normal",
            "standard",
            "first-frame",
            "last-frame",
            "start-end",
            "reference",
            "all-reference",
            "video-edit",
          ].includes(option)
        ) {
          // The canonical parser checks that the declared mode matches media.
        } else if (!VIDEO_MODES[key]!.includes(option)) return "unsupported_video_options";
      } else if (["mode", "omnireferencetasktype", "characterorientation"].includes(key)) {
        if (typeof option !== "string") return "invalid_video_options";
        return "unsupported_video_options";
      } else if (
        ["count", "n", "inputvideoseconds", "inputvideoduration", "inputimagecount"].includes(key)
      ) {
        if (typeof option !== "number" || !Number.isFinite(option)) return "invalid_video_options";
        if (option !== (key === "count" || key === "n" ? 1 : 0)) return "unsupported_video_options";
      } else if (VIDEO_SWITCHES.has(key)) {
        if (typeof option !== "boolean") return "invalid_video_options";
        if (option) return "unsupported_video_options";
      } else if (VIDEO_CONTAINERS.has(key)) {
        if (key === "motioncontrol" && typeof option === "boolean") {
          if (option) return "unsupported_video_options";
          continue;
        }
        if (!record(option)) return "invalid_video_options";
        // Empty/disabled defaults are harmless; provider-specific options are
        // unsupported even if no reference URL accompanies them.
        if (Object.entries(option).some(([field, item]) => field !== "enabled" || item !== false))
          return "unsupported_video_options";
      } else if (["generateaudio", "promptextend"].includes(key)) {
        if (typeof option !== "boolean") return "invalid_video_options";
      } else if (key === "metadata" && !record(option)) {
        return "invalid_video_options";
      }
      // Legacy Canvas may carry video options inside metadata or another
      // nested object. Inspect those too before the broker drops the envelope.
      if (record(option)) {
        const error = visit(option, depth + 1);
        if (error) return error;
      }
    }
    return undefined;
  }
  return visit(input, 0);
}
