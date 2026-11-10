import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyPlateValue, readPageDoc, seedPageDoc } from "../realtime/pageYjsContent";
import {
  makeGuestProjectionSessions,
  type ProjectionBackend,
  type ProjectionPage,
} from "./guestProjectionSessions";

const p = (text: string) => ({ type: "p", children: [{ text }] });
const proof = "fixture-only-share-proof";
const visible = [p("Visible published paragraph.")];

function authority(publishedRich: string, ownerState: Uint8Array): ProjectionPage {
  return {
    mode: "share",
    role: "edit",
    kind: "page",
    pageId: "page",
    scope: null,
    actorRef: "a".repeat(64),
    grantEpoch: "authority-1",
    generation: "generation-1",
    revision: 1,
    publishedRich,
    ownerState,
  };
}

describe("guest-only Page projection", () => {
  it("defers SSE revalidation at the operation limit without ending an admitted ticket", async () => {
    const owner = new Y.Doc();
    seedPageDoc(owner, visible);
    const page = authority(JSON.stringify(visible), Y.encodeStateAsUpdate(owner));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    const sessions = makeGuestProjectionSessions<string>({
      readCurrent: async () => {
        if (hold) await blocked;
        return page;
      },
      readIdentity: async () => page,
      commitAuthorized: async () => {
        throw new Error("Unexpected write");
      },
    });
    const signal = new AbortController().signal;
    let waiting: Array<Promise<unknown>> = [];
    try {
      const opened = await sessions.open(proof, "page");
      const observation = await sessions.observe(proof, "page", opened.ticket, signal);
      hold = true;
      waiting = Array.from({ length: 4 }, () => sessions.open(proof, "page"));
      expect(await observation.check(signal)).toBe("wait");
      release();
      await Promise.all(waiting);
      expect(await observation.check(signal)).toBe("ready");
    } finally {
      release();
      await Promise.allSettled(waiting);
      sessions.close();
      owner.destroy();
    }
  });
  it("seeds only the current authorized text even when the actual owner bytes contain deleted, private and pending canaries", async () => {
    const owner = new Y.Doc({ gc: false });
    const guest = new Y.Doc();
    const old = "ZZZ_DELETED_OWNER_TEXT_ZZZ";
    const hidden = "PRIVATE_OWNER_APP_BINDING";
    const pending = "UNPUBLISHED_OWNER_DRAFT";
    const backend: ProjectionBackend<string> = {
      readCurrent: async (entry) => {
        if (entry !== proof) throw new Error("private credential diagnostics");
        return authority(JSON.stringify(visible), checkpoint);
      },
      commitAuthorized: async () => {
        throw new Error("A read cannot commit");
      },
    };
    const sessions = makeGuestProjectionSessions(backend);
    let checkpoint: Uint8Array;
    try {
      seedPageDoc(owner, [p(old)]);
      applyPlateValue(owner, visible, null);
      owner.getMap("private-owner-metadata").set("app-id", hidden);
      checkpoint = Y.encodeStateAsUpdate(owner);
      applyPlateValue(owner, [p(pending)], null);
      const unsafeOwnerWire = Buffer.from(Y.encodeStateAsUpdate(owner));
      for (const marker of [old, hidden, pending])
        expect(unsafeOwnerWire.includes(Buffer.from(marker))).toBe(true);
      const opened = await sessions.open(proof, "page");
      Y.applyUpdate(guest, opened.seed);
      expect(readPageDoc(guest)).toEqual(visible);
      expect([...guest.share.keys()]).toEqual(["content"]);
      for (const marker of [
        old,
        hidden,
        pending,
        proof,
        "authority-1",
        "generation-1",
        opened.ticket.sessionKey,
      ])
        expect(Buffer.from(opened.seed).includes(Buffer.from(marker))).toBe(false);
    } finally {
      sessions.close();
      owner.destroy();
      guest.destroy();
    }
  });
});
