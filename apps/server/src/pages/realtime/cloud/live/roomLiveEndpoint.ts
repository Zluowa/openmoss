import { type RawData, WebSocket } from "ws";
import {
  createRoomEnvelopeAuthority,
  type RoomKeyProvider,
  type RoomFrameReceiver,
} from "../roomEnvelope";
import {
  copyFrame,
  envelopeRecord,
  RoomEnvelopeError,
  ROOM_ENVELOPE_LIMITS,
  roomIdentity,
  streamIdentity,
  type RoomBinding,
} from "../roomEnvelopeProtocol";
import { copyOrdinaryByteView, ordinaryByteViewLength } from "../../ordinaryByteView";
import {
  bundleFromPacket,
  encodePacket,
  decodePacket,
  CHECKPOINT_PACKET_BYTES,
} from "../control/roomCiphertextStore";
import { keyRef, reject, verified } from "../control/roomControlProtocol";
import {
  createLivePair,
  frameProof,
  type LivePairGrant,
  type LiveStreamOffer,
} from "./roomLiveAdmission";
import { MAX_LIVE_BYTES, type LiveKind, type LiveRoomAdapter } from "./roomLiveYjs";

const WIRE_CAP = 2 + CHECKPOINT_PACKET_BYTES;
export interface LiveSocket {
  send(bytes: Uint8Array): void;
  buffered(): number;
  close(code: number): void;
  onMessage(call: (data: unknown) => void): () => void;
  onClose(call: () => void): () => void;
}
export interface RoomLiveConfig {
  room: RoomBinding;
  keys: RoomKeyProvider;
  capture(room: RoomBinding): LivePairGrant | null;
  socket: LiveSocket;
  adapter: LiveRoomAdapter;
  /** A host cache is a hint to the separately authorized P3 recovery path only. */
  checkpointAvailable?: () => void;
}
interface HeldFrame {
  bytes: Uint8Array<ArrayBuffer>;
  done: (ok: boolean) => void;
}
const limit = () => {
  let start = performance.now(),
    count = 0,
    total = 0;
  return (n: number) => {
    const now = performance.now();
    if (now - start >= 1000) {
      start = now;
      count = 0;
      total = 0;
    }
    count++;
    total += n;
    return count <= 96 && total <= 512 * 1024;
  };
};
export async function openRoomLiveEndpoint(config?: RoomLiveConfig) {
  if (!config) return null;
  const c = config,
    core = createRoomEnvelopeAuthority(c.keys),
    stop = new AbortController(),
    unsub: Array<() => void> = [];
  let grant: LivePairGrant | null = null,
    closed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let applied = 0,
    replays = 0;
  let remote: LiveStreamOffer["descriptor"] | undefined,
    receiving = false,
    admitting = false,
    open = false,
    outgoing = 0,
    heldBytes = 0;
  const held: HeldFrame[] = [],
    receivers = new Map<string, RoomFrameReceiver>();
  const ingress = limit(),
    egress = limit();
  let sendTail = Promise.resolve();
  function close(code = 1000) {
    if (closed) return;
    closed = true;
    stop.abort();
    if (timer) clearTimeout(timer);
    for (const undo of unsub.splice(0))
      try {
        undo();
      } catch {}
    for (const h of held.splice(0)) h.done(false);
    heldBytes = 0;
    try {
      c.adapter.close();
    } catch {}
    core.close();
    try {
      grant?.release();
    } catch {}
    try {
      c.socket.close(code);
    } catch {}
  }
  try {
    grant = c.capture(c.room);
    if (!grant || roomIdentity(grant.room) !== roomIdentity(c.room)) return reject();
    const g = grant,
      expires = g.expiresAt,
      localRole = g.localRole,
      peerMode = g.peerMode;
    if (!Number.isFinite(expires) || expires - performance.now() > 60_000) return reject();
    function check() {
      if (closed || g.revoked.aborted || performance.now() >= expires) return reject();
      g.assertCurrent();
      if (closed || g.revoked.aborted || performance.now() >= expires) return reject();
    }
    check();
    const cancel = () => close(1008);
    g.revoked.addEventListener("abort", cancel, { once: true });
    unsub.push(() => g.revoked.removeEventListener("abort", cancel));
    unsub.push(c.socket.onClose(() => close()));
    timer = setTimeout(cancel, Math.max(0, expires - performance.now()));
    timer.unref?.();
    const lease = await core.acquireRoom(c.room, stop.signal);
    check();
    const revoked = core.revocationSignal(lease);
    revoked.addEventListener("abort", cancel, { once: true });
    unsub.push(() => revoked.removeEventListener("abort", cancel));
    const id = keyRef(g.localSigningKey);
    const sync = await core.createWriter(lease, id, "live-update", stop.signal),
      awareness = await core.createWriter(lease, id, "awareness", stop.signal);
    const pair = createLivePair(g, sync.stream, awareness.stream, c.adapter.awarenessId);
    check();
    const seq = { sync: 0, awareness: 0 };
    function transmit(kind: LiveKind, data: Uint8Array) {
      if (closed) return;
      const n = ordinaryByteViewLength(data);
      if (
        !open ||
        !remote ||
        n === null ||
        n < 1 ||
        n > MAX_LIVE_BYTES ||
        outgoing >= 8 ||
        !egress(n)
      ) {
        close(1013);
        return;
      }
      const body = copyOrdinaryByteView(data, MAX_LIVE_BYTES, 1);
      if (!body) {
        close(1008);
        return;
      }
      outgoing++;
      sendTail = sendTail
        .then(async () => {
          check();
          core.assertCurrent(lease);
          const writer = kind === "sync" ? sync : awareness,
            number = seq[kind]++;
          const signature = Buffer.from(
            pair.sign(frameProof(pair.local, remote!, writer.stream, kind, number, body)),
            "base64url",
          );
          const frame = await writer.seal(kind, Buffer.concat([signature, body]), stop.signal);
          check();
          if (frame.seq !== number) return reject();
          const { ciphertext, ...meta } = frame;
          const bytes = Buffer.concat([Buffer.from([1, 1]), encodePacket(meta, ciphertext)]);
          if (c.socket.buffered() + bytes.length > 512 * 1024) return reject();
          c.socket.send(bytes);
        })
        .catch(() => close(1013))
        .finally(() => {
          outgoing--;
          body.fill(0);
        });
    }
    function credit(n: number) {
      const ack = Buffer.alloc(6);
      ack[0] = 1;
      ack[1] = 3;
      ack.writeUInt32BE(n, 2);
      c.socket.send(ack);
    }
    let admissions = 0,
      answered: string | undefined;
    function sendAdmission(type: "offer" | "answer", offer?: LiveStreamOffer) {
      check();
      const local = pair.local;
      const frame = {
        v: 1,
        type,
        from: local.from,
        to: local.to,
        offer: pair.offer,
        ...(offer ? { answer: pair.answer(offer) } : {}),
      };
      const body = Buffer.from(JSON.stringify(frame));
      if (body.length > 4096 || c.socket.buffered() + body.length + 2 > 512 * 1024) return reject();
      c.socket.send(Buffer.concat([Buffer.from([1, 4]), body]));
    }
    async function admit(offer: LiveStreamOffer, response: string) {
      check();
      if (open || admitting) return reject();
      const candidate = pair.admit(offer, response);
      admitting = true;
      try {
        remote = candidate;
        for (const stream of [remote.sync, remote.awareness]) {
          const r = await core.createReceiver(lease, stream, stop.signal);
          check();
          receivers.set(stream.streamId, r);
        }
        open = true;
        c.adapter.open(transmit, remote.awarenessId, peerMode, () => close(1008));
        drain();
      } catch {
        close(1008);
        return reject();
      }
    }
    async function handshake(bytes: Uint8Array): Promise<boolean> {
      if (bytes.length > 4098) return false;
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(2)),
      );
      const type =
        value && typeof value === "object"
          ? Object.getOwnPropertyDescriptor(value, "type")?.value
          : null;
      if (type !== "offer" && type !== "answer") return false;
      const f = envelopeRecord(
        value,
        type === "offer"
          ? ["v", "type", "from", "to", "offer"]
          : ["v", "type", "from", "to", "offer", "answer"],
      );
      if (f.v !== 1 || f.from !== pair.local.to || f.to !== pair.local.from || ++admissions > 16)
        return false;
      const offer = f.offer as LiveStreamOffer;
      // A valid offer alone cannot activate a stream. The response must also
      // prove possession of the enrolled key for this fresh two-sided channel.
      const proof = pair.answer(offer);
      if (open && remote?.nonce !== offer.descriptor.nonce) return false;
      if (type === "answer" && !open && !admitting) {
        if (typeof f.answer !== "string") return false;
        await admit(offer, f.answer);
      }
      if (answered !== proof) {
        answered = proof;
        sendAdmission("answer", offer);
      }
      return true;
    }
    async function consume(bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
      check();
      if (!remote || !open) return false;
      if (bytes[0] !== 1) return false;
      if (bytes[1] !== 1) return false;
      const packet = decodePacket(
        Buffer.from(bytes.buffer, bytes.byteOffset + 2, bytes.length - 2),
      );
      const fields = envelopeRecord(packet.meta, ["v", "suite", "stream", "seq", "kind"]);
      const frame = copyFrame({ ...fields, ciphertext: packet.ciphertext }, ROOM_ENVELOPE_LIMITS);
      if (frame.kind !== "sync" && frame.kind !== "awareness") return false;
      const trusted = frame.kind === "sync" ? remote.sync : remote.awareness;
      if (streamIdentity(frame.stream) !== streamIdentity(trusted)) return false;
      const receiver = receivers.get(trusted.streamId);
      if (!receiver) return false;
      const prepared = await receiver.prepare(frame, stop.signal);
      let clear: Uint8Array<ArrayBuffer> | undefined;
      try {
        check();
        clear = prepared.payload;
        if (clear.length <= 64 || clear.length > MAX_LIVE_BYTES + 64) return false;
        const signature = Buffer.from(clear.buffer, clear.byteOffset, 64).toString("base64url");
        const body = clear.subarray(64);
        if (
          !verified(
            pair.peer,
            frameProof(remote, pair.local, trusted, frame.kind, frame.seq, body),
            signature,
          )
        )
          return false;
        const apply = c.adapter.stage(frame.kind, body);
        check();
        prepared.commit();
        check();
        try {
          apply();
          check();
        } catch {
          close(1011);
          return false;
        }
        return true;
      } finally {
        clear?.fill(0);
        prepared.abort();
      }
    }
    function drain() {
      if (!open || receiving || closed) return;
      receiving = true;
      void (async () => {
        try {
          while (held.length && !closed) {
            const item = held.shift()!;
            heldBytes -= item.bytes.length;
            try {
              const ok = await consume(item.bytes);
              if (ok) applied++;
              item.done(ok);
            } catch (error) {
              if (error instanceof RoomEnvelopeError && error.code === "replayed") replays++;
              item.done(false);
            }
          }
        } finally {
          receiving = false;
        }
      })();
    }
    function receive(input: unknown): Promise<boolean> {
      const size = ordinaryByteViewLength(input);
      if (
        closed ||
        size === null ||
        size < 2 ||
        size > WIRE_CAP ||
        held.length >= 8 ||
        size + heldBytes > 512 * 1024 ||
        !ingress(size)
      ) {
        close(1013);
        return Promise.resolve(false);
      }
      const copy = copyOrdinaryByteView(input, WIRE_CAP, 2);
      if (!copy) {
        close(1008);
        return Promise.resolve(false);
      }
      if (copy[0] !== 1 || (copy[1] !== 1 && copy[1] !== 2 && copy[1] !== 4)) {
        close(1008);
        return Promise.resolve(false);
      }
      if (copy[1] === 1 && size > MAX_LIVE_BYTES + 2048) {
        close(1013);
        return Promise.resolve(false);
      }
      try {
        check();
        credit(size);
      } catch {
        close(1008);
        return Promise.resolve(false);
      }
      if (copy[1] === 4) return handshake(copy).catch(() => false);
      if (copy[1] === 2) {
        if (localRole !== "peer") return Promise.resolve(false);
        try {
          const packet = decodePacket(Buffer.from(copy.buffer, copy.byteOffset + 2, size - 2));
          const bundle = bundleFromPacket(packet.meta, packet.ciphertext);
          if (
            roomIdentity(bundle.room) !== roomIdentity(lease.binding) ||
            bundle.checkpoint.stream.senderRef !== pair.local.to
          )
            return Promise.resolve(false);
          // Before or after live handshake, only notify the independent recovery
          // path. Neither these bytes nor a relay's claimed revision touch the doc.
          c.checkpointAvailable?.();
          return Promise.resolve(true);
        } catch {
          return Promise.resolve(false);
        }
      }
      const result = new Promise<boolean>((done) => {
        held.push({ bytes: copy, done });
        heldBytes += size;
      });
      drain();
      return result;
    }
    unsub.push(
      c.socket.onMessage((data) => {
        void receive(data);
      }),
    );
    sendAdmission("offer");
    return Object.freeze({
      get ready() {
        return open && !closed;
      },
      get activity() {
        return Object.freeze({ applied, replays });
      },
      receive,
      close: () => close(),
    });
  } catch {
    close(1008);
    return reject();
  }
}

