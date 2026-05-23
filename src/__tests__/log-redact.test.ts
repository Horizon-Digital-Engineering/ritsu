import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { eventBus } from '../event-bus.js';
import { logger } from '../util/log.js';

describe('logger redact', () => {
  it('redacts known-sensitive keys recursively', () => {
    const captured: unknown[] = [];
    const onEntry = (e: unknown) => captured.push(e);
    eventBus.on('entry', onEntry);

    logger.info('test', {
      token: 'rt_secret123',
      Authorization: 'Bearer rt_secret123',
      api_key: 'sk-...',
      password: 'hunter2',
      nested: {
        cookie: 'sessionid=abc',
        private_key: 'pem',
        safe: 'visible',
      },
      list: [{ secret: 'no', ok: 'yes' }],
      // Safe keys pass through.
      agent_id: 'hello-world',
      tool: 'list_agents',
      msg_count: 3,
    });

    eventBus.off('entry', onEntry);

    assert.ok((captured.length) > (0));
    const entry = captured.at(-1) as Record<string, unknown>;
    assert.equal(entry.token, '[redacted]');
    assert.equal(entry.Authorization, '[redacted]');
    assert.equal(entry.api_key, '[redacted]');
    assert.equal(entry.password, '[redacted]');
    assert.equal(entry.agent_id, 'hello-world');
    assert.equal(entry.tool, 'list_agents');
    assert.equal(entry.msg_count, 3);

    const nested = entry.nested as Record<string, unknown>;
    assert.equal(nested.cookie, '[redacted]');
    assert.equal(nested.private_key, '[redacted]');
    assert.equal(nested.safe, 'visible');

    const list = entry.list as Array<Record<string, unknown>>;
    assert.equal(list[0].secret, '[redacted]');
    assert.equal(list[0].ok, 'yes');
  });

  it('setLevel changes runtime emit threshold', () => {
    const captured: string[] = [];
    const onEntry = (e: { msg?: string }) => { if (e.msg) captured.push(e.msg); };
    eventBus.on('entry', onEntry);

    const prior = logger.getLevel();
    logger.setLevel('warn');
    logger.info('should-be-suppressed');
    logger.warn('should-appear');
    logger.setLevel(prior);

    eventBus.off('entry', onEntry);

    assert.ok((captured).includes('should-appear'));
    assert.ok(!(captured).includes('should-be-suppressed'));
  });
});
