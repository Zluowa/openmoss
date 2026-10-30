/**
 * 3G thread-load benchmark, reproducing the methodology T3 Code published for
 * its own client: 400 kbps down and up, 400 ms RTT, a new TCP connection per
 * HTTP request, median of 3 runs.
 *
 * It starts the real Moss server on a seeded home (see
 * `apps/server/scripts/seed-thread-load-benchmark.ts`) serving the production
 * web build, puts a link emulator in front of it and drives Chromium through it:
 *
 *   browser ─▶ link emulator ─▶ edge (Connection: close) ─▶ Moss server
 *
 * The emulator shares one 400 kbps pipe per direction across all connections
 * (round-robin per 1460-byte segment), delays each direction by RTT/2 and
 * charges one RTT of TCP handshake to every new connection. The edge forces
 * `Connection: close` on every HTTP response so each request opens a new TCP
 * connection; WebSocket upgrades are piped through unchanged. TCP slow start,
 * packet loss and TLS are not modelled.
 *
 *   node apps/web/scripts/thread-load-3g-benchmark.mjs --home=<seeded MOSS_HOME> --out=result.json
 *
 * `--scope=data` (default) matches T3 Code's numbers: only server data (the
 * WebSocket and `/api/` requests) crosses the link while the app bundle loads
 * locally, as in the desktop app. `--scope=all` also sends the app bundle over
 * the link, as for a browser opening a remote Moss for the first time.
 *
 * Options: --runs=3 --scope=data|all --rtt-ms=400 --kbps=400 --no-throttle
 *          --static-dir=apps/web/dist
 *          --chromium=<executable> (when Playwright's own browser download is absent)
 */
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix));
  return raw === undefined ? fallback : raw.slice(prefix.length);
}

const home = argument("home");
if (!home) throw new Error("--home=<seeded MOSS_HOME> is required");
const out = argument("out", join(home, "thread-load-3g.json"));
const runs = Number(argument("runs", "3"));
const rttMs = Number(argument("rtt-ms", "400"));
const kbps = Number(argument("kbps", "400"));
const throttle = !process.argv.includes("--no-throttle");
const scope = argument("scope", "data");
if (scope !== "data" && scope !== "all") throw new Error("--scope must be data or all");
const staticDir = resolve(argument("static-dir", join(repoRoot, "apps", "web", "dist")));
const chromiumExecutable = argument("chromium");
const manifest = JSON.parse(readFileSync(join(home, "benchmark-manifest.json"), "utf8"));
const READY_TIMEOUT_MS = 180_000;

const median = (values) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const benchmarkStartedAt = performance.now();
const progress = (message) =>
  console.error(`[${((performance.now() - benchmarkStartedAt) / 1_000).toFixed(1)}s] ${message}`);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

// ---------------------------------------------------------------------------
// Link emulator
// ---------------------------------------------------------------------------

const MSS = 1460;

/** One direction of the shared bottleneck link. */
class Link {
  constructor(bytesPerSecond, oneWayDelayMs) {
    this.msPerByte = 1_000 / bytesPerSecond;
    this.oneWayDelayMs = oneWayDelayMs;
    this.flows = [];
    this.cursor = 0;
    this.nextFree = 0;
    this.timer = null;
    this.bytes = 0;
  }

  enqueue(flow, chunk) {
    for (let offset = 0; offset < chunk.length; offset += MSS) {
      flow.pending.push(chunk.subarray(offset, offset + MSS));
    }
    if (!this.flows.includes(flow)) this.flows.push(flow);
    if (this.timer === null) {
      // An idle link starts transmitting now; a busy one keeps its virtual clock
      // so late timers never shave bandwidth off the schedule.
      this.nextFree = Math.max(this.nextFree, performance.now());
      this.pump();
    }
  }

  pump() {
    this.timer = null;
    const now = performance.now();
    while (this.flows.length > 0 && this.nextFree <= now + 1) {
      this.cursor %= this.flows.length;
      const flow = this.flows[this.cursor];
      const segment = flow.pending.shift();
      this.nextFree += segment.length * this.msPerByte;
      this.bytes += segment.length;
      flow.schedule(segment, this.nextFree + this.oneWayDelayMs);
      if (flow.pending.length === 0) this.flows.splice(this.cursor, 1);
      else this.cursor += 1;
    }
    if (this.flows.length > 0) {
      this.timer = setTimeout(() => this.pump(), Math.max(0, this.nextFree - now));
    }
  }
}

