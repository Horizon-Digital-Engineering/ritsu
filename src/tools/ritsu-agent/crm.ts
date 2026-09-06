/**
 * CRM tools for the ritsu-agent runtime — the native-loop half of the email +
 * social surfaces the claude-direct runtime gets as in-process MCP servers.
 *
 * Wired when the agent holds the matching capability ('crm' / 'social'). Both
 * groups are read-mostly with one intrinsically gated write:
 *
 *   email_read_inbox / email_read_email             (ungated, fenced)
 *   email_send_email                                ALWAYS operator-approved
 *   social_read_mentions / social_read_my_posts     (ungated, fenced)
 *   social_post_tweet / social_post_linkedin        ALWAYS operator-approved
 *
 * The gate is not a per-agent setting: sending mail or publishing in public on
 * someone's behalf is the elevated action the approval system exists for.
 * Credentials are resolved from the SecretStore inside each handler, so the
 * model never sees them, and every provider error is scrubbed before it is
 * handed back.
 */
import type { RaTool } from '../../model/ritsu-agent/types.js';
import type { SecretStore } from '../../auth/secret-store.js';
import type { ApprovalStore } from '../../approval-store.js';
import { loadEmailConfig, readInbox, readMessage, sendEmail } from '../../connectors/email.js';
import { loadTwitterConfig, getMentions, getMyTweets, postTweet } from '../../connectors/twitter.js';
import { loadLinkedInConfig, publishPost } from '../../connectors/linkedin.js';
import { asString, asNumber } from '../../util/cast.js';
import { scrubSecrets } from '../../util/scrub.js';
import { fenceUntrusted } from '../../util/untrusted.js';
import { logger } from '../../util/log.js';

export const EMAIL_RA_TOOL_NAMES = ['email_read_inbox', 'email_read_email', 'email_send_email'] as const;
export const SOCIAL_RA_TOOL_NAMES = [
  'social_read_mentions', 'social_read_my_posts', 'social_post_tweet', 'social_post_linkedin',
] as const;

export interface CrmToolDeps {
  agentId: string;
  secrets: SecretStore;
  approvals: ApprovalStore;
  conversationId: number | null;
}

const scrubbed = (prefix: string, e: unknown): string => `${prefix}: ${scrubSecrets((e as Error).message)}`;

const clampLimit = (v: unknown, def: number, min: number, max: number): number => {
  const n = asNumber(v);
  return n == null ? def : Math.min(Math.max(Math.floor(n), min), max);
};

/** Block on the operator. Returns the rejection text to hand the model, or
 *  null once approved. */
async function gate(
  deps: CrmToolDeps, toolName: string, args: Record<string, unknown>, noun: string,
): Promise<string | null> {
  const decision = await deps.approvals.request({
    agentId: deps.agentId,
    conversationId: deps.conversationId,
    toolName,
    args,
  });
  if (decision.state !== 'rejected') return null;
  const reason = decision.reason?.trim();
  return reason ? `Operator rejected ${noun}: ${reason}` : `Operator rejected ${noun}.`;
}

