// FILE: rateLimit.ts
// Purpose: Token bucket used per page per capability by the shell broker.
// Layer: Web pageApps

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const at = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((at - this.last) / 60_000) * this.perMinute);
    this.last = at;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
