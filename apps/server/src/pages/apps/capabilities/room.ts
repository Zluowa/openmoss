// FILE: room.ts
// Purpose: Server half of the `room` capability: live presence and events
// among the viewers who have one 应用页 open right now. Nothing is stored;
// a room lives in memory while someone is in it. Each window joins with a
// `join` stream (SSE through the 应用页 transport); `publish` and `presence`
// calls name that window's peer, which must belong to the same viewer.
// Topics may limit who publishes or receives by sharing level.
// Layer: Server pages/apps

import { randomUUID } from "node:crypto";

import {
  PAGE_APP_ROOM_MAX_EVENT_BYTES,
  PAGE_APP_ROOM_MAX_PEERS,
  PAGE_APP_ROOM_MAX_PRESENCE_BYTES,
  PAGE_APP_ROOM_MAX_TOPICS,
  type PageAppRoomEvent,
  type PageAppRoomPeer,
  type PageAppRoomTopicRule,
  type PageAppViewer,
  type PageAppViewerLevel,
} from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect, Queue, Stream } from "effect";

import { SlidingWindowLimiter } from "../extensions/mcpPolicy";
import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

const LEVELS: readonly PageAppViewerLevel[] = ["view", "interact", "admin", "owner"];
const TOPIC = /^[A-Za-z0-9_.:-]{1,64}$/u;
const EVENTS_PER_SECOND = 30;
/** Presence updates are coalesced to at most one broadcast per peer this often. */
const PRESENCE_MIN_MS = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code: string, message: string) => new PageAppCapabilityError(code, message);
const atLeast = (level: PageAppViewerLevel, needed: PageAppViewerLevel | undefined) =>
  LEVELS.indexOf(level) >= LEVELS.indexOf(needed ?? "view");

export function parseRoomTopics(config: unknown): Map<string, PageAppRoomTopicRule> | string {
  const out = new Map<string, PageAppRoomTopicRule>();
  if (config === undefined || config === null) return out;
  if (!isRecord(config)) return "room config must be an object.";
  if (config.topics === undefined) return out;
  if (!isRecord(config.topics)) return "room.topics must map topic names to rules.";
  const entries = Object.entries(config.topics);
  if (entries.length > PAGE_APP_ROOM_MAX_TOPICS)
    return `room.topics allows at most ${PAGE_APP_ROOM_MAX_TOPICS}.`;
  for (const [name, rule] of entries) {
    if (!TOPIC.test(name)) return `room topic "${name}" is not a valid name.`;
    if (!isRecord(rule)) return `room topic "${name}" needs { publish?, receive? }.`;
    for (const key of ["publish", "receive"] as const) {
      const value = rule[key];
      if (value !== undefined && !(LEVELS as readonly unknown[]).includes(value))
        return `room topic "${name}".${key} must be view, interact, admin or owner.`;
    }
    out.set(name, {
      ...(rule.publish ? { publish: rule.publish as PageAppViewerLevel } : {}),
      ...(rule.receive ? { receive: rule.receive as PageAppViewerLevel } : {}),
    });
  }
  return out;
}

interface Peer {
  readonly peerId: string;
  readonly viewer: PageAppViewer;
  readonly joinedAt: number;
  state: unknown;
  readonly emit: (event: PageAppRoomEvent) => void;
  lastPresenceAt: number;
  presenceTimer: ReturnType<typeof setTimeout> | null;
}

interface Room {
  readonly peers: Map<string, Peer>;
}

export interface PageAppRoomHub {
  readonly peerCount: (appId: string) => number;
}

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return Infinity;
  }
}

