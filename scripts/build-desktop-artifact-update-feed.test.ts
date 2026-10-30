import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { resolveGitHubPublishConfig } from "./build-desktop-artifact.ts";

describe("resolveGitHubPublishConfig", () => {
  it("embeds the public Moss release feed when no repository is configured", () => {
    const config = Effect.runSync(resolveGitHubPublishConfig({}));

    expect(config).toEqual({
      provider: "github",
      owner: "Zluowa",
      repo: "moss-releases",
      releaseType: "release",
    });
  });

  it("ignores GITHUB_REPOSITORY so the private source repository is never a feed", () => {
    const config = Effect.runSync(resolveGitHubPublishConfig({ GITHUB_REPOSITORY: "Zluowa/Moss" }));

    expect(config?.repo).toBe("moss-releases");
  });

  it("honours an explicit repository override", () => {
    const config = Effect.runSync(
      resolveGitHubPublishConfig({ MOSS_DESKTOP_UPDATE_REPOSITORY: " acme/moss-canary-feed " }),
    );

    expect(config).toEqual({
      provider: "github",
      owner: "acme",
      repo: "moss-canary-feed",
      releaseType: "release",
    });
  });

  it("packages without a feed only when explicitly disabled", () => {
    expect(
      Effect.runSync(resolveGitHubPublishConfig({ MOSS_DESKTOP_UPDATE_REPOSITORY: "none" })),
    ).toBeUndefined();
    expect(
      Effect.runSync(resolveGitHubPublishConfig({ MOSS_DESKTOP_UPDATE_REPOSITORY: "NONE" })),
    ).toBeUndefined();
  });

  it("fails the build on a malformed repository slug instead of silently dropping the feed", () => {
    for (const value of ["moss-releases", "a/b/c", "/repo", "owner/"]) {
      const exit = Effect.runSyncExit(
        resolveGitHubPublishConfig({ MOSS_DESKTOP_UPDATE_REPOSITORY: value }),
      );
      expect(Exit.isFailure(exit), value).toBe(true);
    }
  });
});