export function buildEmailTools(deps: CrmToolDeps): RaTool[] {
  const { agentId, secrets } = deps;
  const notConfigured = 'Email is not configured. Ask the operator to set the email credentials in the Secrets tab.';
  return [
    {
      name: 'email_read_inbox',
      description:
        'List the most recent messages in the mailbox (newest first): uid, from, subject, date, read/unread. ' +
        'Use the uid with email_read_email to open one. Does not mark anything read.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'how many recent messages (default 15)' },
        },
      },
      handler: async (args) => {
        const cfg = loadEmailConfig(secrets);
        if (!cfg) return notConfigured;
        try {
          const msgs = await readInbox(cfg, clampLimit(args.limit, 15, 1, 50));
          if (msgs.length === 0) return '(inbox is empty)';
          const body = msgs
            .map(m => `[uid ${m.uid}]${m.seen ? '' : ' •'} ${m.date.slice(0, 16)}  ${m.from}\n    ${m.subject}`)
            .join('\n');
          // From/subject are attacker-controlled — fence them.
          return fenceUntrusted('inbox listing', body);
        } catch (e) {
          logger.warn('email.read_inbox.error', { agent_id: agentId, err: (e as Error).message });
          return scrubbed('error reading inbox', e);
        }
      },
    },
    {
      name: 'email_read_email',
      description: 'Read one message in full by its uid (from email_read_inbox): headers + plain-text body.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['uid'],
        properties: { uid: { type: 'integer', minimum: 1, description: 'the uid from email_read_inbox' } },
      },
      handler: async (args) => {
        const uid = asNumber(args.uid);
        if (uid == null || uid < 1) return 'error: uid required';
        const cfg = loadEmailConfig(secrets);
        if (!cfg) return notConfigured;
        try {
          const m = await readMessage(cfg, Math.floor(uid));
          if (!m) return `no message with uid ${uid}`;
          const text = `From: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.text}`;
          return fenceUntrusted(`email from ${m.from}`, text);
        } catch (e) {
          logger.warn('email.read_email.error', { agent_id: agentId, err: (e as Error).message });
          return scrubbed('error reading message', e);
        }
      },
    },
    {
      name: 'email_send_email',
      selfGated: true,
      description:
        'Send an email. This ALWAYS requires operator approval before it is sent — compose the full message, ' +
        'call this, and it will pause until the operator approves or rejects. On rejection you receive the reason.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'subject', 'body'],
        properties: {
          // CRLF is rejected on every header-bound field so a model cannot
          // inject extra headers (Bcc:, etc.).
          to: { type: 'string', minLength: 3, maxLength: 320, pattern: String.raw`^[^\r\n@]*@[^\r\n]*$`, description: 'recipient address' },
          subject: { type: 'string', minLength: 1, maxLength: 998, pattern: String.raw`^[^\r\n]*$`, description: 'subject line' },
          body: { type: 'string', minLength: 1, maxLength: 100000, description: 'plain-text body of the email' },
          in_reply_to: { type: 'string', maxLength: 998, pattern: String.raw`^[^\r\n]*$`, description: 'optional Message-ID this replies to (threads it)' },
        },
      },
      handler: async (args) => {
        const to = asString(args.to).trim();
        const subject = asString(args.subject);
        const body = asString(args.body);
        const inReplyTo = asString(args.in_reply_to).trim();
        // A provider can emit anything; the schema is a hint, not enforcement.
        if (!/^[^\r\n@]*@[^\r\n]*$/.test(to)) return 'error: `to` must be an email address with no line breaks';
        if (/[\r\n]/.test(subject) || /[\r\n]/.test(inReplyTo)) return 'error: header fields must not contain line breaks';
        if (!subject || !body) return 'error: subject and body are required';
        logger.info('email.send.gate', { agent_id: agentId, to, conversation_id: deps.conversationId });
        const rejected = await gate(
          deps, 'email_send_email',
          { to, subject, body, ...(inReplyTo ? { in_reply_to: inReplyTo } : {}) },
          'sending this email',
        );
        if (rejected) return rejected;
        const cfg = loadEmailConfig(secrets);
        if (!cfg) return notConfigured;
        try {
          const { messageId } = await sendEmail(cfg, { to, subject, text: body, ...(inReplyTo ? { inReplyTo } : {}) });
          return `sent to ${to} (message-id ${messageId})`;
        } catch (e) {
          logger.error('email.send.error', { agent_id: agentId, err: (e as Error).message });
          return scrubbed('approved, but sending failed', e);
        }
      },
    },
  ];
}

