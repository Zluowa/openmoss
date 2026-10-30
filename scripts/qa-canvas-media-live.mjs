#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chmodSync, writeFileSync } from "node:fs";

const IMAGE_MODELS = [
  "gpt-image-2-official",
  "grok-imagine-image-2.0",
  "gemini-flash-image",
  "nano-banana-pro",
  "wan2.7-image-pro",
  "seedream-5-0",
];

const VIDEO_MODELS = [
  "kling-v3-omni",
  "wan3.0-video",
  "wan3.0-video-prime",
  "happyhorse",
  "doubao-seedance-2.0",
  "doubao-seedance-2.0-fast",
  "doubao-seedance-2.5",
  "MiniMax-H3",
];

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const gateway = String(args.get("--gateway") ?? "").replace(/\/+$/u, "");
const gatewayPrefix = String(
  args.has("--gateway-prefix") ? args.get("--gateway-prefix") : "/functions/v1/moss-model-gateway",
).replace(/\/$/u, "");
const tokenFile = args.get("--token-file");
const stateFile = args.get("--state-file");
const selected = String(args.get("--models") ?? [...IMAGE_MODELS, ...VIDEO_MODELS].join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const pollIntervalMs = Number(args.get("--poll-ms") ?? "15000");
const timeoutMs = Number(args.get("--timeout-ms") ?? "1800000");
const resume = args.get("--resume") === "true";

if (!gateway || !tokenFile || !stateFile) {
  console.error(
    "Usage: qa-canvas-media-live.mjs --gateway URL --token-file FILE --state-file FILE [--gateway-prefix PATH] [--models a,b] [--poll-ms N] [--timeout-ms N]",
  );
  process.exit(2);
}

const unknown = selected.filter(
  (modelId) => !IMAGE_MODELS.includes(modelId) && !VIDEO_MODELS.includes(modelId),
);
if (unknown.length > 0) {
  console.error(`Unknown model ids: ${unknown.join(", ")}`);
  process.exit(2);
}

const sha = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const token = (await readFile(tokenFile, "utf8")).trim();

function assetReceipt(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return {
      scheme: url.protocol,
      host: url.hostname,
      pathFingerprint: sha(url.pathname),
    };
  } catch {
    return { invalidUrlFingerprint: sha(rawUrl) };
  }
}

async function persist(state) {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(stateFile, 0o600);
}

