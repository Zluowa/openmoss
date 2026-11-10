// FILE: streamingFadeScheduler.ts
// Purpose: Paces the streamed-word fade the way the desktop chat does. Words that arrive
//          together do not all appear at once: they join a queue, each chunk starting
//          2.5ms per character after the one before (never more than 600ms out), and
//          each fades in over 200ms. Output faster than about 1.6 characters per ms skips
//          the fade. A word whose fade is over stays shown when its row remounts.
// Layer: Chat transcript motion (pure, clock injected)
// Exports: StreamingFadeScheduler, STREAM_FADE_MS, FadeReveal

export const STREAM_FADE_MS = 200;
const DELAY_PER_CHAR_MS = 2.5;
const MAX_QUEUE_MS = 600;
// A chunk takes words until it holds this many characters within one text update,
// or this many across updates; then the next word opens a later chunk.
const CHUNK_CHARS_SAME_UPDATE = 16;
const CHUNK_CHARS_ACROSS_UPDATES = 48;
const SPEED_WINDOW_MS = 100;
const TOO_FAST_CHARS_PER_MS = 1.6;
const TOO_FAST_RELEASE_MS = 400;

export interface FadeReveal {
  /** Animation delay for this word; 0 starts now. */
  delayMs: number;
  /** True when it should appear without a fade (primed, or the stream is too fast). */
  instant: boolean;
}

interface StoredReveal extends FadeReveal {
  assignedAt: number;
}

interface Chunk {
  delayMs: number;
  update: number;
  chars: number;
  instant: boolean;
}

const INSTANT: FadeReveal = { delayMs: 0, instant: true };

export class StreamingFadeScheduler {
  private readonly reveals = new Map<number, StoredReveal>();
  private openChunk: Chunk | null = null;
  private openedAt = 0;
  private lastAssigned = 0;
  private update = 0;
  private tooFast = false;
  private speed: { since: number; length: number; fastAt: number };

  constructor(private readonly now: () => number = () => performance.now()) {
    this.speed = { since: this.now(), length: 0, fastAt: Number.NEGATIVE_INFINITY };
  }

  /** Called with the message length on every text update. */
  sync(length: number): void {
    const now = this.now();
    this.update += 1;
    const { since, length: previous, fastAt } = this.speed;
    if (now - since >= SPEED_WINDOW_MS) {
      const limit = TOO_FAST_CHARS_PER_MS * (this.tooFast ? 0.75 : 1);
      const fast = (length - previous) / (now - since) > limit;
      // Two fast windows in a row switch the fade off; it comes back after 400ms of calm.
      this.tooFast = fast
        ? this.tooFast || fastAt === since
        : this.tooFast && now - fastAt < TOO_FAST_RELEASE_MS;
      this.speed = { since: now, length, fastAt: fast ? now : fastAt };
    }
    if (length < previous) {
      // The text was replaced (a retry or an edit): what was shown stays shown.
      for (const [offset, reveal] of this.reveals) {
        this.reveals.set(offset, { ...INSTANT, assignedAt: reveal.assignedAt });
      }
      this.openChunk = null;
    }
    if (this.openChunk && now - this.openedAt >= SPEED_WINDOW_MS) this.openChunk = null;
  }

  /** The reveal for the word starting at `offset`; the same offset keeps its reveal. */
  reveal(offset: number, chars: number): FadeReveal {
    const now = this.now();
    const known = this.reveals.get(offset);
    if (known) {
      // Once its fade has run, a remounted word must not fade again.
      return known.instant || now < known.assignedAt + known.delayMs + STREAM_FADE_MS
        ? known
        : INSTANT;
    }
    let chunk = this.openChunk;
    const limit =
      chunk && chunk.update === this.update ? CHUNK_CHARS_SAME_UPDATE : CHUNK_CHARS_ACROSS_UPDATES;
    if (!chunk || chunk.chars + chars > limit) {
      const start = Math.min(
        Math.max(now, this.lastAssigned) + (this.tooFast ? 0 : chars * DELAY_PER_CHAR_MS),
        now + MAX_QUEUE_MS,
      );
      if (!chunk) this.openedAt = now;
      const delayMs = Math.round(start - now);
      chunk = { delayMs, update: this.update, chars: 0, instant: this.tooFast && delayMs === 0 };
      this.openChunk = chunk;
      this.lastAssigned = start;
    } else if (!this.tooFast) {
      this.lastAssigned = Math.min(
        this.lastAssigned + chars * DELAY_PER_CHAR_MS,
        now + MAX_QUEUE_MS,
      );
    }
    chunk.chars += chars;
    const reveal: StoredReveal = {
      delayMs: chunk.delayMs,
      instant: chunk.instant,
      assignedAt: now,
    };
    this.reveals.set(offset, reveal);
    return reveal;
  }
}
