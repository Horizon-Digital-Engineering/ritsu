/**
 * X / Twitter connector — the API plumbing for the social half of the CRM.
 *
 * Same posture as the email connector: OAuth 1.0a user-context credentials
 * live in the SecretStore (namespace 'twitter') and are decrypted here,
 * in-process, only to build a client. An agent calls read_mentions /
 * post_tweet with plain content; it never handles a token.
 *
 * OAuth 1.0a (4 long-lived creds: api key + secret, access token + secret)
 * is the simplest user-context auth for a server posting on behalf of one
 * account — no refresh dance. Reads (mentions/timeline) need the paid basic
 * tier; posting works on the free tier. Errors (tier limits, rate limits)
 * are surfaced as strings so the agent can react instead of crashing.
 */
import { TwitterApi } from 'twitter-api-v2';
import type { SecretStore } from '../auth/secret-store.js';
import { logger } from '../util/log.js';

export const TWITTER_NS = 'twitter';

export const TWITTER_SECRET_KEYS = ['api_key', 'api_secret', 'access_token', 'access_secret'] as const;

export interface TwitterConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export interface TweetSummary {
  id: string;
  text: string;
  author?: string;
  created_at?: string;
}

/** Assemble OAuth 1.0a creds from the secret store, or null if not set up. */
export function loadTwitterConfig(secrets: SecretStore): TwitterConfig | null {
  const appKey = secrets.get(TWITTER_NS, 'api_key');
  const appSecret = secrets.get(TWITTER_NS, 'api_secret');
  const accessToken = secrets.get(TWITTER_NS, 'access_token');
  const accessSecret = secrets.get(TWITTER_NS, 'access_secret');
  if (!appKey || !appSecret || !accessToken || !accessSecret) return null;
  return { appKey, appSecret, accessToken, accessSecret };
}

/** A tweet as the v2 timeline endpoints return it. */
interface RawTweet { id: string; text: string; author_id?: string; created_at?: string }
type Timeline = Promise<{ data: { data?: RawTweet[] } }>;

/**
 * The slice of twitter-api-v2 these functions actually use. Declared narrowly
 * so a test can stand in for the client — these calls reach a paid third-party
 * API and must never fire from a test run.
 */
export interface TwitterClient {
  v2: {
    me(): Promise<{ data: { id: string; username?: string } }>;
    userMentionTimeline(id: string, opts: Record<string, unknown>): Timeline;
    userTimeline(id: string, opts: Record<string, unknown>): Timeline;
    tweet(text: string): Promise<{ data: { id: string } }>;
    reply(text: string, replyToId: string): Promise<{ data: { id: string } }>;
  };
}

export type TwitterClientFactory = (cfg: TwitterConfig) => TwitterClient;

const client: TwitterClientFactory = (cfg) => new TwitterApi({
  appKey: cfg.appKey,
  appSecret: cfg.appSecret,
  accessToken: cfg.accessToken,
  accessSecret: cfg.accessSecret,
});

/** v2 caps max_results at 100 and floors mention/timeline at 5. */
function clampResults(n: number): number {
  return Math.min(100, Math.max(5, n));
}

/** Recent mentions of the authenticated account. */
export async function getMentions(
  cfg: TwitterConfig, limit = 10, makeClient: TwitterClientFactory = client,
): Promise<TweetSummary[]> {
  const c = makeClient(cfg);
  const me = await c.v2.me();
  const res = await c.v2.userMentionTimeline(me.data.id, {
    max_results: clampResults(limit),
    'tweet.fields': ['created_at', 'author_id'],
  });
  const out: TweetSummary[] = [];
  for (const t of res.data.data ?? []) {
    out.push({ id: t.id, text: t.text, author: t.author_id, created_at: t.created_at });
  }
  return out;
}

/** Recent posts by the authenticated account. */
export async function getMyTweets(
  cfg: TwitterConfig, limit = 10, makeClient: TwitterClientFactory = client,
): Promise<TweetSummary[]> {
  const c = makeClient(cfg);
  const me = await c.v2.me();
  const res = await c.v2.userTimeline(me.data.id, {
    max_results: clampResults(limit),
    'tweet.fields': ['created_at'],
  });
  const out: TweetSummary[] = [];
  for (const t of res.data.data ?? []) {
    out.push({ id: t.id, text: t.text, created_at: t.created_at });
  }
  return out;
}

/** Post a tweet, optionally as a reply. Returns the new tweet id + URL. */
export async function postTweet(
  cfg: TwitterConfig, text: string, replyToId?: string, makeClient: TwitterClientFactory = client,
): Promise<{ id: string; url: string }> {
  const c = makeClient(cfg);
  const res = replyToId
    ? await c.v2.reply(text, replyToId)
    : await c.v2.tweet(text);
  const me = await c.v2.me().catch(() => null);
  const handle = me?.data?.username ?? 'i';
  logger.info('twitter.posted', { id: res.data.id, reply_to: replyToId ?? null, len: text.length });
  return { id: res.data.id, url: `https://x.com/${handle}/status/${res.data.id}` };
}
