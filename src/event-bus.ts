import { EventEmitter } from 'node:events';

export interface LogEvent {
  /** ISO timestamp. */
  t: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  /** Arbitrary structured fields the logger was called with. */
  [extra: string]: unknown;
}

/**
 * In-memory ring buffer of recent log events + an event emitter so live tails
 * (admin SSE) can subscribe. The bus is a singleton — the logger pushes to it
 * on every call, the admin /events endpoint reads from it.
 *
 * Capacity is deliberately small. journald has the durable copy in prod;
 * this is for the live-tail UI only.
 */
export class EventBus extends EventEmitter {
  private readonly buf: LogEvent[] = [];
  private writeIdx = 0;

  constructor(readonly capacity = 1000) {
    super();
    this.setMaxListeners(0); // many SSE clients may attach
  }

  push(event: LogEvent): void {
    if (this.buf.length < this.capacity) {
      this.buf.push(event);
    } else {
      this.buf[this.writeIdx] = event;
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
    }
    this.emit('entry', event);
  }

  /** Snapshot in chronological order (oldest first). */
  recent(limit = 200): LogEvent[] {
    const ordered = this.buf.length < this.capacity
      ? this.buf.slice()
      : [...this.buf.slice(this.writeIdx), ...this.buf.slice(0, this.writeIdx)];
    return ordered.slice(-limit);
  }

  clear(): void {
    this.buf.length = 0;
    this.writeIdx = 0;
  }
}

/** Process-wide singleton. */
export const eventBus = new EventBus();
