import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { padNumber } from '../../utils/embeds.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('transcript');
const TRANSCRIPT_DIR = join(process.cwd(), 'transcripts');

/**
 * Ticket transcripts as self-contained HTML.
 *
 * A Discord channel is not an archive — it can be deleted, and it is
 * unreadable to anyone without server access. An HTML file is searchable,
 * attachable to an appeal, and still readable in five years. No external CSS or
 * JS, so it opens from a file:// URL with no network.
 *
 * Transcripts contain whatever players typed, which can include personal
 * information. Treat `transcripts/` as sensitive.
 */

const MAX_MESSAGES = 2000;

/** Fetch a channel's full history, oldest first. */
export async function fetchMessages(channel, limit = MAX_MESSAGES) {
  const collected = [];
  let before;

  while (collected.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    collected.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  return collected.reverse();
}

/**
 * Convert fetched messages into the structure the web viewer stores.
 *
 * Kept separate from rendering so the same capture feeds both the database
 * record and the fallback HTML file — one pass over the channel, two outputs.
 */
export function toTranscriptMessages(messages, staffIds = new Set()) {
  return messages.map((message) => ({
    id: message.id,
    authorId: message.author?.id ?? null,
    authorTag: message.author?.tag ?? 'Unknown',
    authorAvatar: message.author?.displayAvatarURL?.({ size: 64, extension: 'png' }) ?? null,
    bot: Boolean(message.author?.bot),
    isStaff: staffIds.has(message.author?.id),
    content: message.content ?? '',
    createdAt: new Date(message.createdTimestamp),
    editedAt: message.editedTimestamp ? new Date(message.editedTimestamp) : null,
    attachments: [...(message.attachments?.values() ?? [])].map((a) => ({
      name: a.name,
      url: a.url,
      contentType: a.contentType ?? null,
      size: a.size ?? null,
    })),
    embeds: (message.embeds ?? []).slice(0, 3).map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
      color: e.color ?? null,
      fields: (e.fields ?? []).slice(0, 5).map((f) => ({ name: f.name, value: f.value })),
    })),
  }));
}

export async function generateTranscript(channel, ticket) {
  const messages = await fetchMessages(channel);
  const html = renderHtml(messages, ticket, channel.guild);

  await mkdir(TRANSCRIPT_DIR, { recursive: true });
  const fileName = `ticket-${padNumber(ticket.ticketId)}.html`;
  const path = join(TRANSCRIPT_DIR, fileName);
  await writeFile(path, html, 'utf8');

  log.info({ ticketId: ticket.ticketId, messages: messages.length }, 'Transcript generated');

  return {
    path,
    fileName,
    messageCount: messages.length,
    /** Raw messages, so the caller can also build the web transcript record. */
    raw: messages,
    attachment: new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName }),
  };
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderMessage(message) {
  const author = escapeHtml(message.author?.tag ?? 'Unknown');
  const time = new Date(message.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
  const bot = message.author?.bot ? '<span class="tag">BOT</span>' : '';

  const content = escapeHtml(message.content).replaceAll('\n', '<br>') || '<i>no text</i>';

  const attachments = [...(message.attachments?.values() ?? [])]
    .map((a) => `<a class="att" href="${escapeHtml(a.url)}">📎 ${escapeHtml(a.name)}</a>`)
    .join('');

  // Embeds are flattened to title + description: a transcript is a record, not
  // a pixel-perfect replica of Discord.
  const embeds = (message.embeds ?? [])
    .map(
      (e) =>
        `<div class="embed"><b>${escapeHtml(e.title ?? '')}</b><div>${escapeHtml(
          e.description ?? '',
        ).replaceAll('\n', '<br>')}</div></div>`,
    )
    .join('');

  return `<div class="msg">
  <div class="meta"><span class="author">${author}</span>${bot}<span class="time">${time}</span></div>
  <div class="body">${content}${attachments}${embeds}</div>
</div>`;
}

function renderHtml(messages, ticket, guild) {
  const responses = (ticket.responses ?? [])
    .map(
      (r) =>
        `<div class="resp"><div class="label">${escapeHtml(r.label)}</div><div>${escapeHtml(
          r.value,
        ).replaceAll('\n', '<br>')}</div></div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Ticket #${padNumber(ticket.ticketId)} — ${escapeHtml(guild.name)}</title>
<style>
  :root { color-scheme: dark; }
  body { background:#1a1b1e; color:#dcddde; font:15px/1.5 "Segoe UI",system-ui,sans-serif; margin:0; padding:32px; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { color:#f2a33c; margin:0 0 4px; font-size:24px; }
  .sub { color:#8e9297; margin-bottom:24px; font-size:13px; }
  .card { background:#25262b; border-radius:8px; padding:16px 20px; margin-bottom:24px; }
  .card h2 { font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:#8e9297; margin:0 0 12px; }
  .kv { display:grid; grid-template-columns:150px 1fr; gap:6px 16px; font-size:14px; }
  .kv dt { color:#8e9297; }
  .resp { margin-bottom:12px; }
  .resp .label { color:#f2a33c; font-weight:600; font-size:13px; }
  .msg { padding:8px 0; border-bottom:1px solid #2f3136; }
  .meta { font-size:13px; margin-bottom:2px; }
  .author { color:#fff; font-weight:600; }
  .time { color:#72767d; font-size:11px; margin-left:8px; }
  .tag { background:#5865f2; color:#fff; font-size:10px; border-radius:3px; padding:1px 4px; margin-left:6px; }
  .body { white-space:normal; word-wrap:break-word; }
  .att { display:block; color:#00a8fc; text-decoration:none; margin-top:4px; font-size:13px; }
  .embed { border-left:3px solid #f2a33c; background:#2b2d31; padding:8px 12px; margin-top:6px; border-radius:0 4px 4px 0; }
  footer { color:#72767d; font-size:12px; margin-top:32px; text-align:center; }
</style></head>
<body><div class="wrap">
  <h1>Ticket #${padNumber(ticket.ticketId)}</h1>
  <div class="sub">${escapeHtml(guild.name)} · generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</div>

  <div class="card">
    <h2>Details</h2>
    <dl class="kv">
      <dt>Category</dt><dd>${escapeHtml(ticket.category)}</dd>
      <dt>Opened by</dt><dd>${escapeHtml(ticket.openerTag ?? ticket.openerId)} (${escapeHtml(ticket.openerId)})</dd>
      <dt>Opened</dt><dd>${new Date(ticket.createdAt).toISOString().slice(0, 19).replace('T', ' ')} UTC</dd>
      <dt>Handled by</dt><dd>${escapeHtml(ticket.claimedByTag ?? 'Unclaimed')}</dd>
      <dt>Closed by</dt><dd>${escapeHtml(ticket.closedByTag ?? '—')}</dd>
      <dt>Close reason</dt><dd>${escapeHtml(ticket.closeReason ?? '—')}</dd>
      <dt>Messages</dt><dd>${messages.length}</dd>
    </dl>
  </div>

  ${responses ? `<div class="card"><h2>Form responses</h2>${responses}</div>` : ''}

  <div class="card">
    <h2>Conversation</h2>
    ${messages.map(renderMessage).join('\n') || '<i>No messages</i>'}
  </div>

  <footer>Pizza Guy's Time — internal record. Handle according to your data policy.</footer>
</div></body></html>`;
}
