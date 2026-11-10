import type { CancellationToken } from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import {
  generateMossUpdateManifestKeyPair,
  signMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import { describe, expect, it } from "vitest";

import {
  SignedUpdateMirrorProvider,
  UPDATE_MIRROR_UNTRUSTED_MANIFEST_CODE,
} from "./signedUpdateMirrorProvider";

const { manifestPublicKey, privateKey } = generateMossUpdateManifestKeyPair();
const feedUrl = "https://updates.example.cn/moss/";
const manifest = `version: 2.0.0
files:
  - url: Moss-2.0.0-x64.exe
    sha512: abc
    size: 3
path: Moss-2.0.0-x64.exe
sha512: abc
`;

type RequestHandler = (url: URL) => Promise<string | null>;

function providerWith(
  handler: RequestHandler,
  options: {
    readonly requestTimeoutMs?: number;
    readonly channel?: string | null;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const requested: URL[] = [];
  const executor = {
    request: (
      requestOptions: {
        protocol?: string;
        hostname?: string;
        port?: string | number;
        path?: string;
      },
      cancellation: CancellationToken,
    ) => {
      const port = requestOptions.port ? `:${requestOptions.port}` : "";
      const url = new URL(
        `${requestOptions.protocol}//${requestOptions.hostname}${port}${requestOptions.path}`,
      );
      requested.push(url);
      return cancellation.createPromise<string | null>((resolve, reject) => {
        handler(url).then(resolve, reject);
      });
    },
  };
  const provider = new SignedUpdateMirrorProvider(
    {
      provider: "custom",
      feedUrl,
      manifestPublicKey,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    },
    { channel: options.channel === undefined ? "moss" : options.channel },
    {
      isUseMultipleRangeRequest: true,
      platform: options.platform ?? "win32",
      executor,
    } as unknown as ProviderRuntimeOptions,
  );
  return { provider, requested };
}

function feedServing(files: Readonly<Record<string, string | null>>): RequestHandler {
  return async (url) => {
    const name = url.pathname.split("/").pop() ?? "";
    if (!(name in files)) throw new Error(`HttpError: 404 ${name}`);
    return files[name] ?? null;
  };
}

const signature = signMossUpdateManifest({ channelFile: "moss.yml", manifest, privateKey });

describe("SignedUpdateMirrorProvider", () => {
  it("returns update info from a correctly signed manifest", async () => {
    const { provider, requested } = providerWith(
      feedServing({ "moss.yml": manifest, "moss.yml.sig": signature }),
    );

    const info = await provider.getLatestVersion();

    expect(info.version).toBe("2.0.0");
    expect(requested.map((url) => url.pathname).toSorted()).toEqual([
      "/moss/moss.yml",
      "/moss/moss.yml.sig",
    ]);
    // A CDN must not answer a check from a stale manifest.
    expect(requested.every((url) => url.searchParams.has("noCache"))).toBe(true);
  });

  it("resolves installers relative to the mirror", async () => {
    const { provider } = providerWith(
      feedServing({ "moss.yml": manifest, "moss.yml.sig": signature }),
    );
    const info = await provider.getLatestVersion();

    expect(provider.resolveFiles(info).map((file) => file.url.href)).toEqual([
      "https://updates.example.cn/moss/Moss-2.0.0-x64.exe",
    ]);
  });

  it("rejects a manifest changed after signing", async () => {
    const { provider } = providerWith(
      feedServing({
        "moss.yml": manifest.replaceAll("sha512: abc", "sha512: evil"),
        "moss.yml.sig": signature,
      }),
    );

    await expect(provider.getLatestVersion()).rejects.toMatchObject({
      code: UPDATE_MIRROR_UNTRUSTED_MANIFEST_CODE,
    });
  });

  it("rejects a manifest with an empty signature file", async () => {
    const { provider } = providerWith(feedServing({ "moss.yml": manifest, "moss.yml.sig": null }));

    await expect(provider.getLatestVersion()).rejects.toMatchObject({
      code: UPDATE_MIRROR_UNTRUSTED_MANIFEST_CODE,
    });
  });

  it("fails when the mirror has no signature at all", async () => {
    const { provider } = providerWith(feedServing({ "moss.yml": manifest }));

    await expect(provider.getLatestVersion()).rejects.toThrow("404");
  });

  it("fails fast when the mirror never answers", async () => {
    const { provider } = providerWith(() => new Promise<string | null>(() => undefined), {
      requestTimeoutMs: 20,
    });

    await expect(provider.getLatestVersion()).rejects.toThrow("did not answer within 20 ms");
  });

  it("asks for one byte range per request", () => {
    const { provider } = providerWith(feedServing({}));
    expect(provider.isUseMultipleRangeRequest).toBe(false);
  });

  it("reads the manifest of the updater's channel", async () => {
    const betaSignature = signMossUpdateManifest({
      channelFile: "beta.yml",
      manifest,
      privateKey,
    });
    const { provider, requested } = providerWith(
      feedServing({ "beta.yml": manifest, "beta.yml.sig": betaSignature }),
      { channel: "beta" },
    );

    await provider.getLatestVersion();

    expect(requested[0]?.pathname).toBe("/moss/beta.yml");
  });

  it.each([
    ["darwin", "moss-mac.yml"],
    ["linux", "moss-linux.yml"],
  ] as const)("requires a signature for %s's own manifest", async (platform, channelFile) => {
    const { provider } = providerWith(
      feedServing({
        [channelFile]: manifest,
        [`${channelFile}.sig`]: signMossUpdateManifest({ channelFile, manifest, privateKey }),
      }),
      { platform },
    );
    await expect(provider.getLatestVersion()).resolves.toMatchObject({ version: "2.0.0" });

    const replayed = providerWith(
      feedServing({ [channelFile]: manifest, [`${channelFile}.sig`]: signature }),
      { platform },
    );
    await expect(replayed.provider.getLatestVersion()).rejects.toMatchObject({
      code: UPDATE_MIRROR_UNTRUSTED_MANIFEST_CODE,
    });
  });
});
