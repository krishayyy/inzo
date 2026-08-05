/**
 * Sliding-window failure counter for pairing-code guessing.
 *
 * Only FAILED attempts are recorded. A pairing code is 32^6 (~1.07e9)
 * possibilities, which is not brute-forceable on its own, but the limiter
 * means an attacker cannot cheaply grind even a small keyspace slice, and it
 * bounds the damage if the alphabet or length is ever shortened.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when this key has already burned through its allowance. */
  isLimited(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
  }

  /** Called on a successful join so a legitimate typo streak doesn't linger. */
  clear(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);
    return recent;
  }
}
