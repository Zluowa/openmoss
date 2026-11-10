import { describe, expect, it } from "vitest";

import {
  readThreadOutputHref,
  slidesCoverText,
  threadOutputFileFromActivity,
  threadOutputFilesLinkedIn,
  THREAD_OUTPUT_FILE_ACTIVITY_KIND,
} from "./chatArtifactActivity";
import { threadOutputHref } from "./threadWorkspace";

describe("chat artifact activities", () => {
  it("reads Moss download links and the files an answer links to", () => {
    const href = threadOutputHref("thread-1", "out/季度回顾.pptx", "b".repeat(64));
    expect(readThreadOutputHref(href)).toEqual({
      threadId: "thread-1",
      file: "out/季度回顾.pptx",
      sha256: "b".repeat(64),
    });
    expect(readThreadOutputHref("https://example.com/api/thread-output?file=x")).toBeNull();
    expect(readThreadOutputHref("/api/thread-output?threadId=t")).toBeNull();
    const answer = `做好了：[季度回顾.pptx](${href})，表格见 [数据.xlsx](${threadOutputHref("thread-1", "数据.xlsx")})。`;
    expect([...threadOutputFilesLinkedIn(answer)]).toEqual(["out/季度回顾.pptx", "数据.xlsx"]);
    expect(threadOutputFilesLinkedIn("没有链接").size).toBe(0);
  });

  it("keeps the cover line short and the file payload bounded", () => {
    expect(slidesCoverText(["  季度回顾 ", "", "2026\n年"])).toBe("季度回顾 · 2026 年");
    expect(slidesCoverText([" ", ""])).toBeNull();
    expect(slidesCoverText(["长".repeat(500)])?.length).toBe(200);
    expect(
      threadOutputFileFromActivity({
        kind: THREAD_OUTPUT_FILE_ACTIVITY_KIND,
        payload: { threadOutput: { file: "a.zip", name: "a.zip", bytes: 3, sha256: "not-hex" } },
      }),
    ).toEqual({ file: "a.zip", name: "a.zip", path: null, bytes: 3, sha256: null });
  });
});
