import { expect, it, vi } from "vitest";
import { localHtmlPreviewUrl } from "./localHtmlPreviewUrl";

vi.mock("./wsHttpUrl", () => ({
  resolveWsHttpUrl: (route: string) => `http://127.0.0.1:5733${route}?token=main-app-secret`,
}));

it("gives HTML only a scoped grant, removing the main application token", () => {
  const url = new URL(localHtmlPreviewUrl("E:/演示/品牌页面.html", "scoped-preview-grant"));
  expect(url.origin).toBe("http://127.0.0.1:5733");
  expect(decodeURIComponent(url.pathname)).toBe(
    "/api/local-html/scoped-preview-grant/品牌页面.html",
  );
  expect(url.search).toBe("");
  expect(url.href).not.toContain("main-app-secret");
});

it.each([
  ["C:\\Users\\me\\Downloads\\site\\index.html", ["Users", "Downloads", "site", "C:"]],
  ["\\\\server\\share\\reports\\index.html", ["server", "share", "reports"]],
  ["/home/me/projects/site/index.html", ["home", "projects", "site"]],
  ["file:///C:/Users/me/site/index.html", ["Users", "site", "C:"]],
])("never puts the folder of %s in the frame URL", (filePath, folderParts) => {
  const decoded = decodeURIComponent(localHtmlPreviewUrl(filePath, "grant"));
  expect(decoded).toBe("http://127.0.0.1:5733/api/local-html/grant/index.html");
  for (const part of folderParts) expect(decoded).not.toContain(part);
});
