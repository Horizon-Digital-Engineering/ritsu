import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SettingsStore } from '../settings-store.js';

describe('SettingsStore', () => {
  let s: SettingsStore;
  beforeEach(() => { s = new SettingsStore(openDatabase(':memory:')); });

  it('round-trips and overwrites in place', () => {
    assert.equal(s.get('backups.keep'), null);
    s.set('backups.keep', '30');
    assert.equal(s.get('backups.keep'), '30');
    s.set('backups.keep', '7');
    assert.equal(s.get('backups.keep'), '7');
    assert.deepEqual(s.all(), { 'backups.keep': '7' });
  });

  it('getNumber falls back when unset', () => {
    assert.equal(s.getNumber('backups.keep', 14), 14);
    s.set('backups.keep', '30');
    assert.equal(s.getNumber('backups.keep', 14), 30);
  });

  it('getNumber refuses a non-numeric value rather than yielding NaN', () => {
    // NaN here would silently disable the timer or limit it configures.
    s.set('approvals.ttl_seconds', 'soon');
    assert.equal(s.getNumber('approvals.ttl_seconds', 86400), 86400);
    s.set('approvals.ttl_seconds', '');
    assert.equal(s.getNumber('approvals.ttl_seconds', 86400), 86400);
  });

  it('delete restores the default', () => {
    s.set('backups.keep', '30');
    assert.equal(s.delete('backups.keep'), true);
    assert.equal(s.getNumber('backups.keep', 14), 14);
    assert.equal(s.delete('backups.keep'), false);
  });
});
