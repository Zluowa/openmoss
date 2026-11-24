import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOSS_CANVAS_MUTATE_RECORD_VERSIONS } from "./mossCanvasMutate";

// The Canvas storage as the gateway sees it, holding one board that someone else keeps saving.
const storage = vi.hoisted(() => ({
  revision: 1,
  writes: [] as { expectedUpdatedAt?: string; snapshot: unknown }[],
  concurrentSaves: 0,
}));

function board() {
  return {
    document: {
      store: {
        "document:document": {
          id: "document:document",
          typeName: "document",
          gridSize: 10,
          name: "",
          meta: {},
        },
        "page:page": { id: "page:page", typeName: "page", name: "画布", index: "a1", meta: {} },
      },
      schema: { schemaVersion: 2, sequences: { ...MOSS_CANVAS_MUTATE_RECORD_VERSIONS } },
    },
  };
}

vi.mock("./mossCanvasStorage", () => ({
  mossCanvasStorageExists: async () => true,
  mossCanvasStorageFor: async () => ({
    request: async (method: string, input: Record<string, unknown> = {}) => {
      if (method === "workspace.conversationJobs") return { relativePath: "conversation.tldr" };
      if (method === "projects.active") return { relativePath: "conversation.tldr" };
      if (method === "projects.read")
        return {
          entry: { title: "画布", updatedAt: `rev-${storage.revision}` },
          snapshot: board(),
        };
      if (method === "projects.write") {
        storage.writes.push(input as never);
        // The editor saved in between the agent's read and write.
        if (storage.concurrentSaves > 0) {
          storage.concurrentSaves -= 1;
          storage.revision += 1;
        }
        if (input.expectedUpdatedAt !== `rev-${storage.revision}`)
          throw Object.assign(new Error("changed"), { code: "HOOLA_PROJECT_REVISION_MISMATCH" });
        storage.revision += 1;
        return { updatedAt: `rev-${storage.revision}` };
      }
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

const { mutateMossCanvas } = await import("./mossCanvasMutate");

const input = {
  stateDirectory: "/state",
  identity: {
    account: { id: "user-a", realm: "memfire-phone" as const },
    realm: "memfire-phone" as const,
    gatewayBaseUrl: "https://gateway.example/v1",
  },
  workspace: { threadId: "thread-1", cwd: "/work", title: "画布" },
  ops: [{ op: "addNote" as const, text: "代理写入" }],
};

describe("an agent edit written to storage while no editor holds the board", () => {
  beforeEach(() => {
    storage.revision = 1;
    storage.writes = [];
    storage.concurrentSaves = 0;
  });

  it("names the revision it read", async () => {
    await mutateMossCanvas(input);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]!.expectedUpdatedAt).toBe("rev-1");
  });

  it("reads again and retries when the board changed in between, never writing over it", async () => {
    storage.concurrentSaves = 1;
    const result = await mutateMossCanvas(input);
    expect(storage.writes.map((write) => write.expectedUpdatedAt)).toEqual(["rev-1", "rev-2"]);
    expect(result.revision).toBe("rev-3");
  });

  it("gives up after three refused writes and says the 画布 is busy", async () => {
    storage.concurrentSaves = 3;
    await expect(mutateMossCanvas(input)).rejects.toThrow("canvas_busy");
    expect(storage.writes).toHaveLength(3);
  });
});
