import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, FileSystem, Scope } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  localPreviewDownloadDisposition,
  rangedBufferResponse,
  resolveLocalPreviewByteRange,
  streamedFileResponseWithRange,
} from "./localPreviewRange";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function withRangeServer(
  filePath: string,
  bufferBytes: Uint8Array,
  onStreamCall: (path: string, options: unknown) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const routes = HttpRouter.addAll([
    HttpRouter.route(
      "GET",
      "/file",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const baseFs = yield* FileSystem.FileSystem;
        const spiedFs: FileSystem.FileSystem = {
          ...baseFs,
          stream: (targetPath, options) => {
            onStreamCall(targetPath, options);
            return baseFs.stream(targetPath, options);
          },
        };
        const info = yield* baseFs.stat(filePath);
        return streamedFileResponseWithRange({
          request,
          fileSystem: spiedFs,
          path: filePath,
          sizeBytes: Number(info.size),
          contentType: "video/mp4",
          headers: { "Cache-Control": "private, max-age=60" },
        });
      }),
    ),
    HttpRouter.route(
      "GET",
      "/buffer",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return rangedBufferResponse({
          request,
          bytes: bufferBytes,
          contentType: "video/webm",
          headers: { "Cache-Control": "no-store" },
        });
      }),
    ),
  ]);

  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          yield* httpServer.serve(yield* HttpRouter.toHttpEffect(routes));
        }).pipe(Effect.provide(NodeHttpServer.layerHttpServices)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected server address");
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("local preview response metadata", () => {
  it("clamps large end/suffix values without losing integer precision", () => {
    expect(resolveLocalPreviewByteRange("bytes=2-999999999999999999999999", 8)).toEqual({
      kind: "partial",
      offset: 2,
      length: 6,
    });
    expect(resolveLocalPreviewByteRange("bytes=-999999999999999999999999", 8)).toEqual({
      kind: "partial",
      offset: 0,
      length: 8,
    });
    expect(resolveLocalPreviewByteRange("bytes=999999999999999999999999-", 8)).toEqual({
      kind: "unsatisfiable",
    });
  });

  it("parses start-end, open-ended, suffix, multi-range, and invalid ranges per RFC 7233", () => {
    expect(resolveLocalPreviewByteRange(undefined, 16)).toEqual({ kind: "full" });
    expect(resolveLocalPreviewByteRange("items=0-5", 16)).toEqual({ kind: "full" });
    expect(resolveLocalPreviewByteRange("bytes=0-0", 16)).toEqual({
      kind: "partial",
      offset: 0,
      length: 1,
    });
    expect(resolveLocalPreviewByteRange("bytes=4-", 16)).toEqual({
      kind: "partial",
      offset: 4,
      length: 12,
    });
    expect(resolveLocalPreviewByteRange("bytes=-5", 16)).toEqual({
      kind: "partial",
      offset: 11,
      length: 5,
    });
    expect(resolveLocalPreviewByteRange("bytes=0-1, 4-5", 16)).toEqual({ kind: "full" });

    for (const bad of [
      "bytes=",
      "bytes=-",
      "bytes=abc",
      "bytes=5-2",
      "bytes=-0",
      "bytes=16-",
      "bytes=0-1, nope",
    ]) {
      expect(resolveLocalPreviewByteRange(bad, 16), bad).toEqual({ kind: "unsatisfiable" });
    }
    expect(resolveLocalPreviewByteRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("does not put Unicode, quotes or control characters in the ASCII filename", () => {
    const header = localPreviewDownloadDisposition('季度 "report"\r\nX-Injected: yes\\.xlsx');
    expect(header).not.toMatch(/[\r\n]/u);
    expect(header).toMatch(
      /^attachment; filename="[\x20-\x21\x23-\x5b\x5d-\x7e]+"; filename\*=UTF-8''/u,
    );
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(
      '季度 "report"\r\nX-Injected: yes\\.xlsx',
    );
  });
});

describe("streamedFileResponseWithRange and rangedBufferResponse", () => {
  it("streams 200, 206 slices, 416 rejections, and HEAD without opening a stream", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-range-test-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "clip.mp4");
    const content = Buffer.from("0123456789abcdef");
    await fs.writeFile(filePath, content);
    const bufferBytes = new Uint8Array(Buffer.from("ABCDEFGHIJ"));

    const streamCalls: Array<{ path: string; options: unknown }> = [];
    const onStreamCall = vi.fn((targetPath: string, options: unknown) => {
      streamCalls.push({ path: targetPath, options });
    });

    await withRangeServer(filePath, bufferBytes, onStreamCall, async (origin) => {
      const headRes = await fetch(`${origin}/file`, { method: "HEAD" });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("accept-ranges")).toBe("bytes");
      expect(headRes.headers.get("content-type")).toBe("video/mp4");
      expect(headRes.headers.get("content-length")).toBe("16");
      expect(await headRes.text()).toBe("");
      expect(onStreamCall).not.toHaveBeenCalled();

      const fullRes = await fetch(`${origin}/file`);
      expect(fullRes.status).toBe(200);
      expect(fullRes.headers.get("accept-ranges")).toBe("bytes");
      expect(fullRes.headers.get("content-length")).toBe("16");
      expect(await fullRes.text()).toBe("0123456789abcdef");

      const sliceRes = await fetch(`${origin}/file`, { headers: { Range: "bytes=2-5" } });
      expect(sliceRes.status).toBe(206);
      expect(sliceRes.headers.get("accept-ranges")).toBe("bytes");
      expect(sliceRes.headers.get("content-range")).toBe("bytes 2-5/16");
      expect(sliceRes.headers.get("content-length")).toBe("4");
      expect(await sliceRes.text()).toBe("2345");
      expect(streamCalls.at(-1)?.options).toEqual({
        offset: 2,
        bytesToRead: 4,
        chunkSize: 64 * 1024,
      });

      const openEndedRes = await fetch(`${origin}/file`, { headers: { Range: "bytes=12-" } });
      expect(openEndedRes.status).toBe(206);
      expect(openEndedRes.headers.get("content-range")).toBe("bytes 12-15/16");
      expect(await openEndedRes.text()).toBe("cdef");

      const suffixRes = await fetch(`${origin}/file`, { headers: { Range: "bytes=-3" } });
      expect(suffixRes.status).toBe(206);
      expect(suffixRes.headers.get("content-range")).toBe("bytes 13-15/16");
      expect(await suffixRes.text()).toBe("def");

      const badRes = await fetch(`${origin}/file`, { headers: { Range: "bytes=99-120" } });
      expect(badRes.status).toBe(416);
      expect(badRes.headers.get("content-range")).toBe("bytes */16");

      // In-memory rangedBufferResponse checks
      const bufHead = await fetch(`${origin}/buffer`, { method: "HEAD" });
      expect(bufHead.status).toBe(200);
      expect(bufHead.headers.get("accept-ranges")).toBe("bytes");
      expect(bufHead.headers.get("content-type")).toBe("video/webm");
      expect(bufHead.headers.get("content-length")).toBe("10");
      expect(await bufHead.text()).toBe("");

      const bufPartial = await fetch(`${origin}/buffer`, { headers: { Range: "bytes=1-4" } });
      expect(bufPartial.status).toBe(206);
      expect(bufPartial.headers.get("accept-ranges")).toBe("bytes");
      expect(bufPartial.headers.get("content-range")).toBe("bytes 1-4/10");
      expect(bufPartial.headers.get("content-length")).toBe("4");
      expect(await bufPartial.text()).toBe("BCDE");

      const bufBad = await fetch(`${origin}/buffer`, { headers: { Range: "bytes=20-" } });
      expect(bufBad.status).toBe(416);
      expect(bufBad.headers.get("content-range")).toBe("bytes */10");
    });
  });

  it("handles 0-byte files cleanly for GET, HEAD, and Range", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-range-empty-"));
    tempDirs.push(dir);
    const emptyFile = path.join(dir, "empty.mp4");
    await fs.writeFile(emptyFile, Buffer.alloc(0));

    await withRangeServer(
      emptyFile,
      new Uint8Array(0),
      () => undefined,
      async (origin) => {
        const getEmpty = await fetch(`${origin}/file`);
        expect(getEmpty.status).toBe(200);
        expect(getEmpty.headers.get("content-length")).toBe("0");
        expect(getEmpty.headers.get("accept-ranges")).toBe("bytes");
        expect(await getEmpty.text()).toBe("");

        const headEmpty = await fetch(`${origin}/file`, { method: "HEAD" });
        expect(headEmpty.status).toBe(200);
        expect(headEmpty.headers.get("content-length")).toBe("0");

        const rangeEmpty = await fetch(`${origin}/file`, { headers: { Range: "bytes=0-0" } });
        expect(rangeEmpty.status).toBe(416);
        expect(rangeEmpty.headers.get("content-range")).toBe("bytes */0");

        const bufRangeEmpty = await fetch(`${origin}/buffer`, { headers: { Range: "bytes=0-" } });
        expect(bufRangeEmpty.status).toBe(416);
        expect(bufRangeEmpty.headers.get("content-range")).toBe("bytes */0");
      },
    );
  });
});
