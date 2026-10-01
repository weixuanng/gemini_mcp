/** Per-instance safety cap on Gemini-backed tool calls per UTC day (guards against runaway loops). */
export class DailyLimiter {
  private day = '';
  private used = 0;

  constructor(private readonly limit: number) {}

  tryConsume(now: Date = new Date()): { ok: boolean; used: number; limit: number } {
    const today = now.toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.limit > 0 && this.used >= this.limit) {
      return { ok: false, used: this.used, limit: this.limit };
    }
    this.used++;
    return { ok: true, used: this.used, limit: this.limit };
  }
}
