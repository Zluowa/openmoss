import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  generateMossUpdateManifestKeyPair,
  MOSS_DESKTOP_CN_UPDATE_MIRROR,
} from "@moss/shared/mossUpdateMirror";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isUpdateIntegrityFailure,
  readAccessLaneFromSettingsFile,
  resolveDesktopUpdateFeeds,
  resolveDesktopUpdateMirror,
  resolveMirrorManualDownloadUrl,
  UpdateFeedRouter,
  type DesktopUpdateFeed,
  type UpdateFeedUpdater,
} from "./updateFeedRouter";

const { manifestPublicKey } = generateMossUpdateManifestKeyPair();
const mirror = { feedUrl: "https://updates.example.cn/moss/", manifestPublicKey };
const mirrorFeed: DesktopUpdateFeed = { id: "cn-mirror", mirror };
const officialFeed: DesktopUpdateFeed = { id: "official" };

type ActiveProvider = "official" | "mirror";

function fakeUpdater(outcomes: Record<ActiveProvider, ReadonlyArray<Error | null>>) {
  const attempts: ActiveProvider[] = [];
  const remaining = { official: [...outcomes.official], mirror: [...outcomes.mirror] };
  let active: ActiveProvider = "official";
  let configPathWrites = 0;
  const updater: UpdateFeedUpdater = {
    setFeedURL: vi.fn(() => {
      active = "mirror";
    }),
    get updateConfigPath() {
      return null;
    },
    set updateConfigPath(_value: string | null) {
      configPathWrites += 1;
      active = "official";
    },
    checkForUpdates: async () => {
      attempts.push(active);
      const outcome = remaining[active].shift() ?? null;
      if (outcome) throw outcome;
      return null;
    },
  };
  return {
    updater,
    attempts,
    configPathWrites: () => configPathWrites,
  };
}

function router(
  updater: UpdateFeedUpdater,
  feeds: ReadonlyArray<DesktopUpdateFeed>,
  now?: () => number,
) {
  return new UpdateFeedRouter({
    getUpdater: () => updater,
    resolveFeeds: async () => feeds,
    ...(now ? { now } : {}),
  });
}

describe("resolveDesktopUpdateFeeds", () => {
  it("tries the mirror first on the mirror channel, keeping the official feed behind it", () => {
    expect(resolveDesktopUpdateFeeds({ channel: "cn-mirror", mirror })).toEqual([
      mirrorFeed,
      officialFeed,
    ]);
  });

  it("never gives official-channel accounts the mirror", () => {
    expect(resolveDesktopUpdateFeeds({ channel: "official", mirror })).toEqual([officialFeed]);
  });

  it("stays on the official feed until a mirror is configured", () => {
    expect(resolveDesktopUpdateFeeds({ channel: "cn-mirror", mirror: null })).toEqual([
      officialFeed,
    ]);
  });
});

describe("resolveDesktopUpdateMirror", () => {
  it("ignores mock settings unless mock updates are on", () => {
    expect(
      resolveDesktopUpdateMirror({
        MOSS_DESKTOP_MOCK_UPDATE_MIRROR_URL: "http://127.0.0.1:9000",
        MOSS_DESKTOP_MOCK_UPDATE_MIRROR_PUBLIC_KEY: manifestPublicKey,
      }),
    ).toBe(MOSS_DESKTOP_CN_UPDATE_MIRROR);
  });

  it("accepts a loopback mock mirror when mock updates are on", () => {
    expect(
      resolveDesktopUpdateMirror({
        MOSS_DESKTOP_MOCK_UPDATES: "1",
        MOSS_DESKTOP_MOCK_UPDATE_MIRROR_URL: "http://127.0.0.1:9000",
        MOSS_DESKTOP_MOCK_UPDATE_MIRROR_PUBLIC_KEY: manifestPublicKey,
      }),
    ).toEqual({ feedUrl: "http://127.0.0.1:9000/", manifestPublicKey });
  });
});

describe("readAccessLaneFromSettingsFile", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  function settingsFile(contents: string): string {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-update-lane-"));
    directories.push(directory);
    const file = Path.join(directory, "settings.json");
    FS.writeFileSync(file, contents);
    return file;
  }

  it("reads the signed-in lane from the server's settings envelope", async () => {
    const file = settingsFile(
      JSON.stringify({
        revision: 3,
        migrationVersion: 3,
        settings: { providerInstances: { codex_moss: { config: { realm: "enterprise" } } } },
      }),
    );
    await expect(readAccessLaneFromSettingsFile(file)).resolves.toBe("enterprise");
  });

  it("reads the signed-in lane from a flat settings file written by an older build", async () => {
    const file = settingsFile(
      JSON.stringify({ providerInstances: { codex_moss: { config: { realm: "cn" } } } }),
    );
    await expect(readAccessLaneFromSettingsFile(file)).resolves.toBe("cn");
  });

  it("treats missing or corrupt settings as no account", async () => {
    await expect(readAccessLaneFromSettingsFile("/no/such/settings.json")).resolves.toBeNull();
    await expect(readAccessLaneFromSettingsFile(settingsFile("{oops"))).resolves.toBeNull();
    await expect(readAccessLaneFromSettingsFile(settingsFile("null"))).resolves.toBeNull();
  });
});

