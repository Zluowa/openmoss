// FILE: inlineVisualizationAccess.ts
// Purpose: Resolve a visualization marker (`<cursor-content kind="visualization" src=…>`) of a
//          Moss thread to the validated file it names, and read the shipped chart libraries.
// Layer: Server security boundary
// Why: The owner's frame route and the shared conversation's guest routes answer the same
//      markers, so both use one resolver: a Codex thread's native visualization folder, else the
//      thread's own workspace, always confined with realpath.

import fs from "node:fs/promises";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderInstanceId } from "@moss/contracts";
import {
  providerStartOptionsFromInstance,
  resolveProviderInstance,
} from "@moss/shared/providerInstances";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveCodexHomePath } from "./codexGeneratedImages";
import { ServerConfig } from "./config";
import {
  inlineVisualizationLibraryContentType,
  validateInlineVisualizationFile,
  validateWorkspaceInlineVisualizationFile,
  type ValidatedInlineVisualization,
} from "./inlineVisualization";
import { ServerSettingsService } from "./serverSettings";

interface InlineVisualizationThreadBinding {
  readonly providerName: string | null;
  readonly providerInstanceId: string | null;
  readonly providerThreadId: string | null;
  readonly worktreePath: string | null;
  readonly workingDirectory: string | null;
  readonly projectWorkspaceRoot: string | null;
}

/**
 * The projection deliberately hides provider IDs from normal client snapshots,
 * but this route needs the native Codex id as an authorization boundary. Keep
 * the lookup here, parameterized and server-only, rather than trusting the
 * marker's date/thread path.
 */
const readInlineVisualizationBinding = Effect.fn(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<InlineVisualizationThreadBinding>`
    SELECT
      s.provider_name AS "providerName",
      s.provider_instance_id AS "providerInstanceId",
      s.provider_thread_id AS "providerThreadId",
      t.worktree_path AS "worktreePath",
      t.working_directory AS "workingDirectory",
      p.workspace_root AS "projectWorkspaceRoot"
    FROM projection_thread_sessions s
    LEFT JOIN projection_threads t ON t.thread_id = s.thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    WHERE s.thread_id = ${threadId}
    LIMIT 1
  `;
  return rows[0] ?? null;
});

export interface ResolvedInlineVisualization {
  readonly threadId: string;
  readonly visualization: ValidatedInlineVisualization;
}

/**
 * The visualization file a thread's marker names, or null. Settings are optional: without them
 * (a caller that has no settings service) only the thread's workspace is searched.
 */
export const readInlineVisualizationRequest = Effect.fn(function* (input: {
  readonly threadId: string | null;
  readonly requestedPath: string | null;
}) {
  const threadId = input.threadId?.trim() ?? "";
  const requestedPath = input.requestedPath?.trim() ?? "";
  if (!/^[A-Za-z0-9:_-]{1,256}$/u.test(threadId) || requestedPath.length === 0) {
    return null;
  }
  const binding = yield* readInlineVisualizationBinding(threadId);
  if (!binding) return null;

  // Codex threads keep the native chain: the marker path must live under the
  // instance's codexHome in the exact date/<native thread> shape.
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  if (
    binding.providerName === "codex" &&
    binding.providerThreadId &&
    binding.providerThreadId.length <= 256 &&
    Option.isSome(serverSettings)
  ) {
    const settings = yield* serverSettings.value.getSettings;
    const instance = resolveProviderInstance(settings, {
      provider: "codex",
      ...(binding.providerInstanceId
        ? { instanceId: ProviderInstanceId.makeUnsafe(binding.providerInstanceId) }
        : {}),
    });
    if (instance && instance.driver === "codex" && instance.enabled) {
      const codexHome = resolveCodexHomePath(providerStartOptionsFromInstance(instance)?.codex);
      const visualization = yield* Effect.promise(() =>
        validateInlineVisualizationFile({
          requestedPath,
          codexHome,
          codexThreadId: binding.providerThreadId!,
        }),
      );
      if (typeof visualization !== "string") {
        return { threadId, visualization } satisfies ResolvedInlineVisualization;
      }
    }
  }

  // Moss is multi-provider: Kimi/Claude/Cursor/etc. threads (and Codex threads
  // whose markers point at workspace artifacts) resolve `src` against the
  // thread's own workspace instead of codexHome. Confinement stays identical:
  // realpath inside the workspace, .html only, 2MB cap, CDN rewriting.
  // A project thread without a worktree runs in its project's folder. Global
  // chats have no project workspace — their runtime cwd is the server cwd, so
  // relative markers anchor there.
  const config = yield* ServerConfig;
  const workspaceRoot =
    binding.worktreePath ?? binding.workingDirectory ?? binding.projectWorkspaceRoot ?? config.cwd;
  const visualization = yield* Effect.promise(() =>
    validateWorkspaceInlineVisualizationFile({ requestedPath, workspaceRoot }),
  );
  return typeof visualization === "string"
    ? null
    : ({ threadId, visualization } satisfies ResolvedInlineVisualization);
});

/** Where the shipped chart libraries live: beside the built web app, else the source checkout. */
export function inlineVisualizationLibraryRoots(staticDir: string | undefined): string[] {
  return [
    ...(staticDir ? [nodePath.join(staticDir, "inline-visualization-libs")] : []),
    fileURLToPath(new URL("../../web/public/inline-visualization-libs/", import.meta.url)),
  ];
}

/** One shipped library's bytes and type, or null when the name is not a shipped library. */
export async function readInlineVisualizationLibrary(
  assetName: string,
  staticDir: string | undefined,
): Promise<{ readonly contents: Uint8Array; readonly contentType: string } | null> {
  const contentType = inlineVisualizationLibraryContentType(assetName);
  if (!contentType) return null;
  for (const root of inlineVisualizationLibraryRoots(staticDir)) {
    // A packaged deployment does not retain source assets. Try the next
    // known root before treating this shipped library as unavailable.
    const contents = await fs.readFile(nodePath.join(root, assetName)).catch(() => null);
    if (contents) return { contents, contentType };
  }
  return null;
}