/** One connection's bytes in one direction, delivered in order once they cross the link. */
class Flow {
  constructor(destination) {
    this.destination = destination;
    this.pending = [];
    this.inflight = [];
    this.timer = null;
    this.ending = false;
  }

  schedule(segment, deliverAt) {
    this.inflight.push({ segment, deliverAt });
    if (this.timer === null) this.arm();
  }

  arm() {
    const head = this.inflight[0];
    if (!head) {
      if (this.ending && this.pending.length === 0) this.destination.end();
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const now = performance.now();
        while (this.inflight.length > 0 && this.inflight[0].deliverAt <= now + 1) {
          if (!this.destination.destroyed) this.destination.write(this.inflight.shift().segment);
          else this.inflight.shift();
        }
        this.arm();
      },
      Math.max(0, head.deliverAt - performance.now()),
    );
  }

  end() {
    this.ending = true;
    if (this.timer === null && this.inflight.length === 0 && this.pending.length === 0) {
      this.destination.end();
    }
  }
}

/**
 * With `--scope=data` only server data crosses the emulated link: WebSocket
 * upgrades and `/api/`, `/ws` requests. The app's HTML, scripts, styles and
 * images stay local, as they are for the desktop app or a cached web client.
 * Each connection carries one request (the edge forces `Connection: close`),
 * so classifying its first request classifies the whole connection.
 */
function crossesLink(firstChunk) {
  if (scope === "all") return true;
  const head = firstChunk.toString("latin1", 0, Math.min(firstChunk.length, 8_192));
  const path = head.slice(0, head.indexOf("\r\n")).split(" ")[1] ?? "";
  return (
    /\r\nupgrade:\s*websocket/i.test(head) || path.startsWith("/api/") || path.startsWith("/ws")
  );
}

function startLinkEmulator(listenPort, upstreamPort) {
  const bytesPerSecond = (kbps * 1_000) / 8;
  const downlink = new Link(bytesPerSecond, rttMs / 2);
  const uplink = new Link(bytesPerSecond, rttMs / 2);
  const stats = { connections: 0, localConnections: 0 };
  // Half-open sockets: each side is ended only by its own Flow, after delivery.
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const acceptedAt = performance.now();
    client.setNoDelay(true);
    const upstream = net.connect({ port: upstreamPort, host: "127.0.0.1", allowHalfOpen: true });
    upstream.setNoDelay(true);
    let gateTimer = null;
    const destroy = () => {
      clearTimeout(gateTimer);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", destroy);
    upstream.on("error", destroy);
    let classified = false;
    client.once("close", () => {
      if (!classified) destroy();
    });
    client.once("data", (firstChunk) => {
      classified = true;
      if (!crossesLink(firstChunk)) {
        stats.localConnections += 1;
        upstream.write(firstChunk);
        client.pipe(upstream);
        upstream.pipe(client);
        return;
      }
      stats.connections += 1;
      const toServer = new Flow(upstream);
      const toClient = new Flow(client);
      // SYN / SYN-ACK: the first request byte leaves the client one RTT after connect().
      // Until then client bytes (and a close) wait in order behind the handshake.
      let handshakePending = [];
      gateTimer = setTimeout(
        () => {
          for (const action of handshakePending) action();
          handshakePending = null;
        },
        Math.max(0, acceptedAt + rttMs - performance.now()),
      );
      const fromClient = (action) => (handshakePending ? handshakePending.push(action) : action());
      fromClient(() => uplink.enqueue(toServer, firstChunk));
      client.on("data", (chunk) => fromClient(() => uplink.enqueue(toServer, chunk)));
      upstream.on("data", (chunk) => downlink.enqueue(toClient, chunk));
      // A close only ends the far side once every byte still crossing the link has
      // been delivered; the origin closes right after each `Connection: close` response.
      const endUp = () => fromClient(() => toServer.end());
      const endDown = () => toClient.end();
      client.on("end", endUp);
      client.on("close", endUp);
      upstream.on("end", endDown);
      upstream.on("close", endDown);
    });
  });
  return new Promise((resolveListen) =>
    server.listen(listenPort, "127.0.0.1", () =>
      resolveListen({
        server,
        snapshot: () => ({
          down: downlink.bytes,
          up: uplink.bytes,
          connections: stats.connections,
        }),
      }),
    ),
  );
}

