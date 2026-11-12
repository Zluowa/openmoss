// Project official media into the existing transcript gallery for every CLI.
// Only durable server-owned origins and verified media assets reach this boundary.
import { isAbsolute } from "node:path";
import {
  CommandId,
  EventId,
  MOSS_GENERATED_IMAGE_ARTIFACT_KIND,
  MOSS_GENERATED_VIDEO_ARTIFACT_KIND,
  MOSS_IMAGE_GENERATION_FAILURE_KIND,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@moss/contracts";
import type { MossConversationImageObservation } from "../mossMediaJobsService";
import { stableGatewayDigest } from "./creationUtils";

/**
 * Width / height of the image a request asked for ("16:9", "3:4", "1536x1024"),
 * bounded to shapes a chat placeholder can draw. Unknown shapes stay square.
 */
export function requestedImageAspectRatio(
  shape: { readonly aspectRatio?: string; readonly resolution?: string } | undefined,
): number | undefined {
  for (const value of [shape?.aspectRatio, shape?.resolution]) {
    const match = /^\s*(\d{1,5}(?:\.\d{1,3})?)\s*[:x×*]\s*(\d{1,5}(?:\.\d{1,3})?)\s*$/iu.exec(
      value ?? "",
    );
    if (!match) continue;
    const ratio = Number(match[1]) / Number(match[2]);
    if (Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 4) return Math.round(ratio * 1e4) / 1e4;
  }
  return undefined;
}

export function conversationImageActivityCommands(
  observation: MossConversationImageObservation,
): readonly OrchestrationCommand[] {
  const { origin, snapshot, outputs, accountScope } = observation;
  // A video takes the image's lifecycle too; its placeholder says it is a video, which
  // takes minutes, and its result is drawn as a player.
  const video = snapshot.operation === "video";
  const noun = video ? "video" : "image";
  if (
    snapshot.projectId !== `thread:${origin.threadId}` ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(origin.threadId) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(origin.turnId) ||
    !/^[a-f0-9]{64}$/u.test(accountScope) ||
    !/^moss_[A-Za-z0-9_-]{1,128}$/u.test(snapshot.jobId) ||
    !Number.isFinite(Date.parse(snapshot.createdAt))
  )
    return [];
  const identity = stableGatewayDigest([accountScope, origin.threadId, snapshot.jobId], 64);
  const callId = (index: number) => `moss-image:${identity}:${index}`;
  const command = (
    index: number,
    status: "inProgress" | "completed" | "failed",
    summary: string,
    data: Record<string, unknown>,
  ): OrchestrationCommand => {
    // Fingerprint the stable safe payload, never a polling timestamp or mutable
    // billing field. Orchestration command receipts deduplicate disk replays.
    const payload = {
      itemType: "image_generation",
      status,
      data: { ...data, ...(video ? { media: "video" } : {}), callId: callId(index) },
    };
    const digest = stableGatewayDigest([identity, origin.turnId, index, payload], 64);
    const id = `moss-image:${digest}`;
    return {
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(id),
      threadId: ThreadId.makeUnsafe(origin.threadId),
      createdAt: snapshot.createdAt,
      activity: {
        id: EventId.makeUnsafe(id),
        kind: status === "inProgress" ? "tool.started" : "tool.completed",
        tone: status === "failed" ? "error" : "tool",
        summary,
        payload,
        turnId: TurnId.makeUnsafe(origin.turnId),
        createdAt: snapshot.createdAt,
      },
    };
  };
  const images =
    snapshot.status === "succeeded" && snapshot.persistenceStatus === "ready"
      ? [...new Map(outputs.map((output) => [output.index, output])).values()]
          .filter(
            (output) =>
              Number.isInteger(output.index) &&
              output.index >= 0 &&
              output.index < 32 &&
              (output.path ===
                `/api/moss/media/assets/${snapshot.jobId}/${output.index}?accountScope=${accountScope}` ||
                isAbsolute(output.path)) &&
              !output.path.includes("\0"),
          )
          .sort((left, right) => left.index - right.index)
      : [];
  if (images.length) {
    const completed = images.map((image) =>
      command(image.index, "completed", video ? "Generated video" : "Generated image", {
        kind: video ? MOSS_GENERATED_VIDEO_ARTIFACT_KIND : MOSS_GENERATED_IMAGE_ARTIFACT_KIND,
        path: image.path,
        jobId: snapshot.jobId,
        outputIndex: image.index,
      }),
    );
    // A malformed partial cache must not leave the original job placeholder
    // spinning alongside later valid outputs.
    if (!images.some((image) => image.index === 0))
      completed.push(
        command(0, "failed", `${video ? "Video" : "Image"} output unavailable`, {
          kind: MOSS_IMAGE_GENERATION_FAILURE_KIND,
          jobId: snapshot.jobId,
          errorCode: "media_output_missing",
        }),
      );
    return completed;
  }
  if (
    observation.projectionFailed ||
    snapshot.status === "failed_terminal" ||
    snapshot.status === "reconciliation_required" ||
    snapshot.status === "succeeded"
  ) {
    const unknown = snapshot.status === "reconciliation_required";
    return [
      command(
        0,
        "failed",
        `${video ? "Video" : "Image"} ${unknown ? "outcome needs review" : "output unavailable"}`,
        {
          kind: MOSS_IMAGE_GENERATION_FAILURE_KIND,
          jobId: snapshot.jobId,
          jobStatus: snapshot.status,
          errorCode: unknown
            ? "media_outcome_unknown"
            : observation.projectionFailed || snapshot.status === "succeeded"
              ? "media_output_save_pending"
              : "media_generation_failed",
        },
      ),
    ];
  }
  const aspectRatio = requestedImageAspectRatio(observation.requestedShape);
  return [
    command(0, "inProgress", `Generating ${noun}`, {
      jobId: snapshot.jobId,
      ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    }),
  ];
}
