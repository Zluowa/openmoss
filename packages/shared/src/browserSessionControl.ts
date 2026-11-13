/**
 * Who may drive one browser tab right now: the agent, or a person watching it.
 *
 * A tab streamed to viewers has two kinds of drivers. The agent acts through
 * its tools; a person takes control from a viewer to sign in, solve a
 * captcha or correct something, then releases it. Both must never act at the
 * same time, and the handover must not tear an action in half.
 *
 * - Every action runs through one queue, so actions never interleave.
 * - `take` reserves control immediately: from that moment the agent's next
 *   call is refused, while work already running drains before the person's
 *   first input lands.
 * - The agent is refused, not queued, while a person holds control. A queued
 *   agent action would land the instant they release, on a page they changed.
 * - Every owner change advances `generation`, so an action queued before the
 *   change is refused instead of running against a page it never observed.
 * - Reads (`observe`) bypass control and the queue: watching the page never
 *   delays the person's input.
 * - Releasing records a handoff notice that the agent's next call consumes,
 *   so the agent learns the person is done instead of polling for it.
 *
 * Adapted from T3 Code's `SessionControl` (MIT). See THIRD_PARTY_NOTICES.md.
 *
 * @module browserSessionControl
 */

export type BrowserControlRefusalReason = "humanControl" | "interrupted" | "closed" | "notOwner";

export class BrowserControlRefusedError extends Error {
  readonly reason: BrowserControlRefusalReason;
  constructor(reason: BrowserControlRefusalReason, message: string) {
    super(message);
    this.name = "BrowserControlRefusedError";
    this.reason = reason;
  }
}

export interface BrowserHandoffNotice {
  /** The viewer that held control. */
  readonly viewerId: string;
  /** When control returned to the agent, epoch milliseconds. */
  readonly releasedAt: number;
}

const settle = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined,
  );

export class BrowserSessionControl {
  private tail: Promise<unknown> = Promise.resolve();
  private latestHuman: {
    entry: { viewerId: string; key: string; input: unknown; run: (input: never) => Promise<void> };
    result: Promise<void>;
  } | null = null;
  private handoffWork = new Set<Promise<void>>();
  private owner: string | null = null;
  private epoch = 0;
  private closed = false;
  private notice: BrowserHandoffNotice | null = null;
  private readonly onChange: () => void;
  private readonly now: () => number;

  constructor(options: { readonly onChange?: () => void; readonly now?: () => number } = {}) {
    this.onChange = options.onChange ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  /** The viewer holding control, or `null` when the agent may act. */
  get controller(): string | null {
    return this.owner;
  }

  get generation(): number {
    return this.epoch;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The agent may start an action right now. */
  agentCanAct(): boolean {
    return !this.closed && this.owner === null;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    this.latestHuman = null;
    const result = this.tail.then(run);
    this.tail = settle(result);
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new BrowserControlRefusedError("closed", "This browser tab is closed.");
  }

  private changeOwner(owner: string | null): void {
    this.latestHuman = null;
    this.owner = owner;
    this.epoch += 1;
    this.onChange();
  }

  private action<A>(allowed: () => boolean, run: () => Promise<A>): Promise<A> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!allowed()) {
      return Promise.reject(
        new BrowserControlRefusedError("notOwner", "You do not control this browser tab."),
      );
    }
    const epoch = this.epoch;
    return this.enqueue(async () => {
      this.assertOpen();
      if (epoch !== this.epoch || !allowed()) {
        throw new BrowserControlRefusedError(
          "interrupted",
          "Browser control changed. Observe the page again before acting.",
        );
      }
      return run();
    });
  }

  /**
   * Run an agent action. Refused at once while a person holds control, and
   * refused when control changes before the action starts.
   */
  agent<A>(run: () => Promise<A>): Promise<A> {
    if (!this.closed && this.owner !== null) {
      return Promise.reject(
        new BrowserControlRefusedError("humanControl", "A person controls this browser tab."),
      );
    }
    return this.action(() => this.owner === null, run);
  }

  /** Read without control or queueing: observing never delays a person's input. */
  observe<A>(run: () => Promise<A>): Promise<A> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    return run();
  }

  /** Run a viewer's input; refused unless that viewer holds control. */
  human<A>(viewerId: string, run: () => Promise<A>): Promise<A> {
    return this.action(() => this.owner === viewerId, run);
  }

  /**
   * Merge into the adjacent waiting input with the same key (pointer moves,
   * wheel deltas), so a burst of hover events costs one dispatch. Running and
   * intervening actions keep their order. Inputs sharing a key share a type.
   */
  humanLatest<A>(
    viewerId: string,
    key: string,
    input: A,
    run: (input: A) => Promise<void>,
    merge: (waiting: A, next: A) => A = (_waiting, next) => next,
  ): Promise<void> {
    if (this.closed || this.owner !== viewerId) return this.human(viewerId, () => run(input));
    const latest = this.latestHuman;
    if (latest?.entry.viewerId === viewerId && latest.entry.key === key) {
      latest.entry.input = merge(latest.entry.input as A, input);
      latest.entry.run = run as (input: never) => Promise<void>;
      return latest.result;
    }
    const entry = {
      viewerId,
      key,
      input: input as unknown,
      run: run as (input: never) => Promise<void>,
    };
    const result = this.human(viewerId, async () => {
      if (this.latestHuman?.entry === entry) this.latestHuman = null;
      await (entry.run as (input: unknown) => Promise<void>)(entry.input);
    });
    this.latestHuman = { entry, result };
    return result;
  }

  /** Viewer navigations can outlive their input; a handoff still waits for them. */
  trackUntilHandoff(work: Promise<unknown>): void {
    const settled: Promise<void> = settle(work).finally(() => {
      this.handoffWork.delete(settled);
    });
    this.handoffWork.add(settled);
  }

  /**
   * Give control to a viewer. Reserved immediately, so the agent's next call
   * is refused; resolves once the work already queued has drained.
   */
  async take(viewerId: string): Promise<void> {
    this.assertOpen();
    if (this.owner !== null && this.owner !== viewerId) {
      throw new BrowserControlRefusedError("notOwner", "Another viewer controls this browser tab.");
    }
    if (this.owner !== viewerId) {
      this.notice = null;
      this.changeOwner(viewerId);
    }
    await this.human(viewerId, async () => {});
  }

  /** Return control to the agent once the viewer's pending work has drained. */
  async release(viewerId: string, afterDrain: () => Promise<void> = async () => {}): Promise<void> {
    this.assertOpen();
    if (this.owner !== viewerId) {
      throw new BrowserControlRefusedError(
        "notOwner",
        "Only the controlling viewer can release this browser tab.",
      );
    }
    this.changeOwner(null);
    this.notice = { viewerId, releasedAt: this.now() };
    await this.enqueue(async () => {
      await Promise.all(this.handoffWork);
      await afterDrain();
    });
  }

  /** A viewer that goes away hands control back. */
  async disconnect(viewerId: string, afterDrain?: () => Promise<void>): Promise<void> {
    if (!this.closed && this.owner === viewerId) await this.release(viewerId, afterDrain);
  }

  /** The handoff notice since the agent last asked, consumed by reading it. */
  consumeHandoffNotice(): BrowserHandoffNotice | null {
    const notice = this.notice;
    this.notice = null;
    return notice;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.notice = null;
      this.changeOwner(null);
    }
    await this.tail;
  }
}