export function buildSocialTools(deps: CrmToolDeps): RaTool[] {
  const { agentId, secrets } = deps;
  const noTwitter = 'X/Twitter is not configured. Ask the operator to set the credentials in the Extensions tab.';
  return [
    {
      name: 'social_read_mentions',
      description:
        'Read recent mentions of the connected X/Twitter account (id, author, text, date). ' +
        'Use these to decide what to reply to. (Reading needs the paid API tier.)',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 5, maximum: 100, description: 'how many recent mentions (default 10)' } },
      },
      handler: async (args) => {
        const cfg = loadTwitterConfig(secrets);
        if (!cfg) return noTwitter;
        try {
          const ms = await getMentions(cfg, clampLimit(args.limit, 10, 5, 100));
          if (ms.length === 0) return '(no recent mentions)';
          const body = ms.map(m => `[${m.id}] ${m.created_at?.slice(0, 16) ?? ''}\n    ${m.text}`).join('\n');
          // Mentions are written by third parties — fence them.
          return fenceUntrusted('X/Twitter mentions', body);
        } catch (e) {
          logger.warn('social.read_mentions.error', { agent_id: agentId, err: (e as Error).message });
          return scrubbed('error reading mentions', e);
        }
      },
    },
    {
      name: 'social_read_my_posts',
      description: "Read the connected account's own recent posts (id, text, date). Useful to avoid repeating yourself.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 5, maximum: 100, description: 'how many recent posts (default 10)' } },
      },
      handler: async (args) => {
        const cfg = loadTwitterConfig(secrets);
        if (!cfg) return noTwitter;
        try {
          const ts = await getMyTweets(cfg, clampLimit(args.limit, 10, 5, 100));
          if (ts.length === 0) return '(no recent posts)';
          return ts.map(t => `[${t.id}] ${t.created_at?.slice(0, 16) ?? ''}\n    ${t.text}`).join('\n');
        } catch (e) {
          logger.warn('social.read_my_posts.error', { agent_id: agentId, err: (e as Error).message });
          return scrubbed('error reading posts', e);
        }
      },
    },
    {
      name: 'social_post_tweet',
      selfGated: true,
      description:
        'Publish a post on X/Twitter (or a reply if reply_to is set). This ALWAYS requires operator approval ' +
        'before it goes live — write the full text, call this, and it pauses until the operator approves or ' +
        'rejects. Max 280 characters. On rejection you receive the reason.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 280, description: 'the post text (<=280 chars)' },
          reply_to: { type: 'string', maxLength: 64, description: 'optional tweet id this is a reply to' },
        },
      },
      handler: async (args) => {
        const text = asString(args.text);
        const replyTo = asString(args.reply_to).trim();
        if (!text) return 'error: text required';
        if (text.length > 280) return `error: post is ${text.length} characters; the limit is 280`;
        logger.info('social.post.gate', {
          agent_id: agentId, len: text.length, reply_to: replyTo || null, conversation_id: deps.conversationId,
        });
        const rejected = await gate(
          deps, 'social_post_tweet', { text, ...(replyTo ? { reply_to: replyTo } : {}) }, 'this post',
        );
        if (rejected) return rejected;
        const cfg = loadTwitterConfig(secrets);
        if (!cfg) return noTwitter;
        try {
          const { url } = await postTweet(cfg, text, replyTo || undefined);
          return `posted: ${url}`;
        } catch (e) {
          logger.error('social.post.error', { agent_id: agentId, err: (e as Error).message });
          return scrubbed('approved, but posting failed', e);
        }
      },
    },
    {
      name: 'social_post_linkedin',
      selfGated: true,
      description:
        'Publish a text post to LinkedIn (to the configured person or company page). This ALWAYS requires ' +
        'operator approval before it goes live. LinkedIn is publish-only here (no feed reading). On rejection ' +
        'you receive the reason.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 3000, description: 'the post text (<=3000 chars)' } },
      },
      handler: async (args) => {
        const text = asString(args.text);
        if (!text) return 'error: text required';
        if (text.length > 3000) return `error: post is ${text.length} characters; the limit is 3000`;
        logger.info('social.linkedin.gate', { agent_id: agentId, len: text.length, conversation_id: deps.conversationId });
        const rejected = await gate(deps, 'social_post_linkedin', { text }, 'this LinkedIn post');
        if (rejected) return rejected;
        const cfg = loadLinkedInConfig(secrets);
        if (!cfg) return 'LinkedIn is not configured. Ask the operator to set the credentials in the Extensions tab.';
        try {
          const { url } = await publishPost(cfg, text);
          return `posted to LinkedIn: ${url}`;
        } catch (e) {
          logger.error('social.linkedin.error', { agent_id: agentId, err: (e as Error).message });
          return scrubbed('approved, but posting failed', e);
        }
      },
    },
  ];
}
