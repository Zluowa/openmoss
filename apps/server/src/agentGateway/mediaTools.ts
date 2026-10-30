// Official media tools share the Images workspace service and account authority.
// No provider secret or account bearer is ever passed to a CLI process or tool result.
import { Effect } from "effect";
import {
  canvasVideoInputError,
  canvasVideoReferenceImageLimit,
  normalizeCanvasVideoInput,
} from "../../../../supabase/functions/moss-model-gateway/canvasVideoInput.ts";
import { hoolaCanvasModelKind } from "../hoolaCanvasBridge";
import { readWorkspaceMediaEditFiles, readWorkspaceMediaReferences } from "./mediaReferenceFiles";
import { mediaImageEditInputError } from "../mediaImageEditInput";
import {
  mediaAccountScope,
  MossMediaJobsError,
  type MossMediaCredential,
  type MossMediaJobsService,
} from "../mossMediaJobsService";
import { mcpToolResultJson, type McpToolCallResult } from "./protocol";
import { GatewayToolError, type ToolContext, type ToolEntry } from "./toolRuntime";

export const MOSS_MEDIA_TOOL_NAMES = [
  "moss_canvas_open",
  "moss_media_list",
  "moss_media_generate",
  "moss_media_get",
] as const;
const MAX_REFERENCE_CHARS = 7 * 1024 * 1024;
const GENERATE_KEYS = new Set([
  "modelId",
  "prompt",
  "idempotencyKey",
  "referenceImages",
  "referencePaths",
  "startFrameUrl",
  "endFrameUrl",
  "generationMode",
  "referenceVideos",
  "referenceVideoDurations",
  "referenceAudios",
  "referenceAudioDurations",
  "sourceVideoUrl",
  "sourceVideoDuration",
  "maskPath",
  "background",
  "outputFormat",
  "aspectRatio",
  "resolution",
  "duration",
  "generateAudio",
  "promptExtend",
]);

function invalid(): never {
  throw new MossMediaJobsError("invalid_request");
}

function threadProjectId(context: ToolContext): string {
  // The gateway binds this principal to the provider session. Keep the stable
  // thread id across turns/restarts, never a model-supplied project or session id.
  return `thread:${context.principal.threadId}`;
}
function readGenerateInput(
  args: Record<string, unknown>,
): Record<string, unknown> & { modelId: string; prompt: string; idempotencyKey: string } {
  if (Object.keys(args).some((key) => !GENERATE_KEYS.has(key))) invalid();
  const { modelId, prompt, idempotencyKey } = args;
  if (
    typeof modelId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(modelId) ||
    typeof prompt !== "string" ||
    !prompt.trim() ||
    prompt.trim().length > 8_000 ||
    typeof idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(idempotencyKey)
  )
    invalid();
  const isVideo = hoolaCanvasModelKind(modelId) === "video";
  const maximumReferences = isVideo ? canvasVideoReferenceImageLimit(modelId) : 4;
  if (isVideo) {
    const error = canvasVideoInputError(args, {
      modelId,
      allowLocalReferencePaths: true,
    });
    if (error) throw new MossMediaJobsError(error);
  }
  if (args.referenceImages !== undefined) {
    if (!Array.isArray(args.referenceImages) || args.referenceImages.length > maximumReferences)
      invalid();
    let total = 0;
    for (const reference of args.referenceImages) {
      if (typeof reference !== "string") invalid();
      total += reference.length;
      if (total > MAX_REFERENCE_CHARS) invalid();
      if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(reference)) continue;
      try {
        const url = new URL(reference);
        if (url.protocol !== "https:" || url.username || url.password) invalid();
      } catch {
        invalid();
      }
    }
  }
  if (
    args.referencePaths !== undefined &&
    (!Array.isArray(args.referencePaths) ||
      args.referencePaths.length > maximumReferences ||
      args.referencePaths.some(
        (value) =>
          typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0"),
      ))
  )
    invalid();
  if (
    (Array.isArray(args.referencePaths) ? args.referencePaths.length : 0) +
      (Array.isArray(args.referenceImages) ? args.referenceImages.length : 0) >
    maximumReferences
  )
    invalid();
  if (
    args.maskPath !== undefined &&
    (typeof args.maskPath !== "string" ||
      !args.maskPath.trim() ||
      args.maskPath.length > 4096 ||
      args.maskPath.includes("\0"))
  )
    invalid();
  if (
    (args.background !== undefined &&
      (typeof args.background !== "string" ||
        !["auto", "opaque", "transparent"].includes(args.background))) ||
    (args.outputFormat !== undefined &&
      (typeof args.outputFormat !== "string" ||
        !["png", "jpeg", "webp"].includes(args.outputFormat))) ||
    (args.background === "transparent" && args.outputFormat === "jpeg")
  )
    invalid();
  for (const key of ["aspectRatio", "resolution"] as const) {
    const value = args[key];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        !value.trim() ||
        value.length > (key === "resolution" ? 16 : 32))
    )
      invalid();
  }
  if (
    args.duration !== undefined &&
    (!Number.isInteger(args.duration) || Number(args.duration) < 1 || Number(args.duration) > 30)
  )
    invalid();
  for (const key of ["generateAudio", "promptExtend"] as const) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") invalid();
  }
  return {
    ...args,
    ...(isVideo ? normalizeCanvasVideoInput(args, modelId, true) : {}),
    modelId,
    prompt: prompt.trim(),
    idempotencyKey,
  };
}