/** Desktop/server transport; credentials go only in the headers of the real
 * direct loopback host/peer route, never in a guest link or a query string. */
export async function connectRoomLiveSocket(
  origin: string,
  room: RoomBinding,
  role: "host" | "peer",
  token: string,
  hostKey?: string,
  signal?: AbortSignal,
): Promise<LiveSocket> {
  const base = new URL(origin);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    !base.port ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(room.roomId) ||
    !/^[\x21-\x7e]{1,16384}$/u.test(token) ||
    (role === "host"
      ? !hostKey || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(hostKey)
      : hostKey !== undefined)
  )
    return reject();
  const url = new URL(`/v1/page-rooms/${room.roomId}/${role}`, base);
  url.protocol = "ws:";
  if (signal?.aborted) return reject();
  const socket = new WebSocket(url, {
    headers: {
      authorization: "Bearer " + token,
      ...(hostKey ? { "x-moss-page-room-host-key": hostKey } : {}),
    },
    perMessageDeflate: false,
    maxPayload: WIRE_CAP,
    handshakeTimeout: 5000,
    followRedirects: false,
  });
  const cancel = () => socket.terminate();
  signal?.addEventListener("abort", cancel, { once: true });
  socket.once("close", () => signal?.removeEventListener("abort", cancel));
  let target: ((value: unknown) => void) | undefined,
    waitingBytes = 0;
  const waiting: Uint8Array<ArrayBuffer>[] = [];
  socket.on("message", (data: RawData, binary: boolean) => {
    const n = binary ? ordinaryByteViewLength(data) : null;
    if (n === null || n < 2 || n > WIRE_CAP) {
      socket.close(1008, "invalid room message");
      return;
    }
    if (target) {
      target(data);
      return;
    }
    if (waiting.length >= 8 || waitingBytes + n > 512 * 1024) {
      socket.close(1013, "room setup budget");
      return;
    }
    const bytes = copyOrdinaryByteView(data, WIRE_CAP, 2);
    if (!bytes) {
      socket.close(1008, "invalid room bytes");
      return;
    }
    waiting.push(bytes);
    waitingBytes += n;
  });
  await new Promise<void>((resolve, fail) => {
    const error = () => {
      socket.off("open", ready);
      fail(new Error("Room WS unavailable"));
    };
    const ready = () => {
      socket.off("error", error);
      resolve();
    };
    socket.once("open", ready);
    socket.once("error", error);
  });
  socket.on("error", () => {
    socket.terminate();
  });
  return {
    send(bytes) {
      if (socket.readyState !== WebSocket.OPEN) return reject();
      socket.send(bytes, { binary: true });
    },
    buffered: () => socket.bufferedAmount,
    close(code) {
      socket.close(code, "room endpoint closed");
    },
    onMessage(fn) {
      if (target) return reject();
      target = fn;
      for (const bytes of waiting.splice(0)) fn(bytes);
      waitingBytes = 0;
      return () => {
        target = undefined;
        waiting.length = 0;
        waitingBytes = 0;
      };
    },
    onClose(fn) {
      socket.on("close", fn);
      if (socket.readyState > WebSocket.OPEN) fn();
      return () => {
        socket.off("close", fn);
      };
    },
  };
}
