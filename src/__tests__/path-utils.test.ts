import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { stripTrailingSlashes } from '../util/path-utils.js';

describe('stripTrailingSlashes', () => {
  it('strips a single trailing slash', () => {
    assert.equal(stripTrailingSlashes('https://example.com/'), 'https://example.com');
  });

  it('strips multiple trailing slashes', () => {
    assert.equal(stripTrailingSlashes('https://example.com////'), 'https://example.com');
  });

  it('leaves strings without trailing slash untouched (no new object)', () => {
    const s = 'no-slash-here';
    assert.equal(stripTrailingSlashes(s), s);
  });

  it('returns the empty string for a string of only slashes', () => {
    assert.equal(stripTrailingSlashes('////'), '');
  });

  it('does not strip leading or internal slashes', () => {
    assert.equal(stripTrailingSlashes('/a/b/c'), '/a/b/c');
  });

  it('throws TypeError on array input (HTTP query-array attack)', () => {
    // The whole reason this guard exists: Express turns ?foo=a&foo=b into
    // ['a','b']. Without the type-guard the function silently returns the
    // array unchanged, downstream callers that expect a string ship subtly
    // wrong behavior.
    assert.throws(
      () => stripTrailingSlashes(['a', 'b'] as unknown as string),
      (err: Error) => err instanceof TypeError && /array/.test(err.message),
    );
  });

  it('throws TypeError on undefined input', () => {
    assert.throws(
      () => stripTrailingSlashes(undefined as unknown as string),
      (err: Error) => err instanceof TypeError && /undefined/.test(err.message),
    );
  });

  it('throws TypeError on number input', () => {
    assert.throws(
      () => stripTrailingSlashes(42 as unknown as string),
      (err: Error) => err instanceof TypeError && /number/.test(err.message),
    );
  });
});
