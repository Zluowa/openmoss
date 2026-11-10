// FILE: updateFeedRouter.ts
// Purpose: Picks the update feed for each check. Mirror accounts try the domestic mirror first and
//          fall back to the official feed from app-update.yml; everyone else only ever uses the
//          official feed. Switching feeds leaves installer verification alone: electron-updater
//          reads the Windows publisher from app-update.yml, not from the active provider.
// Layer: Desktop update runtime

import * as FS from "node:fs/promises";

import type { AppUpdater } from "electron-updater";

import {
  readActiveMossAccessLane,
  type MossDownloadChannel,
} from "@moss/shared/mossDownloadChannel";
import type { MossAccessLane } from "@moss/shared/mossRealmCatalog";
import {
  MOSS_DESKTOP_CN_UPDATE_MIRROR,
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

// After a failed mirror download the mirror's manifest may be fine while its files are not, so
// background checks stay off it for a while. An explicit check tries it again right away.
const UPDATE_MIRROR_SUSPENSION_MS = 30 * 60 * 1000;

/** The slice of electron-updater's AppUpdater that feed routing touches. */
export type UpdateFeedUpdater = Pick<AppUpdater, "setFeedURL" | "updateConfigPath"> & {
  checkForUpdates(): Promise<unknown>;
};

/** A mock feed comes from the environment, under the same flag that enables mock updates. */
export function resolveDesktopUpdateMirror(env: NodeJS.ProcessEnv): MossUpdateMirrorConfig | null {
  const mockFeedUrl = env.MOSS_DESKTOP_MOCK_UPDATE_MIRROR_URL?.trim();
  const mockPublicKey = env.MOSS_DESKTOP_MOCK_UPDATE_MIRROR_PUBLIC_KEY?.trim();
  if (env.MOSS_DESKTOP_MOCK_UPDATES && mockFeedUrl && mockPublicKey) {
    return parseMossUpdateMirrorConfig(
      { feedUrl: mockFeedUrl, manifestPublicKey: mockPublicKey },
      { allowLoopback: true },
    );
  }
  return MOSS_DESKTOP_CN_UPDATE_MIRROR;
}

export function resolveDesktopUpdateFeeds(input: {
  readonly channel: MossDownloadChannel;
  readonly mirror: MossUpdateMirrorConfig | null;
}): ReadonlyArray<DesktopUpdateFeed> {
  return input.channel === "cn-mirror" && input.mirror
    ? [{ id: "cn-mirror", mirror: input.mirror }, OFFICIAL_UPDATE_FEED]
    : [OFFICIAL_UPDATE_FEED];
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
 * The installer a mainland user can fetch by hand when installing keeps failing. The official
 * fallback link is a GitHub page, which is the very thing those users cannot reach.
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
  private mirrorSuspendedUntilMs = 0;
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

  /** True when the official feed is standing in for a mirror this account should be using. */
  get isFallingBack(): boolean {
    return this.fallbackEngaged;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private select(feed: DesktopUpdateFeed): void {
    if (feed.id === this.activeFeed.id) return;
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
   * Runs one update check, moving to the next feed when one fails. Rejects with the last feed's
   * error once every feed has failed. `onFallback` runs before the next feed is tried.
   */
  async check(input: {
    readonly explicit: boolean;
    readonly onFallback: (failedFeed: DesktopUpdateFeed, error: unknown) => void;
  }): Promise<void> {
    if (input.explicit) this.mirrorSuspendedUntilMs = 0;
    const candidates = await this.deps.resolveFeeds();
    const feeds =
      this.now() < this.mirrorSuspendedUntilMs
        ? candidates.filter((feed) => feed.id === "official")
        : candidates;
    this.fallbackEngaged = feeds.length !== candidates.length;

    for (const [index, feed] of feeds.entries()) {
      this.select(feed);
      try {
        await this.deps.getUpdater().checkForUpdates();
        return;
      } catch (error) {
        if (index === feeds.length - 1) throw error;
        this.fallbackEngaged = true;
        input.onFallback(feed, error);
      }
    }
  }

  /** The mirror served a manifest but its download failed; prefer the official feed for a while. */
  suspendMirror(): void {
    this.mirrorSuspendedUntilMs = this.now() + UPDATE_MIRROR_SUSPENSION_MS;
  }
}
