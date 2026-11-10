import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  GUEST_ROUTES,
  guestApiPath,
  PAGE_GUEST_LINK_PARAM,
  type PageGuestEditOpenResult,
} from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Harness } from "../../sharing/PageSharingServiceLive.test";
import { applyPlateValue, readPageDoc } from "../../realtime/pageYjsContent";

const origin = process.env.MOSS_TEST_G3_LOOPBACK_ORIGIN;
const visitor = "loopback-edit-visitor";
const paragraph = (text: string) => ({ type: "p", children: [{ text }] });
const content = "共同编辑的公开段落";

async function setup(h: Harness) {
  if (!origin || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin))
    throw new Error("The fixture requires an explicit IPv4 loopback relay.");
  h.relayEnv.MOSS_SHARE_RELAY_URL = origin;
  h.relayEnv.MOSS_SHARE_RELAY_DEV_BEARER = "local-fixture-owner";
  const page = await h.createPage("协作验收页", "", {
    richContent: JSON.stringify([paragraph(content)]),
  });
  const target = { kind: "page" as const, id: page.id };
  const initial = await h.run(h.sharing.get({ scopeSpaceId: null, target }));
  await h.run(
    h.sharing.mutate({
      op: "set-link",
      scopeSpaceId: null,
      target,
      expectedVersion: initial.version,
      setting: { access: "link", role: "edit" },
    }),
  );
  const state = await vi.waitFor(
    async () => {
      const current = await h.run(h.sharing.get({ scopeSpaceId: null, target }));
      if (!current.linkUrl || current.relayStatus !== "online")
        throw new Error("Waiting for the local owner connection");
      return current;
    },
    { timeout: 6000, interval: 50 },
  );
  const url = new URL(state.linkUrl!);
  if (url.origin !== origin) throw new Error("Unexpected test publisher origin");
  const shareId = url.pathname.split("/")[2]!;
  const entry = {
    visitor,
    ...(url.searchParams.get(PAGE_GUEST_LINK_PARAM)
      ? { link: url.searchParams.get(PAGE_GUEST_LINK_PARAM)! }
      : {}),
    ...(url.hash ? { key: decodeURIComponent(url.hash.slice(1)) } : {}),
  };
  const raw = (
    route: Parameters<typeof guestApiPath>[1],
    body: unknown,
    signal?: AbortSignal,
    source = origin,
  ) =>
    fetch(origin + guestApiPath(shareId, route), {
      method: "POST",
      headers: {
        origin: source!,
        "content-type": "application/json",
        accept: route === GUEST_ROUTES.pageEditEvents ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(6000),
    });
  const post = (
    route: Parameters<typeof guestApiPath>[1],
    extra: object = {},
    signal?: AbortSignal,
  ) => raw(route, { v: 1, pageId: page.id, entry, ...extra }, signal);
  const open = async () => {
    const response = await post(GUEST_ROUTES.pageEditOpen);
    expect(response.status).toBe(200);
    return (await response.json()) as PageGuestEditOpenResult;
  };
  const downgrade = async () => {
    const before = await h.run(h.sharing.get({ scopeSpaceId: null, target }));
    await h.run(
      h.sharing.mutate({
        op: "set-link",
        scopeSpaceId: null,
        target,
        expectedVersion: before.version,
        setting: { access: "link", role: "view" },
      }),
    );
  };
  return { page, state, raw, post, open, downgrade, entry, url };
}

function change(seed: string, text: string) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(seed, "base64url"));
    expect(readPageDoc(doc)).toEqual([paragraph(content)]);
    const vector = Y.encodeStateVector(doc);
    applyPlateValue(doc, [paragraph(text)], null);
    return Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64url");
  } finally {
    doc.destroy();
  }
}

