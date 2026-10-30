import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  mossServerMutationKeys,
  mossServerQueryKeys,
} from "~/components/auth/mossServerReactQuery";
import { leaseOpenUIFormState, type OpenUIFormScope } from "./openUIFormState";

const scope: OpenUIFormScope = {
  threadId: "synthetic-thread",
  messageId: "synthetic-message",
  segmentIndex: undefined,
  blockOffset: 0,
  code: "Aa",
};
function owner(client: QueryClient, id = "synthetic-a", realm = "cn") {
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    activeRealm: realm,
    session: { user: { id } },
  });
}
function fixture() {
  const client = new QueryClient();
  owner(client);
  return client;
}

describe("OpenUI remount form isolation", () => {
  it("separates client, message segment, block and exact program without hash collisions", () => {
    const client = fixture();
    leaseOpenUIFormState(client, scope).write({ value: "synthetic draft" });
    expect(leaseOpenUIFormState(client, scope).read()).toEqual({ value: "synthetic draft" });
    for (const other of [
      { ...scope, segmentIndex: 0 },
      { ...scope, blockOffset: 1 },
      // Same length and djb2 hash as Aa in the former program-only cache.
      { ...scope, code: "B@" },
    ])
      expect(leaseOpenUIFormState(client, other).read()).toBeUndefined();
    expect(leaseOpenUIFormState(fixture(), scope).read()).toBeUndefined();
  });

  it("revokes old callbacks across account changes and clearing/reloading the auth cache", () => {
    const client = fixture();
    const original = leaseOpenUIFormState(client, scope);
    original.write({ value: "private a" });
    owner(client, "synthetic-b");
    const next = leaseOpenUIFormState(client, scope);
    expect(next.rendererKey).not.toBe(original.rendererKey);
    expect(next.read()).toBeUndefined();
    original.write({ value: "late a" });
    expect(next.read()).toBeUndefined();
    client.clear();
    expect(leaseOpenUIFormState(client, scope).read()).toBeUndefined();
    owner(client);
    original.write({ value: "older a" });
    expect(leaseOpenUIFormState(client, scope).read()).toBeUndefined();
  });

  it("invalidates A-to-B-to-A leases without a frame render or intervening cache read", () => {
    const client = fixture();
    const old = leaseOpenUIFormState(client, scope);
    old.write({ value: "prior a" });
    owner(client, "synthetic-b");
    owner(client);
    const next = leaseOpenUIFormState(client, scope);
    expect(next.rendererKey).not.toBe(old.rendererKey);
    old.write({ value: "late a" });
    expect(next.read()).toBeUndefined();
    client.clear();
    owner(client);
    next.write({ value: "late after sign out" });
    expect(leaseOpenUIFormState(client, scope).read()).toBeUndefined();
  });

  it("does not save with incomplete scope or while an account transition is pending", async () => {
    const client = fixture();
    for (const incomplete of [
      { ...scope, messageId: undefined },
      { ...scope, threadId: undefined },
      { ...scope, blockOffset: undefined },
    ]) {
      leaseOpenUIFormState(client, incomplete).write({ value: "unbound" });
      expect(leaseOpenUIFormState(client, incomplete).read()).toBeUndefined();
    }
    const original = leaseOpenUIFormState(client, scope);
    original.write({ value: "prior" });
    let resolve!: () => void;
    const mutation = client.getMutationCache().build(client, {
      mutationKey: mossServerMutationKeys.mossSelectRealm(),
      mutationFn: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    });
    const pending = mutation.execute(undefined);
    await Promise.resolve();
    const transition = leaseOpenUIFormState(client, scope);
    original.write({ value: "late" });
    transition.write({ value: "pending" });
    expect(transition.read()).toBeUndefined();
    resolve();
    await pending;
    expect(leaseOpenUIFormState(client, scope).read()).toBeUndefined();
  });

  it("evicts only the least recently used entry after fifty scoped drafts", () => {
    const client = fixture();
    for (let i = 0; i < 50; i++)
      leaseOpenUIFormState(client, { ...scope, blockOffset: i }).write({ i });
    expect(leaseOpenUIFormState(client, scope).read()).toEqual({ i: 0 });
    leaseOpenUIFormState(client, { ...scope, blockOffset: 50 }).write({ i: 50 });
    expect(leaseOpenUIFormState(client, { ...scope, blockOffset: 1 }).read()).toBeUndefined();
    expect(leaseOpenUIFormState(client, scope).read()).toEqual({ i: 0 });
  });

  it("keeps streaming identity stable without restoring or persisting incomplete program drafts", () => {
    const client = fixture();
    const complete = leaseOpenUIFormState(client, scope);
    complete.write({ value: "complete draft" });
    const streaming = leaseOpenUIFormState(client, { ...scope, isStreaming: true });
    expect(streaming.read()).toBeUndefined();
    streaming.write({ value: "incomplete overwrite" });
    expect(complete.read()).toEqual({ value: "complete draft" });
    const appended = leaseOpenUIFormState(client, {
      ...scope,
      code: "Aa\nmore",
      isStreaming: true,
    });
    expect(appended.rendererKey).toBe(streaming.rendererKey);
    expect(complete.rendererKey).not.toBe(streaming.rendererKey);
    appended.write({ value: "stream only" });
    expect(leaseOpenUIFormState(client, { ...scope, code: "Aa\nmore" }).read()).toBeUndefined();
  });
});
