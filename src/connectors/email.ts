/**
 * Email connector — the IMAP (inbox) + SMTP (outbox) plumbing for the CRM.
 *
 * Credentials live in the SecretStore under the 'email' namespace and are
 * decrypted here, in-process, only for the duration of a connection. They
 * are never returned to a tool's result, never logged, never seen by a
 * model. An agent asks "read my inbox" / "send this" with no auth at all;
 * this module supplies it.
 *
 * Connections are per-call (connect → do work → close). Fine for the low
 * volume of an agent triaging mail; a pool can come later if it matters.
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { SecretStore } from '../auth/secret-store.js';
import { logger } from '../util/log.js';

export const EMAIL_NS = 'email';

/**
 * Hard cap on how many bytes of a single message we pull off the wire. A
 * hostile (or just huge) message — a multi-hundred-MB attachment or a MIME
 * bomb — would otherwise be buffered whole and OOM-kill the process, taking
 * every agent down. We do a partial fetch and parse only the prefix; a
 * truncated body still reads fine for triage. 2 MB covers essentially all
 * real plain-text/HTML mail.
 */
const MAX_MESSAGE_BYTES = 2_000_000;

/** Network timeouts (ms). A non-responsive mail server must not pin a turn
 *  open indefinitely — these abort instead. socketTimeout is an inactivity
 *  timer, so it's generous enough not to trip a legitimate large fetch. */
const IMAP_GREETING_TIMEOUT = 15_000;
const IMAP_SOCKET_TIMEOUT = 60_000;
const SMTP_CONNECTION_TIMEOUT = 15_000;
const SMTP_GREETING_TIMEOUT = 15_000;
const SMTP_SOCKET_TIMEOUT = 30_000;

/** Secret keys the connector reads. user/pass are shared between IMAP + SMTP
 *  (the common case — one mailbox account); override the smtp_* keys only if
 *  the provider splits them. */
export const EMAIL_SECRET_KEYS = [
  'imap_host', 'imap_port', 'smtp_host', 'smtp_port', 'user', 'pass', 'from_address',
] as const;

export interface EmailConfig {
  imap: { host: string; port: number; user: string; pass: string };
  smtp: { host: string; port: number; user: string; pass: string };
  from: string;
}

export interface EmailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  seen: boolean;
}

export interface EmailMessage {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  text: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /** Optional Message-ID this is a reply to (threads it on the recipient side). */
  inReplyTo?: string;
}

/**
 * Assemble an EmailConfig from the secret store, or null if email isn't
 * configured yet. Decrypts only the fields it needs; nothing is returned
 * outward. smtp user/pass default to the shared user/pass.
 */
export function loadEmailConfig(secrets: SecretStore): EmailConfig | null {
  const user = secrets.get(EMAIL_NS, 'user');
  const pass = secrets.get(EMAIL_NS, 'pass');
  const imapHost = secrets.get(EMAIL_NS, 'imap_host');
  const smtpHost = secrets.get(EMAIL_NS, 'smtp_host');
  const from = secrets.get(EMAIL_NS, 'from_address');
  if (!user || !pass || !imapHost || !smtpHost || !from) return null;
  const imapPort = Number(secrets.get(EMAIL_NS, 'imap_port') ?? '993') || 993;
  const smtpPort = Number(secrets.get(EMAIL_NS, 'smtp_port') ?? '587') || 587;
  return {
    imap: { host: imapHost, port: imapPort, user, pass },
    smtp: { host: smtpHost, port: smtpPort, user, pass },
    from,
  };
}

/** Build an ImapFlow client. secure=true for 993 (implicit TLS); STARTTLS is
 *  negotiated automatically for 143. logger off so creds never hit our logs. */
