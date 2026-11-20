import { log } from "./logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PacerOptions {
  /** Spacing between request starts when everything is healthy. */
  minGapMs: number;
  /** Upper bound for the spacing after repeated rate limits. */
  maxGapMs: number;
  /** Added to every gap so parallel clients do not share the same phase. */
  jitterMs?: number;
}

/**
 * Single-flight, serialized request pacer.
 *
 * GMGN's IP limit is a small bucket (rank costs 3 units, token info/security 1)
 * that bans the IP for 30s once exceeded. Bursts are what trigger it, not the
 * average rate, so we keep exactly one request in flight and space request
 * starts by a configurable gap. On a 429 the gap doubles (AIMD) and every
 * caller waits for the reset window; after a streak of successes it decays
 * back to the floor.
 */
export class Pacer {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  private frozenUntil = 0;
  private gap: number;
  private successStreak = 0;

  constructor(private readonly options: PacerOptions) {
    this.gap = options.minGapMs;
  }

  get currentGapMs(): number {
    return this.gap;
  }

  /**
   * Applies new spacing limits from strat.conf without dropping the queue.
   * Outside a 429 freeze the gap snaps to the new floor so tuning takes effect
   * on the next request instead of decaying over dozens of successes.
   */
  reconfigure(options: Partial<PacerOptions>): void {
    this.options.minGapMs = options.minGapMs ?? this.options.minGapMs;
    this.options.maxGapMs = options.maxGapMs ?? this.options.maxGapMs;
    const frozen = Date.now() < this.frozenUntil;
    const clamp = (value: number) =>
      Math.min(Math.max(value, this.options.minGapMs), this.options.maxGapMs);
    this.gap = frozen ? clamp(this.gap) : this.options.minGapMs;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const jitter = Math.floor(Math.random() * (this.options.jitterMs ?? 150));
      const gapWait = this.lastStart + this.gap + jitter - Date.now();
      const freezeWait = this.frozenUntil - Date.now();
      const wait = Math.max(0, gapWait, freezeWait);
      if (wait > 0) await sleep(wait);

      this.lastStart = Date.now();
      return task();
    });

    // Keep the chain alive even if a task rejects.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  penalize(retryAfterMs: number, reason: string): void {
    const pauseMs = Math.max(1_000, retryAfterMs);
    this.frozenUntil = Math.max(this.frozenUntil, Date.now() + pauseMs);
    const previous = this.gap;
    this.gap = Math.min(this.options.maxGapMs, Math.round(this.gap * 2));
    this.successStreak = 0;
    log.warn("gmgn pacer throttled", {
      reason,
      pauseMs,
      gapFromMs: previous,
      gapToMs: this.gap,
    });
  }

  reward(): void {
    this.successStreak += 1;
    if (this.successStreak < 10) return;
    this.successStreak = 0;
    if (this.gap > this.options.minGapMs) {
      this.gap = Math.max(this.options.minGapMs, this.gap - 50);
    }
  }
}
