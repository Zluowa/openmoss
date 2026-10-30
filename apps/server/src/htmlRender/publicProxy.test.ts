import * as net from "node:net";
import * as os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type PublicProxy, startPublicProxy } from "./publicProxy.ts";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  networkInterfaces: vi.fn(() => ({})),
}));

const waitForReply = (socket: net.Socket) =>
  new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for SOCKS reply.")),
      2_000,
    );
    socket.once("data", (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

describe("HTML preview public proxy", () => {
  let proxy: PublicProxy | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    vi.restoreAllMocks();
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.1.2",
    "192.168.1.2",
    "169.254.169.254",
    "100.64.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
  ])("refuses local or private target %s before a preview can connect", async (target) => {
    // Exercise embedded-address classification even when this test host
    // itself cannot enumerate interfaces.
    vi.mocked(os.networkInterfaces).mockReturnValue({});
    proxy = await startPublicProxy();
    const socket = net.createConnection({ host: "127.0.0.1", port: proxy.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(Buffer.from([5, 1, 0]));
    expect(await waitForReply(socket)).toEqual(Buffer.from([5, 0]));
    const host = Buffer.from(target);
    socket.write(
      Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0, 80])]),
    );
    const denied = await waitForReply(socket);
    expect(denied.subarray(0, 2)).toEqual(Buffer.from([5, 2]));
    socket.destroy();
  });

  it("fails closed when local interface enumeration is unavailable", async () => {
    vi.mocked(os.networkInterfaces).mockImplementation(() => {
      throw new Error("Interface enumeration denied");
    });
    proxy = await startPublicProxy();
    const socket = net.createConnection({ host: "127.0.0.1", port: proxy.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(Buffer.from([5, 1, 0]));
    expect(await waitForReply(socket)).toEqual(Buffer.from([5, 0]));
    const host = Buffer.from("8.8.8.8");
    socket.write(
      Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0, 80])]),
    );
    expect((await waitForReply(socket)).subarray(0, 2)).toEqual(Buffer.from([5, 2]));
    socket.destroy();
  });
});
