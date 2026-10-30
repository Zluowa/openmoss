import type {
  RealtimeVoiceId,
  RealtimeVoiceOutputModality,
  RealtimeVoiceStartTransport,
  RealtimeVoiceTransport,
} from "@synara/contracts";
import {
  MOSS_CLOUD_REGION_HEADER,
  isMossCloudRegion,
  type MossCloudRegion,
} from "@synara/shared/mossProductionPublicConfig";
import { isIP } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import WebSocket from "ws";

import { createLogger } from "../logger";

const MAX_RELAY_RESPONSE_BYTES = 768 * 1_024;
export const MOSS_REALTIME_RELAY_URL_ENV_KEY = "MOSS_REALTIME_RELAY_URL";
export const MOSS_CLOUD_REGION_ENV_KEY = "MOSS_CLOUD_REGION";

const relayLogger = createLogger("realtime-voice");
const CONTROL_HANDSHAKE_TIMEOUT_MS = 5_000;
// The message `ws` raises when no upgrade response arrives within `handshakeTimeout`.
const CONTROL_HANDSHAKE_TIMEOUT_MESSAGE = "Opening handshake has timed out";

export type RelayAddressFamily = "IPv4" | "IPv6";

/**
 * Some networks black-hole large IPv6 packets: the control upgrade goes out, but the relay's 101
 * (followed by its first control event) never arrives and the handshake times out. Retry exactly
 * that case once over IPv4. Any other failure, a second attempt, or an IPv4 attempt fails as before.
 */
export function shouldRetryControlOverIpv4(input: {
  readonly error: unknown;
  readonly attempt: number;
  readonly family: RelayAddressFamily | undefined;
}): boolean {
  return (
    input.attempt === 0 &&
    input.family === "IPv6" &&
    input.error instanceof Error &&
    input.error.message === CONTROL_HANDSHAKE_TIMEOUT_MESSAGE
  );
}

/** Same as `ws`'s own TLS connector, but reports which address family the connection used. */
function familyRecordingTlsConnect(
  connect: typeof tlsConnect,
  record: (family: RelayAddressFamily) => void,
): (options: ConnectionOptions) => TLSSocket {
  return (options) => {
    const host = typeof options.host === "string" ? options.host : "";
    const socket = connect({
      ...options,
      path: undefined,
      servername:
        options.servername || options.servername === ""
          ? options.servername
          : isIP(host)
            ? ""
            : host,
    } as ConnectionOptions);
    socket.once("connect", () => {
      if (socket.remoteFamily === "IPv4" || socket.remoteFamily === "IPv6") {
        record(socket.remoteFamily);
      }
    });
    return socket;
  };
}

export class RealtimeVoiceRelayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 500) {
    super(code);
    this.name = "RealtimeVoiceRelayError";
    this.code = code;
    this.status = status;
  }
}

export interface RelayStartResult {
  readonly sessionId: string;
  readonly requestedModel: string;
  readonly transport: RealtimeVoiceTransport;
  readonly controlPath: string;
}

export interface RelayControlConnection {
  readonly send: (command: unknown) => void;
  readonly close: () => void;
}

export interface RealtimeVoiceRelayClientShape {
  startCall(input: {
    readonly accessToken: string;
    readonly sessionId: string;
    readonly transport: RealtimeVoiceStartTransport;
    readonly voice: RealtimeVoiceId;
    readonly outputModality: RealtimeVoiceOutputModality;
    readonly signal?: AbortSignal;
  }): Promise<RelayStartResult>;
  connectControl(input: {
    readonly accessToken: string;
    readonly controlPath: string;
    readonly onOpen: () => void;
    readonly onEvent: (event: unknown) => void;
    readonly onError: (error: Error) => void;
    readonly onClose: () => void;
  }): RelayControlConnection;
  stopCall(input: { readonly accessToken: string; readonly sessionId: string }): Promise<void>;
}

function normalizeRelayOrigin(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new RealtimeVoiceRelayError("REALTIME_RELAY_URL_INVALID");
  }
  return url.origin;
}

export function resolveRealtimeRelayOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[MOSS_REALTIME_RELAY_URL_ENV_KEY]?.trim();
  if (!value) throw new RealtimeVoiceRelayError("REALTIME_RELAY_NOT_CONFIGURED");
  return normalizeRelayOrigin(value);
}

export function resolveMossCloudRegion(env: NodeJS.ProcessEnv = process.env): MossCloudRegion {
  const value = env[MOSS_CLOUD_REGION_ENV_KEY]?.trim().toLowerCase();
  if (!isMossCloudRegion(value)) {
    throw new RealtimeVoiceRelayError("MOSS_CLOUD_REGION_NOT_CONFIGURED");
  }
  return value;
}

