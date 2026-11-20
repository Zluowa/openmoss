import { describe, expect, it, vi } from "vitest";

import {
  applyMacUpdateNoticeResult,
  fetchMacUpdateNotice,
  MAC_UPDATE_NOTICE_PATH,
  MOSS_DOWNLOAD_PAGE_URL,
  parseMacUpdateNotice,
  resolveDesktopUpdateDelivery,
  type MacUpdateNoticeFetch,
} from "./macUpdateNotice";
import { createInitialDesktopUpdateState } from "./updateMachine";

const runtimeInfo = {
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
} as const;

describe("resolveDesktopUpdateDelivery", () => {
  it("announces new versions on a packaged Mac build without a Developer ID", () => {
    // Ad-hoc signed: codesign reports `TeamIdentifier=not set`, which ownAppTeamId turns into null.
    expect(
      resolveDesktopUpdateDelivery({
        platform: "darwin",
        isPackaged: true,
        readTeamId: () => null,
      }),
    ).toBe("manual-download");
    // codesign could not tell: an install that may fail is never offered.
    expect(
      resolveDesktopUpdateDelivery({
        platform: "darwin",
        isPackaged: true,
        readTeamId: () => "unavailable",
      }),
    ).toBe("manual-download");
  });

  it("keeps the in-app update on a Mac build signed with a Developer ID", () => {
    expect(
      resolveDesktopUpdateDelivery({
        platform: "darwin",
        isPackaged: true,
        readTeamId: () => "ABCDE12345",
      }),
    ).toBe("in-app");
  });

  it("leaves Windows, Linux and unpackaged runs alone without asking codesign", () => {
    const readTeamId = vi.fn(() => null);
    expect(resolveDesktopUpdateDelivery({ platform: "win32", isPackaged: true, readTeamId })).toBe(
      "in-app",
    );
    expect(resolveDesktopUpdateDelivery({ platform: "linux", isPackaged: true, readTeamId })).toBe(
      "in-app",
    );
    expect(
      resolveDesktopUpdateDelivery({ platform: "darwin", isPackaged: false, readTeamId }),
    ).toBe("in-app");
    expect(readTeamId).not.toHaveBeenCalled();
  });
});

describe("parseMacUpdateNotice", () => {
  it("reads the version", () => {
    expect(parseMacUpdateNotice('{ "version": "1.0.9" }\n')).toBe("1.0.9");
  });

  it("refuses anything that is not a plain version", () => {
    expect(parseMacUpdateNotice("not json")).toBeNull();
    expect(parseMacUpdateNotice("{}")).toBeNull();
    expect(parseMacUpdateNotice('{ "version": 109 }')).toBeNull();
    expect(parseMacUpdateNotice('{ "version": "<b>1.0.9</b>" }')).toBeNull();
    expect(parseMacUpdateNotice('["1.0.9"]')).toBeNull();
  });
});

function response(status: number, body = ""): Awaited<ReturnType<MacUpdateNoticeFetch>> {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const COS = "https://cos.example/";
const R2 = "https://r2.example/";

describe("fetchMacUpdateNotice", () => {
  it("reads the notice beside the desktop feed, bypassing caches", async () => {
    const fetch = vi.fn<MacUpdateNoticeFetch>(async () => response(200, '{"version":"1.0.9"}'));
    await expect(fetchMacUpdateNotice({ sources: [R2, COS], fetch })).resolves.toEqual({
      status: "found",
      version: "1.0.9",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${R2.slice(0, -1)}/${MAC_UPDATE_NOTICE_PATH}`);
    expect(MAC_UPDATE_NOTICE_PATH).toBe("desktop/moss-mac-notice.json");
    expect(url.searchParams.has("noCache")).toBe(true);
  });

  it("moves to the next source when one fails", async () => {
    const fetch = vi.fn<MacUpdateNoticeFetch>(async (url) => {
      if (url.startsWith(R2)) throw new Error("connect ETIMEDOUT");
      return response(200, '{"version":"1.0.9"}');
    });
    await expect(fetchMacUpdateNotice({ sources: [R2, COS], fetch })).resolves.toEqual({
      status: "found",
      version: "1.0.9",
    });
  });

  it("reports no notice when the file is not published", async () => {
    const fetch = vi.fn<MacUpdateNoticeFetch>(async () => response(404));
    await expect(fetchMacUpdateNotice({ sources: [R2, COS], fetch })).resolves.toEqual({
      status: "none",
    });
  });

  it("fails when no source answers", async () => {
    const fetch = vi.fn<MacUpdateNoticeFetch>(async () => response(503));
    const result = await fetchMacUpdateNotice({ sources: [R2, COS], fetch });
    expect(result.status).toBe("failed");
  });
});

describe("applyMacUpdateNoticeResult", () => {
  const base = {
    ...createInitialDesktopUpdateState("1.0.8", runtimeInfo),
    enabled: true,
    status: "idle" as const,
    manualDownloadUrl: MOSS_DOWNLOAD_PAGE_URL,
  };
  const checkedAt = "2026-11-20T10:00:00.000Z";
  const acceptVersion = (version: string) => version !== "1.0.8" && version !== "1.0.7";

  it("announces a newer version, with the download page and no install", () => {
    const state = applyMacUpdateNoticeResult(
      base,
      { status: "found", version: "1.0.9" },
      { acceptVersion, checkedAt },
    );
    expect(state).toMatchObject({
      status: "available",
      availableVersion: "1.0.9",
      downloadedVersion: null,
      manualDownloadUrl: "https://mossbotai.com/download",
    });
  });

  it("stays quiet for the running version or an older one", () => {
    for (const version of ["1.0.8", "1.0.7"]) {
      const state = applyMacUpdateNoticeResult(
        base,
        { status: "found", version },
        { acceptVersion, checkedAt },
      );
      expect(state.status).toBe("up-to-date");
      expect(state.availableVersion).toBeNull();
    }
  });

  it("keeps an announced version through a failed recheck", () => {
    const announced = applyMacUpdateNoticeResult(
      base,
      { status: "found", version: "1.0.9" },
      { acceptVersion, checkedAt },
    );
    const state = applyMacUpdateNoticeResult(
      announced,
      { status: "failed", message: "offline" },
      { acceptVersion, checkedAt },
    );
    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.0.9");
  });

  it("reports a failed first check as a check error, which the sidebar keeps hidden", () => {
    const state = applyMacUpdateNoticeResult(
      base,
      { status: "failed", message: "offline" },
      { acceptVersion, checkedAt },
    );
    expect(state).toMatchObject({ status: "error", errorContext: "check" });
  });
});
