import {
  GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  GUEST_MESSAGE_MAX_ATTACHMENTS,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyGuestUploads,
  isGuestInlineImageMimeType,
  matchesImageSignature,
  type InspectedGuestUpload,
} from "./guestAttachments.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = Uint8Array.from([...Buffer.from("GIF89a"), 0, 0, 0, 0, 0, 0]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
const HTML = Uint8Array.from(Buffer.from("<!doctype h"));

const upload = (overrides: Partial<InspectedGuestUpload> = {}): InspectedGuestUpload => ({
  name: "photo.png",
  contentType: "image/png",
  sizeBytes: 10,
  header: PNG,
  ...overrides,
});

describe("matchesImageSignature", () => {
  it("accepts the four inline types only when the bytes match", () => {
    expect(matchesImageSignature("image/png", PNG)).toBe(true);
    expect(matchesImageSignature("image/jpeg", JPEG)).toBe(true);
    expect(matchesImageSignature("image/gif", GIF)).toBe(true);
    expect(matchesImageSignature("image/webp", WEBP)).toBe(true);
    expect(matchesImageSignature("image/png", HTML)).toBe(false);
    expect(matchesImageSignature("image/webp", PNG)).toBe(false);
    expect(matchesImageSignature("image/svg+xml", PNG)).toBe(false);
    expect(isGuestInlineImageMimeType("image/svg+xml")).toBe(false);
  });
});

describe("classifyGuestUploads", () => {
  it("turns images into image attachments and other files into file attachments", () => {
    const result = classifyGuestUploads([
      upload(),
      upload({ name: "notes.md", contentType: "text/markdown; charset=utf-8", header: HTML }),
    ]);
    expect(result).toEqual({
      ok: true,
      attachments: [
        { type: "image", name: "photo.png", mimeType: "image/png", sizeBytes: 10 },
        { type: "file", name: "notes.md", mimeType: "text/markdown", sizeBytes: 10 },
      ],
    });
  });

  it("refuses an image whose bytes are not what its type says", () => {
    expect(classifyGuestUploads([upload({ header: HTML })])).toEqual({
      ok: false,
      reason: "unsupported_file",
    });
    expect(classifyGuestUploads([upload({ contentType: "image/svg+xml" })])).toEqual({
      ok: false,
      reason: "unsupported_file",
    });
  });

  it("refuses empty files, too many files, and too many bytes", () => {
    expect(classifyGuestUploads([upload({ sizeBytes: 0 })])).toEqual({
      ok: false,
      reason: "unsupported_file",
    });
    expect(
      classifyGuestUploads(
        Array.from({ length: GUEST_MESSAGE_MAX_ATTACHMENTS + 1 }, () => upload()),
      ),
    ).toEqual({ ok: false, reason: "too_many_files" });
    expect(
      classifyGuestUploads([
        upload({ sizeBytes: GUEST_MESSAGE_MAX_ATTACHMENT_BYTES }),
        upload({ sizeBytes: 1 }),
      ]),
    ).toEqual({ ok: false, reason: "too_large" });
  });

  it("sanitizes names that would break headers or hide an extension", () => {
    const result = classifyGuestUploads([
      upload({ name: "invoice‮fdp.exe", contentType: "application/octet-stream", header: HTML }),
      upload({ name: "../../x\n.txt", contentType: "text/plain", header: HTML }),
      upload({ name: "   ", contentType: "text/plain", header: HTML }),
    ]);
    expect(result.ok && result.attachments.map((attachment) => attachment.name)).toEqual([
      "invoice_fdp.exe",
      ".._.._x_.txt",
      "file",
    ]);
  });
});
