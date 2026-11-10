// FILE: signedUpdateMirrorProvider.ts
// Purpose: electron-updater feed for the domestic mirror. Only a manifest signed by the Moss release
//          key is accepted, and the request is time-boxed so a dead mirror fails fast into the
//          official feed instead of hanging the whole update check.
// Layer: Desktop update runtime

import {
  CancellationToken,
  Provider,
  type AppUpdater,
  type ResolvedUpdateFileInfo,
  type UpdateInfo,
} from "electron-updater";
import {
  parseUpdateInfo,
  resolveFiles,
  type ProviderRuntimeOptions,
} from "electron-updater/out/providers/Provider";

import {
  MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX,
  verifyMossUpdateManifest,
  type MossUpdateMirrorConfig,
} from "@moss/shared/mossUpdateMirror";

// Short on purpose: a mainland user waiting on a dead mirror still has the official feed to try
// inside the same check.
const UPDATE_MIRROR_REQUEST_TIMEOUT_MS = 10_000;

export const UPDATE_MIRROR_UNTRUSTED_MANIFEST_CODE = "ERR_MOSS_UPDATE_MIRROR_UNTRUSTED_MANIFEST";

type CustomPublishOptions = Extract<
  Parameters<AppUpdater["setFeedURL"]>[0],
  { readonly provider: "custom" }
>;

export interface SignedUpdateMirrorOptions extends CustomPublishOptions, MossUpdateMirrorConfig {
  readonly requestTimeoutMs?: number;
}

export class SignedUpdateMirrorProvider extends Provider<UpdateInfo> {
  private readonly options: SignedUpdateMirrorOptions;
  private readonly baseUrl: URL;

  constructor(
    options: CustomPublishOptions,
    private readonly updater: { readonly channel: string | null },
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    // Object storage and CDNs answer multi-range requests inconsistently; one range per request
    // works everywhere.
    super({ ...runtimeOptions, isUseMultipleRangeRequest: false });
    // electron-updater passes back the object given to setFeedURL.
    this.options = options as SignedUpdateMirrorOptions;
    this.baseUrl = new URL(this.options.feedUrl);
  }

  private uncachedUrl(fileName: string): URL {
    const url = new URL(fileName, this.baseUrl);
    url.searchParams.set("noCache", Date.now().toString(32));
    return url;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const channelFile = `${this.getCustomChannelName(this.updater.channel ?? "latest")}.yml`;
    const manifestUrl = this.uncachedUrl(channelFile);
    const cancellation = new CancellationToken();
    const timeoutMs = this.options.requestTimeoutMs ?? UPDATE_MIRROR_REQUEST_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancellation.cancel();
    }, timeoutMs);
    timer.unref();

    let manifest: string | null;
    let signature: string | null;
    try {
      [manifest, signature] = await Promise.all([
        this.httpRequest(manifestUrl, null, cancellation),
        this.httpRequest(
          this.uncachedUrl(`${channelFile}${MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX}`),
          null,
          cancellation,
        ),
      ]);
    } catch (error) {
      // Abort whichever request is still running.
      cancellation.cancel();
      if (timedOut) {
        throw new Error(`Update mirror did not answer within ${timeoutMs} ms.`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (
      manifest === null ||
      signature === null ||
      !verifyMossUpdateManifest({
        channelFile,
        manifest,
        signature,
        manifestPublicKey: this.options.manifestPublicKey,
      })
    ) {
      throw Object.assign(
        new Error(`Update mirror manifest ${channelFile} is not signed by the Moss release key.`),
        { code: UPDATE_MIRROR_UNTRUSTED_MANIFEST_CODE },
      );
    }
    return parseUpdateInfo(manifest, channelFile, manifestUrl);
  }

  resolveFiles(updateInfo: UpdateInfo): Array<ResolvedUpdateFileInfo> {
    return resolveFiles(updateInfo, this.baseUrl);
  }
}
