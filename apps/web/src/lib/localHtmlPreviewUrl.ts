import { LOCAL_HTML_PREVIEW_ROUTE_PREFIX } from "@moss/shared/localPreviewFiles";

import { basenameOfPath } from "~/file-icons";
import { resolveWsHttpUrl } from "./wsHttpUrl";

/**
 * The untrusted frame receives only its scoped grant and the file's own name: never
 * the app's auth token, and never the folder the file lives in.
 */
export function localHtmlPreviewUrl(filePath: string, grant: string): string {
  const url = new URL(resolveWsHttpUrl(LOCAL_HTML_PREVIEW_ROUTE_PREFIX));
  url.pathname += `${encodeURIComponent(grant)}/${encodeURIComponent(basenameOfPath(filePath))}`;
  url.search = "";
  url.hash = "";
  return url.href;
}