async function post(path, body, operationId) {
  const response = await fetch(`${gateway}${gatewayPrefix}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(operationId ? { "x-moss-operation-id": operationId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(130_000),
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: { code: "invalid_json_response" } };
  }
  return { response, data };
}

const gatewayHost = new URL(gateway).hostname;
const tokenFingerprint = sha(token);
const state = resume
  ? JSON.parse(await readFile(stateFile, "utf8"))
  : {
      schemaVersion: 1,
      gatewayHost,
      tokenFingerprint,
      startedAt: new Date().toISOString(),
      entries: [],
    };
if (
  state.schemaVersion !== 1 ||
  state.gatewayHost !== gatewayHost ||
  state.tokenFingerprint !== tokenFingerprint ||
  !Array.isArray(state.entries)
) {
  throw new Error("resume_state_mismatch");
}
delete state.completedAt;

for (const modelId of selected) {
  const mediaType = IMAGE_MODELS.includes(modelId) ? "image" : "video";
  let entry = state.entries.find(
    (candidate) => candidate?.modelId === modelId && candidate?.mediaType === mediaType,
  );
  let startedAtMs;
  if (entry) {
    if (entry.status === "completed" && entry.assetUrl) {
      console.log(JSON.stringify({ modelId, mediaType, status: "already_completed" }));
      continue;
    }
    if (typeof entry.taskToken !== "string" || !entry.taskToken) {
      entry.status = "resume_failed";
      entry.errorCode = "resume_task_token_missing";
      await persist(state);
      console.log(
        JSON.stringify({ modelId, mediaType, status: entry.status, errorCode: entry.errorCode }),
      );
      continue;
    }
    startedAtMs = Date.parse(entry.startedAt);
    if (!Number.isFinite(startedAtMs)) startedAtMs = Date.now();
    entry.status = "resuming";
    await persist(state);
    console.log(
      JSON.stringify({
        modelId,
        mediaType,
        provider: entry.provider,
        status: entry.status,
        requestFingerprint: entry.requestFingerprint,
        billingExempt: entry.billingExempt,
      }),
    );
  } else {
    const operationId = `hoola-live-${mediaType}-${modelId.replaceAll(/[^A-Za-z0-9._:-]/gu, "-")}-${randomUUID()}`;
    startedAtMs = Date.now();
    entry = {
      modelId,
      mediaType,
      operationId,
      operationFingerprint: sha(operationId),
      startedAt: new Date(startedAtMs).toISOString(),
      status: "submitting",
    };
    state.entries.push(entry);
    await persist(state);

    let created;
    try {
      created = await post(
        mediaType === "image" ? "/v1/canvas/images/generations" : "/v1/canvas/videos/generations",
        mediaType === "image"
          ? {
              modelId,
              prompt: "一只毛茸茸的橙猫坐在广州清晨的窗边，写实摄影，自然光，无文字，无水印",
              resolution: "1K",
              aspectRatio: "1:1",
            }
          : {
              modelId,
              prompt:
                "一只毛茸茸的橙猫在广州清晨的窗边缓慢转头，固定机位，写实电影感，无文字，无水印",
              resolution: modelId === "MiniMax-H3" ? "2K" : "720p",
              aspectRatio: "16:9",
              duration:
                modelId === "happyhorse"
                  ? 3
                  : modelId.startsWith("wan3.0")
                    ? 2
                    : modelId === "MiniMax-H3"
                      ? 4
                      : 5,
              generateAudio: false,
            },
        operationId,
      );
    } catch (error) {
      entry.status = "transport_failed";
      entry.errorCode = error instanceof Error ? error.name : "unknown_transport_failure";
      entry.durationMs = Date.now() - startedAtMs;
      await persist(state);
      console.log(
        JSON.stringify({ modelId, mediaType, status: entry.status, errorCode: entry.errorCode }),
      );
      continue;
    }

    if (!created.response.ok || !created.data?.taskToken) {
      entry.status = "submit_failed";
      entry.httpStatus = created.response.status;
      entry.errorCode = created.data?.error?.code ?? "unknown_submit_failure";
      entry.durationMs = Date.now() - startedAtMs;
      await persist(state);
      console.log(
        JSON.stringify({
          modelId,
          mediaType,
          status: entry.status,
          httpStatus: entry.httpStatus,
          errorCode: entry.errorCode,
        }),
      );
      continue;
    }

    entry.status = "submitted";
    entry.provider = created.data.provider;
    entry.requestFingerprint = sha(created.data.requestId);
    entry.taskToken = created.data.taskToken;
    entry.billingExempt = created.data.billingExempt === true;
    entry.submittedReceipt = created.data.receipt;
    await persist(state);
    console.log(
      JSON.stringify({
        modelId,
        mediaType,
        provider: entry.provider,
        status: entry.status,
        requestFingerprint: entry.requestFingerprint,
        billingExempt: entry.billingExempt,
      }),
    );
  }

  const deadline = startedAtMs + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let queried;
    try {
      queried = await post("/v1/canvas/media/query", { taskToken: entry.taskToken });
    } catch (error) {
      entry.lastQueryError =
        error instanceof Error ? error.name : "unknown_query_transport_failure";
      await persist(state);
      continue;
    }
    if (!queried.response.ok) {
      entry.status = "query_failed";
      entry.httpStatus = queried.response.status;
      entry.errorCode = queried.data?.error?.code ?? "unknown_query_failure";
      entry.durationMs = Date.now() - startedAtMs;
      break;
    }
    entry.status = queried.data.status ?? "unknown";
    entry.polls = (entry.polls ?? 0) + 1;
    if (queried.data.pending === false) {
      const rawAssetUrl = queried.data.imageUrl ?? queried.data.videoUrl;
      entry.status = "completed";
      entry.assetReceipt = assetReceipt(rawAssetUrl);
      entry.assetUrl = rawAssetUrl;
      entry.completedReceipt = queried.data.receipt;
      entry.durationMs = Date.now() - startedAtMs;
      break;
    }
    await persist(state);
  }

  if (entry.status !== "completed" && !entry.durationMs) {
    entry.status = "timeout";
    entry.durationMs = Date.now() - startedAtMs;
  }
  await persist(state);
  console.log(
    JSON.stringify({
      modelId,
      mediaType,
      provider: entry.provider,
      status: entry.status,
      requestFingerprint: entry.requestFingerprint,
      asset: entry.assetReceipt ?? null,
      durationMs: entry.durationMs,
      billingExempt: entry.billingExempt,
      errorCode: entry.errorCode ?? null,
    }),
  );
}

state.completedAt = new Date().toISOString();
await persist(state);
const failed = state.entries.filter((entry) => entry.status !== "completed");
console.log(
  JSON.stringify({
    summary: true,
    total: state.entries.length,
    completed: state.entries.length - failed.length,
    failed: failed.map(({ modelId, status, errorCode }) => ({ modelId, status, errorCode })),
    stateFile,
  }),
);
process.exit(failed.length === 0 ? 0 : 1);