/** Forces a new TCP connection per HTTP request; WebSocket upgrades pass through. */
function startEdge(listenPort, upstreamPort) {
  const edge = http.createServer((request, response) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: request.headers,
        agent: false,
      },
      (upstreamResponse) => {
        const headers = { ...upstreamResponse.headers, connection: "close" };
        delete headers["keep-alive"];
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  edge.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(upstreamPort, "127.0.0.1", () => {
      let raw = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        raw += `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`;
      }
      upstream.write(`${raw}\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const destroy = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", destroy);
    socket.on("error", destroy);
    upstream.on("close", destroy);
    socket.on("close", destroy);
  });
  return new Promise((resolveListen) =>
    edge.listen(listenPort, "127.0.0.1", () => resolveListen(edge)),
  );
}

// ---------------------------------------------------------------------------
// Moss server
// ---------------------------------------------------------------------------

async function startMoss(port) {
  const log = createWriteStream(`${out}.server.log`);
  const child = spawn("bun", [join(repoRoot, "apps", "server", "src", "index.ts")], {
    cwd: home,
    env: {
      ...process.env,
      MOSS_HOME: home,
      MOSS_PORT: String(port),
      MOSS_HOST: "127.0.0.1",
      MOSS_MODE: "web",
      MOSS_NO_BROWSER: "1",
      MOSS_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const startedAt = performance.now();
  while (performance.now() - startedAt < 120_000) {
    if (child.exitCode !== null)
      throw new Error(`Moss server exited (${child.exitCode}); see ${out}.server.log`);
    const ok = await new Promise((resolveProbe) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
        response.resume();
        resolveProbe(response.statusCode === 200);
      });
      request.on("error", () => resolveProbe(false));
    });
    if (ok) return child;
    await sleep(250);
  }
  child.kill();
  throw new Error("Moss server did not become ready");
}

// ---------------------------------------------------------------------------
// Browser measurement
// ---------------------------------------------------------------------------

const bigThreads = Object.fromEntries(manifest.bigThreads.map((thread) => [thread.key, thread]));

/** A fresh profile: empty HTTP cache, IndexedDB and localStorage. */
function newContext(browser) {
  // No request interception here: Playwright routing disables the HTTP cache,
  // which would make every reconnect re-download the immutable assets.
  return browser.newContext({ viewport: { width: 1440, height: 900 } });
}

/** Records every WebSocket frame so JSON bytes can be attributed to the RPC that produced them. */
async function instrument(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const requestTags = new Map();
  const frames = [];
  const httpJson = { bytes: 0 };
  const jsonRequestIds = new Set();
  cdp.on("Network.webSocketFrameSent", ({ response }) => {
    for (const message of parseFrame(response.payloadData)) {
      if (message?._tag === "Request") requestTags.set(String(message.id), message.tag);
    }
  });
  cdp.on("Network.webSocketFrameReceived", ({ response }) => {
    const bytes = Buffer.byteLength(response.payloadData);
    const messages = parseFrame(response.payloadData);
    const requestId = messages.find((message) => message?.requestId !== undefined)?.requestId;
    frames.push({
      at: performance.now(),
      bytes,
      requestId: requestId === undefined ? null : String(requestId),
    });
  });
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    if (response.mimeType?.includes("json")) jsonRequestIds.add(requestId);
  });
  cdp.on("Network.dataReceived", ({ requestId, dataLength }) => {
    if (jsonRequestIds.has(requestId)) httpJson.bytes += dataLength;
  });
  return {
    mark: () => ({ frameIndex: frames.length, httpJsonBytes: httpJson.bytes }),
    jsonSince(mark, until = Number.POSITIVE_INFINITY) {
      const byTag = {};
      let total = 0;
      for (const frame of frames.slice(mark.frameIndex)) {
        if (frame.at > until) break;
        const tag = (frame.requestId && requestTags.get(frame.requestId)) || "(unattributed)";
        byTag[tag] = (byTag[tag] ?? 0) + frame.bytes;
        total += frame.bytes;
      }
      const sum = (predicate) =>
        Object.entries(byTag).reduce(
          (bytes, [tag, value]) => (predicate(tag) ? bytes + value : bytes),
          0,
        );
      return {
        wsJsonBytes: total,
        shellJsonBytes: sum((tag) => /shell/i.test(tag)),
        threadJsonBytes: sum((tag) => /thread(detail)?/i.test(tag) && !/shell/i.test(tag)),
        httpJsonBytes: httpJson.bytes - mark.httpJsonBytes,
        byTag,
      };
    },
  };
}

function parseFrame(payload) {
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function waitForThread(page, messageId) {
  await page.waitForSelector(`[data-message-id="${messageId}"]`, {
    state: "attached",
    timeout: READY_TIMEOUT_MS,
  });
  return performance.now();
}

const sidebarRow = (threadId) => `li[data-thread-item][data-thread-hover-anchor$=":${threadId}"]`;

async function waitForShell(page) {
  // Every big thread must be listed: the shell, not just the active thread, is loaded.
  // Rows are matched by id because the localized UI rewrites thread titles.
  for (const thread of manifest.bigThreads) {
    await page.waitForSelector(sidebarRow(thread.threadId), {
      state: "attached",
      timeout: READY_TIMEOUT_MS,
    });
  }
  return performance.now();
}

async function waitForQuietLink(link, quietMs = 2_000, maxMs = 60_000) {
  const startedAt = performance.now();
  let last = link.snapshot();
  let quietSince = performance.now();
  while (performance.now() - startedAt < maxMs) {
    await sleep(200);
    const current = link.snapshot();
    if (current.down !== last.down || current.up !== last.up) {
      last = current;
      quietSince = performance.now();
    } else if (performance.now() - quietSince >= quietMs) {
      return;
    }
  }
}

/**
 * Closes first-run modals so they cannot block sidebar clicks. The project-import
 * announcement opens a few seconds after startup settles and the what's-new tour
 * opens once it closes, so keep dismissing until no dialog shows up for a while.
 */
async function dismissDialogs(page, appearTimeoutMs = 20_000) {
  const dialog = page.locator("[role=dialog]:visible");
  await dialog
    .first()
    .waitFor({ state: "visible", timeout: appearTimeoutMs })
    .catch(() => {});
  const deadline = performance.now() + 30_000;
  let quietSince = performance.now();
  while (performance.now() < deadline) {
    if ((await dialog.count()) > 0) {
      await page.keyboard.press("Escape");
      quietSince = performance.now();
    } else if (performance.now() - quietSince > 2_500) {
      return;
    }
    await sleep(300);
  }
  throw new Error("A modal dialog stayed open");
}

function delta(after, before) {
  return {
    downBytes: after.down - before.down,
    upBytes: after.up - before.up,
    connections: after.connections - before.connections,
  };
}

async function coldConnectAndReconnect(browser, link, baseUrl) {
  const context = await newContext(browser);
  const page = await context.newPage();
  const probe = await instrument(context, page);
  const thread = bigThreads.A;

  const coldMark = probe.mark();
  const coldBytes = link.snapshot();
  const coldStart = performance.now();
  await page.goto(`${baseUrl}/${thread.threadId}`, {
    waitUntil: "commit",
    timeout: READY_TIMEOUT_MS,
  });
  const [coldThreadAt, coldShellAt] = await Promise.all([
    waitForThread(page, thread.lastMessageId),
    waitForShell(page),
  ]);
  const coldReadyAt = Math.max(coldThreadAt, coldShellAt);
  progress(`cold ready in ${((coldReadyAt - coldStart) / 1_000).toFixed(1)}s`);
  const coldWire = delta(link.snapshot(), coldBytes);
  const coldJson = probe.jsonSince(coldMark, coldReadyAt);
  await waitForQuietLink(link);
  const coldSettledWire = delta(link.snapshot(), coldBytes);
  progress("cold settled");
  await dismissDialogs(page);
  // Let the client's idle flush persist thread detail before reloading.
  await sleep(3_000);
  await waitForQuietLink(link);

  const reloadMark = probe.mark();
  const reloadBytes = link.snapshot();
  const reloadStart = performance.now();
  await page.reload({ waitUntil: "commit", timeout: READY_TIMEOUT_MS });
  const [reloadThreadAt, reloadShellAt] = await Promise.all([
    waitForThread(page, thread.lastMessageId),
    waitForShell(page),
  ]);
  const reloadReadyAt = Math.max(reloadThreadAt, reloadShellAt);
  progress(`reconnect ready in ${((reloadReadyAt - reloadStart) / 1_000).toFixed(1)}s`);
  const reloadWire = delta(link.snapshot(), reloadBytes);
  const reloadJson = probe.jsonSince(reloadMark, reloadReadyAt);
  await context.close();

  return {
    cold: {
      ms: coldReadyAt - coldStart,
      shellMs: coldShellAt - coldStart,
      threadMs: coldThreadAt - coldStart,
      wire: coldWire,
      settledWire: coldSettledWire,
      json: coldJson,
    },
    reconnect: {
      ms: reloadReadyAt - reloadStart,
      shellMs: reloadShellAt - reloadStart,
      threadMs: reloadThreadAt - reloadStart,
      wire: reloadWire,
      json: reloadJson,
    },
  };
}

async function openThread(browser, link, baseUrl, key) {
  const context = await newContext(browser);
  const page = await context.newPage();
  const probe = await instrument(context, page);
  await page.goto(`${baseUrl}/${manifest.startThread.threadId}`, {
    waitUntil: "commit",
    timeout: READY_TIMEOUT_MS,
  });
  await Promise.all([waitForThread(page, manifest.startThread.lastMessageId), waitForShell(page)]);
  await dismissDialogs(page);
  await waitForQuietLink(link);

  const thread = bigThreads[key];
  const mark = probe.mark();
  const before = link.snapshot();
  const startedAt = performance.now();
  await page
    .locator(`${sidebarRow(thread.threadId)} [role=button]`)
    .first()
    .click();
  const readyAt = await waitForThread(page, thread.lastMessageId);
  progress(`open ${key} ready in ${((readyAt - startedAt) / 1_000).toFixed(1)}s`);
  const result = {
    ms: readyAt - startedAt,
    wire: delta(link.snapshot(), before),
    json: probe.jsonSince(mark, readyAt),
  };
  await context.close();
  return result;
}

async function main() {
  const mossPort = await freePort();
  const edgePort = await freePort();
  const linkPort = await freePort();
  const moss = await startMoss(mossPort);
  const edge = await startEdge(edgePort, mossPort);
  const link = throttle
    ? await startLinkEmulator(linkPort, edgePort)
    : { server: null, snapshot: () => ({ down: 0, up: 0, connections: 0 }) };
  const baseUrl = `http://127.0.0.1:${throttle ? linkPort : edgePort}`;
  const samples = [];
  let browser;
  try {
    browser = await chromium.launch({
      ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
      // Third-party hosts (web fonts, telemetry) are optional and would add
      // internet variance, so they fail DNS; only the Moss origin is measured.
      args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    // One discarded warm-up pass so SQLite and server caches are warm for every measured run.
    console.error("warm-up");
    await coldConnectAndReconnect(browser, link, baseUrl);
    for (let run = 0; run < runs; run += 1) {
      const sample = await coldConnectAndReconnect(browser, link, baseUrl);
      for (const key of ["A", "B", "C"])
        sample[`open${key}`] = await openThread(browser, link, baseUrl, key);
      samples.push(sample);
      console.error(
        `run ${run + 1}: cold ${(sample.cold.ms / 1e3).toFixed(2)}s, reconnect ${(sample.reconnect.ms / 1e3).toFixed(2)}s, ` +
          `A ${(sample.openA.ms / 1e3).toFixed(2)}s, B ${(sample.openB.ms / 1e3).toFixed(2)}s, C ${(sample.openC.ms / 1e3).toFixed(2)}s`,
      );
    }
  } finally {
    await browser?.close();
    edge.close();
    link.server?.close();
    moss.kill("SIGTERM");
  }

  const scenarios = ["cold", "reconnect", "openA", "openB", "openC"];
  const summary = Object.fromEntries(
    scenarios.map((scenario) => [
      scenario,
      {
        medianMs: median(samples.map((sample) => sample[scenario].ms)),
        medianDownBytes: median(samples.map((sample) => sample[scenario].wire.downBytes)),
        medianWsJsonBytes: median(samples.map((sample) => sample[scenario].json.wsJsonBytes)),
        medianShellJsonBytes: median(samples.map((sample) => sample[scenario].json.shellJsonBytes)),
        medianThreadJsonBytes: median(
          samples.map((sample) => sample[scenario].json.threadJsonBytes),
        ),
      },
    ]),
  );
  const result = {
    createdAt: new Date().toISOString(),
    network: throttle
      ? { downKbps: kbps, upKbps: kbps, rttMs, newTcpConnectionPerRequest: true, scope }
      : { throttled: false },
    runs,
    manifest,
    summary,
    samples,
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
