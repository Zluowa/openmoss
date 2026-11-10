import http from "node:http";
import { Readable } from "node:stream";
import { createDevsReportReceiver } from "./devsReportReceiver";
import { createRepairRunner } from "./devsRepairRunner";
import { readDevsRepairConfig } from "./devsRepairConfig";

const { root, config, engines, required } = readDevsRepairConfig();
const repair = createRepairRunner(config);
const receiver = await createDevsReportReceiver({
  stateDir: root,
  token: required("MOSS_DEVS_REPORT_TOKEN"),
  engines,
  repair,
});
const port = Number(process.env.MOSS_DEVS_PORT ?? 5789);
const server = http.createServer(async (request, response) => {
  try {
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : Readable.toWeb(request);
    const webRequest = new Request(`http://localhost:${port}${request.url ?? "/"}`, {
      method: request.method ?? "GET",
      headers: request.headers as Record<string, string>,
      ...(body ? { body: body as unknown as ReadableStream<Uint8Array>, duplex: "half" } : {}),
    });
    const result = await receiver.handle(webRequest);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  } catch {
    response.writeHead(503);
    response.end('{"error":"Developer service unavailable"}');
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
// Terminate HTTPS at the operator's existing proxy. No unauthenticated public listener.
server.listen(port, "127.0.0.1", () =>
  console.log(`Moss developer service listening on 127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => {
      void receiver.close();
    });
  });
