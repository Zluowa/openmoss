import { bearerToken } from "@moss/shared/accountTokenVerifier";
import { envelopeRecord, roomIdentity, type RoomBinding } from "../roomEnvelopeProtocol";
import type { RecoveryBundle } from "../roomRecoveryProtocol";
import {
  CHECKPOINT_PACKET_BYTES,
  bundleFromPacket,
  decodePacket,
  encodePacket,
  sealedPacket,
} from "./roomCiphertextStore";
import type { openRoomControlService } from "./roomControlService";
import type { RoomControlTransport } from "./roomControlClient";
import { CONTROL_WIRE_BYTES, copyRequest, parseWire, reject, wire } from "./roomControlProtocol";

const PREFIX = "/internal/page-room/";
const TYPE = "application/octet-stream";
const JSON_TYPE = "application/json";
const headers = (mime: string) => ({
  "content-type": mime,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});
async function limitedBody(message: Request | Response, max: number): Promise<Buffer> {
  const size = message.headers.get("content-length");
  if (size !== null && (!/^(?:0|[1-9]\d{0,7})$/u.test(size) || Number(size) > max)) return reject();
  if (message.headers.has("content-encoding") || !message.body) return reject();
  const reader = message.body.getReader(),
    chunks: Buffer[] = [];
  let total = 0,
    expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 4_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (expired) return reject();
      if (done) break;
      if (value.byteLength > max - total) {
        await reader.cancel().catch(() => {});
        return reject();
      }
      total += value.byteLength;
      if (value.byteLength) chunks.push(Buffer.from(value));
    }
    if (size !== null && total !== Number(size)) return reject();
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
const jsonText = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const jsonResponse = (v: unknown) => new Response(wire(v), { headers: headers(JSON_TYPE) });
const fixedError = (status: number) =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });
type Service = NonNullable<ReturnType<typeof openRoomControlService>>;

/** Bound into NodeShareRelay.privatePageRoom only by explicit loopback composition.
 * One registry entry per trusted binding, each with its own durable authority file. */
export function privateRoomHttpHandler(
  entries: readonly { room: RoomBinding; service: Service }[],
) {
  const services = new Map(entries.map((e) => [roomIdentity(e.room), e.service]));
  if (!entries.length || services.size !== entries.length) return reject();
  let active = 0;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      path = url.pathname.slice(PREFIX.length);
    if (
      request.method !== "POST" ||
      !url.pathname.startsWith(PREFIX) ||
      !["challenge", "control", "publish", "fetch"].includes(path)
    )
      return fixedError(404);
    const token = bearerToken(request.headers);
    if (!token || active >= 8) return fixedError(token ? 429 : 401);
    const binary = path === "publish";
    if (request.headers.get("content-type") !== (binary ? TYPE : JSON_TYPE)) return fixedError(415);
    active++;
    try {
      const buf = await limitedBody(request, binary ? CHECKPOINT_PACKET_BYTES : CONTROL_WIRE_BYTES);
      const packet = binary ? decodePacket(buf) : null;
      const meta = packet ? packet.meta : parseWire(jsonText(buf));
      if (path === "challenge") {
        const r = copyRequest(meta),
          s = services.get(roomIdentity(r.room));
        if (!s) return fixedError(403);
        return jsonResponse(await s.begin(token, wire(r)));
      }
      const env = envelopeRecord(
        meta,
        binary
          ? ["request", "challenge", "signature", "bundleMeta"]
          : ["request", "challenge", "signature"],
      );
      const r = copyRequest(env.request),
        s = services.get(roomIdentity(r.room));
      if (!s || typeof env.challenge !== "string" || typeof env.signature !== "string")
        return fixedError(403);
      const args = [token, wire(r), env.challenge, env.signature] as const;
      if (path === "control") return jsonResponse(await s.finish(...args));
      if (binary) {
        if (r.operation.kind !== "publish" || !packet) return fixedError(400);
        const b = bundleFromPacket(env.bundleMeta, packet.ciphertext);
        return jsonResponse((await s.finishCheckpoint(...args, b)).receipt);
      }
      if (r.operation.kind !== "fetch") return fixedError(400);
      const result = await s.finishCheckpoint(...args);
      if (!result.bundle) return fixedError(403);
      const out = sealedPacket(result.bundle);
      return new Response(
        new Uint8Array(
          encodePacket({ receipt: result.receipt, bundleMeta: out.meta }, out.ciphertext),
        ),
        { headers: headers(TYPE) },
      );
    } catch {
      return fixedError(403);
    } finally {
      active--;
    }
  };
}
export function roomCheckpointHttpTransport(origin: string): RoomControlTransport {
  const base = new URL(origin);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    !base.port ||
    base.port === "0" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    return reject();
  const listeners = new Set<() => void>();
  async function call(token: string, path: string, body: string | Buffer, responseBinary = false) {
    try {
      const res = await fetch(new URL(PREFIX + path, base), {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        headers: {
          authorization: "Bearer " + token,
          "content-type": typeof body === "string" ? JSON_TYPE : TYPE,
        },
        body: typeof body === "string" ? body : new Uint8Array(body),
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok || res.headers.get("content-type") !== (responseBinary ? TYPE : JSON_TYPE)) {
        await res.body?.cancel().catch(() => {});
        return reject();
      }
      return await limitedBody(res, responseBinary ? CHECKPOINT_PACKET_BYTES : CONTROL_WIRE_BYTES);
    } catch {
      for (const notify of listeners) notify();
      return reject();
    }
  }
  const parseString = (b: Buffer) => {
    const v = parseWire(jsonText(b));
    if (typeof v !== "string") return reject();
    return v;
  };
  return {
    begin: async (token, request) => parseString(await call(token, "challenge", request)),
    finish: async (token, request, challenge, signature) =>
      parseString(
        await call(token, "control", wire({ request: parseWire(request), challenge, signature })),
      ),
    async finishCheckpoint(token, request, challenge, signature, bundle?: RecoveryBundle) {
      const env = { request: parseWire(request), challenge, signature };
      if (bundle) {
        const p = sealedPacket(bundle);
        return {
          receipt: parseString(
            await call(
              token,
              "publish",
              encodePacket({ ...env, bundleMeta: p.meta }, p.ciphertext),
            ),
          ),
        };
      }
      const p = decodePacket(await call(token, "fetch", wire(env), true)),
        m = envelopeRecord(p.meta, ["receipt", "bundleMeta"]);
      if (typeof m.receipt !== "string") return reject();
      return { receipt: m.receipt, bundle: bundleFromPacket(m.bundleMeta, p.ciphertext) };
    },
    onDisconnect(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
