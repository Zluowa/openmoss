// Read the same canonical history as Codex desktop without starting a turn.
// Paginated sessions deliberately omit turns from thread/read, even when
// includeTurns is true. Keep paging and failure handling shared by both reads.

const MAX_HISTORY_PAGES = 1_000;
const MAX_HISTORY_TURNS = 2_000;
const MAX_HISTORY_ITEMS = 100_000;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

type RecordValue = Record<string, unknown>;
type SendHistoryRequest = (method: string, params: RecordValue) => Promise<unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function pageResult(
  value: unknown,
  method: string,
): { data: unknown[]; nextCursor: string | null } {
  const page = record(value);
  if (
    !Array.isArray(page?.data) ||
    !(page.nextCursor === null || typeof page.nextCursor === "string")
  ) {
    throw new Error(`${method} returned an invalid history page.`);
  }
  return { data: page.data, nextCursor: page.nextCursor };
}

export async function readCodexThreadHistory(
  response: unknown,
  sendRequest: SendHistoryRequest,
): Promise<unknown> {
  const envelope = record(response);
  const thread = record(envelope?.thread);
  if (thread?.historyMode !== "paginated") return response;
  const threadId = identifier(thread.id);
  if (!threadId) throw new Error("Paginated Codex history did not include a thread id.");

  let pages = 0;
  let bytes = 0;
  let itemCount = 0;
  const requestPage = async (method: string, params: RecordValue) => {
    if (++pages > MAX_HISTORY_PAGES)
      throw new Error("Codex history exceeds the import page limit.");
    const result = await sendRequest(method, params);
    bytes += Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
    if (bytes > MAX_HISTORY_BYTES)
      throw new Error("Codex history exceeds the 64 MiB import limit.");
    return pageResult(result, method);
  };
  const readItems = async (turn: RecordValue): Promise<unknown[]> => {
    const turnId = identifier(turn.id);
    if (!turnId) throw new Error("Codex history turn did not include an id.");
    if (turn.itemsView === "full" && Array.isArray(turn.items)) return turn.items;
    const items = new Map<string, unknown>();
    const cursors = new Set<string | null>();
    let cursor: string | null = null;
    do {
      if (cursors.has(cursor)) throw new Error("thread/items/list returned a repeated cursor.");
      cursors.add(cursor);
      const page = await requestPage("thread/items/list", {
        threadId,
        turnId,
        cursor,
        limit: 100,
        sortDirection: "asc",
      });
      for (const entry of page.data) {
        const wrapper = record(entry);
        const item = record(wrapper?.item);
        const itemId = identifier(item?.id);
        if (wrapper?.turnId !== turnId || !itemId) {
          throw new Error("thread/items/list returned an invalid or unrelated item.");
        }
        // Overlapping pages retain the original position and newest value.
        items.set(itemId, item);
        if (items.size + itemCount > MAX_HISTORY_ITEMS)
          throw new Error("Codex history exceeds the import item limit.");
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return [...items.values()];
  };

  const turns = new Map<string, RecordValue>();
  const cursors = new Set<string | null>();
  let cursor: string | null = null;
  do {
    if (cursors.has(cursor)) throw new Error("thread/turns/list returned a repeated cursor.");
    cursors.add(cursor);
    const page = await requestPage("thread/turns/list", {
      threadId,
      cursor,
      limit: 5,
      sortDirection: "asc",
      itemsView: "full",
    });
    for (const value of page.data) {
      const turn = record(value);
      const turnId = identifier(turn?.id);
      if (!turn || !turnId) throw new Error("thread/turns/list returned an invalid turn.");
      const items = await readItems(turn);
      itemCount +=
        items.length - ((turns.get(turnId)?.items as unknown[] | undefined)?.length ?? 0);
      turns.set(turnId, { ...turn, items, itemsView: "full" });
      if (turns.size > MAX_HISTORY_TURNS || itemCount > MAX_HISTORY_ITEMS) {
        throw new Error("Codex history exceeds the import turn/item limit.");
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  return { ...envelope, thread: { ...thread, turns: [...turns.values()] } };
}