describe("resolveMirrorManualDownloadUrl", () => {
  it("points at the installer on the mirror", () => {
    expect(
      resolveMirrorManualDownloadUrl(mirror, [
        { url: "Moss-2.0.0-mac.zip" },
        { url: "Moss-2.0.0.dmg" },
      ]),
    ).toBe("https://updates.example.cn/moss/Moss-2.0.0.dmg");
  });

  it("has no answer without an installer", () => {
    expect(resolveMirrorManualDownloadUrl(mirror, [{ url: "Moss-2.0.0-mac.zip" }])).toBeNull();
    expect(resolveMirrorManualDownloadUrl(mirror, undefined)).toBeNull();
  });
});

describe("isUpdateIntegrityFailure", () => {
  it("recognizes rejected installers", () => {
    expect(
      isUpdateIntegrityFailure("New version 2.0.0 is not signed by the application owner: x"),
    ).toBe(true);
    expect(isUpdateIntegrityFailure("sha512 checksum mismatch (expected a, got b).")).toBe(true);
  });

  it("does not mistake connection problems for them", () => {
    expect(isUpdateIntegrityFailure("net::ERR_CONNECTION_TIMED_OUT")).toBe(false);
    expect(isUpdateIntegrityFailure("Timed out while checking for updates. Try again.")).toBe(
      false,
    );
  });
});

describe("UpdateFeedRouter", () => {
  it("uses the mirror when it answers, without touching the official feed", async () => {
    const fake = fakeUpdater({ official: [], mirror: [null] });
    const feedRouter = router(fake.updater, [mirrorFeed, officialFeed]);
    const onFallback = vi.fn();

    await feedRouter.check({ explicit: false, onFallback });

    expect(fake.attempts).toEqual(["mirror"]);
    expect(feedRouter.feed.id).toBe("cn-mirror");
    expect(feedRouter.isFallingBack).toBe(false);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back to the official feed from app-update.yml when the mirror fails", async () => {
    const mirrorDown = new Error("mirror down");
    const fake = fakeUpdater({ official: [null], mirror: [mirrorDown] });
    const feedRouter = router(fake.updater, [mirrorFeed, officialFeed]);
    const onFallback = vi.fn();

    await feedRouter.check({ explicit: false, onFallback });

    expect(fake.attempts).toEqual(["mirror", "official"]);
    expect(fake.configPathWrites()).toBe(1);
    expect(feedRouter.feed.id).toBe("official");
    expect(feedRouter.isFallingBack).toBe(true);
    expect(onFallback).toHaveBeenCalledWith(mirrorFeed, mirrorDown);
  });

  it("reports the official feed's error once both feeds fail", async () => {
    const fake = fakeUpdater({
      official: [new Error("official down")],
      mirror: [new Error("mirror down")],
    });
    const feedRouter = router(fake.updater, [mirrorFeed, officialFeed]);

    await expect(feedRouter.check({ explicit: false, onFallback: vi.fn() })).rejects.toThrow(
      "official down",
    );
    expect(feedRouter.isFallingBack).toBe(true);
  });

  it("leaves official-only accounts exactly as they were", async () => {
    const fake = fakeUpdater({ official: [new Error("offline")], mirror: [] });
    const feedRouter = router(fake.updater, [officialFeed]);

    await expect(feedRouter.check({ explicit: false, onFallback: vi.fn() })).rejects.toThrow(
      "offline",
    );
    expect(fake.updater.setFeedURL).not.toHaveBeenCalled();
    expect(fake.configPathWrites()).toBe(0);
    expect(feedRouter.isFallingBack).toBe(false);
  });

  it("moves back to the official feed when the account changes to Google", async () => {
    const fake = fakeUpdater({ official: [null], mirror: [null] });
    let feeds: ReadonlyArray<DesktopUpdateFeed> = [mirrorFeed, officialFeed];
    const feedRouter = new UpdateFeedRouter({
      getUpdater: () => fake.updater,
      resolveFeeds: async () => feeds,
    });

    await feedRouter.check({ explicit: false, onFallback: vi.fn() });
    feeds = [officialFeed];
    await feedRouter.check({ explicit: false, onFallback: vi.fn() });

    expect(fake.attempts).toEqual(["mirror", "official"]);
    expect(feedRouter.isFallingBack).toBe(false);
  });

  it("keeps background checks off a suspended mirror until it expires", async () => {
    let now = 1_000;
    const fake = fakeUpdater({ official: [null, null], mirror: [null] });
    const feedRouter = router(fake.updater, [mirrorFeed, officialFeed], () => now);

    feedRouter.suspendMirror();
    await feedRouter.check({ explicit: false, onFallback: vi.fn() });
    expect(fake.attempts).toEqual(["official"]);
    expect(feedRouter.isFallingBack).toBe(true);

    now += 31 * 60 * 1000;
    await feedRouter.check({ explicit: false, onFallback: vi.fn() });
    expect(fake.attempts).toEqual(["official", "mirror"]);
    expect(feedRouter.isFallingBack).toBe(false);
  });

  it("lets an explicit check retry a suspended mirror right away", async () => {
    const fake = fakeUpdater({ official: [], mirror: [null] });
    const feedRouter = router(fake.updater, [mirrorFeed, officialFeed]);

    feedRouter.suspendMirror();
    await feedRouter.check({ explicit: true, onFallback: vi.fn() });

    expect(fake.attempts).toEqual(["mirror"]);
    expect(feedRouter.isFallingBack).toBe(false);
  });
});
