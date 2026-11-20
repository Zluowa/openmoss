import { ThreadId, type DevsReportPreview, type DevsReportState } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  devsReportDraftReportId,
  devsReportDraftRequest,
  sendDevsReportDraft,
} from "./DevsReportDraftCard.logic";

const threadId = ThreadId.makeUnsafe("chat");
const draft = { draftId: `devs-draft:${"0123456789abcdef".repeat(2)}`, summary: "窗口卡住了" };

describe("developer report drafts", () => {
  it("gives one draft one stable report ID", () => {
    expect(devsReportDraftReportId(draft.draftId)).toBe("01234567-89ab-cdef-0123-456789abcdef");
  });

  it("sends the agent's words as written, after @devs, in the chat they came from", () => {
    expect(devsReportDraftRequest(threadId, draft)).toEqual({
      threadId,
      id: "01234567-89ab-cdef-0123-456789abcdef",
      text: "@devs 窗口卡住了",
      verbatim: true,
    });
    expect(devsReportDraftRequest(threadId, { ...draft, details: "点了三次都没反应。" }).text).toBe(
      "@devs 窗口卡住了\n\n点了三次都没反应。",
    );
  });

  it("sends nothing unless the person confirms", async () => {
    const request = devsReportDraftRequest(threadId, draft);
    const server = {
      prepareDevsReport: vi.fn(async () => ({}) as DevsReportPreview),
      submitDevsReport: vi.fn(async () => ({}) as DevsReportState),
    };
    expect(await sendDevsReportDraft({ server, request, confirm: async () => false })).toBe(
      "cancelled",
    );
    expect(server.submitDevsReport).not.toHaveBeenCalled();
    expect(await sendDevsReportDraft({ server, request, confirm: async () => true })).toBe("sent");
    expect(server.submitDevsReport).toHaveBeenCalledExactlyOnceWith(request);
    expect(await sendDevsReportDraft({ server: {}, request, confirm: async () => true })).toBe(
      "unsupported",
    );
  });
});
