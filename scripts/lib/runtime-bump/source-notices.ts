// Preserve notices supplied in source headers when a published crate omits LICENSE.
// This narrow fallback requires every retained copyright header to identify the
// selected MIT/Apache family; mixed or unidentified grants still need review.
import { readTarFile } from "./tar.ts";

export interface SourceHeaderNotice {
  readonly path: string;
  readonly bytes: Buffer;
}

const HEADER_LIMIT = 64 * 1024;
const SOURCE_LIMIT = 2 * 1024 * 1024;

export async function readCrateSourceHeaderNotices(
  archive: string,
  directory: string,
  selectedLicense: string,
): Promise<readonly SourceHeaderNotice[]> {
  if (selectedLicense !== "MIT" && selectedLicense !== "Apache-2.0") return [];
  const notices: SourceHeaderNotice[] = [];
  const prefix = directory ? `${directory}/` : "";
  let compatible = true;
  await readTarFile(archive, {
    entry: (entry) => {
      const relative = entry.path.slice(entry.path.indexOf("/") + 1);
      if (
        entry.type !== "file" ||
        !relative.startsWith(prefix) ||
        !/\.(?:rs|c|h|cc|cpp|hpp|md|rst|txt)$/iu.test(relative)
      )
        return null;
      const parts: Buffer[] = [];
      let retained = 0;
      return {
        chunk: (bytes) => {
          const part = bytes.subarray(0, Math.max(0, SOURCE_LIMIT - retained));
          if (part.length) {
            parts.push(Buffer.from(part));
            retained += part.length;
          }
        },
        end: () => {
          const source = Buffer.concat(parts).toString("utf8");
          if (entry.size > SOURCE_LIMIT) {
            compatible = false;
            return;
          }
          const header = /^\uFEFF?\s*(?:(?:\/\/[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/\s*))+/u.exec(
            source.slice(0, HEADER_LIMIT),
          )?.[0];
          // A later or prose copyright notice cannot be silently omitted by this
          // header-only recovery. Leave such packages for an explicit review.
          if (/(?:\bcopyright\b|SPDX-FileCopyrightText)/iu.test(source.slice(header?.length ?? 0)))
            compatible = false;
          if (!header || !/(?:\bcopyright\b|SPDX-FileCopyrightText)/iu.test(header)) return;
          if (header.includes("\uFFFD")) {
            compatible = false;
            return;
          }
          // Do not accept a comment truncated at the read boundary as a notice.
          if (Buffer.byteLength(header) >= HEADER_LIMIT - 4) {
            compatible = false;
            return;
          }
          const namesLicense =
            selectedLicense === "MIT"
              ? /\bMIT\b/u.test(header)
              : /\bApache\b[\s\S]*\b2\.0\b/iu.test(header);
          if (!namesLicense || !/licen[cs]e|permission/iu.test(header)) compatible = false;
          notices.push({ path: relative, bytes: Buffer.from(header, "utf8") });
        },
      };
    },
  });
  return compatible ? notices : [];
}
