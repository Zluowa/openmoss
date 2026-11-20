// A Codex image call that failed, then a retry that made the picture, as the owner's
// 2026-11-20 theme chat stored them (round 20261120-devin-lead, thread c35ba3c2). Codex
// still names where the failed image would have been saved; no file is there. The
// transcript drew that path as the big 「图片无法显示 exec-56bbeb81…png」 card in front of
// the picture that was actually made.
import { describe, expect, it } from "vitest";

import {
  groupGeneratedImagesByTurn,
  suppressGeneratedImageCompatibilityMarkdown,
} from "./components/chat/generatedImageGallery.logic";
import { makeActivity } from "./storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries } from "./workLog";

const TURN = "01a1f84a-5dab-7c82-af26-56b4be671f1d";
const DIR =
  String.raw`D:\DevTemp\moss\smoke-108\owner-preview-108\home\codex-home-overlay\generated_images\01a1f84a-449e-7731-9396-ea34d080378a` +
  "\\";
const FAILED_CALL = "exec-56bbeb81-a241-435f-9557-cea1fa5d99a1";
const MADE_CALL = "exec-9c25e640-e6fd-4471-baaf-e914dee5cd52";
const FAILED_PATH = `${DIR}${FAILED_CALL}.png`;
const MADE_PATH = `${DIR}${MADE_CALL}.png`;

function started(id: string, callId: string, sequence: number, createdAt: string) {
  return makeActivity({
    id,
    kind: "tool.started",
    summary: "Generated image started",
    turnId: TURN,
    sequence,
    createdAt,
    payload: {
      itemType: "image_generation",
      status: "inProgress",
      title: "Generated image",
      data: { callId },
    },
  });
}

function finished(
  id: string,
  callId: string,
  path: string,
  status: "completed" | "failed",
  sequence: number,
  createdAt: string,
) {
  return makeActivity({
    id,
    kind: "tool.completed",
    summary: "Generated image",
    turnId: TURN,
    sequence,
    createdAt,
    payload: {
      itemType: "image_generation",
      status,
      title: "Generated image",
      detail: path,
      data: { kind: "codex.generated_image", path, callId },
    },
  });
}

const activities = [
  started("65dc90e8-2056-45c6-98ce-53b3cf2c6c86", FAILED_CALL, 5919, "2026-11-20T09:30:32.223Z"),
  finished(
    "459cbfe0-f79b-4f34-892e-df13ea18daf7",
    FAILED_CALL,
    FAILED_PATH,
    "failed",
    5920,
    "2026-11-20T09:30:35.043Z",
  ),
  started("44ec8e9c-5728-411e-952b-0729db345b6f", MADE_CALL, 5923, "2026-11-20T09:30:39.192Z"),
  finished(
    "f117612b-0051-4521-8bcd-0854c1e0cc2f",
    MADE_CALL,
    MADE_PATH,
    "completed",
    5927,
    "2026-11-20T09:31:08.683Z",
  ),
];

// The reply's tail as stored: the server appended one reference per image call.
const REPLY = `Moss 已确认保存并下发主题。\n\n![Generated image](${FAILED_PATH})\n\n![Generated image](${MADE_PATH})`;

describe("a failed Codex image call before the one that made the picture", () => {
  const entries = deriveWorkLogEntries(activities, undefined);
  const timeline = deriveTimelineEntries([], [], entries);
  const gallery = groupGeneratedImagesByTurn(timeline).get(TURN);

  it("shows only the picture that was made", () => {
    expect(gallery?.images.map((image) => image.path)).toEqual([MADE_PATH]);
    expect(gallery?.pendingImageCount).toBe(0);
  });

  it("drops the reply's reference to the image that was never saved", () => {
    const text = suppressGeneratedImageCompatibilityMarkdown(REPLY, gallery);
    expect(text).not.toContain(FAILED_CALL);
    expect(text).not.toContain(MADE_CALL);
    expect(text.trim()).toBe("Moss 已确认保存并下发主题。");
  });
});
