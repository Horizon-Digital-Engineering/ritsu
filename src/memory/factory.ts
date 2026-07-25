/**
 * Build a MemoryService from the resolved config + the on-box DB. This is the single
 * place the mode/URL/token turn into concrete backends, so index.ts stays a
 * one-liner and the wiring is testable in isolation.
 *
 * The sqlite backend is ALWAYS constructed (it's the floor + backstop). The
 * flashback backend is added only when a remote mode is configured AND its
 * URL/token are present; otherwise the service runs sqlite-only and logs once.
 */
import type { Db } from '../db.js';
import { SqliteMemoryBackend } from './sqlite-backend.js';
import { FlashbackMemoryBackend } from './flashback-backend.js';
import { MemoryService } from './service.js';
import { type MemoryConfig } from './config.js';

export function buildMemoryService(db: Db, cfg: MemoryConfig): MemoryService {
  const sqlite = new SqliteMemoryBackend(db);
  const flashback = cfg.flashback
    ? new FlashbackMemoryBackend({
        endpoint: cfg.flashback.endpoint,
        token: cfg.flashback.token,
        timeoutMs: cfg.flashback.timeoutMs,
      })
    : undefined;
  return new MemoryService({
    mode: cfg.mode,
    sqlite,
    flashback,
    fireAndForgetTimeoutMs: cfg.flashback?.timeoutMs,
  });
}
