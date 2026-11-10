import { PAGE_VERSION_CONTRIBUTOR_LIMIT, type PageVersionContributor } from "@moss/contracts";
import { encodeContributors } from "../pageVersionContributors";

const keyOf = (source: PageVersionContributor) =>
  source.kind === "agent"
    ? "agent:" + source.threadId
    : source.kind === "guest"
      ? "guest:" + source.actorRef
      : source.kind;
export const localContributor = { kind: "local-user" } as const;

/** Keep the last acceptance order. A repeated source can have a newer contribution
 * while an older cut is being appended or published. */
export class RoomContributors {
  private readonly seen = new Map<string, { source: PageVersionContributor; clock: number }>();
  private clock = 0;

  check(source: PageVersionContributor) {
    if (this.seen.has(keyOf(source))) return;
    if (this.seen.size >= PAGE_VERSION_CONTRIBUTOR_LIMIT)
      throw new Error("Publish the current Page edits before accepting another source");
    encodeContributors([...this.seen.values()].map((entry) => entry.source).concat(source));
  }

  accept(source: PageVersionContributor) {
    this.check(source);
    const key = keyOf(source);
    this.seen.delete(key);
    this.seen.set(key, { source, clock: ++this.clock });
  }

  cut() {
    return { sources: Array.from(this.seen.values(), (entry) => entry.source), clock: this.clock };
  }

  published(clock: number) {
    for (const [key, entry] of this.seen) if (entry.clock <= clock) this.seen.delete(key);
  }
}

export function batchContributors(
  batch: readonly { source?: PageVersionContributor | undefined }[],
) {
  const ordered = new Map<string, PageVersionContributor>();
  for (const { source } of batch) {
    if (!source) continue;
    const key = keyOf(source);
    ordered.delete(key);
    ordered.set(key, source);
  }
  return [...ordered.values()];
}
