/**
 * The CRM connectors — the code that actually sends mail and publishes in
 * public on the operator's behalf. Every one of these calls reaches a
 * third-party service, so each function takes a client factory it defaults to
 * the real thing; these tests stand in for it.
 *
 * Closes the connector half of #9: the send/read paths had no cover because
 * they needed IMAP/SMTP/Twitter/LinkedIn mocking.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { SecretStore } from '../auth/secret-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import {
  loadEmailConfig, readInbox, readMessage, sendEmail,
  type EmailConfig, type ImapClient, type ImapMessage, type SmtpTransport,
} from '../connectors/email.js';
import {
  loadTwitterConfig, getMentions, getMyTweets, postTweet,
  type TwitterConfig, type TwitterClient,
} from '../connectors/twitter.js';
import { loadLinkedInConfig, publishPost, type LinkedInConfig } from '../connectors/linkedin.js';

const emailCfg: EmailConfig = {
  imap: { host: 'imap.example.com', port: 993, user: 'u', pass: 'p' },
  smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' },
  from: 'Agent <agent@example.com>',
};

/** Minimal IMAP stand-in. Records lifecycle so we can assert the socket closes. */
function fakeImap(messages: ImapMessage[], opts: { failOpen?: boolean } = {}) {
  const calls = { connected: 0, loggedOut: 0, opened: [] as string[] };
  const client: ImapClient = {
    async connect() { calls.connected++; },
    async mailboxOpen(name) {
      calls.opened.push(name);
      if (opts.failOpen) throw new Error('NO [AUTHENTICATIONFAILED]');
      return { exists: messages.length };
    },
    fetch(_range, _o) {
      return (async function* () { for (const m of messages) yield m; })();
    },
    async fetchOne(uid) { return messages.find(m => String(m.uid) === uid) ?? false; },
    async logout() { calls.loggedOut++; },
  };
  return { client, calls };
}

describe('email connector', () => {
  it('lists the inbox newest-first with sender, subject and read state', async () => {
    const { client, calls } = fakeImap([
      { uid: 1, envelope: { subject: 'older', date: '2026-01-01T00:00:00Z', from: [{ name: 'Ann', address: 'ann@x.com' }] }, flags: new Set(['\\Seen']) },
      { uid: 2, envelope: { subject: 'newer', date: '2026-02-01T00:00:00Z', from: [{ address: 'bob@x.com' }] }, flags: new Set() },
    ]);
    const out = await readInbox(emailCfg, 15, () => client);

    assert.deepEqual(out.map(m => m.uid), [2, 1], 'IMAP returns ascending; the reader wants newest first');
    assert.equal(out[0].subject, 'newer');
    assert.equal(out[0].seen, false, 'unread must be distinguishable');
    assert.equal(out[1].seen, true);
    assert.equal(out[1].from, 'Ann <ann@x.com>');
    assert.equal(out[0].from, '<bob@x.com>', 'a nameless sender still renders');
    assert.equal(calls.loggedOut, 1, 'the connection is always closed');
  });

  it('returns nothing for an empty mailbox without fetching', async () => {
    const { client } = fakeImap([]);
    assert.deepEqual(await readInbox(emailCfg, 15, () => client), []);
  });

  it('closes the connection even when the mailbox fails to open', async () => {
    const { client, calls } = fakeImap([], { failOpen: true });
    await assert.rejects(() => readInbox(emailCfg, 15, () => client), /AUTHENTICATIONFAILED/);
    assert.equal(calls.loggedOut, 1, 'a failed read must not leak the socket');
  });

  it('falls back gracefully when an envelope is missing fields', async () => {
    const { client } = fakeImap([{ uid: 7, flags: new Set() }]);
    const [m] = await readInbox(emailCfg, 15, () => client);
    assert.equal(m.from, '(unknown)');
    assert.equal(m.subject, '(no subject)');
    assert.equal(m.date, '');
  });

  it('parses one message by uid', async () => {
    const raw = Buffer.from(
      'From: Ann <ann@x.com>\r\nTo: me@x.com\r\nSubject: Hello\r\n' +
      'Date: Thu, 01 Jan 2026 00:00:00 +0000\r\n\r\nbody text here\r\n',
    );
    const { client } = fakeImap([{ uid: 9, source: raw, size: raw.length }]);
    const msg = await readMessage(emailCfg, 9, () => client);
    assert.ok(msg);
    assert.equal(msg.uid, 9);
    assert.equal(msg.subject, 'Hello');
    assert.match(msg.from, /ann@x\.com/);
    assert.match(msg.text, /body text here/);
  });

  it('marks a truncated message so the reader knows there is more', async () => {
    const raw = Buffer.from('From: a@x.com\r\nSubject: Big\r\n\r\nstart of body\r\n');
    // `size` is the FULL message size; source is what we pulled off the wire.
    const { client } = fakeImap([{ uid: 4, source: raw, size: 50_000_000 }]);
    const msg = await readMessage(emailCfg, 4, () => client);
    assert.match(msg!.text, /message truncated/);
  });

  it('returns null for a uid that is not there', async () => {
    const { client } = fakeImap([]);
    assert.equal(await readMessage(emailCfg, 404, () => client), null);
  });

  it('sends with the configured from-address and returns the message id', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const transport: SmtpTransport = {
      async sendMail(o) { sent.push(o); return { messageId: '<abc@example.com>' }; },
    };
    const { messageId } = await sendEmail(
      emailCfg, { to: 'x@y.com', subject: 'Hi', text: 'there' }, () => transport,
    );
    assert.equal(messageId, '<abc@example.com>');
    assert.equal(sent[0].from, 'Agent <agent@example.com>');
    assert.equal(sent[0].to, 'x@y.com');
    assert.equal(sent[0].inReplyTo, undefined, 'no threading headers unless asked for');
  });

  it('threads a reply with both In-Reply-To and References', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const transport: SmtpTransport = {
      async sendMail(o) { sent.push(o); return { messageId: '<n@x>' }; },
    };
    await sendEmail(
      emailCfg, { to: 'x@y.com', subject: 'Re', text: 'reply', inReplyTo: '<orig@x>' }, () => transport,
    );
    assert.equal(sent[0].inReplyTo, '<orig@x>');
    assert.equal(sent[0].references, '<orig@x>', 'References is what actually threads in most clients');
  });
});

