// FILE: mediaPermissions.test.ts
// Purpose: Verifies desktop microphone permissions fail closed outside the trusted Moss renderer.
// Layer: Desktop unit test
// Depends on: mediaPermissions helpers.

import { describe, expect, it } from "vitest";

import {
  normalizePermissionOrigin,
  shouldAllowMediaPermissionCheck,
  shouldAllowMediaPermissionRequest,
  type MediaPermissionCheckInput,
  type MediaPermissionRequestInput,
} from "./mediaPermissions";

const TRUSTED_RENDERER_URL = "moss://app/index.html";
const MAIN_WEB_CONTENTS = {};
const OTHER_WEB_CONTENTS = {};

function requestInput(
  overrides: Partial<MediaPermissionRequestInput> = {},
): MediaPermissionRequestInput {
  return {
    permission: "media",
    webContents: MAIN_WEB_CONTENTS,
    trustedWebContents: MAIN_WEB_CONTENTS,
    trustedRendererUrl: TRUSTED_RENDERER_URL,
    details: {
      isMainFrame: true,
      requestingUrl: "moss://app/index.html#/chat",
      securityOrigin: "moss://app",
      mediaTypes: ["audio"],
    },
    ...overrides,
  };
}

function checkInput(overrides: Partial<MediaPermissionCheckInput> = {}): MediaPermissionCheckInput {
  return {
    permission: "media",
    webContents: MAIN_WEB_CONTENTS,
    trustedWebContents: MAIN_WEB_CONTENTS,
    trustedRendererUrl: TRUSTED_RENDERER_URL,
    requestingOrigin: "moss://app/",
    details: {
      isMainFrame: true,
      requestingUrl: "moss://app/index.html#/chat",
      securityOrigin: "moss://app",
      mediaType: "audio",
    },
    ...overrides,
  };
}

describe("normalizePermissionOrigin", () => {
  it("normalizes the custom Moss scheme without relying on URL.origin", () => {
    expect(new URL(TRUSTED_RENDERER_URL).origin).toBe("null");
    expect(normalizePermissionOrigin(TRUSTED_RENDERER_URL)).toBe("moss://app");
    expect(normalizePermissionOrigin("MOSS://APP/settings")).toBe("moss://app");
  });

  it("keeps the exact scheme, host, and port for development URLs", () => {
    expect(normalizePermissionOrigin("http://127.0.0.1:5173/chat")).toBe("http://127.0.0.1:5173");
    expect(normalizePermissionOrigin("http://localhost:5173/chat")).toBe("http://localhost:5173");
  });

  it.each([
    "",
    " moss://app/index.html",
    "moss://app/index.html ",
    "moss:index.html",
    "moss://user@app/index.html",
    "not a url",
  ])("rejects malformed or ambiguous URLs: %j", (value) => {
    expect(normalizePermissionOrigin(value)).toBeNull();
  });
});