async function nextEvent(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  state: { text: string },
) {
  for (;;) {
    const end = state.text.indexOf("\n\n");
    if (end >= 0) {
      const event = state.text.slice(0, end);
      state.text = state.text.slice(end + 2);
      if (event.startsWith("data: ")) return JSON.parse(event.slice(6));
      continue;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("The stream ended before its control event");
    state.text += new TextDecoder().decode(chunk.value);
    if (state.text.length > 16384) throw new Error("Stream data exceeded its budget");
  }
}

export function registerGuestEditRelayCases(harness: () => Harness) {
  describe.skipIf(!origin)("G3 real loopback relay with SQLite owner", () => {
    it("admits a published seed, refreshes an existing stream after a durable edit, and closes explicitly", async () => {
      const h = harness(),
        x = await setup(h);
      const view = await x.raw(GUEST_ROUTES.page, { ...x.entry, pageId: x.page.id });
      expect(await view.json()).toMatchObject({ role: "edit", editProjection: { v: 1 } });
      const first = await x.open(),
        second = await x.open();
      const bytes = change(first.seed, "访客已保存");
      const stream = await x.post(GUEST_ROUTES.pageEditEvents, { ticket: second.ticket });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body!.getReader(),
        state = { text: "" };
      expect(await nextEvent(reader, state)).toEqual({ v: 1, type: "ready", revision: 1 });
      const update = async () =>
        await x.post(GUEST_ROUTES.pageEditUpdate, { ticket: first.ticket, update: bytes });
      expect(await (await update()).json()).toEqual({ v: 1, applied: true, revision: 2 });
      expect(await nextEvent(reader, state)).toEqual({ v: 1, type: "refresh" });
      expect((await reader.read()).done).toBe(true);
      expect(await (await update()).json()).toEqual({ v: 1, applied: true, revision: 2 });
      expect(
        (
          await x.post(GUEST_ROUTES.pageEditUpdate, {
            ticket: second.ticket,
            update: change(second.seed, "旧草稿"),
          })
        ).status,
      ).toBe(409);
      const rows = await h.run(
        h.sql<{
          revision: number;
          author: string;
          rich_content: string;
        }>`SELECT revision,author,rich_content FROM pages_versions WHERE page_id=${x.page.id} ORDER BY revision`,
      );
      expect(rows.map((row) => row.revision)).toEqual([1, 2]);
      expect(rows[1]?.author).toBe("guest");
      expect(rows[1]?.rich_content).toContain("访客已保存");
      const close = await x.post(GUEST_ROUTES.pageEditClose, { ticket: first.ticket });
      expect(close.status).toBe(204);
      expect(await close.text()).toBe("");
      expect((await update()).status).toBe(404);
    });
    it("releases a canceled HTTP stream and ends its replacement when actual SQLite permission is downgraded", async () => {
      const x = await setup(harness()),
        opened = await x.open();
      const a = new AbortController();
      const response = await x.post(
        GUEST_ROUTES.pageEditEvents,
        { ticket: opened.ticket },
        a.signal,
      );
      const reader = response.body!.getReader();
      expect(await nextEvent(reader, { text: "" })).toEqual({ v: 1, type: "ready", revision: 1 });
      expect((await x.post(GUEST_ROUTES.pageEditEvents, { ticket: opened.ticket })).status).toBe(
        429,
      );
      a.abort();
      await reader.cancel().catch(() => undefined);
      const next = await vi.waitFor(
        async () => {
          const response = await x.post(GUEST_ROUTES.pageEditEvents, { ticket: opened.ticket });
          if (response.status !== 200) {
            await response.body?.cancel();
            throw new Error("waiting for stream cancellation");
          }
          return response;
        },
        { timeout: 2000, interval: 30 },
      );
      const nextReader = next.body!.getReader(),
        state = { text: "" };
      expect(await nextEvent(nextReader, state)).toEqual({ v: 1, type: "ready", revision: 1 });
      await x.downgrade();
      expect(await nextEvent(nextReader, state)).toEqual({ v: 1, type: "ended" });
      expect((await nextReader.read()).done).toBe(true);
      const denied = await x.post(GUEST_ROUTES.pageEditUpdate, {
        ticket: opened.ticket,
        update: "AAA",
      });
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ reason: "unavailable" });
      expect((await x.post(GUEST_ROUTES.pageEditOpen)).status).toBe(404);
    });
    it("refuses requests with the wrong origin, bad proof, another page binding and excessive JSON", async () => {
      const h = harness(),
        x = await setup(h);
      const other = await h.createPage("私有测试页", "", {
        richContent: JSON.stringify([paragraph("私有段落")]),
      });
      const opened = await x.open();
      expect(
        (
          await x.raw(
            GUEST_ROUTES.pageEditOpen,
            { v: 1, pageId: x.page.id, entry: x.entry },
            undefined,
            "https://elsewhere.example",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await x.raw(GUEST_ROUTES.pageEditOpen, {
            v: 1,
            pageId: x.page.id,
            entry: { ...x.entry, key: "forged-fixture-proof" },
          })
        ).status,
      ).toBe(404);
      const wrong = await x.post(GUEST_ROUTES.pageEditUpdate, {
        ticket: opened.ticket,
        entry: { ...x.entry, key: "forged-fixture-proof" },
        update: "AAA",
      });
      expect(wrong.status).toBe(404);
      expect(await wrong.json()).toEqual({ reason: "unavailable" });
      expect(
        (await x.post(GUEST_ROUTES.pageEditClose, { ticket: opened.ticket, pageId: other.id }))
          .status,
      ).toBe(404);
      expect((await x.post(GUEST_ROUTES.pageEditOpen, { padding: "a".repeat(4100) })).status).toBe(
        413,
      );
      expect((await x.post(GUEST_ROUTES.pageEditClose, { ticket: opened.ticket })).status).toBe(
        204,
      );
    });
    it.skipIf(!process.env.MOSS_TEST_G3_BROWSER_DIRECTORY)(
      "holds a private browser fixture until its authorized local stop",
      async () => {
        const h = harness(),
          x = await setup(h);
        const directory = path.resolve(process.env.MOSS_TEST_G3_BROWSER_DIRECTORY!);
        const manifest = path.join(directory, "connection.json"),
          command = path.join(directory, "command.json"),
          ack = path.join(directory, "ack.json");
        const token = randomBytes(32).toString("hex");
        await fs.writeFile(
          manifest,
          JSON.stringify({ url: x.url.href, pageId: x.page.id, control: token }),
          { flag: "wx", mode: 0o600 },
        );
        try {
          const deadline = Date.now() + 240_000;
          while (Date.now() < deadline) {
            let action: { control?: string; action?: string } = {};
            try {
              action = JSON.parse(await fs.readFile(command, "utf8"));
            } catch {
              await delay(80);
              continue;
            }
            await fs.rm(command, { force: true });
            if (
              typeof action.control !== "string" ||
              !/^[a-f0-9]{64}$/.test(action.control) ||
              !timingSafeEqual(Buffer.from(token), Buffer.from(action.control))
            )
              continue;
            if (action.action === "stop" || action.action === "done") return;
            if (action.action === "revoke") {
              await x.downgrade();
              await fs.writeFile(ack, JSON.stringify({ downgraded: true }), { mode: 0o600 });
            }
          }
          throw new Error("Local browser fixture timed out");
        } finally {
          await Promise.all([manifest, command, ack].map((file) => fs.rm(file, { force: true })));
        }
      },
      255_000,
    );
  });
}
