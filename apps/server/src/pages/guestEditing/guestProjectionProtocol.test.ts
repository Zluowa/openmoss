import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { applyPlateValue, readPageDoc, seedPageDoc } from "../realtime/pageYjsContent";
import {
  makeGuestProjectionSessions,
  type ProjectionBackend,
  type ProjectionPage,
} from "./guestProjectionSessions";

const p = (text: string) => ({ type: "p", children: [{ text }] });
const initial = [p("First published paragraph"), p("Second published paragraph")];
const proofA = "proof-A-test-only";
const proofB = "proof-B-test-only";

function delta(seed: Uint8Array, target: readonly unknown[]) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, seed);
    const vector = Y.encodeStateVector(doc);
    applyPlateValue(doc, target, null);
    return Y.encodeStateAsUpdate(doc, vector);
  } finally {
    doc.destroy();
  }
}

function fixture(nodes: readonly unknown[] = initial, extraRoot = false) {
  const owner = new Y.Doc({ gc: false });
  seedPageDoc(owner, nodes);
  if (extraRoot) owner.getMap("controller-only").set("private", "INTERNAL_VALUE");
  let checkpoint = Y.encodeStateAsUpdate(owner);
  let rich = JSON.stringify(readPageDoc(owner));
  let revision = 1;
  let commits = 0;
  const flags: {
    allowed: boolean;
    grantEpoch: string;
    generation: string;
    role: ProjectionPage["role"];
    mode: ProjectionPage["mode"];
    kind: string;
  } = {
    allowed: true,
    grantEpoch: "grant-1",
    generation: "room-1",
    role: "edit",
    mode: "share",
    kind: "page",
  };
  const current = (proof: string, state = checkpoint): ProjectionPage => {
    if (!flags.allowed || ![proofA, proofB].includes(proof))
      throw new Error("PRIVATE_OWNER_DIAGNOSTICS");
    return {
      mode: flags.mode,
      role: flags.role,
      kind: flags.kind,
      pageId: "page",
      scope: null,
      actorRef: (proof === proofA ? "a" : "b").repeat(64),
      grantEpoch: flags.grantEpoch,
      generation: flags.generation,
      revision,
      publishedRich: rich,
      ownerState: state,
    };
  };
  let beforeMap: (() => Promise<void>) | undefined;
  let afterCommit: (() => void) | undefined;
  const backend: ProjectionBackend<string> = {
    readCurrent: async (proof) => current(proof),
    commitAuthorized: async (proof, _pageId, map, signal) => {
      await beforeMap?.();
      if (signal.aborted) throw new Error("private abort diagnostic");
      const mapped = map(current(proof, Y.encodeStateAsUpdate(owner)));
      if (mapped) {
        Y.applyUpdate(owner, mapped);
        checkpoint = Y.encodeStateAsUpdate(owner);
        rich = JSON.stringify(readPageDoc(owner));
        revision++;
        commits++;
      }
      afterCommit?.();
      return { revision, applied: mapped !== null };
    },
  };
  const sessions = makeGuestProjectionSessions(backend);
  return {
    owner,
    sessions,
    flags,
    get commits() {
      return commits;
    },
    get revision() {
      return revision;
    },
    pause: (gate: (() => Promise<void>) | undefined) => {
      beforeMap = gate;
    },
    after: (fn: (() => void) | undefined) => {
      afterCommit = fn;
    },
    setPublic: (body: string) => {
      rich = body;
      revision++;
    },
    close: () => {
      sessions.close();
      owner.destroy();
    },
  };
}

