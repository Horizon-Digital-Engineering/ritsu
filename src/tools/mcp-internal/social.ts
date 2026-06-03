/**
 * Social tools (in-process MCP) — the social half of the CRM. An agent with
 * the 'social' capability gets these. Today they target X/Twitter; more
 * platforms slot in beside them under the same secret-store + gate pattern.
 *
 *   read_mentions(limit?)        recent mentions of the account     (ungated)
 *   read_my_posts(limit?)        recent posts by the account        (ungated)
 *   post_tweet(text, reply_to?)  publish a post / reply — ALWAYS blocks on
 *                                operator approval before it goes out    (GATED)
 *
 * post_tweet is intrinsically gated: posting in public on someone's behalf is
 * exactly the elevated action the approval system exists for. Credentials are
 * resolved from the SecretStore inside the handler; the model never sees them.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SecretStore } from '../../auth/secret-store.js';
import type { ApprovalStore } from '../../approval-store.js';
import { loadTwitterConfig, getMentions, getMyTweets, postTweet } from '../../connectors/twitter.js';
import { loadLinkedInConfig, publishPost } from '../../connectors/linkedin.js';
import { logger } from '../../util/log.js';

export const SOCIAL_MCP_NAME = 'social';

export const SOCIAL_TOOL_NAMES = [
  `mcp__${SOCIAL_MCP_NAME}__read_mentions`,
  `mcp__${SOCIAL_MCP_NAME}__read_my_posts`,
  `mcp__${SOCIAL_MCP_NAME}__post_tweet`,
  `mcp__${SOCIAL_MCP_NAME}__post_linkedin`,
] as const;

const POST_TOOL = SOCIAL_TOOL_NAMES[2];
const LINKEDIN_TOOL = SOCIAL_TOOL_NAMES[3];

export interface SocialMcpDeps {
  agentId: string;
  secrets: SecretStore;
  approvals: ApprovalStore;
  conversationId: number | null;
}

function notConfigured() {
  return { content: [{ type: 'text' as const, text: 'X/Twitter is not configured. Ask the operator to set the credentials in the Extensions tab.' }] };
}

function err(prefix: string, e: unknown) {
  return { content: [{ type: 'text' as const, text: `${prefix}: ${(e as Error).message}` }] };
}

export function buildAgentSocialMcp(deps: SocialMcpDeps) {
  const { agentId, secrets, approvals, conversationId } = deps;
  return createSdkMcpServer({
    name: SOCIAL_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'read_mentions',
        'Read recent mentions of the connected X/Twitter account (id, author, text, date). ' +
          'Use these to decide what to reply to. (Reading needs the paid API tier.)',
        { limit: z.number().int().min(5).max(100).optional().describe('how many recent mentions (default 10)') },
        async ({ limit }) => {
          const cfg = loadTwitterConfig(secrets);
          if (!cfg) return notConfigured();
          try {
            const ms = await getMentions(cfg, limit ?? 10);
            if (ms.length === 0) return { content: [{ type: 'text', text: '(no recent mentions)' }] };
            const body = ms.map(m => `[${m.id}] ${m.created_at?.slice(0, 16) ?? ''}\n    ${m.text}`).join('\n');
            return { content: [{ type: 'text', text: body }] };
          } catch (e) {
            logger.warn('social.read_mentions.error', { agent_id: agentId, err: (e as Error).message });
            return err('error reading mentions', e);
          }
        },
      ),
      tool(
        'read_my_posts',
        'Read the connected account\'s own recent posts (id, text, date). Useful to avoid repeating yourself.',
        { limit: z.number().int().min(5).max(100).optional().describe('how many recent posts (default 10)') },
        async ({ limit }) => {
          const cfg = loadTwitterConfig(secrets);
          if (!cfg) return notConfigured();
          try {
            const ts = await getMyTweets(cfg, limit ?? 10);
            if (ts.length === 0) return { content: [{ type: 'text', text: '(no recent posts)' }] };
            const body = ts.map(t => `[${t.id}] ${t.created_at?.slice(0, 16) ?? ''}\n    ${t.text}`).join('\n');
            return { content: [{ type: 'text', text: body }] };
          } catch (e) {
            logger.warn('social.read_my_posts.error', { agent_id: agentId, err: (e as Error).message });
            return err('error reading posts', e);
          }
        },
      ),
      tool(
        'post_tweet',
        'Publish a post on X/Twitter (or a reply if reply_to is set). This ALWAYS requires operator approval ' +
          'before it goes live — write the full text, call this, and it pauses until the operator approves or ' +
          'rejects. Max 280 characters. On rejection you receive the reason.',
        {
          text: z.string().min(1).max(280).describe('the post text (<=280 chars)'),
          reply_to: z.string().optional().describe('optional tweet id this is a reply to'),
        },
        async ({ text, reply_to }) => {
          // ALWAYS gate — publishing is the elevated action. Block until the
          // operator decides; nothing goes out otherwise.
          logger.info('social.post.gate', { agent_id: agentId, len: text.length, reply_to: reply_to ?? null, conversation_id: conversationId });
          const decision = await approvals.request({
            agentId,
            conversationId,
            toolName: POST_TOOL,
            args: { text, ...(reply_to ? { reply_to } : {}) },
          });
          if (decision.state === 'rejected') {
            return {
              content: [{
                type: 'text',
                text: decision.reason?.trim()
                  ? `Operator rejected this post: ${decision.reason.trim()}`
                  : 'Operator rejected this post.',
              }],
            };
          }
          const cfg = loadTwitterConfig(secrets);
          if (!cfg) return notConfigured();
          try {
            const { url } = await postTweet(cfg, text, reply_to);
            return { content: [{ type: 'text', text: `posted: ${url}` }] };
          } catch (e) {
            logger.error('social.post.error', { agent_id: agentId, err: (e as Error).message });
            return err('approved, but posting failed', e);
          }
        },
      ),
      tool(
        'post_linkedin',
        'Publish a text post to LinkedIn (to the configured person or company page). This ALWAYS requires ' +
          'operator approval before it goes live. LinkedIn is publish-only here (no feed reading). On rejection ' +
          'you receive the reason.',
        { text: z.string().min(1).max(3000).describe('the post text (<=3000 chars)') },
        async ({ text }) => {
          logger.info('social.linkedin.gate', { agent_id: agentId, len: text.length, conversation_id: conversationId });
          const decision = await approvals.request({
            agentId,
            conversationId,
            toolName: LINKEDIN_TOOL,
            args: { text },
          });
          if (decision.state === 'rejected') {
            return {
              content: [{
                type: 'text',
                text: decision.reason?.trim()
                  ? `Operator rejected this LinkedIn post: ${decision.reason.trim()}`
                  : 'Operator rejected this LinkedIn post.',
              }],
            };
          }
          const cfg = loadLinkedInConfig(secrets);
          if (!cfg) return { content: [{ type: 'text', text: 'LinkedIn is not configured. Ask the operator to set the credentials in the Extensions tab.' }] };
          try {
            const { url } = await publishPost(cfg, text);
            return { content: [{ type: 'text', text: `posted to LinkedIn: ${url}` }] };
          } catch (e) {
            logger.error('social.linkedin.error', { agent_id: agentId, err: (e as Error).message });
            return err('approved, but posting failed', e);
          }
        },
      ),
    ],
  });
}
