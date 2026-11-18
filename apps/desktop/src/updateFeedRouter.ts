// FILE: updateFeedRouter.ts
// Purpose: Picks the update feed for each check. Mirror accounts try the signed mirrors in order
//          (COS, then R2) and fall back to the official feed from app-update.yml; everyone else
//          only ever uses the official feed. Switching feeds leaves installer verification alone:
//          electron-updater reads the Windows publisher from app-update.yml, not from the active
//          provider.
// Layer: Desktop update runtime

import * as FS from "node:fs/promises";

import type { AppUpdater } from "electron-updater";

import {
  readActiveMossAccessLane,
  type MossDownloadChannel,
} from "@moss/shared/mossDownloadChannel";
import type { MossAccessLane } from "@moss/shared/mossRealmCatalog";
import {
  MOSS_DESKTOP_UPDATE_MIRRORS,
  parseMossUpdateMirrorConfig,
  type MossUpdateMirrorConfig,
} from "@moss/shared/mossUpdateMirror";

import {
  SignedUpdateMirrorProvider,
  type SignedUpdateMirrorOptions,
} from "./signedUpdateMirrorProvider";

export type DesktopUpdateFeed =
  | { readonly id: "official" }
  | { readonly id: "cn-mirror"; readonly mirror: MossUpdateMirrorConfig };

const OFFICIAL_UPDATE_FEED: DesktopUpdateFeed = { id: "official" };

// After a failed mirror download that mirror's manifest may be fine while its files are not, so
// background checks stay off that mirror for a while and start at the next feed. An explicit check
// tries every mirror again right away.
const UPDATE_MIRROR_SUSPENSION_MS = 30 * 60 * 1000;

/** The slice of electron-updater's AppUpdater that feed routing touches. */
export type UpdateFeedUpdater = Pick<AppUpdater, "setFeedURL" | "updateConfigPath"> & {
  checkForUpdates(): Promise<unknown>;
};

/**
 * The mirrors to try, most preferred first. A mock feed comes from the environment, under the same
 * flag that enables mock updates, and stands alone.
 */
export function resolveDesktopUpdateMirrors(
  env: NodeJS.ProcessEnv,
): ReadonlyArray<MossUpdateMirrorConfig> {
  const mockFeedUrl = env.MOSS_DESKTOP_MOCK_UPDATE_MIRROR_URL?.trim();
  const mockPublicKey = env.MOSS_DESKTOP_MOCK_UPDATE_MIRROR_PUBLIC_KEY?.trim();
  if (env.MOSS_DESKTOP_MOCK_UPDATES && mockFeedUrl && mockPublicKey) {
    return [
      parseMossUpdateMirrorConfig(
        { feedUrl: mockFeedUrl, manifestPublicKey: mockPublicKey },
        { allowLoopback: true },
      ),
    ];
  }
  return MOSS_DESKTOP_UPDATE_MIRRORS;
}

export function resolveDesktopUpdateFeeds(input: {
  readonly channel: MossDownloadChannel;
  readonly mirrors: ReadonlyArray<MossUpdateMirrorConfig>;
}): ReadonlyArray<DesktopUpdateFeed> {
  return input.channel === "cn-mirror"
    ? [
        ...input.mirrors.map((mirror): DesktopUpdateFeed => ({ id: "cn-mirror", mirror })),
        OFFICIAL_UPDATE_FEED,
      ]
    : [OFFICIAL_UPDATE_FEED];
}

/** Tells feeds apart: every mirror shares the id "cn-mirror". */
function updateFeedKey(feed: DesktopUpdateFeed): string {
  return feed.id === "official" ? "official" : `mirror:${feed.mirror.feedUrl}`;
}

/** For logs only. */
export function describeUpdateFeed(feed: DesktopUpdateFeed): string {
  return feed.id === "official" ? "official" : `cn-mirror ${new URL(feed.mirror.feedUrl).host}`;
}

/** Settings the server wrote; an unreadable file means no known account, not a failed update. */
export async function readAccessLaneFromSettingsFile(
  settingsPath: string,
): Promise<MossAccessLane | null> {
  try {
    const parsed = JSON.parse(await FS.readFile(settingsPath, "utf8")) as {
      readonly settings?: { readonly providerInstances?: unknown };
      readonly providerInstances?: unknown;
    } | null;
    // The server wraps settings in a versioned envelope; files from older builds are flat.
    return readActiveMossAccessLane((parsed?.settings ?? parsed)?.providerInstances);
  } catch {
    return null;
  }
}

