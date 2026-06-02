/**
 * CRM email tools (in-process MCP) for the claude-direct runtime. An agent
 * with the 'crm' capability gets these. The model never handles credentials:
 * it calls read_inbox / read_email / send_email with plain content, and the
 * handler resolves the mailbox account from the SecretStore internally.
 *
 *   read_inbox(limit?)            list recent messages           (ungated)
 *   read_email(uid)              read one message in full        (ungated)
 *   send_email(to,subject,body)  send a message — ALWAYS blocks on
 *                                operator approval before it leaves    (GATED)
 *
 * send_email is intrinsically gated: it always raises an approval and never
 * sends until the operator says yes. This is hard-coded, not a per-agent
 * setting — sending mail on someone's behalf is exactly the elevated action
 * the approval system exists for.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SecretStore } from '../../auth/secret-store.js';
import type { ApprovalStore } from '../../approval-store.js';
import { loadEmailConfig, readInbox, readMessage, sendEmail } from '../../connectors/email.js';
import { logger } from '../../util/log.js';

export const EMAIL_MCP_NAME = 'email';

export const EMAIL_TOOL_NAMES = [
  `mcp__${EMAIL_MCP_NAME}__read_inbox`,
  `mcp__${EMAIL_MCP_NAME}__read_email`,
  `mcp__${EMAIL_MCP_NAME}__send_email`,
] as const;

const SEND_TOOL = EMAIL_TOOL_NAMES[2];

export interface EmailMcpDeps {
  agentId: string;
  secrets: SecretStore;
  approvals: ApprovalStore;
  conversationId: number | null;
}

function notConfigured() {
  return { content: [{ type: 'text' as const, text: 'Email is not configured. Ask the operator to set the email credentials in the Secrets tab.' }] };
}

export function buildAgentEmailMcp(deps: EmailMcpDeps) {
  const { agentId, secrets, approvals, conversationId } = deps;
  return createSdkMcpServer({
    name: EMAIL_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'read_inbox',
        'List the most recent messages in the mailbox (newest first): uid, from, subject, date, read/unread. ' +
          'Use the uid with read_email to open one. Does not mark anything read.',
        { limit: z.number().int().min(1).max(50).optional().describe('how many recent messages (default 15)') },
        async ({ limit }) => {
          const cfg = loadEmailConfig(secrets);
          if (!cfg) return notConfigured();
          try {
            const msgs = await readInbox(cfg, limit ?? 15);
            if (msgs.length === 0) return { content: [{ type: 'text', text: '(inbox is empty)' }] };
            const body = msgs
              .map(m => `[uid ${m.uid}]${m.seen ? '' : ' •'} ${m.date.slice(0, 16)}  ${m.from}\n    ${m.subject}`)
              .join('\n');
            return { content: [{ type: 'text', text: body }] };
          } catch (e) {
            logger.warn('email.read_inbox.error', { agent_id: agentId, err: (e as Error).message });
            return { content: [{ type: 'text', text: `error reading inbox: ${(e as Error).message}` }] };
          }
        },
      ),
      tool(
        'read_email',
        'Read one message in full by its uid (from read_inbox): headers + plain-text body.',
        { uid: z.number().int().positive().describe('the uid from read_inbox') },
        async ({ uid }) => {
          const cfg = loadEmailConfig(secrets);
          if (!cfg) return notConfigured();
          try {
            const m = await readMessage(cfg, uid);
            if (!m) return { content: [{ type: 'text', text: `no message with uid ${uid}` }] };
            const text = `From: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.text}`;
            return { content: [{ type: 'text', text }] };
          } catch (e) {
            logger.warn('email.read_email.error', { agent_id: agentId, err: (e as Error).message });
            return { content: [{ type: 'text', text: `error reading message: ${(e as Error).message}` }] };
          }
        },
      ),
      tool(
        'send_email',
        'Send an email. This ALWAYS requires operator approval before it is sent — compose the full message, ' +
          'call this, and it will pause until the operator approves or rejects. On rejection you receive the reason.',
        {
          to: z.string().min(3).describe('recipient address'),
          subject: z.string().min(1).describe('subject line'),
          body: z.string().min(1).describe('plain-text body of the email'),
          in_reply_to: z.string().optional().describe('optional Message-ID this replies to (threads it)'),
        },
        async ({ to, subject, body, in_reply_to }) => {
          // ALWAYS gate — sending mail is the elevated action. Block here
          // until the operator decides; the message does not leave otherwise.
          logger.info('email.send.gate', { agent_id: agentId, to, conversation_id: conversationId });
          const decision = await approvals.request({
            agentId,
            conversationId,
            toolName: SEND_TOOL,
            args: { to, subject, body, ...(in_reply_to ? { in_reply_to } : {}) },
          });
          if (decision.state === 'rejected') {
            return {
              content: [{
                type: 'text',
                text: decision.reason?.trim()
                  ? `Operator rejected sending this email: ${decision.reason.trim()}`
                  : 'Operator rejected sending this email.',
              }],
            };
          }
          const cfg = loadEmailConfig(secrets);
          if (!cfg) return notConfigured();
          try {
            const { messageId } = await sendEmail(cfg, { to, subject, text: body, ...(in_reply_to ? { inReplyTo: in_reply_to } : {}) });
            return { content: [{ type: 'text', text: `sent to ${to} (message-id ${messageId})` }] };
          } catch (e) {
            logger.error('email.send.error', { agent_id: agentId, err: (e as Error).message });
            return { content: [{ type: 'text', text: `approved, but sending failed: ${(e as Error).message}` }] };
          }
        },
      ),
    ],
  });
}
