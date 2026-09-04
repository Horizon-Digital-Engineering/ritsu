import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { masterKeyStatus } from '../util/secret-crypto.js';

const ENV = 'RITSU_MASTER_KEY';
const COLOCATED = 'RITSU_ALLOW_COLOCATED_KEY';

describe('masterKeyStatus', () => {
  let savedEnv: string | undefined;
  let savedColocated: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV];
    savedColocated = process.env[COLOCATED];
    delete process.env[ENV];
    delete process.env[COLOCATED];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
    if (savedColocated === undefined) delete process.env[COLOCATED]; else process.env[COLOCATED] = savedColocated;
  });

  it('reports the environment as a source without creating anything', () => {
    process.env[ENV] = 'a'.repeat(44);
    const st = masterKeyStatus();
    assert.equal(st.ok, true);
    assert.equal(st.source, 'env');
  });

  it('reports missing with an actionable detail rather than throwing', () => {
    // No env key, and neither key file exists in this test environment.
    const st = masterKeyStatus();
    assert.equal(st.ok, false);
    assert.equal(st.source, null);
    assert.match(st.detail ?? '', /secrets cannot be stored/);
    // The message must carry the fix, since this surfaces in a UI banner.
    assert.match(st.detail ?? '', /openssl rand/);
  });

  it('never throws — callers use it to report, not to bootstrap', () => {
    assert.doesNotThrow(() => masterKeyStatus());
    process.env[ENV] = 'not-valid-base64-length';
    assert.doesNotThrow(() => masterKeyStatus());
  });
});
