import { PageId, PagesRpcError, type PagesMutateInput } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPageMutationRejected, PageMutationIntent } from "./pageMutationIntent";

const input: PagesMutateInput = {
  op: "comment",
  pageId: PageId.makeUnsafe("p"),
  scopeSpaceId: null,
  expectedRevision: 1,
  requestId: "request-original",
  content: "Once only",
};
const accepts = (candidate: PagesMutateInput) => candidate.scopeSpaceId === null;
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("durable Page action identity", () => {
  it("restores the exact request across surfaces and rejects a competing action", () => {
    new PageMutationIntent("intent", accepts).remember(input);
    const recovered = new PageMutationIntent("intent", accepts);
    expect(recovered.remember({ ...input, expectedRevision: 2, requestId: "replacement" })).toEqual(
      input,
    );
    expect(() => recovered.remember({ ...input, content: "Different action" })).toThrow("上次操作");
    expect(localStorage.getItem("intent")).toContain("request-original");
  });
  it("does not let a late acknowledgement remove a newer action journal", () => {
    const oldSurface = new PageMutationIntent("intent", accepts);
    oldSurface.remember(input);
    const currentSurface = new PageMutationIntent("intent", accepts);
    currentSurface.clear();
    const next = { ...input, requestId: "request-next", content: "New comment" };
    currentSurface.remember(next);
    oldSurface.clear();
    expect(new PageMutationIntent("intent", accepts).pending).toEqual(next);
  });
  it("keeps storage and network failures uncertain but recognizes typed rejection", () => {
    expect(
      isPageMutationRejected(
        new PagesRpcError({ code: "conflict", message: "changed", currentRevision: 2 }),
      ),
    ).toBe(true);
    expect(
      isPageMutationRejected(new PagesRpcError({ code: "storage", message: "not confirmed" })),
    ).toBe(false);
    expect(isPageMutationRejected(new Error("socket lost"))).toBe(false);
  });
  it("refuses an external write when its durable reconciliation id cannot be stored", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const intent = new PageMutationIntent("intent", accepts);
    expect(() => intent.remember(input)).toThrow("quota");
    expect(intent.pending).toBeNull();
  });
});