describe("shouldAllowMediaPermissionRequest", () => {
  it("allows an exact audio-only request from the trusted production renderer", () => {
    expect(shouldAllowMediaPermissionRequest(requestInput())).toBe(true);
  });

  it("allows the exact configured development origin but not a localhost alias", () => {
    const trustedRendererUrl = "http://127.0.0.1:5173/index.html";
    expect(
      shouldAllowMediaPermissionRequest(
        requestInput({
          trustedRendererUrl,
          details: {
            isMainFrame: true,
            requestingUrl: "http://127.0.0.1:5173/chat",
            securityOrigin: "http://127.0.0.1:5173",
            mediaTypes: ["audio"],
          },
        }),
      ),
    ).toBe(true);
    expect(
      shouldAllowMediaPermissionRequest(
        requestInput({
          trustedRendererUrl,
          details: {
            isMainFrame: true,
            requestingUrl: "http://localhost:5173/chat",
            securityOrigin: "http://localhost:5173",
            mediaTypes: ["audio"],
          },
        }),
      ),
    ).toBe(false);
  });

  it.each([undefined, []])(
    "rejects an omitted or empty mediaTypes value %j even after trust checks pass",
    (mediaTypes) => {
      expect(
        shouldAllowMediaPermissionRequest(
          requestInput({
            details: {
              isMainFrame: true,
              requestingUrl: "moss://app/index.html",
              securityOrigin: "moss://app",
              mediaTypes,
            },
          }),
        ),
      ).toBe(false);
    },
  );

  it("does not let omitted mediaTypes bypass renderer, frame, or origin checks", () => {
    const details = {
      isMainFrame: true,
      requestingUrl: "moss://app/index.html",
      securityOrigin: "moss://app",
    };
    expect(
      shouldAllowMediaPermissionRequest(requestInput({ webContents: OTHER_WEB_CONTENTS, details })),
    ).toBe(false);
    expect(
      shouldAllowMediaPermissionRequest(
        requestInput({ details: { ...details, isMainFrame: false } }),
      ),
    ).toBe(false);
    expect(
      shouldAllowMediaPermissionRequest(
        requestInput({ details: { ...details, requestingUrl: "moss://evil/index.html" } }),
      ),
    ).toBe(false);
  });

  it.each([["video"], ["audio", "video"], ["unknown"], ["audio", "audio"], "audio", null])(
    "rejects video, mixed, unknown, duplicate, or malformed mediaTypes: %j",
    (mediaTypes) => {
      expect(
        shouldAllowMediaPermissionRequest(
          requestInput({
            details: {
              isMainFrame: true,
              requestingUrl: "moss://app/index.html",
              securityOrigin: "moss://app",
              mediaTypes,
            },
          }),
        ),
      ).toBe(false);
    },
  );

  it.each(["notifications", "display-capture", undefined])(
    "rejects non-media permission %j",
    (permission) => {
      expect(shouldAllowMediaPermissionRequest(requestInput({ permission }))).toBe(false);
    },
  );

  it("rejects a null, missing, or different WebContents", () => {
    expect(
      shouldAllowMediaPermissionRequest(requestInput({ webContents: OTHER_WEB_CONTENTS })),
    ).toBe(false);
    expect(shouldAllowMediaPermissionRequest(requestInput({ webContents: null }))).toBe(false);
    expect(
      shouldAllowMediaPermissionRequest(
        requestInput({ webContents: null, trustedWebContents: null }),
      ),
    ).toBe(false);
  });

  it("rejects sub-frame requests even when every origin is trusted", () => {
    expect(
      shouldAllowMediaPermissionRequest(
        requestInput({
          details: {
            isMainFrame: false,
            requestingUrl: "moss://app/index.html",
            securityOrigin: "moss://app",
            mediaTypes: ["audio"],
          },
        }),
      ),
    ).toBe(false);
  });

  it.each([
    "moss://evil/index.html",
    "moss://app.evil/index.html",
    "moss://app@evil/index.html",
    "not a url",
    undefined,
  ])("rejects an untrusted or malformed requestingUrl: %j", (requestingUrl) => {
    expect(
      shouldAllowMediaPermissionRequest(
        requestInput({
          details: {
            isMainFrame: true,
            requestingUrl,
            mediaTypes: ["audio"],
          },
        }),
      ),
    ).toBe(false);
  });

  it("allows an omitted securityOrigin but rejects a mismatched or malformed value", () => {
    expect(
      shouldAllowMediaPermissionRequest(
        requestInput({
          details: {
            isMainFrame: true,
            requestingUrl: "moss://app/index.html",
            mediaTypes: ["audio"],
          },
        }),
      ),
    ).toBe(true);
    for (const securityOrigin of ["moss://evil", "not a url", null]) {
      expect(
        shouldAllowMediaPermissionRequest(
          requestInput({
            details: {
              isMainFrame: true,
              requestingUrl: "moss://app/index.html",
              securityOrigin,
              mediaTypes: ["audio"],
            },
          }),
        ),
      ).toBe(false);
    }
  });

  it("rejects a malformed trusted renderer URL", () => {
    expect(
      shouldAllowMediaPermissionRequest(requestInput({ trustedRendererUrl: "moss:index.html" })),
    ).toBe(false);
  });
});

describe("shouldAllowMediaPermissionCheck", () => {
  it("allows only an audio check from the exact trusted top-level renderer", () => {
    expect(shouldAllowMediaPermissionCheck(checkInput())).toBe(true);
  });

  it.each(["video", "unknown", undefined, ["audio"]])(
    "rejects a non-audio or malformed mediaType: %j",
    (mediaType) => {
      expect(
        shouldAllowMediaPermissionCheck(
          checkInput({
            details: {
              isMainFrame: true,
              requestingUrl: "moss://app/index.html",
              securityOrigin: "moss://app",
              mediaType,
            },
          }),
        ),
      ).toBe(false);
    },
  );

  it.each(["moss://evil", "moss://app.evil", "not a url", undefined])(
    "rejects an untrusted or malformed requestingOrigin: %j",
    (requestingOrigin) => {
      expect(shouldAllowMediaPermissionCheck(checkInput({ requestingOrigin }))).toBe(false);
    },
  );

  it("applies the same permission, WebContents, frame, requestingUrl, and securityOrigin rules", () => {
    expect(shouldAllowMediaPermissionCheck(checkInput({ permission: "geolocation" }))).toBe(false);
    expect(shouldAllowMediaPermissionCheck(checkInput({ webContents: OTHER_WEB_CONTENTS }))).toBe(
      false,
    );
    expect(
      shouldAllowMediaPermissionCheck(
        checkInput({
          details: {
            isMainFrame: false,
            requestingUrl: "moss://app/index.html",
            mediaType: "audio",
          },
        }),
      ),
    ).toBe(false);
    expect(
      shouldAllowMediaPermissionCheck(
        checkInput({
          details: {
            isMainFrame: true,
            requestingUrl: "moss://evil/index.html",
            mediaType: "audio",
          },
        }),
      ),
    ).toBe(false);
    expect(
      shouldAllowMediaPermissionCheck(
        checkInput({
          details: {
            isMainFrame: true,
            requestingUrl: "moss://app/index.html",
            securityOrigin: "moss://evil",
            mediaType: "audio",
          },
        }),
      ),
    ).toBe(false);
  });
});
