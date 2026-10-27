export class IdleRuntimePool<T> {
  private readonly entries = new Map<T, NodeJS.Timeout>();

  constructor(
    private readonly timeoutMs: number,
    private readonly capacity: number,
    private readonly reclaim: (entry: T) => void,
  ) {}

  activate(entry: T): void {
    const timer = this.entries.get(entry);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.entries.delete(entry);
    }
  }

  release(entry: T): void {
    this.activate(entry);
    const timer = setTimeout(() => this.evict(entry), this.timeoutMs);
    timer.unref?.();
    this.entries.set(entry, timer);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.evict(oldest.value);
    }
  }

  private evict(entry: T): void {
    if (!this.entries.has(entry)) return;
    this.activate(entry);
    this.reclaim(entry);
  }
}