async function boundedJson(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RELAY_RESPONSE_BYTES) {
    throw new RealtimeVoiceRelayError("REALTIME_RELAY_INVALID_RESPONSE", 502);
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Readonly<Record<string, unknown>>;
  } catch {
    throw new RealtimeVoiceRelayError("REALTIME_RELAY_INVALID_RESPONSE", 502);
  }
}

function errorCode(value: Readonly<Record<string, unknown>>): string {
  const error = value.error;
  return typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>).code === "string"
    ? String((error as Record<string, unknown>).code).slice(0, 120)
    : "REALTIME_RELAY_REJECTED";
}

function parseStartResult(
  value: Readonly<Record<string, unknown>>,
  expectedRegion: MossCloudRegion,
  relayOrigin: string,
  now: number,
): RelayStartResult {
  const transport = value.transport;
  const sessionId =
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 160
      ? value.sessionId
      : null;
  const requestedModel =
    typeof value.requestedModel === "string" &&
    value.requestedModel.length > 0 &&
    value.requestedModel.length <= 160
      ? value.requestedModel
      : null;
  const expectedControlPath = sessionId
    ? `/v1/realtime/control?session_id=${encodeURIComponent(sessionId)}`
    : null;
  if (
    value.cloudRegion !== expectedRegion ||
    !sessionId ||
    !requestedModel ||
    value.controlPath !== expectedControlPath ||
    typeof transport !== "object" ||
    transport === null ||
    Array.isArray(transport)
  ) {
    throw new RealtimeVoiceRelayError("REALTIME_RELAY_INVALID_RESPONSE", 502);
  }
  const transportRecord = transport as Readonly<Record<string, unknown>>;
  let parsedTransport: RealtimeVoiceTransport;
  if (
    transportRecord.type === "webrtc" &&
    typeof transportRecord.sdp === "string" &&
    transportRecord.sdp.startsWith("v=0")
  ) {
    parsedTransport = { type: "webrtc", sdp: transportRecord.sdp };
  } else if (transportRecord.type === "websocket-pcm16") {
    const expiresAt = transportRecord.expiresAt;
    const ticket = transportRecord.ticket;
    const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (
      transportRecord.url !== "/v1/realtime/media" ||
      transportRecord.protocol !== "moss-realtime-pcm16-v1" ||
      transportRecord.encoding !== "pcm16" ||
      transportRecord.sampleRate !== 24_000 ||
      typeof ticket !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(ticket) ||
      typeof expiresAt !== "string" ||
      !Number.isFinite(expiresAtMs) ||
      new Date(expiresAtMs).toISOString() !== expiresAt ||
      expiresAtMs <= now ||
      expiresAtMs - now > 60_000
    ) {
      throw new RealtimeVoiceRelayError("REALTIME_RELAY_INVALID_RESPONSE", 502);
    }
    const websocketOrigin = relayOrigin.replace(/^http/u, "ws");
    parsedTransport = {
      type: "websocket-pcm16",
      url: `${websocketOrigin}/v1/realtime/media`,
      protocol: "moss-realtime-pcm16-v1",
      ticket,
      expiresAt,
      encoding: "pcm16",
      sampleRate: 24_000,
    };
  } else {
    throw new RealtimeVoiceRelayError("REALTIME_RELAY_INVALID_RESPONSE", 502);
  }
  return {
    sessionId,
    requestedModel,
    controlPath: `/v1/realtime/control?session_id=${encodeURIComponent(sessionId)}`,
    transport: parsedTransport,
  };
}

export class RealtimeVoiceRelayClient implements RealtimeVoiceRelayClientShape {
  readonly #origin: string;
  readonly #cloudRegion: MossCloudRegion;
  readonly #fetch: typeof fetch;
  readonly #webSocketFactory: typeof WebSocket;
  readonly #tlsConnect: typeof tlsConnect;
  readonly #now: () => number;

  constructor(input: {
    readonly origin: string;
    readonly cloudRegion: MossCloudRegion;
    readonly fetch?: typeof fetch;
    readonly webSocketFactory?: typeof WebSocket;
    readonly tlsConnect?: typeof tlsConnect;
    readonly now?: () => number;
  }) {
    this.#origin = normalizeRelayOrigin(input.origin);
    this.#cloudRegion = input.cloudRegion;
    this.#fetch = input.fetch ?? fetch;
    this.#webSocketFactory = input.webSocketFactory ?? WebSocket;
    this.#tlsConnect = input.tlsConnect ?? tlsConnect;
    this.#now = input.now ?? Date.now;
  }