/**
 * The installer a mainland user can fetch by hand when installing keeps failing, on the mirror
 * that served the manifest. The official fallback link is a GitHub page, which is the very thing
 * those users cannot reach.
 */
export function resolveMirrorManualDownloadUrl(
  mirror: MossUpdateMirrorConfig,
  files: ReadonlyArray<{ readonly url: string }> | null | undefined,
): string | null {
  const installer = files?.find((file) => /\.(?:exe|dmg|appimage)$/iu.test(file.url));
  return installer ? new URL(installer.url, mirror.feedUrl).toString() : null;
}

/** A rejected installer is a security verdict, not a connection problem a retry would fix. */
export function isUpdateIntegrityFailure(message: string): boolean {
  return /not signed by the application owner|sha512 checksum mismatch/iu.test(message);
}

export class UpdateFeedRouter {
  private activeFeed: DesktopUpdateFeed = OFFICIAL_UPDATE_FEED;
  /** Mirror feed URL → until when background checks skip that mirror. */
  private readonly mirrorSuspendedUntilMs = new Map<string, number>();
  private fallbackEngaged = false;

  constructor(
    private readonly deps: {
      readonly getUpdater: () => UpdateFeedUpdater;
      /** Feeds this install may use, most preferred first. */
      readonly resolveFeeds: () => Promise<ReadonlyArray<DesktopUpdateFeed>>;
      readonly now?: () => number;
    },
  ) {}

  get feed(): DesktopUpdateFeed {
    return this.activeFeed;
  }

  /**
   * True when the official feed is standing in for the mirrors this account should be using (each
   * one failed or is suspended). A later mirror standing in for an earlier one does not count: the
   * account is still on a domestic source.
   */
  get isFallingBack(): boolean {
    return this.fallbackEngaged;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private isSuspended(feed: DesktopUpdateFeed): boolean {
    if (feed.id === "official") return false;
    return this.now() < (this.mirrorSuspendedUntilMs.get(feed.mirror.feedUrl) ?? 0);
  }

  private select(feed: DesktopUpdateFeed): void {
    if (updateFeedKey(feed) === updateFeedKey(this.activeFeed)) return;
    this.activeFeed = feed;
    const updater = this.deps.getUpdater();
    if (feed.id === "official") {
      // Drops the mirror provider; electron-updater rebuilds its client from app-update.yml.
      updater.updateConfigPath = null;
      return;
    }
    updater.setFeedURL({
      provider: "custom",
      updateProvider: SignedUpdateMirrorProvider,
      feedUrl: feed.mirror.feedUrl,
      manifestPublicKey: feed.mirror.manifestPublicKey,
    } satisfies SignedUpdateMirrorOptions);
  }

  /**
   * Runs one update check, moving to the next feed when one fails (a mirror that does not answer
   * or whose manifest is not signed by the release key). Rejects with the last feed's error once
   * every feed has failed. `onFallback` runs before the next feed is tried.
   */
  async check(input: {
    readonly explicit: boolean;
    readonly onFallback: (
      failedFeed: DesktopUpdateFeed,
      error: unknown,
      nextFeed: DesktopUpdateFeed,
    ) => void;
  }): Promise<void> {
    if (input.explicit) this.mirrorSuspendedUntilMs.clear();
    const candidates = await this.deps.resolveFeeds();
    const feeds = candidates.filter((feed) => !this.isSuspended(feed));
    const hasMirror = candidates.some((feed) => feed.id === "cn-mirror");
    this.fallbackEngaged = false;

    for (const [index, feed] of feeds.entries()) {
      this.select(feed);
      this.fallbackEngaged = hasMirror && feed.id === "official";
      try {
        await this.deps.getUpdater().checkForUpdates();
        return;
      } catch (error) {
        const nextFeed = feeds[index + 1];
        if (nextFeed === undefined) throw error;
        input.onFallback(feed, error, nextFeed);
      }
    }
  }

  /**
   * The active mirror served a manifest but its download failed: background checks skip that
   * mirror for a while and start at the next feed. Does nothing while the official feed is active.
   */
  suspendActiveMirror(): void {
    const feed = this.activeFeed;
    if (feed.id === "official") return;
    this.mirrorSuspendedUntilMs.set(feed.mirror.feedUrl, this.now() + UPDATE_MIRROR_SUSPENSION_MS);
  }
}