function failure(error: unknown): McpToolCallResult {
  // Service errors have safe codes. Do not return exception strings which can contain
  // request URLs, credentials, provider payloads or filesystem paths.
  const code =
    error instanceof MossMediaJobsError || error instanceof GatewayToolError
      ? error.code
      : "media_request_failed";
  return {
    ...mcpToolResultJson({
      error: {
        code,
        message:
          code === "media_account_changed"
            ? "The active Moss account changed during this turn. Start a new user turn before generating media."
            : code === "authentication_required"
              ? "Sign in to a Moss account to use official media skills."
              : code === "media_skill_not_installed"
                ? "Install and enable this official model skill in the Moss plugin marketplace."
                : "The media request did not complete. Check moss_media_list and the job state before retrying. Reuse the same idempotencyKey for the same request.",
      },
    }),
    isError: true,
  };
}

export interface AgentGatewayMediaToolsInput {
  readonly service: Pick<MossMediaJobsService, "list" | "create" | "check"> &
    Partial<Pick<MossMediaJobsService, "readOwnedJob">>;
  readonly resolveCredential: Effect.Effect<MossMediaCredential, unknown>;
  readonly resolveWorkspaceRoot?: (context: ToolContext) => Effect.Effect<string | null>;
  readonly openCanvas?: (
    request: { threadId: string; jobId?: string; imageIndex?: number },
    context: ToolContext,
  ) => Effect.Effect<void, unknown>;
}