function imapClient(cfg: EmailConfig): ImapFlow {
  const secure = cfg.imap.port === 993;
  return new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure,
    // SECURITY: on a non-993 port, REQUIRE a STARTTLS upgrade. imapflow's
    // default is opportunistic (falls back to plaintext LOGIN if STARTTLS is
    // absent — a downgrade-attack vector that would send the password in the
    // clear). doSTARTTLS:true aborts instead of authenticating unencrypted.
    ...(secure ? {} : { doSTARTTLS: true }),
    auth: { user: cfg.imap.user, pass: cfg.imap.pass },
    logger: false,
    greetingTimeout: IMAP_GREETING_TIMEOUT,
    socketTimeout: IMAP_SOCKET_TIMEOUT,
  });
}

/** Read the most recent `limit` envelopes from INBOX, newest first. */
export async function readInbox(cfg: EmailConfig, limit = 15): Promise<EmailSummary[]> {
  const client = imapClient(cfg);
  await client.connect();
  try {
    const mbox = await client.mailboxOpen('INBOX');
    const total = mbox.exists;
    if (total === 0) return [];
    const start = Math.max(1, total - limit + 1);
    const out: EmailSummary[] = [];
    for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
      const env = msg.envelope;
      const fromAddr = env?.from?.[0];
      out.push({
        uid: msg.uid,
        from: fromAddr ? `${fromAddr.name ? fromAddr.name + ' ' : ''}<${fromAddr.address ?? ''}>`.trim() : '(unknown)',
        subject: env?.subject ?? '(no subject)',
        date: env?.date ? new Date(env.date).toISOString() : '',
        seen: msg.flags?.has('\\Seen') ?? false,
      });
    }
    // fetch returns ascending sequence; newest last → reverse for newest-first.
    return out.reverse();
  } finally {
    await client.logout().catch(() => { /* best-effort close */ });
  }
}

/** Fetch + parse one message by UID. Returns the plain-text body (HTML is
 *  stripped to text by mailparser). */
export async function readMessage(cfg: EmailConfig, uid: number): Promise<EmailMessage | null> {
  const client = imapClient(cfg);
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    // Partial fetch: pull at most MAX_MESSAGE_BYTES off the wire so a giant
    // message can't OOM the process. `size` lets us tell the reader when the
    // body was truncated.
    const msg = await client.fetchOne(
      String(uid),
      { source: { maxLength: MAX_MESSAGE_BYTES }, size: true },
      { uid: true },
    );
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source);
    const fullSize = typeof msg.size === 'number' ? msg.size : 0;
    let text = (parsed.text ?? parsed.html ?? '').toString().trim();
    if (fullSize > MAX_MESSAGE_BYTES) {
      text += `\n\n[message truncated: ${(fullSize / 1_000_000).toFixed(1)} MB total, ` +
        `showing first ${(MAX_MESSAGE_BYTES / 1_000_000).toFixed(1)} MB]`;
    }
    return {
      uid,
      from: parsed.from?.text ?? '(unknown)',
      to: Array.isArray(parsed.to) ? parsed.to.map(a => a.text).join(', ') : parsed.to?.text ?? '',
      subject: parsed.subject ?? '(no subject)',
      date: parsed.date ? parsed.date.toISOString() : '',
      text,
    };
  } finally {
    await client.logout().catch(() => { /* best-effort close */ });
  }
}

/** Send a message via SMTP. Returns the provider message id. */
export async function sendEmail(cfg: EmailConfig, input: SendEmailInput): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465, // implicit TLS on 465; STARTTLS on 587
    // SECURITY: require encryption before AUTH. Without requireTLS, nodemailer
    // will fall back to plaintext AUTH PLAIN if the server's EHLO omits
    // STARTTLS (MITM strip / misconfig) — leaking the password on the wire.
    // requireTLS aborts instead. Pin a modern TLS floor too.
    requireTLS: true,
    tls: { minVersion: 'TLSv1.2' },
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT,
    greetingTimeout: SMTP_GREETING_TIMEOUT,
    socketTimeout: SMTP_SOCKET_TIMEOUT,
  });
  const info = await transporter.sendMail({
    from: cfg.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: input.inReplyTo } : {}),
  });
  logger.info('email.sent', { to: input.to, subject_len: input.subject.length, message_id: info.messageId });
  return { messageId: info.messageId };
}