describe("private guest projection protocol", () => {
  it.each(["timeout", "close"] as const)(
    "replies on %s while uncooperative backend still holds its real operation slots",
    async (reason) => {
      vi.useFakeTimers();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const base = new Y.Doc();
      seedPageDoc(base, initial);
      let reads = 0;
      let ignore = true;
      const backend: ProjectionBackend<string> = {
        readCurrent: async () => {
          reads++;
          if (ignore) await gate;
          return {
            mode: "share",
            role: "edit",
            kind: "page",
            pageId: "page",
            scope: null,
            actorRef: "a".repeat(64),
            grantEpoch: "g",
            generation: "r",
            revision: 1,
            publishedRich: JSON.stringify(initial),
            ownerState: Y.encodeStateAsUpdate(base),
          };
        },
        commitAuthorized: async () => {
          throw new Error("unexpected write");
        },
      };
      const sessions = makeGuestProjectionSessions(backend);
      const replies: string[] = [];
      const calls = Array.from({ length: 4 }, () =>
        sessions.open(proofA, "page").then(
          () => {
            replies.push("seed");
          },
          (cause) => {
            replies.push(cause.code);
          },
        ),
      );
      try {
        expect(reads).toBe(4);
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(5001);
        else sessions.close();
        await vi.advanceTimersByTimeAsync(0);
        expect(replies).toEqual(Array(4).fill("unavailable"));
        await expect(sessions.open(proofA, "page")).rejects.toMatchObject({ code: "unavailable" });
        expect(reads).toBe(4);
        ignore = false;
        release();
        await Promise.all(calls);
        await vi.advanceTimersByTimeAsync(0);
        if (reason === "timeout")
          expect(await sessions.open(proofA, "page")).toMatchObject({ revision: 1 });
        else
          await expect(sessions.open(proofA, "page")).rejects.toMatchObject({
            code: "unavailable",
          });
      } finally {
        release();
        await Promise.all(calls);
        sessions.close();
        base.destroy();
        vi.useRealTimers();
      }
    },
  );
  it("translates guest-relative IDs onto the exact published owner state, consumes one epoch and reauthenticates receipt replay", async () => {
    const h = fixture();
    try {
      const opened = await h.sessions.open(proofA, "page");
      const update = delta(opened.seed, [p("Guest revised first"), initial[1]]);
      expect(await h.sessions.submit(proofA, opened.ticket, update)).toEqual({
        revision: 2,
        applied: true,
      });
      expect(readPageDoc(h.owner)).toEqual([p("Guest revised first"), initial[1]]);
      expect(h.commits).toBe(1);
      expect(await h.sessions.submit(proofA, opened.ticket, update)).toEqual({
        revision: 2,
        applied: true,
      });
      await expect(
        h.sessions.submit(proofA, opened.ticket, delta(opened.seed, [p("different operation")])),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(h.commits).toBe(1);
      h.flags.allowed = false;
      await expect(h.sessions.submit(proofA, opened.ticket, update)).rejects.toMatchObject({
        code: "unavailable",
        message: "unavailable",
      });
    } finally {
      h.close();
    }
  });

  it.each(["same-paragraph", "different-paragraph", "delete-set-only"] as const)(
    "returns conflict and preserves the owner's concurrent %s edit",
    async (scenario) => {
      const h = fixture(initial, scenario === "delete-set-only");
      try {
        const opened = await h.sessions.open(proofA, "page");
        const update = delta(opened.seed, [p("Guest target"), initial[1]]);
        if (scenario === "delete-set-only") {
          const vector = Y.encodeStateVector(h.owner);
          h.owner.getMap("controller-only").delete("private");
          expect(Y.encodeStateVector(h.owner)).toEqual(vector);
        } else
          applyPlateValue(
            h.owner,
            scenario === "same-paragraph"
              ? [p("Owner edited same paragraph"), initial[1]]
              : [initial[0], p("Owner edited the other paragraph")],
            null,
          );
        const before = Y.encodeStateAsUpdate(h.owner);
        await expect(h.sessions.submit(proofA, opened.ticket, update)).rejects.toMatchObject({
          code: "conflict",
        });
        expect(Y.encodeStateAsUpdate(h.owner)).toEqual(before);
        expect(h.commits).toBe(0);
      } finally {
        h.close();
      }
    },
  );

  it.each([
    "application",
    "unknown-attribute",
    "private-image",
    "file-reference",
    "hidden-text-property",
  ] as const)(
    "refuses %s while opening instead of disclosing or dropping protected content",
    async (kind) => {
      const nodes =
        kind === "application"
          ? [{ type: "moss_visualization", appPageId: "PRIVATE_APP", children: [{ text: "" }] }]
          : kind === "unknown-attribute"
            ? [{ ...p("Visible"), privateData: "PRIVATE_SYSTEM_KEY" }]
            : kind === "private-image"
              ? [{ type: "img", url: "/library/private", children: [{ text: "" }] }]
              : kind === "file-reference"
                ? [{ type: "file", url: "file:///private/file", children: [{ text: "" }] }]
                : [{ type: "p", children: [{ text: "Visible", secret: "PRIVATE_SYSTEM_KEY" }] }];
      const h = fixture(nodes);
      try {
        await expect(h.sessions.open(proofA, "page")).rejects.toMatchObject({
          code: "unsupported",
          message: "unsupported",
        });
      } finally {
        h.close();
      }
    },
  );

  it("refuses adding an application or unknown field during writeback without changing the owner", async () => {
    const h = fixture();
    try {
      const opened = await h.sessions.open(proofA, "page");
      const update = delta(opened.seed, [
        { ...p("injected"), hiddenCredential: "AN_OPAQUE_SECRET" },
      ]);
      await expect(h.sessions.submit(proofA, opened.ticket, update)).rejects.toMatchObject({
        code: "unsupported",
        message: "unsupported",
      });
      expect(h.commits).toBe(0);
      expect(readPageDoc(h.owner)).toEqual(initial);
    } finally {
      h.close();
    }
  });

  it("isolates sessions sharing the same public proof, and requires freshly authorized matching subject and epoch", async () => {
    const h = fixture();
    try {
      const a = await h.sessions.open(proofA, "page"),
        b = await h.sessions.open(proofA, "page");
      expect(a.ticket.sessionKey).not.toBe(b.ticket.sessionKey);
      expect(a.ticket.epoch).not.toBe(b.ticket.epoch);
      await expect(
        h.sessions.read(proofA, { sessionKey: a.ticket.sessionKey, epoch: b.ticket.epoch }),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(h.sessions.read(proofB, a.ticket)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(await h.sessions.read(proofA, b.ticket)).toMatchObject({ revision: 1 });
      h.flags.grantEpoch = "replacement-grant";
      await expect(h.sessions.read(proofA, b.ticket)).rejects.toMatchObject({
        code: "unavailable",
      });
      h.flags.grantEpoch = "grant-1";
      await expect(h.sessions.read(proofA, b.ticket)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      h.close();
    }
  });

  it("never exports a stale seed after Page revision or room generation changes", async () => {
    const h = fixture();
    try {
      const a = await h.sessions.open(proofA, "page"),
        b = await h.sessions.open(proofA, "page");
      h.setPublic(JSON.stringify([p("new revision")]));
      await expect(h.sessions.read(proofA, a.ticket)).rejects.toMatchObject({ code: "conflict" });
      h.flags.generation = "replacement-room";
      await expect(h.sessions.read(proofA, b.ticket)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      h.close();
    }
  });

  it.each(["view-role", "comment-role", "site", "application-page"] as const)(
    "denies %s before any initial export",
    async (kind) => {
      const h = fixture();
      try {
        if (kind === "site") h.flags.mode = "site";
        else if (kind === "application-page") h.flags.kind = "app";
        else h.flags.role = kind === "view-role" ? "view" : "comment";
        await expect(h.sessions.open(proofA, "page")).rejects.toMatchObject({
          code: "unavailable",
          message: "unavailable",
        });
        expect(h.commits).toBe(0);
      } finally {
        h.close();
      }
    },
  );

  it("enforces intrinsic incoming byte budgets and returns independent seed copies", async () => {
    const h = fixture();
    try {
      const a = await h.sessions.open(proofA, "page");
      a.seed.fill(255);
      const copy = await h.sessions.read(proofA, a.ticket);
      const bad = Object.defineProperties(new Uint8Array(256 * 1024 + 1), {
        length: { value: 1 },
        byteLength: { value: 1 },
      });
      for (const value of [
        bad,
        new Uint8Array(new SharedArrayBuffer(8)),
        new Proxy(new Uint8Array(8), {}),
      ])
        await expect(h.sessions.submit(proofA, a.ticket, value)).rejects.toMatchObject({
          code: "invalid",
        });
      expect(await h.sessions.submit(proofA, a.ticket, delta(copy.seed, initial))).toEqual({
        revision: 1,
        applied: false,
      });
      expect(h.commits).toBe(0);
    } finally {
      h.close();
    }
  });

  it("rejects overlapping submissions and a revoke between read and the locked owner commit", async () => {
    const h = fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((res) => {
      enter = res;
    });
    const gate = new Promise<void>((res) => {
      release = res;
    });
    try {
      const a = await h.sessions.open(proofA, "page");
      const update = delta(a.seed, [p("draft"), initial[1]]);
      h.pause(async () => {
        enter();
        await gate;
      });
      const first = h.sessions.submit(proofA, a.ticket, update);
      await entered;
      await expect(h.sessions.submit(proofA, a.ticket, update)).rejects.toMatchObject({
        code: "conflict",
      });
      h.flags.allowed = false;
      release();
      await expect(first).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
      expect(h.commits).toBe(0);
      expect(readPageDoc(h.owner)).toEqual(initial);
    } finally {
      release();
      h.close();
    }
  });

  it("detects a same-paragraph owner edit after initial authorization but before the locked mapping", async () => {
    const h = fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((res) => {
      enter = res;
    });
    const gate = new Promise<void>((res) => {
      release = res;
    });
    try {
      const a = await h.sessions.open(proofA, "page");
      h.pause(async () => {
        enter();
        await gate;
      });
      const writing = h.sessions.submit(
        proofA,
        a.ticket,
        delta(a.seed, [p("guest replacement"), initial[1]]),
      );
      await entered;
      applyPlateValue(h.owner, [p("owner typed before lock"), initial[1]], null);
      const before = Y.encodeStateAsUpdate(h.owner);
      release();
      await expect(writing).rejects.toMatchObject({ code: "conflict" });
      expect(Y.encodeStateAsUpdate(h.owner)).toEqual(before);
      expect(h.commits).toBe(0);
    } finally {
      release();
      h.close();
    }
  });

  it("denies receipt disclosure on a revoke immediately after a committed write", async () => {
    const h = fixture();
    try {
      const a = await h.sessions.open(proofA, "page");
      h.after(() => {
        h.flags.allowed = false;
      });
      await expect(
        h.sessions.submit(proofA, a.ticket, delta(a.seed, [p("authorized at commit")])),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(h.commits).toBe(1);
      expect(h.revision).toBe(2);
      await expect(h.sessions.read(proofA, a.ticket)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      h.close();
    }
  });

  it("aborts an in-flight commit on shutdown and refuses its late callback", async () => {
    const h = fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((res) => {
      enter = res;
    });
    const gate = new Promise<void>((res) => {
      release = res;
    });
    try {
      const a = await h.sessions.open(proofA, "page");
      h.pause(async () => {
        enter();
        await gate;
      });
      const writing = h.sessions.submit(proofA, a.ticket, delta(a.seed, [p("late write")]));
      await entered;
      h.sessions.close();
      release();
      await expect(writing).rejects.toMatchObject({ code: "unavailable" });
      expect(h.commits).toBe(0);
      expect(readPageDoc(h.owner)).toEqual(initial);
      await expect(h.sessions.open(proofA, "page")).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      release();
      h.close();
    }
  });

  it("enforces session count, expires old handles and clears the service timer on close", async () => {
    vi.useFakeTimers();
    const h = fixture();
    try {
      const first = await h.sessions.open(proofA, "page");
      for (let index = 1; index < 16; index++) await h.sessions.open(proofA, "page");
      await expect(h.sessions.open(proofA, "page")).rejects.toMatchObject({ code: "unavailable" });
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(h.sessions.read(proofA, first.ticket)).rejects.toMatchObject({
        code: "unavailable",
      });
      await h.sessions.open(proofA, "page");
      h.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.close();
      vi.useRealTimers();
    }
  });

  it("limits aggregate retained seed bytes even below the session-count limit", async () => {
    const h = fixture([p("x".repeat(180_000))]);
    try {
      const first = await h.sessions.open(proofA, "page");
      const capacity = Math.floor((2 * 1024 * 1024) / first.seed.length);
      expect(capacity).toBeLessThan(16);
      expect(capacity).toBeGreaterThan(1);
      for (let index = 1; index < capacity; index++) await h.sessions.open(proofA, "page");
      await expect(h.sessions.open(proofA, "page")).rejects.toMatchObject({ code: "unavailable" });
      expect(h.commits).toBe(0);
    } finally {
      h.close();
    }
  });

  it("accepts only a single-use mapped commit and never treats a second guest's private baseline as current", async () => {
    const h = fixture();
    try {
      const a = await h.sessions.open(proofA, "page"),
        b = await h.sessions.open(proofB, "page");
      const first = delta(a.seed, [p("A committed"), initial[1]]);
      const stale = delta(b.seed, [initial[0], p("B draft")]);
      await h.sessions.submit(proofA, a.ticket, first);
      await expect(h.sessions.submit(proofB, b.ticket, stale)).rejects.toMatchObject({
        code: "conflict",
      });
      const fresh = await h.sessions.open(proofB, "page");
      await h.sessions.submit(
        proofB,
        fresh.ticket,
        delta(fresh.seed, [p("A committed"), p("B fresh")]),
      );
      expect(readPageDoc(h.owner)).toEqual([p("A committed"), p("B fresh")]);
      expect(h.commits).toBe(2);
    } finally {
      h.close();
    }
  });
});