export function makeAgentGatewayMediaTools(
  input: AgentGatewayMediaToolsInput,
): readonly ToolEntry[] {
  // An authenticated provider session may advance to another user turn, but a
  // tool call never silently changes its billing account within the same turn.
  const leases = new Map<string, { readonly turnId: string; readonly scope: string }>();
  const credentialFor = (context: ToolContext) =>
    Effect.gen(function* () {
      yield* context.assertCallerTurnActive();
      if (!context.callerTurnId)
        return yield* Effect.fail(
          new GatewayToolError("active_turn_required", "An active user turn is required."),
        );
      const credential = yield* input.resolveCredential;
      yield* context.assertCallerTurnActive();
      const scope = yield* Effect.try({
        try: () => mediaAccountScope(credential),
        catch: (error) => error,
      });
      const previous = leases.get(context.callerSessionKey);
      if (previous?.turnId === context.callerTurnId && previous.scope !== scope) {
        return yield* Effect.fail(new MossMediaJobsError("media_account_changed", 409));
      }
      // Never evict a live session's binding and accidentally allow it to rebind.
      if (!previous && leases.size >= 4096)
        return yield* Effect.fail(new MossMediaJobsError("media_session_capacity", 503));
      leases.set(context.callerSessionKey, { turnId: context.callerTurnId, scope });
      return credential;
    });
  const guarded = (effect: Effect.Effect<McpToolCallResult, unknown>) =>
    effect.pipe(
      Effect.catch((error) => Effect.succeed(failure(error))),
      Effect.catchDefect((error) => Effect.succeed(failure(error))),
    );
  return [
    {
      definition: {
        name: "moss_canvas_open",
        description:
          "Open the complete Moss Canvas for this caller conversation only when the user explicitly asks to open Canvas or edit an image there. Ordinary image generation stays in the Images/chat flow and never opens Canvas automatically. Optional jobId must be an existing image in this caller thread; imageIndex selects its output. Opening performs no supplier generation or payment and preserves the conversation folder.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: {
              type: "string",
              description:
                "Existing image job returned by moss_media_list or moss_media_generate in this caller thread.",
            },
            imageIndex: { type: "integer", minimum: 0, maximum: 31 },
          },
          additionalProperties: false,
        },
      },
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      handler: (args, context) =>
        guarded(
          Effect.gen(function* () {
            if (
              Object.keys(args).some((key) => !["jobId", "imageIndex"].includes(key)) ||
              (args.jobId !== undefined &&
                (typeof args.jobId !== "string" ||
                  !/^moss_[A-Za-z0-9_-]{1,128}$/u.test(args.jobId))) ||
              (args.imageIndex !== undefined &&
                (args.jobId === undefined ||
                  typeof args.imageIndex !== "number" ||
                  !Number.isInteger(args.imageIndex) ||
                  args.imageIndex < 0 ||
                  args.imageIndex > 31))
            )
              return yield* Effect.fail(new MossMediaJobsError("invalid_request"));
            const credential = yield* credentialFor(context);
            if (!input.openCanvas)
              return yield* Effect.fail(new MossMediaJobsError("canvas_host_unavailable", 503));
            if (args.jobId !== undefined) {
              if (!input.service.readOwnedJob)
                return yield* Effect.fail(new MossMediaJobsError("canvas_host_unavailable", 503));
              const job = yield* Effect.tryPromise({
                try: () => input.service.readOwnedJob!(args.jobId as string, credential),
                catch: (error) => error,
              });
              if (
                job.projectId !== threadProjectId(context) ||
                job.operation === "video" ||
                !job.imageUrls[Number(args.imageIndex ?? 0)]
              )
                return yield* Effect.fail(new MossMediaJobsError("job_not_found", 404));
            }
            yield* credentialFor(context);
            yield* input.openCanvas(
              {
                threadId: context.callerThreadId,
                ...(args.jobId !== undefined
                  ? { jobId: args.jobId as string, imageIndex: Number(args.imageIndex ?? 0) }
                  : {}),
              },
              context,
            );
            return mcpToolResultJson({
              opened: true,
              threadId: context.callerThreadId,
              supplierRequests: 0,
            });
          }),
        ),
    },
    {
      definition: {
        name: "moss_media_list",
        description:
          "List installed official image/video models, current availability/pricing and persisted media jobs created in this caller thread. Use this before generation; choose an installed, available model. Account details, wallet balance, other threads' jobs and provider credentials are not exposed. The owner can view all media history in the Images workspace.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      requiredCapability: "thread:read",
      requiresActiveTurn: true,
      handler: (args, context) =>
        guarded(
          Effect.gen(function* () {
            if (Object.keys(args).length)
              return yield* Effect.fail(new MossMediaJobsError("invalid_request"));
            const credential = yield* credentialFor(context);
            const result = yield* Effect.tryPromise({
              try: () => input.service.list(credential),
              catch: (error) => error,
            });
            // Recheck account/turn before exposing a response after a network wait.
            yield* credentialFor(context);
            return mcpToolResultJson({
              models: result.models,
              jobs: result.jobs.filter((job) => job.projectId === threadProjectId(context)),
              ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            });
          }),
        ),
    },
    {
      definition: {
        name: "moss_media_generate",
        description:
          "Generate or edit an image/video with an installed official model using the current Moss account's shared package allowance at actual supplier cost. Call only when the user requests this generation. Read moss_media_list first. Supply a unique idempotencyKey for each intended generation. Unknown outcomes must be observed through the existing job and records; never automatically submit another generation. Returns a queued job immediately; poll moss_media_get (about every 15 seconds) for outputs. Media is saved automatically to the caller conversation workspace and its Canvas. Completed images appear automatically in the conversation gallery; do not emit duplicate Markdown images or download/copy the outputs again. For edits pass the selected original HTTPS output URL in referenceImages, or local image files inside the caller workspace in referencePaths (no base64 needed). Never request, print, or pass an API key. Account changes during a turn require a new user turn.",
        inputSchema: {
          type: "object",
          properties: {
            modelId: { type: "string", minLength: 2, maxLength: 128 },
            prompt: { type: "string", minLength: 1, maxLength: 8_000 },
            idempotencyKey: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              description:
                "Stable unique key for this intended generation. Reuse on retries; change only for a new generation.",
            },
            referenceImages: {
              type: "array",
              maxItems: 30,
              items: { type: "string" },
              description:
                "HTTPS output/reference URLs or PNG/JPEG/WebP base64 data URLs; total encoded content <= 7 MiB.",
            },
            referencePaths: {
              type: "array",
              maxItems: 30,
              items: { type: "string", maxLength: 4096 },
              description:
                "Explicit PNG/JPEG/WebP files inside the caller thread workspace; model-specific limit (Seedance 2.5:30, Wan3:10, H3/HappyHorse:9, HappyHorse edit:5, image models:4) and combined local bytes <= 5 MiB. Paths outside that workspace and symbolic-link files are rejected.",
            },
            startFrameUrl: {
              type: "string",
              maxLength: 8 * 1024 * 1024,
              description:
                "First frame for Wan 3, Seedance 2.5, MiniMax H3/H3 Max, or HappyHorse. HTTPS or bounded PNG/JPEG/WebP data URL. First/last frames cannot mix with reference images/video/audio.",
            },
            endFrameUrl: {
              type: "string",
              maxLength: 8 * 1024 * 1024,
              description:
                "Last frame for Wan 3, Seedance 2.5, or MiniMax H3/H3 Max. MiniMax also supports a last frame alone.",
            },
            generationMode: {
              type: "string",
              enum: ["normal", "first-frame", "last-frame", "start-end", "reference", "video-edit"],
              description:
                "Optional explicit video mode; must match supplied media. HappyHorse editing uses modelId happyhorse-video-edit and sourceVideoUrl.",
            },
            referenceVideos: {
              type: "array",
              maxItems: 10,
              items: { type: "string", maxLength: 4096 },
              description:
                "Public HTTPS video references. Supply matching referenceVideoDurations. Model-specific count and duration limits are enforced.",
            },
            referenceVideoDurations: {
              type: "array",
              maxItems: 10,
              items: { type: "number", minimum: 1, maximum: 30 },
            },
            referenceAudios: {
              type: "array",
              maxItems: 10,
              items: { type: "string", maxLength: 4096 },
              description:
                "Public HTTPS audio references. Supply matching referenceAudioDurations.",
            },
            referenceAudioDurations: {
              type: "array",
              maxItems: 10,
              items: { type: "number", minimum: 1, maximum: 30 },
            },
            sourceVideoUrl: {
              type: "string",
              maxLength: 4096,
              description:
                "Public HTTPS MP4/MOV to edit, only with happyhorse-video-edit. Supply sourceVideoDuration and omit duration; only the first 15 output seconds are used.",
            },
            sourceVideoDuration: { type: "number", minimum: 3, maximum: 60 },
            maskPath: {
              type: "string",
              maxLength: 4096,
              description:
                "Optional local PNG mask inside the caller workspace, only when moss_media_list reports supportsMaskEdits. Transparent pixels select the edit area. The first reference must be a PNG file/data image of the same dimensions; a remote URL is insufficient. Mask must contain an alpha channel and be smaller than 4 MiB. All local references plus mask share a 5 MiB byte limit, and all encoded references plus mask share 7 MiB. Supply the path, never generate base64 in model output.",
            },
            background: {
              type: "string",
              enum: ["auto", "opaque", "transparent"],
              description:
                "Transparent requires supportsTransparentBackground in moss_media_list and PNG or WebP output.",
            },
            outputFormat: { type: "string", enum: ["png", "jpeg", "webp"] },
            aspectRatio: { type: "string", maxLength: 32 },
            resolution: { type: "string", maxLength: 16 },
            duration: { type: "integer", minimum: 1, maximum: 30 },
            generateAudio: { type: "boolean" },
            promptExtend: { type: "boolean" },
          },
          required: ["modelId", "prompt", "idempotencyKey"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      handler: (args, context) =>
        guarded(
          Effect.gen(function* () {
            const parsed = yield* Effect.try({
              try: () => readGenerateInput(args),
              catch: (error) => error,
            });
            const credential = yield* credentialFor(context);
            const selectedWorkspace = input.resolveWorkspaceRoot
              ? yield* input.resolveWorkspaceRoot(context)
              : null;
            const referencePaths = Array.isArray(parsed.referencePaths)
              ? (parsed.referencePaths as string[])
              : [];
            const references = Array.isArray(parsed.referenceImages)
              ? [...(parsed.referenceImages as string[])]
              : [];
            let maskImage: string | undefined;
            if (referencePaths.length || parsed.maskPath !== undefined) {
              const root = selectedWorkspace;
              if (!root) return yield* Effect.fail(new MossMediaJobsError("workspace_required"));
              if (typeof parsed.maskPath === "string") {
                const files = yield* Effect.tryPromise({
                  try: () =>
                    readWorkspaceMediaEditFiles(root, referencePaths, parsed.maskPath as string),
                  catch: (error) => error,
                });
                references.push(...files.references);
                maskImage = files.maskImage;
              } else {
                references.push(
                  ...(yield* Effect.tryPromise({
                    try: () =>
                      readWorkspaceMediaReferences(
                        root,
                        referencePaths,
                        hoolaCanvasModelKind(parsed.modelId) === "video"
                          ? canvasVideoReferenceImageLimit(parsed.modelId)
                          : 4,
                      ),
                    catch: (error) => error,
                  })),
                );
              }
            }
            if (
              references.reduce((sum, value) => sum + value.length, 0) + (maskImage?.length ?? 0) >
              MAX_REFERENCE_CHARS
            )
              return yield* Effect.fail(new MossMediaJobsError("request_too_large", 413));
            const editError = mediaImageEditInputError({
              ...parsed,
              referenceImages: references,
              maskImage,
            });
            if (editError) return yield* Effect.fail(new MossMediaJobsError(editError));
            const { referencePaths: _paths, maskPath: _maskPath, ...request } = parsed;
            const job = yield* Effect.tryPromise({
              try: () =>
                input.service.create(
                  {
                    ...request,
                    ...(references.length ? { referenceImages: references } : {}),
                    ...(maskImage ? { maskImage } : {}),
                    projectId: threadProjectId(context),
                    metadata: {
                      sourceSurface: "moss-agent-media",
                      threadId: context.callerThreadId,
                    },
                  },
                  credential,
                  () =>
                    Effect.runPromise(
                      Effect.result(
                        Effect.gen(function* () {
                          const fresh = yield* credentialFor(context);
                          if (!fresh.installedModelIds?.includes(parsed.modelId))
                            return yield* Effect.fail(
                              new MossMediaJobsError("media_skill_not_installed", 403),
                            );
                        }),
                      ),
                    ).then((result) => {
                      if (result._tag === "Failure") throw result.failure;
                    }),
                  selectedWorkspace ?? undefined,
                  {
                    threadId: context.callerThreadId,
                    turnId: context.callerTurnId!,
                  },
                ),
              catch: (error) => error,
            });
            yield* credentialFor(context);
            if (job.projectId !== threadProjectId(context))
              return yield* Effect.fail(new MossMediaJobsError("job_not_found", 404));
            return mcpToolResultJson(job);
          }),
        ),
    },
    {
      definition: {
        name: "moss_media_get",
        description:
          "Read/resume a persisted media job created in this caller thread. Poll this for a previously returned jobId; jobs from other threads are not accessible. Do not submit another generation just because a task is slow. Reconciliation means the provider outcome or billing is still unknown, not that credits were refunded.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string", pattern: "^moss_[A-Za-z0-9_-]+$", maxLength: 133 },
          },
          required: ["jobId"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      requiredCapability: "thread:read",
      requiresActiveTurn: true,
      handler: (args, context) =>
        guarded(
          Effect.gen(function* () {
            if (
              Object.keys(args).some((key) => key !== "jobId") ||
              typeof args.jobId !== "string" ||
              !/^moss_[A-Za-z0-9_-]{1,128}$/u.test(args.jobId)
            )
              return yield* Effect.fail(new MossMediaJobsError("invalid_request"));
            const credential = yield* credentialFor(context);
            const projectId = threadProjectId(context);
            const job = yield* Effect.tryPromise({
              try: () => input.service.check(args.jobId as string, credential, projectId),
              catch: (error) => error,
            });
            yield* credentialFor(context);
            if (job.projectId !== projectId)
              return yield* Effect.fail(new MossMediaJobsError("job_not_found", 404));
            return mcpToolResultJson(job);
          }),
        ),
    },
  ];
}
