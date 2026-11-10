import { describe, expect, it } from "vitest";

import type { ServerLocalServerProcess } from "@moss/contracts";

import { localServerBelongsToWorkspace, localServerOpenUrl } from "./localServers";

function makeServer(overrides: Partial<ServerLocalServerProcess>): ServerLocalServerProcess {
  return {
    id: "srv-1",
    pid: 2518,
    command: "node.exe",
    displayName: "Vite",
    args: "",
    ports: [5173],
    addresses: [],
    isStoppable: true,
    ...overrides,
  };
}

describe("localServerBelongsToWorkspace", () => {
  it("keeps a server running in the project folder or one inside it", () => {
    expect(
      localServerBelongsToWorkspace(makeServer({ cwd: "D:\\work\\shop" }), "d:/work/shop"),
    ).toBe(true);
    expect(
      localServerBelongsToWorkspace(
        makeServer({ cwd: "D:\\work\\shop\\apps\\web" }),
        "D:\\work\\shop",
      ),
    ).toBe(true);
    expect(
      localServerBelongsToWorkspace(makeServer({ cwd: "D:\\work\\other" }), "D:\\work\\shop"),
    ).toBe(false);
  });

  it("keeps a server Moss started when nothing places it elsewhere", () => {
    expect(localServerBelongsToWorkspace(makeServer({ launchedByMoss: true }), "D:\\work")).toBe(
      true,
    );
    expect(localServerBelongsToWorkspace(makeServer({}), "D:\\work")).toBe(false);
    expect(
      localServerBelongsToWorkspace(
        makeServer({ launchedByMoss: true, cwd: "D:\\elsewhere" }),
        "D:\\work",
      ),
    ).toBe(false);
  });
});

describe("localServerOpenUrl", () => {
  it("prefers a reported URL, else localhost and the first port", () => {
    expect(
      localServerOpenUrl(
        makeServer({
          addresses: [
            { host: "127.0.0.1", port: 5941, family: "tcp4", url: "http://127.0.0.1:5941" },
          ],
        }),
      ),
    ).toBe("http://127.0.0.1:5941");
    expect(localServerOpenUrl(makeServer({ ports: [8000] }))).toBe("http://localhost:8000/");
    expect(localServerOpenUrl(makeServer({ ports: [] }))).toBeNull();
  });
});