describe('email config', () => {
  let secrets: SecretStore;
  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    secrets = new SecretStore(openDatabase(':memory:'));
  });

  it('is null until the mailbox is actually configured', () => {
    assert.equal(loadEmailConfig(secrets), null);
    secrets.set('email', 'imap_host', 'imap.example.com');
    assert.equal(loadEmailConfig(secrets), null, 'a half-filled config must not look usable');
  });

  it('twitter needs all four OAuth values, not some of them', () => {
    assert.equal(loadTwitterConfig(secrets), null);
    for (const k of ['api_key', 'api_secret', 'access_token']) secrets.set('twitter', k, 'v');
    assert.equal(loadTwitterConfig(secrets), null, 'three of four is not usable');
    secrets.set('twitter', 'access_secret', 'v');
    assert.ok(loadTwitterConfig(secrets));
  });

  it('linkedin needs a token and an author, and defaults its API version', () => {
    assert.equal(loadLinkedInConfig(secrets), null);
    secrets.set('linkedin', 'access_token', 'tok');
    assert.equal(loadLinkedInConfig(secrets), null, 'a token with nobody to post as is not usable');
    secrets.set('linkedin', 'author_urn', 'urn:li:person:1');
    assert.equal(loadLinkedInConfig(secrets)?.apiVersion, '202401', 'falls back to a pinned version');
    secrets.set('linkedin', 'api_version', '202506');
    assert.equal(loadLinkedInConfig(secrets)?.apiVersion, '202506');
  });
});

const twCfg: TwitterConfig = { appKey: 'k', appSecret: 's', accessToken: 't', accessSecret: 'a' };

function fakeTwitter(over: Partial<TwitterClient['v2']> = {}): { client: TwitterClient; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { tweet: [], reply: [], mentions: [], timeline: [] };
  const client: TwitterClient = {
    v2: {
      async me() { return { data: { id: 'me-1', username: 'ritsu' } }; },
      async userMentionTimeline(id, o) { calls.mentions.push([id, o]); return { data: { data: [] } }; },
      async userTimeline(id, o) { calls.timeline.push([id, o]); return { data: { data: [] } }; },
      async tweet(text) { calls.tweet.push(text); return { data: { id: '111' } }; },
      async reply(text, to) { calls.reply.push([text, to]); return { data: { id: '222' } }; },
      ...over,
    },
  };
  return { client, calls };
}

