import type { MossLibraryItem } from "~/components/MossLibrarySurface.logic";
import { readNativeApi } from "~/nativeApi";
import { downloadUrlAsBlob } from "./browserDownload";
import { copyPngBlobToDesktopClipboard } from "./desktopClipboard";
import { normalizeImageToPng, readGeneratedImageContextFile } from "./generatedImageContextMenu";
import { buildLocalImageUrl } from "./localImageUrls";
import { LocalizedError, localizedMessage } from "./localizedError";
import { resolveWsHttpUrl } from "./wsHttpUrl";

type CurrentOwner = () => boolean;

function assertCurrent(isCurrent: CurrentOwner): void {
  if (!isCurrent())
    throw new DOMException(localizedMessage("library.error.switched"), "AbortError");
}

/** Resolve original bytes from a trusted index row, never from a display thumbnail. */
export async function resolveMossLibraryOriginalUrl(
  item: MossLibraryItem,
  isCurrent: CurrentOwner,
): Promise<string> {
  assertCurrent(isCurrent);
  if (item.kind === "folder") throw new LocalizedError("library.error.folderDownload");
  if (
    item.mediaJobId &&
    /^moss_[A-Za-z0-9_-]{1,128}$/u.test(item.mediaJobId) &&
    Number.isSafeInteger(item.mediaImageIndex) &&
    item.mediaImageIndex! >= 0 &&
    item.mediaImageIndex! <= 31
  ) {
    return resolveWsHttpUrl(`/api/moss/media/assets/${item.mediaJobId}/${item.mediaImageIndex}`);
  }
  if (!item.path) throw new LocalizedError("library.error.originalUnavailable");
  const api = readNativeApi();
  if (!api) throw new LocalizedError("library.error.notConnected");
  const { grant } = await api.projects.createLocalFilePreviewGrant({ path: item.path });
  assertCurrent(isCurrent);
  return buildLocalImageUrl({
    src: item.path,
    cwd: undefined,
    grant,
    cacheKey: item.updatedAt,
    download: true,
  });
}

/** Copies a single real image into the local OS clipboard without creating a public URL. */
export async function shareMossLibraryImage(
  items: readonly MossLibraryItem[],
  isCurrent: CurrentOwner,
): Promise<void> {
  if (items.length !== 1 || items[0]?.kind !== "image") {
    throw new LocalizedError("library.error.shareOneImage");
  }
  const desktop =
    typeof window !== "undefined" &&
    typeof window.desktopBridge?.clipboard?.writeImagePngDataUrl === "function";
  const browser =
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function";
  if (!desktop && !browser) throw new LocalizedError("library.error.copyUnsupported");
  const item = items[0];
  const url = await resolveMossLibraryOriginalUrl(item, isCurrent);
  const file = await readGeneratedImageContextFile({
    image: { src: item.path ?? item.title, name: item.title },
    resolveImageUrl: () => url,
    fetchCredentials: "include",
  });
  assertCurrent(isCurrent);
  const png = await normalizeImageToPng(file);
  assertCurrent(isCurrent);
  if (desktop) {
    if (!(await copyPngBlobToDesktopClipboard(png, isCurrent))) {
      assertCurrent(isCurrent);
      throw new LocalizedError("library.error.copyFailed");
    }
  } else {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  }
  assertCurrent(isCurrent);
}

/** Fetch before creating a blob download so HTTP errors cannot navigate the app away. */
export async function downloadMossLibraryItem(
  item: MossLibraryItem,
  isCurrent: CurrentOwner,
): Promise<void> {
  const url = await resolveMossLibraryOriginalUrl(item, isCurrent);
  assertCurrent(isCurrent);
  await downloadUrlAsBlob({
    url,
    filename: item.title,
    preferFilename: true,
    credentials: "include",
    isCurrent,
  });
  assertCurrent(isCurrent);
}
