import { assert, describe, it } from "vitest";

import {
  fileIconColor,
  getAttachmentIconName,
  getFileIconName,
  inferEntryKindFromPath,
  pathLooksLikeKnownFile,
} from "./fileIcons";

// Object.prototype member names, which lookup keys can collide with because they are
// derived from untrusted text. Only `constructor` and `__proto__` survive the lowercased
// basename (`toString` becomes `tostring` and misses by luck), so pin them all.
const PROTOTYPE_MEMBER_TOKENS = [
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "map.constructor",
  "obj.__proto__",
];

describe("getFileIconName", () => {
  it("falls back to the bracket glyph for unknown or icon-less types", () => {
    // Swift/Go/Ruby have no dedicated Central icon, so they use the bracket.
    assert.equal(getFileIconName("App.swift"), "code-brackets");
    assert.equal(getFileIconName("main.go"), "code-brackets");
    assert.equal(getFileIconName("server.rb"), "code-brackets");
    assert.equal(getFileIconName("foo.unknown-ext"), "code-brackets");
    assert.equal(getFileIconName("notes"), "code-brackets");
  });

  it("uses the terminal console glyph for shell and PowerShell scripts instead of Mac cmd", () => {
    for (const file of [
      "sample-colors.ps1",
      "module.psm1",
      "manifest.psd1",
      "deploy.sh",
      "init.bash",
      "env.zsh",
      "prompt.fish",
      "build.bat",
    ]) {
      assert.equal(getFileIconName(file), "console", file);
    }
  });

  it("is case insensitive on basename lookup", () => {
    assert.equal(getFileIconName("PACKAGE.JSON"), "code-brackets");
    assert.equal(getFileIconName("Main.MD"), "file-text");
    assert.equal(getFileIconName("Photo.PNG"), "image-alt-text");
  });

  it("treats known extensionless basenames as files", () => {
    assert.equal(inferEntryKindFromPath("LICENSE"), "file");
    assert.equal(inferEntryKindFromPath("C:\\repo\\.gitignore"), "file");
    assert.equal(inferEntryKindFromPath("scripts"), "directory");
  });

  it("never resolves an inherited Object.prototype member as an icon name", () => {
    for (const token of PROTOTYPE_MEMBER_TOKENS) {
      assert.equal(getFileIconName(token), "code-brackets", token);
    }
  });
});

describe("pathLooksLikeKnownFile", () => {
  it("does not mistake an Object.prototype member for a known file", () => {
    for (const token of PROTOTYPE_MEMBER_TOKENS) {
      assert.isFalse(pathLooksLikeKnownFile(token), `${token} must not look like a known file`);
    }
  });
});

describe("getAttachmentIconName", () => {
  it("prefers a recognizable extension over the MIME type", () => {
    assert.equal(
      getAttachmentIconName({ name: "meeting.ics", mimeType: "application/octet-stream" }),
      "calendar-days",
    );
    assert.equal(
      getAttachmentIconName({ name: "invoice.pdf", mimeType: "text/plain" }),
      "file-pdf",
    );
  });

  it("falls back to the MIME type when the filename has no extension", () => {
    // A download named only by its Content-Type (e.g. a UUID with a calendar body).
    assert.equal(
      getAttachmentIconName({ name: "99247298-78c2-44ba-a1f6", mimeType: "text/calendar" }),
      "calendar-days",
    );
    assert.equal(getAttachmentIconName({ name: "blob", mimeType: "application/pdf" }), "file-pdf");
  });

  it("uses the top-level MIME family for unmapped subtypes", () => {
    assert.equal(getAttachmentIconName({ name: "clip", mimeType: "audio/x-wav" }), "audio");
    assert.equal(getAttachmentIconName({ name: "movie", mimeType: "video/quicktime" }), "video");
    assert.equal(getAttachmentIconName({ name: "notes", mimeType: "text/plain" }), "file-text");
  });

  it("never resolves an inherited Object.prototype member as an icon name", () => {
    for (const token of PROTOTYPE_MEMBER_TOKENS) {
      assert.equal(getAttachmentIconName({ name: token, mimeType: "" }), "file-text", token);
    }
  });
});

describe("one file icon style", () => {
  it("draws every file type as a line glyph with no colour of its own", () => {
    const glyphs = [
      "data.json",
      "index.js",
      "photo.png",
      "README.md",
      "style.css",
      "main.ts",
      "package.json",
      ".gitignore",
      "Cargo.toml",
    ].map((file) => getFileIconName(file));
    for (const glyph of glyphs) {
      assert.include(["code-brackets", "image-alt-text", "file-text", "settings-gear-1"], glyph);
      assert.isNull(fileIconColor(glyph));
    }
  });
});
