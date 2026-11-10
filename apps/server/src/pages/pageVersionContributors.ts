import { PageVersionContributors, type PageVersionContributor } from "@moss/contracts";
import { Schema } from "effect";

const decode = Schema.decodeUnknownSync(PageVersionContributors);
export const PAGE_CONTRIBUTOR_RECORD_BYTE_LIMIT = 256 * 1024;
export const unrecordedContributor = { kind: "unrecorded" } as const;

export function encodeContributors(sources: readonly PageVersionContributor[]) {
  const text = JSON.stringify(decode(sources));
  if (Buffer.byteLength(text) > PAGE_CONTRIBUTOR_RECORD_BYTE_LIMIT)
    throw new Error("Page contributor record exceeds the byte limit");
  return text;
}

export function readContributors(text: string | null): readonly PageVersionContributor[] {
  if (text === null) return [unrecordedContributor];
  if (
    text.length > PAGE_CONTRIBUTOR_RECORD_BYTE_LIMIT ||
    Buffer.byteLength(text) > PAGE_CONTRIBUTOR_RECORD_BYTE_LIMIT
  )
    throw new Error("Page contributor record exceeds the byte limit");
  return decode(JSON.parse(text));
}