export function makeRoomCapability(
  deps: { readonly clock?: () => number } = {},
): PageAppServerCapability & {
  readonly hub: PageAppRoomHub;
} {
  const clock = deps.clock ?? Date.now;
  const rooms = new Map<string, Room>();
  const limiter = new SlidingWindowLimiter(1_000, clock);

  const peerView = (peer: Peer, self: string | null): PageAppRoomPeer => ({
    peerId: peer.peerId,
    viewerId: peer.viewer.id,
    name: peer.viewer.name,
    self: peer.peerId === self,
    state: peer.state,
    joinedAt: peer.joinedAt,
  });

  const broadcastPeers = (room: Room) => {
    for (const peer of room.peers.values())
      peer.emit({
        type: "peers",
        peers: [...room.peers.values()].map((other) => peerView(other, peer.peerId)),
      });
  };

  const findPeer = (ctx: PageAppServerCallContext, peerId: unknown) => {
    const room = rooms.get(ctx.app.id);
    const peer = typeof peerId === "string" ? room?.peers.get(peerId) : undefined;
    // A window may only speak as a peer of its own viewer.
    if (!room || !peer || peer.viewer.id !== ctx.viewer.id)
      throw fail("not_found", "You are not in this page's room; join first.");
    return { room, peer };
  };

  const call = (ctx: PageAppServerCallContext, method: string, raw: unknown) =>
    Effect.try({
      try: () => {
        const args = isRecord(raw) ? raw : {};
        const topics = parseRoomTopics(ctx.config);
        if (typeof topics === "string") throw fail("invalid_argument", topics);
        switch (method) {
          case "publish": {
            const { room, peer } = findPeer(ctx, args.peerId);
            const topic = args.topic;
            if (typeof topic !== "string" || !TOPIC.test(topic))
              throw fail("invalid_argument", "A topic is 1-64 letters, digits or _ . : -.");
            const rule = topics.get(topic);
            if (!atLeast(ctx.viewer.level, rule?.publish))
              throw fail("not_granted", `Your access to this page cannot publish to "${topic}".`);
            if (jsonSize(args.data) > PAGE_APP_ROOM_MAX_EVENT_BYTES)
              throw fail("too_large", "A room event is at most 16 KB.");
            if (!limiter.admit(peer.peerId, EVENTS_PER_SECOND))
              throw fail("resource_exhausted", "Too many room events; slow down.");
            const event: PageAppRoomEvent = {
              type: "event",
              topic,
              data: args.data ?? null,
              from: { peerId: peer.peerId, name: peer.viewer.name },
              at: clock(),
            };
            let delivered = 0;
            for (const other of room.peers.values()) {
              if (other.peerId === peer.peerId && args.echo !== true) continue;
              if (!atLeast(other.viewer.level, rule?.receive)) continue;
              other.emit(event);
              delivered += 1;
            }
            return { delivered };
          }
          case "presence": {
            const { room, peer } = findPeer(ctx, args.peerId);
            if (jsonSize(args.state) > PAGE_APP_ROOM_MAX_PRESENCE_BYTES)
              throw fail("too_large", "Presence state is at most 4 KB.");
            peer.state = args.state ?? null;
            const wait = PRESENCE_MIN_MS - (clock() - peer.lastPresenceAt);
            if (wait <= 0) {
              peer.lastPresenceAt = clock();
              broadcastPeers(room);
            } else if (!peer.presenceTimer) {
              peer.presenceTimer = setTimeout(() => {
                peer.presenceTimer = null;
                peer.lastPresenceAt = clock();
                if (room.peers.has(peer.peerId)) broadcastPeers(room);
              }, wait);
            }
            return { ok: true };
          }
          case "peers": {
            const room = rooms.get(ctx.app.id);
            return {
              peers: room ? [...room.peers.values()].map((peer) => peerView(peer, null)) : [],
            };
          }
          default:
            throw fail("invalid_argument", `room has no "${method}".`);
        }
      },
      catch: (error) =>
        error instanceof PageAppCapabilityError ? error : fail("unavailable", "The room failed."),
    });

  const join = (
    ctx: PageAppServerCallContext,
    raw: unknown,
  ): Stream.Stream<unknown, PageAppCapabilityError> => {
    const args = isRecord(raw) ? raw : {};
    const topics = parseRoomTopics(ctx.config);
    if (typeof topics === "string") return Stream.fail(fail("invalid_argument", topics));
    if (jsonSize(args.state) > PAGE_APP_ROOM_MAX_PRESENCE_BYTES)
      return Stream.fail(fail("too_large", "Presence state is at most 4 KB."));
    return Stream.callback<unknown, PageAppCapabilityError>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let room = rooms.get(ctx.app.id);
          if (!room) {
            room = { peers: new Map() };
            rooms.set(ctx.app.id, room);
          }
          if (room.peers.size >= PAGE_APP_ROOM_MAX_PEERS) return null;
          const peer: Peer = {
            peerId: randomUUID(),
            viewer: ctx.viewer,
            joinedAt: clock(),
            state: args.state ?? null,
            emit: (event) => {
              Queue.offerUnsafe(queue, event);
            },
            lastPresenceAt: 0,
            presenceTimer: null,
          };
          room.peers.set(peer.peerId, peer);
          peer.emit({
            type: "welcome",
            peerId: peer.peerId,
            peers: [...room.peers.values()].map((other) => peerView(other, peer.peerId)),
          });
          for (const other of room.peers.values())
            if (other.peerId !== peer.peerId)
              other.emit({
                type: "peers",
                peers: [...room.peers.values()].map((p) => peerView(p, other.peerId)),
              });
          return { room, peer };
        }),
        (joined) =>
          Effect.sync(() => {
            if (!joined) return;
            const { room, peer } = joined;
            if (peer.presenceTimer) clearTimeout(peer.presenceTimer);
            room.peers.delete(peer.peerId);
            if (room.peers.size === 0) rooms.delete(ctx.app.id);
            else broadcastPeers(room);
          }),
      ).pipe(
        Effect.flatMap((joined) =>
          joined
            ? Effect.void
            : Effect.fail(fail("resource_exhausted", "This page's room is full.")),
        ),
      ),
    );
  };

  return {
    name: "room",
    consent: "standing",
    validateConfig: (config) => {
      const parsed = parseRoomTopics(config);
      return typeof parsed === "string" ? parsed : null;
    },
    call,
    watch: (ctx, method, args) =>
      method === "join"
        ? join(ctx, args)
        : Stream.fail(fail("invalid_argument", `room has no "${method}".`)),
    hub: { peerCount: (appId) => rooms.get(appId)?.peers.size ?? 0 },
  };
}
