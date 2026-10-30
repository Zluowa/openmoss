import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatAttachment } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildFileAttachmentsPromptBlock } from "./attachmentProjection.ts";

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("buildFileAttachmentsPromptBlock", () => {
  it("projects ordinary files as controlled local paths and never as cloud objects", () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-attachment-projection-"));
    temporaryRoots.add(attachmentsDir);
    const textPath = path.join(attachmentsDir, "thread-1-notes.txt");
    const pdfPath = path.join(attachmentsDir, "thread-1-report.pdf");
    fs.writeFileSync(textPath, "private local notes\n");
    fs.writeFileSync(pdfPath, "private local pdf\n");

    const attachments: ChatAttachment[] = [
      {
        type: "file",
        id: "thread-1-notes",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 19,
      },
      {
        type: "file",
        id: "thread-1-report",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 17,
      },
    ];

    const prompt = buildFileAttachmentsPromptBlock({
      attachments,
      attachmentsDir,
      include: "non-pdf-files",
    });

    expect(prompt).toContain(textPath);
    expect(prompt).not.toContain(pdfPath);
    expect(prompt).not.toMatch(/https?:\/\/|s3|bucket|presign|base64|data:/iu);
    expect(prompt).toContain("<attached_files>");
    expect(prompt).toContain("Read/extract them with your tools as needed");
  });
});
