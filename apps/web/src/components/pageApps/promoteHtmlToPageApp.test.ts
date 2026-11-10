import type { PageAppsMutateInput, PageSpaceId, SpaceId } from "@moss/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn(async (input: PageAppsMutateInput) => ({ app: { id: "app-1", input } }));
vi.mock("./pageAppsClient", () => ({ pageAppsClient: { mutate } }));

const { promoteHtmlToPageApp } = await import("./promoteHtmlToPageApp");

const html = "<!doctype html><title>Plan</title><p>x</p>";

describe("promoteHtmlToPageApp", () => {
  beforeEach(() => mutate.mockClear());

  it("files the page in the given space with its declared capabilities", async () => {
    await promoteHtmlToPageApp({
      html,
      title: "  Weekly plan  ",
      threadId: "thread-1",
      scopeSpaceId: "scope-1" as SpaceId,
      spaceId: "space-1" as PageSpaceId,
      capabilities: { db: {}, ai: {} },
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      op: "create",
      scopeSpaceId: "scope-1",
      spaceId: "space-1",
      capabilities: { db: {}, ai: {} },
      title: "Weekly plan",
      sourceThreadId: "thread-1",
      html,
    });
  });

  it("keeps explicit nulls for 个人 and the default domain", async () => {
    await promoteHtmlToPageApp({
      html,
      title: "Plan",
      threadId: null,
      spaceId: null,
      scopeSpaceId: null,
    });
    const input = mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.spaceId).toBeNull();
    expect(input.scopeSpaceId).toBeNull();
    expect(input.sourceThreadId).toBeNull();
  });

  it("leaves capabilities and space out when not given, so the server reads the manifest", async () => {
    await promoteHtmlToPageApp({ html, title: "", threadId: null });
    const input = mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.scopeSpaceId).toBeNull();
    expect("capabilities" in input).toBe(false);
    expect("spaceId" in input).toBe(false);
    expect("title" in input).toBe(false);
  });
});
