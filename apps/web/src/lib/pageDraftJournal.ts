type DraftRecord = {
  key: string;
  value: string;
  updatedAt: number;
  title: string;
  content: string;
  richContent: string | null;
};

/** Separate records preserve drafts from simultaneous renderers. A late save
 * may retire only its own bytes and the exact recovered snapshot it saved. */
export class PageDraftJournal {
  private readonly ownKey: string;
  private recovered: DraftRecord | undefined;
  constructor(private readonly baseKey: string) {
    this.ownKey = `${baseKey}:draft:${crypto.randomUUID()}`;
  }
  records = (): DraftRecord[] => {
    const records: DraftRecord[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || (key !== this.baseKey && !key.startsWith(`${this.baseKey}:draft:`))) continue;
      const value = localStorage.getItem(key);
      if (!value) continue;
      try {
        const draft: unknown = JSON.parse(value);
        if (
          draft &&
          typeof draft === "object" &&
          "title" in draft &&
          typeof draft.title === "string" &&
          "content" in draft &&
          typeof draft.content === "string" &&
          "revision" in draft &&
          typeof draft.revision === "number" &&
          Number.isSafeInteger(draft.revision) &&
          draft.revision >= 1
        )
          records.push({
            key,
            value,
            title: draft.title,
            content: draft.content,
            richContent:
              "richContent" in draft && typeof draft.richContent === "string"
                ? draft.richContent
                : null,
            updatedAt:
              "updatedAt" in draft && typeof draft.updatedAt === "number" ? draft.updatedAt : 0,
          });
      } catch {
        /* Preserve unreadable records for local recovery. */
      }
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  };
  read = () => {
    this.recovered = this.records()[0];
    return this.recovered?.value ?? null;
  };
  write = (value: string | null) => {
    if (value !== null) {
      localStorage.setItem(
        this.ownKey,
        JSON.stringify({ ...JSON.parse(value), updatedAt: Date.now() }),
      );
      return;
    }
    localStorage.removeItem(this.ownKey);
    if (this.recovered && localStorage.getItem(this.recovered.key) === this.recovered.value)
      localStorage.removeItem(this.recovered.key);
    this.recovered = undefined;
  };
}