  async startCall(input: {
    readonly accessToken: string;
    readonly sessionId: string;
    readonly transport: RealtimeVoiceStartTransport;
    readonly voice: RealtimeVoiceId;
    readonly outputModality: RealtimeVoiceOutputModality;
    readonly signal?: AbortSignal;
  }): Promise<RelayStartResult> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/v1/realtime/calls`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
          [MOSS_CLOUD_REGION_HEADER]: this.#cloudRegion,
        },
        body: JSON.stringify({
          sessionId: input.sessionId,
          ...(input.transport.type === "webrtc"
            ? { sdp: input.transport.sdp, transport: { type: "webrtc" } }
            : { transport: { type: "websocket-pcm16" } }),
          voice: input.voice,
          outputModality: input.outputModality,
        }),
        cache: "no-store",
        redirect: "error",
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new RealtimeVoiceRelayError("REALTIME_RELAY_UNAVAILABLE", 503);
    }
    const json = await boundedJson(response);
    if (!response.ok) throw new RealtimeVoiceRelayError(errorCode(json), response.status);
    const result = parseStartResult(json, this.#cloudRegion, this.#origin, this.#now());
    if (result.transport.type !== input.transport.type) {
      throw new RealtimeVoiceRelayError("REALTIME_RELAY_TRANSPORT_MISMATCH", 502);
    }
    return result;
  }

  connectControl(input: {
    readonly accessToken: string;
    readonly controlPath: string;
    readonly onOpen: () => void;
    readonly onEvent: (event: unknown) => void;
    readonly onError: (error: Error) => void;
    readonly onClose: () => void;
  }): RelayControlConnection {
    if (!input.controlPath.startsWith("/v1/realtime/control?")) {
      throw new RealtimeVoiceRelayError("REALTIME_RELAY_CONTROL_PATH_INVALID", 502);
    }
    const url = `${this.#origin.replace(/^http/u, "ws")}${input.controlPath}`;
    const secure = url.startsWith("wss:");
    let closed = false;
    let socket: WebSocket;
    const open = (attempt: number) => {
      let family: RelayAddressFamily | undefined;
      let retrying = false;
      const current = new this.#webSocketFactory(url, {
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          [MOSS_CLOUD_REGION_HEADER]: this.#cloudRegion,
        },
        perMessageDeflate: false,
        handshakeTimeout: CONTROL_HANDSHAKE_TIMEOUT_MS,
        maxPayload: 128 * 1_024,
        ...(attempt > 0 ? { family: 4 } : {}),
        ...(secure
          ? {
              createConnection: familyRecordingTlsConnect(this.#tlsConnect, (value) => {
                family = value;
              }) as unknown as WebSocket.ClientOptions["createConnection"],
            }
          : {}),
      });
      socket = current;
      current.on("open", () => {
        if (attempt > 0) {
          relayLogger.info("realtime control channel connected after IPv4 fallback", {
            family: family ?? "IPv4",
          });
        }
        input.onOpen();
      });
      current.on("message", (raw) => {
        if (closed) return;
        const text = raw.toString();
        if (Buffer.byteLength(text) > 128 * 1_024) {
          current.close(1009, "event too large");
          return;
        }
        try {
          input.onEvent(JSON.parse(text) as unknown);
        } catch {
          input.onError(new Error("Realtime relay returned invalid JSON"));
        }
      });
      current.on("error", (cause) => {
        if (!closed && shouldRetryControlOverIpv4({ error: cause, attempt, family })) {
          retrying = true;
          relayLogger.warn("realtime control handshake timed out over IPv6; retrying over IPv4");
          open(attempt + 1);
          return;
        }
        input.onError(cause instanceof Error ? cause : new Error("Realtime relay control error"));
      });
      current.on("close", () => {
        if (retrying || closed) return;
        closed = true;
        input.onClose();
      });
    };
    open(0);
    return {
      send(command: unknown) {
        if (closed || socket.readyState !== WebSocket.OPEN) {
          throw new RealtimeVoiceRelayError("REALTIME_RELAY_CONTROL_NOT_READY", 409);
        }
        const payload = JSON.stringify(command);
        if (Buffer.byteLength(payload) > 1_100_000) {
          throw new RealtimeVoiceRelayError("REALTIME_RELAY_COMMAND_TOO_LARGE", 413);
        }
        socket.send(payload);
      },
      close() {
        if (closed) return;
        closed = true;
        socket.close(1000, "local session complete");
      },
    };
  }

  async stopCall(input: {
    readonly accessToken: string;
    readonly sessionId: string;
  }): Promise<void> {
    try {
      await this.#fetch(
        `${this.#origin}/v1/realtime/sessions/${encodeURIComponent(input.sessionId)}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${input.accessToken}`,
            [MOSS_CLOUD_REGION_HEADER]: this.#cloudRegion,
          },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(3_000),
        },
      );
    } catch {
      // Best effort: the relay's stale-session reconciler owns eventual release.
    }
  }
}
