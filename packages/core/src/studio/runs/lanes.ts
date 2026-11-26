/**
 * Named lanes that each run a fixed number of jobs at once: Claude runs in one lane,
 * renders in another, so many scenes can be written while a few are rendered.
 */
export class Lanes<Name extends string> {
  private readonly active = new Map<Name, number>();
  private readonly waiting = new Map<Name, (() => void)[]>();
  private pending = 0;
  private idleWaiters: (() => void)[] = [];
  /** The most jobs each lane has run at once, for tests. */
  readonly peak = new Map<Name, number>();

  constructor(private readonly limits: Record<Name, number>) {}

  /** Run `job` when its lane has room. Jobs in a lane start in the order they were added. */
  async run<T>(lane: Name, job: () => Promise<T>): Promise<T> {
    this.pending++;
    try {
      if ((this.active.get(lane) ?? 0) >= this.limits[lane]) {
        await new Promise<void>((resolve) => {
          const queue = this.waiting.get(lane) ?? [];
          queue.push(resolve);
          this.waiting.set(lane, queue);
        });
      } else {
        this.active.set(lane, (this.active.get(lane) ?? 0) + 1);
      }
      this.peak.set(lane, Math.max(this.peak.get(lane) ?? 0, this.active.get(lane) ?? 0));
      try {
        return await job();
      } finally {
        const next = this.waiting.get(lane)?.shift();
        // Hand the slot straight to the next job, so the count never dips and lets a third in.
        if (next) next();
        else this.active.set(lane, (this.active.get(lane) ?? 1) - 1);
      }
    } finally {
      this.pending--;
      if (this.pending === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  get busy() {
    return this.pending > 0;
  }

  /** Resolves when nothing is running or waiting. */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
