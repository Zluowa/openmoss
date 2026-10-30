// FILE: publicProxy.ts
// Purpose: Keep headless HTML previews away from the machine and private networks.
// Layer: Server utility
// Origin: Adapted from apps/server/src/htmlRender/publicProxy.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at ba0ea3d152150f399827d36a5b4b86c5bbda2d7f.

import * as dns from "node:dns/promises";
import * as net from "node:net";
import * as os from "node:os";

/** Local and special-use networks a preview must never be able to reach. */
const LOCAL_ADDRESSES = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const NAT64 = new net.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new net.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

const ownAddresses = () => {
  const addresses = new net.BlockList();
  for (const entry of Object.values(os.networkInterfaces()).flat()) {
    if (entry) addresses.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return addresses;
};

const ipv6Groups = (address: string) => {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

const embeddedIpv4 = (address: string) => {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

const isLocal = (address: string, family: number): boolean => {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (LOCAL_ADDRESSES.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIpv4(address) : undefined;
  return embedded !== undefined && isLocal(embedded, 4);
};

type Address = { readonly address: string; readonly family: number };

/** Resolve once and return only addresses verified to be public, defeating DNS rebinding. */
const publicAddresses = async (host: string): Promise<ReadonlyArray<Address> | undefined> => {
  const addresses: ReadonlyArray<Address> = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
  return addresses.length === 0 || addresses.some(({ address, family }) => isLocal(address, family))
    ? undefined
    : addresses;
};

const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
const MAX_EARLY_BYTES = 64 * 1024;

const refuse = (client: net.Socket, code: number) => {
  client.end(reply(code), () => client.destroy());
};

type SocksRequest =
  | {
      readonly command: number;
      readonly host: string;
      readonly port: number;
      readonly rest: Buffer;
    }
  | "short"
  | undefined;

const readRequest = (data: Buffer): SocksRequest => {
  if (data.length < 5) return "short";
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short";
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, index) =>
            data.readUInt16BE(4 + index * 2).toString(16),
          ).join(":");
  return { command: data[1]!, host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
};

export interface PublicProxy {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Starts a short-lived SOCKS5 proxy on loopback. Chromium sends all web traffic
 * through it; the proxy itself connects only to DNS-checked public addresses.
 */
export async function startPublicProxy(): Promise<PublicProxy> {
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = net.createServer((client) => {
    track(client);
    let data = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (!greeted) {
        if (data.length < 2 || data.length < 2 + data[1]!) return;
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        data = data.subarray(2 + data[1]!);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      const request = readRequest(data);
      if (request === "short") return;
      client.off("data", onData);
      if (request === undefined || request.command !== 1 || request.port === 0) {
        refuse(client, 7);
        return;
      }
      const early: Array<Buffer> = [request.rest];
      let earlyBytes = request.rest.length;
      const holdEarly = (earlyChunk: Buffer) => {
        earlyBytes += earlyChunk.length;
        if (earlyBytes > MAX_EARLY_BYTES) client.destroy();
        else early.push(earlyChunk);
      };
      client.on("data", holdEarly);
      void publicAddresses(request.host)
        .then((addresses) => {
          if (client.destroyed) return;
          client.off("data", holdEarly);
          if (addresses === undefined) {
            refuse(client, 2);
            return;
          }
          client.pause();
          const upstream = track(
            net.connect({
              host: request.host,
              port: request.port,
              autoSelectFamily: true,
              lookup: (_host, options, callback) =>
                options.all
                  ? callback(null, [...addresses])
                  : callback(null, addresses[0]!.address, addresses[0]!.family),
            }),
          );
          upstream.once("connect", () => {
            client.write(reply(0));
            for (const earlyChunk of early) upstream.write(earlyChunk);
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("close", () => client.destroy());
          client.on("close", () => upstream.destroy());
        })
        .catch(() => {
          // Address enumeration can fail in a confined desktop/runtime. Deny
          // the request rather than leave an unhandled rejection or connect
          // without the own-address check.
          if (!client.destroyed) refuse(client, 2);
        });
    };
    client.on("data", onData);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("The preview proxy did not receive a loopback port."));
    });
  });
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
