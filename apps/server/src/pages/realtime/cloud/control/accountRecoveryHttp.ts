import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect, FileSystem, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RECOVERY_HTTP_BYTES, hex } from "./accountRecoveryCrypto";
import type { AccountRecoveryTransport, RecoveryReply } from "./accountRecoveryAuthority";
import { AccountRecoveryAuthority } from "./accountRecoveryAuthorityRuntime";
import { reject } from "./roomControlProtocol";

export const ACCOUNT_RECOVERY_HTTP_PATH = "/internal/account-page-recovery";
export function accountRecoveryHttpHandler(authority: AccountRecoveryTransport) {
  let active = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("cache-control", "no-store");
    if (
      req.method !== "POST" ||
      req.url !== ACCOUNT_RECOVERY_HTTP_PATH ||
      req.headers.origin ||
      req.headers.cookie ||
      req.headers["content-type"] !== "application/json"
    ) {
      res.writeHead(404).end();
      return;
    }
    const token = /^Bearer ([!-~]{1,16384})$/.exec(req.headers.authorization ?? "")?.[1];
    if (
      !token ||
      active >= 16 ||
      Number(req.headers["content-length"] ?? 0) > RECOVERY_HTTP_BYTES
    ) {
      res.writeHead(403).end();
      return;
    }
    active++;
    const stop = new AbortController(),
      timer = setTimeout(() => {
        stop.abort();
        req.destroy();
      }, 8000);
    const closed = () => {
      if (!res.writableFinished) stop.abort();
    };
    res.once("close", closed);
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > RECOVERY_HTTP_BYTES) return reject();
        chunks.push(chunk);
      }
      const { realm, tenant, command } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!hex(tenant)) return reject();
      const reply = await authority.call(token, realm, tenant, command, stop.signal);
      const data = JSON.stringify(reply);
      if (stop.signal.aborted || Buffer.byteLength(data) > RECOVERY_HTTP_BYTES) return reject();
      res.writeHead(200, { "content-type": "application/json" }).end(data);
    } catch {
      if (!res.headersSent) res.writeHead(403);
      res.end();
    } finally {
      clearTimeout(timer);
      res.off("close", closed);
      active--;
    }
  };
}
/** Explicit private service origin. HTTPS for provisioned deployments, loopback HTTP for local acceptance. */
export function accountRecoveryHttpTransport(origin: string): AccountRecoveryTransport {
  const u = new URL(origin);
  if (
    u.origin !== origin ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    return reject();
  return {
    async call(token, realm, tenant, command, signal) {
      const body = JSON.stringify({ realm, tenant, command });
      if (Buffer.byteLength(body) > RECOVERY_HTTP_BYTES || !/^[!-~]{1,16384}$/.test(token))
        return reject();
      const res = await fetch(origin + ACCOUNT_RECOVERY_HTTP_PATH, {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (
        !res.ok ||
        !res.body ||
        Number(res.headers.get("content-length") ?? 0) > RECOVERY_HTTP_BYTES
      ) {
        await res.body?.cancel();
        return reject();
      }
      const reader = res.body.getReader(),
        chunks: Buffer[] = [];
      let n = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          n += part.value.length;
          if (n > RECOVERY_HTTP_BYTES) return reject();
          chunks.push(Buffer.from(part.value));
        }
        return JSON.parse(Buffer.concat(chunks).toString()) as RecoveryReply;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}

/**
 * Hosted authority route for the normal Effect HTTP server. The route is
 * intentionally optional: without an explicit AccountRecoveryAuthority
 * provision it answers 404, so a desktop/client process cannot become an
 * authority by merely setting a client origin.
 */
export const accountRecoveryEffectRouteLayer = HttpRouter.add(
  "POST",
  ACCOUNT_RECOVERY_HTTP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authority = Option.getOrUndefined(yield* Effect.serviceOption(AccountRecoveryAuthority));
    if (!authority) return HttpServerResponse.text("Not Found", { status: 404 });
    if (
      request.headers.origin ||
      request.headers.cookie ||
      request.headers["content-type"] !== "application/json"
    )
      return HttpServerResponse.text("Not Found", { status: 404 });
    const token = /^Bearer ([!-~]{1,16384})$/.exec(request.headers.authorization ?? "")?.[1];
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (!token || !Number.isFinite(declaredLength) || declaredLength > RECOVERY_HTTP_BYTES)
      return HttpServerResponse.text("Forbidden", { status: 403 });
    const body = yield* request.json.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(RECOVERY_HTTP_BYTES)),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!body || typeof body !== "object")
      return HttpServerResponse.text("Forbidden", { status: 403 });
    const input = body as {
      readonly realm?: unknown;
      readonly tenant?: unknown;
      readonly command?: unknown;
    };
    const tenant = input.tenant;
    if (typeof tenant !== "string" || !hex(tenant))
      return HttpServerResponse.text("Forbidden", { status: 403 });
    const controller = new AbortController();
    const reply = yield* Effect.promise(async () => {
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        return await authority.call(
          token,
          input.realm as never,
          tenant,
          input.command as never,
          controller.signal,
        );
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
    if (!reply) return HttpServerResponse.text("Forbidden", { status: 403 });
    const serialized = JSON.stringify(reply);
    if (Buffer.byteLength(serialized) > RECOVERY_HTTP_BYTES)
      return HttpServerResponse.text("Forbidden", { status: 403 });
    return HttpServerResponse.jsonUnsafe(reply, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  }),
);
