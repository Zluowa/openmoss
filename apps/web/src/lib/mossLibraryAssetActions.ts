import type { MossLibraryItem } from "~/components/MossLibrarySurface.logic";
import { readNativeApi } from "~/nativeApi";
import { downloadUrlAsBlob } from "./browserDownload";
import { copyPngBlobToDesktopClipboard } from "./desktopClipboard";
import { normalizeImageToPng, readGeneratedImageContextFile } from "./generatedImageContextMenu";
import { buildLocalImageUrl } from "./localImageUrls";
import { resolveWsHttpUrl } from "./wsHttpUrl";

type CurrentOwner = () => boolean;

function assertCurrent(isCurrent: CurrentOwner): void {
  if (!isCurrent()) throw new DOMException("资料库已切换，请重新选择。", "AbortError");
}

/** Resolve original bytes from a trusted index row, never from a display thumbnail. */
export async function resolveMossLibraryOriginalUrl(
  item: MossLibraryItem,
  isCurrent: CurrentOwner,
): Promise<string> {
  assertCurrent(isCurrent);
  if (item.kind === "folder") throw new Error("文件夹不支持直接下载。");
  if (
    item.mediaJobId &&
    /^moss_[A-Za-z0-9_-]{1,128}$/u.test(item.mediaJobId) &&
    Number.isSafeInteger(item.mediaImageIndex) &&
    item.mediaImageIndex! >= 0 &&
    item.mediaImageIndex! <= 31
  ) {
    return resolveWsHttpUrl(`/api/moss/media/assets/${item.mediaJobId}/${item.mediaImageIndex}`);
  }
  if (!item.path) throw new Error("原文件暂时无法读取，请刷新资料库后重试。");
  const api = readNativeApi();
  if (!api) throw new Error("资料库连接尚未就绪，请稍后重试。");
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
    throw new Error("请仅选择一张图片进行分享。");
  }
  const desktop =
    typeof window !== "undefined" &&
    typeof window.desktopBridge?.clipboard?.writeImagePngDataUrl === "function";
  const browser =
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function";
  if (!desktop && !browser) throw new Error("当前环境无法复制图片，请使用下载。");
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
      throw new Error("图片未能复制到剪贴板，请重试或下载图片。");
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