describe('twitter connector', () => {
  it('maps mentions onto the common summary shape', async () => {
    const { client } = fakeTwitter({
      async userMentionTimeline() {
        return { data: { data: [{ id: '1', text: 'hi @ritsu', author_id: 'u9', created_at: '2026-01-01' }] } };
      },
    });
    const out = await getMentions(twCfg, 10, () => client);
    assert.deepEqual(out, [{ id: '1', text: 'hi @ritsu', author: 'u9', created_at: '2026-01-01' }]);
  });

  it('clamps the result count to what the API accepts', async () => {
    const { client, calls } = fakeTwitter();
    await getMentions(twCfg, 1000, () => client);
    await getMyTweets(twCfg, 1, () => client);
    assert.equal((calls.mentions[0] as [string, Record<string, number>])[1].max_results, 100, 'v2 caps at 100');
    assert.equal((calls.timeline[0] as [string, Record<string, number>])[1].max_results, 5, 'and floors at 5');
  });

  it('handles an empty timeline without throwing', async () => {
    const { client } = fakeTwitter();
    assert.deepEqual(await getMyTweets(twCfg, 10, () => client), []);
  });

  it('posts and builds a URL from the resolved handle', async () => {
    const { client, calls } = fakeTwitter();
    const { id, url } = await postTweet(twCfg, 'hello world', undefined, () => client);
    assert.equal(id, '111');
    assert.equal(url, 'https://x.com/ritsu/status/111');
    assert.deepEqual(calls.tweet, ['hello world']);
    assert.deepEqual(calls.reply, [], 'a non-reply must not go through the reply endpoint');
  });

  it('routes a reply to the reply endpoint', async () => {
    const { client, calls } = fakeTwitter();
    const { id } = await postTweet(twCfg, 'answering', '999', () => client);
    assert.equal(id, '222');
    assert.deepEqual(calls.reply, [['answering', '999']]);
  });

  it('still returns a usable URL when the handle lookup fails', async () => {
    // Posting succeeded; failing the whole call over a cosmetic lookup would
    // tell the agent the post did not happen when it did.
    const { client } = fakeTwitter({ async me() { throw new Error('rate limited'); } });
    const { url } = await postTweet(twCfg, 'hi', undefined, () => client);
    assert.equal(url, 'https://x.com/i/status/111');
  });
});

describe('linkedin connector', () => {
  const liCfg: LinkedInConfig = { accessToken: 'tok', authorUrn: 'urn:li:person:42', apiVersion: '202401' };

  it('posts as the configured author and returns a viewable URL', async () => {
    const seen: Array<{ endpoint: string; body: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (target: string, init?: RequestInit) => {
      seen.push({
        endpoint: target,
        body: typeof init?.body === 'string' ? init.body : '',
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:77' } });
    }) as unknown as typeof fetch;

    const { id, url } = await publishPost(liCfg, 'hello', fetchImpl);
    assert.equal(id, 'urn:li:share:77');
    assert.equal(url, 'https://www.linkedin.com/feed/update/urn:li:share:77');

    assert.equal(seen[0].endpoint, 'https://api.linkedin.com/rest/posts');
    const body = JSON.parse(seen[0].body) as Record<string, unknown>;
    assert.equal(body.author, 'urn:li:person:42');
    assert.equal(body.commentary, 'hello');
    assert.equal(body.lifecycleState, 'PUBLISHED');
    const headers = seen[0].headers;
    assert.equal(headers.Authorization, 'Bearer tok');
    assert.equal(headers['LinkedIn-Version'], '202401');
  });

  it('raises the API status and body on failure', async () => {
    const fetchImpl = (async () => new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch;
    await assert.rejects(() => publishPost(liCfg, 'hi', fetchImpl), /LinkedIn 429: quota exceeded/);
  });

  it('degrades to the feed URL when no post urn comes back', async () => {
    const fetchImpl = (async () => new Response('', { status: 201 })) as unknown as typeof fetch;
    const { id, url } = await publishPost(liCfg, 'hi', fetchImpl);
    assert.equal(id, '(unknown)');
    assert.equal(url, 'https://www.linkedin.com/feed/');
  });
});
