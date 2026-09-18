/**
 * The transcript viewer page.
 *
 * Rendered server-side from the stored `Transcript` document, with the message
 * data embedded as JSON so search and filtering work with no network calls.
 *
 * ## Escaping
 *
 * Every value that came from a user is escaped exactly once, here, on the way
 * into the HTML. The embedded JSON goes through `jsonScript`, which also
 * neutralises `</script`. Nothing in this file interpolates raw user content
 * into markup, and the page's own CSP blocks anything that slipped through from
 * loading or executing.
 */

const BRAND = '#f2a33c';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Safely embed JSON in a <script> block.
 *
 * `JSON.stringify` alone is not enough: a message containing `</script>` would
 * close the tag and everything after it becomes markup.
 */
function jsonScript(data) {
  return JSON.stringify(data)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

function pad(n) {
  return String(n).padStart(6, '0');
}

function humanMs(ms) {
  if (ms == null) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function isoDate(value) {
  if (!value) return '—';
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * @param {object} transcript a lean Transcript document
 * @returns {string} a complete, self-contained HTML page
 */
export function renderViewer(transcript) {
  const meta = transcript.meta ?? {};
  const title = `Ticket #${pad(transcript.ticketId)}`;

  // Only the fields the client script needs. Avatars and IDs are included so
  // the message list renders without a second request.
  const payload = {
    ticketId: transcript.ticketId,
    truncated: transcript.truncated,
    messages: (transcript.messages ?? []).map((m) => ({
      i: m.id,
      a: m.authorTag ?? 'Unknown',
      av: m.authorAvatar ?? null,
      b: Boolean(m.bot),
      s: Boolean(m.isStaff),
      c: m.content ?? '',
      t: m.createdAt ? new Date(m.createdAt).toISOString() : null,
      e: m.editedAt ? new Date(m.editedAt).toISOString() : null,
      at: (m.attachments ?? []).map((a) => ({ n: a.name, u: a.url, ct: a.contentType })),
      em: (m.embeds ?? []).map((e) => ({ t: e.title, d: e.description, c: e.color })),
    })),
  };

  const responses = (meta.responses ?? [])
    .filter((r) => r.value)
    .map(
      (r) =>
        `<div class="resp"><div class="resp-label">${escapeHtml(r.label)}</div>` +
        `<div class="resp-value">${escapeHtml(r.value).replaceAll('\n', '<br>')}</div></div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive, noimageindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · ${escapeHtml(meta.guildName ?? "Pizza Guy's Time")}</title>
<style>
  :root {
    --brand: ${BRAND};
    --bg: #17181c;
    --bg-2: #1e2025;
    --bg-3: #24262c;
    --line: #2f323a;
    --text: #e6e7ea;
    --muted: #9aa0ab;
    --green: #43b581;
    --red: #ed4245;
    --blue: #5865f2;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.6 "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, system-ui, sans-serif;
    -webkit-text-size-adjust: 100%;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }

  /* ---------- header ---------- */
  header.hero {
    background: linear-gradient(135deg, rgba(242,163,60,.16), rgba(242,163,60,.03));
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 22px 24px;
    margin-bottom: 18px;
  }
  .brandline { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--brand); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  h1 { margin: 6px 0 4px; font-size: clamp(22px, 4vw, 30px); }
  .sub { color: var(--muted); font-size: 13px; }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .badge { background: var(--bg-3); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-size: 12.5px; color: var(--muted); }
  .badge b { color: var(--text); font-weight: 600; }

  /* ---------- detail grid ---------- */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .card { background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
  .card h3 { margin: 0 0 6px; font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .card p { margin: 0; font-size: 14px; word-break: break-word; }

  .panel { background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 20px; margin-bottom: 18px; }
  .panel > h2 { margin: 0 0 14px; font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
  .resp { margin-bottom: 14px; }
  .resp:last-child { margin-bottom: 0; }
  .resp-label { color: var(--brand); font-weight: 600; font-size: 13px; margin-bottom: 2px; }
  .resp-value { white-space: pre-wrap; word-break: break-word; }

  .reason { border-left: 3px solid var(--brand); padding-left: 14px; margin-top: 8px; white-space: pre-wrap; }

  /* ---------- summary ---------- */
  .summary { border-left: 3px solid var(--brand); }
  dl.sum { margin: 0; display: grid; gap: 10px; }
  .sum-row { display: grid; grid-template-columns: 130px 1fr; gap: 12px; align-items: start; }
  .sum-row dt { color: var(--muted); font-size: 13px; }
  .sum-row dd { margin: 0; word-break: break-word; }
  .pill { display: inline-block; padding: 3px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 600; border: 1px solid var(--line); }
  .pill.ok { background: rgba(67,181,129,.16); color: #7ee2b8; border-color: rgba(67,181,129,.4); }
  .pill.bad { background: rgba(237,66,69,.16); color: #ff9a9c; border-color: rgba(237,66,69,.4); }
  .pill.warn { background: rgba(250,166,26,.16); color: #ffce7a; border-color: rgba(250,166,26,.4); }
  .pill.muted { background: var(--bg-3); color: var(--muted); }

  /* ---------- timeline ---------- */
  ul.timeline { list-style: none; margin: 0; padding: 0 0 0 4px; }
  ul.timeline li { position: relative; padding: 0 0 14px 22px; border-left: 2px solid var(--line); }
  ul.timeline li:last-child { padding-bottom: 0; border-left-color: transparent; }
  ul.timeline li::before { content: ""; position: absolute; left: -6px; top: 5px; width: 10px; height: 10px; border-radius: 50%; background: var(--brand); }
  .tl-time { font-variant-numeric: tabular-nums; color: var(--brand); font-weight: 600; margin-right: 10px; }
  .tl-label { font-weight: 600; }
  .tl-actor { color: var(--muted); font-size: 13px; margin-left: 8px; }
  .tl-note { color: var(--muted); font-size: 12px; margin-top: 12px; }
  .unknown { color: var(--muted); font-style: italic; }

  /* ---------- transactions ---------- */
  table.tx { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13.5px; }
  table.tx th { text-align: left; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); }
  table.tx td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
  table.tx tr:last-child td { border-bottom: none; }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; color: var(--muted); }

  /* ---------- toolbar ---------- */
  .toolbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 10px; padding: 12px 0; background: var(--bg); flex-wrap: wrap; }
  .search { flex: 1 1 240px; position: relative; }
  .search input {
    width: 100%; padding: 11px 14px 11px 38px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--bg-2); color: var(--text);
    font-size: 15px; font-family: inherit;
  }
  .search input:focus { outline: 2px solid var(--brand); outline-offset: -1px; }
  .search svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); opacity: .5; }
  button {
    padding: 11px 16px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--bg-2); color: var(--text); font: inherit; font-size: 14px; cursor: pointer;
  }
  button:hover { background: var(--bg-3); border-color: var(--brand); }
  .count { align-self: center; color: var(--muted); font-size: 13px; }

  /* ---------- messages ---------- */
  .msg { display: flex; gap: 12px; padding: 10px 12px; border-radius: 10px; }
  .msg + .msg { margin-top: 2px; }
  .msg:hover { background: var(--bg-2); }
  .msg.hit { background: rgba(242,163,60,.10); }
  .avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; background: var(--bg-3); object-fit: cover; }
  .avatar.initial { display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--muted); font-size: 15px; text-transform: uppercase; }
  .body { min-width: 0; flex: 1; }
  .line { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .author { font-weight: 600; color: #fff; }
  .author.staff { color: var(--brand); }
  .tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--blue); color: #fff; font-weight: 700; letter-spacing: .03em; }
  .tag.staff { background: var(--brand); color: #1a1a1a; }
  .time { font-size: 11.5px; color: var(--muted); }
  .content { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .content:empty::after { content: "no text"; color: var(--muted); font-style: italic; }
  mark { background: var(--brand); color: #17181c; border-radius: 3px; padding: 0 2px; }
  .att { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; padding: 7px 12px; border-radius: 8px; background: var(--bg-3); border: 1px solid var(--line); color: #7cc0ff; text-decoration: none; font-size: 13px; }
  .att:hover { border-color: var(--brand); }
  .att-img { display: block; max-width: min(400px, 100%); max-height: 300px; margin-top: 8px; border-radius: 8px; border: 1px solid var(--line); }
  .emb { border-left: 3px solid var(--brand); background: var(--bg-3); padding: 9px 13px; margin-top: 7px; border-radius: 0 8px 8px 0; }
  .emb-title { font-weight: 600; margin-bottom: 2px; }
  .emb-desc { font-size: 14px; color: #cfd3da; white-space: pre-wrap; }

  .empty { text-align: center; color: var(--muted); padding: 40px 0; }
  .notice { background: rgba(250,166,26,.12); border: 1px solid rgba(250,166,26,.35); border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; }
  footer { margin-top: 32px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; text-align: center; }

  /* ---------- mobile ---------- */
  @media (max-width: 600px) {
    .wrap { padding: 14px 12px 48px; }
    header.hero { padding: 16px; }
    .avatar { width: 32px; height: 32px; }
    .msg { padding: 8px; gap: 9px; }
    .toolbar { gap: 8px; }
    button { flex: 1 1 auto; }
    /* Without this the count is pushed past the right edge by the button. */
    .count { flex: 1 0 100%; text-align: center; }
    .avatar.initial { font-size: 13px; }
    /* Stacked labels read better than a 90px squeezed column. */
    .sum-row { grid-template-columns: 1fr; gap: 2px; }
    table.tx { display: block; overflow-x: auto; white-space: nowrap; }
  }

  /* ---------- print / PDF ---------- */
  @media print {
    :root { --bg: #fff; --bg-2: #fff; --bg-3: #f4f4f5; --line: #d4d4d8; --text: #18181b; --muted: #52525b; }
    body { background: #fff; color: #18181b; font-size: 11pt; }
    .toolbar, .no-print { display: none !important; }
    .wrap { max-width: none; padding: 0; }
    header.hero { background: none; border-color: #d4d4d8; }
    .author { color: #18181b; }
    .msg { break-inside: avoid; page-break-inside: avoid; }
    .att-img { max-height: 200px; }
    a { color: #18181b; text-decoration: underline; }
    a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 8pt; color: #52525b; word-break: break-all; }
  }
</style>
</head>
<body>
<div class="wrap">

  <header class="hero">
    <div class="brandline">🍕 Pizza Guy's Time · Support Transcript</div>
    <h1>Ticket #${pad(transcript.ticketId)}</h1>
    <div class="sub">${escapeHtml(meta.categoryLabel ?? meta.category ?? 'Support')} · ${escapeHtml(meta.channelName ?? '')}</div>
    <div class="badges">
      <span class="badge">Opened <b>${escapeHtml(isoDate(meta.createdAt))}</b></span>
      <span class="badge">Closed <b>${escapeHtml(isoDate(meta.closedAt))}</b></span>
      <span class="badge">Messages <b>${transcript.messageCount ?? 0}</b></span>
      ${meta.firstResponseMs != null ? `<span class="badge">First reply <b>${escapeHtml(humanMs(meta.firstResponseMs))}</b></span>` : ''}
      ${meta.resolutionTimeMs != null ? `<span class="badge">Open for <b>${escapeHtml(humanMs(meta.resolutionTimeMs))}</b></span>` : ''}
    </div>
  </header>

  ${transcript.truncated ? '<div class="notice">⚠️ This ticket had more messages than the storage limit. The earliest messages are not included.</div>' : ''}

  <div class="grid">
    <div class="card"><h3>Opened by</h3><p>${escapeHtml(meta.openerTag ?? meta.openerId ?? 'Unknown')}</p></div>
    <div class="card"><h3>Roblox</h3><p>${meta.robloxUsername ? escapeHtml(meta.robloxUsername) + ' <span style="color:var(--muted);font-size:12px">(unverified)</span>' : '<span style="color:var(--muted)">not provided</span>'}</p></div>
    <div class="card"><h3>Handled by</h3><p>${escapeHtml(meta.claimedByTag ?? 'Unclaimed')}</p></div>
    <div class="card"><h3>Closed by</h3><p>${escapeHtml(meta.closedByTag ?? '—')}</p></div>
  </div>

  ${renderSummary(transcript, meta)}

  ${renderTimeline(transcript.timeline)}

  ${renderPlayerContext(transcript.playerContext)}

  ${responses ? `<div class="panel"><h2>Form responses</h2>${responses}</div>` : ''}

  <div class="toolbar no-print">
    <div class="search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="q" type="search" placeholder="Search messages…" autocomplete="off" spellcheck="false" aria-label="Search messages">
    </div>
    <button id="pdf" type="button">Download PDF</button>
    <span class="count" id="count"></span>
  </div>

  <div class="panel" style="padding:10px">
    <div id="messages"></div>
  </div>

  <footer>
    Internal support record — ${escapeHtml(meta.guildName ?? "Pizza Guy's Time")}.<br>
    This page is not indexed and is reachable only through its private link. Handle according to your data policy.
  </footer>
</div>

<script id="data" type="application/json">${jsonScript(payload)}</script>
<script>
(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("data").textContent);
  const list = document.getElementById("messages");
  const input = document.getElementById("q");
  const count = document.getElementById("count");

  const fmt = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    // Rendered in the reader's own timezone, which is what they expect when
    // cross-referencing against their Discord client.
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  };

  const IMAGE = /\\.(png|jpe?g|gif|webp|avif)(\\?|$)/i;

  function initialAvatar(name) {
    const el = document.createElement("div");
    el.className = "avatar initial";
    el.setAttribute("aria-hidden", "true");
    el.textContent = (name || "?").trim().charAt(0) || "?";
    return el;
  }

  // Built with DOM APIs, never innerHTML, so message content cannot become
  // markup no matter what it contains.
  function build(m) {
    const row = document.createElement("div");
    row.className = "msg";
    // Searchable text covers the author, the message, attachment filenames and
    // embed text — people look for "that screenshot someone posted" as often as
    // they look for a phrase that was typed.
    row.dataset.text = [
      m.a,
      m.c,
      ...(m.at || []).map((a) => a.n || ""),
      ...(m.em || []).map((e) => (e.t || "") + " " + (e.d || "")),
    ].join(" ").toLowerCase();

    // An <img> with no src renders as a broken-image icon in some browsers, so
    // fall back to an initial instead. Avatar URLs also expire on Discord's CDN,
    // which the onerror handler covers.
    if (m.av) {
      const img = document.createElement("img");
      img.className = "avatar";
      img.alt = "";
      img.loading = "lazy";
      img.src = m.av;
      img.addEventListener("error", () => img.replaceWith(initialAvatar(m.a)));
      row.appendChild(img);
    } else {
      row.appendChild(initialAvatar(m.a));
    }

    const body = document.createElement("div");
    body.className = "body";

    const line = document.createElement("div");
    line.className = "line";

    const author = document.createElement("span");
    author.className = "author" + (m.s ? " staff" : "");
    author.textContent = m.a;
    line.appendChild(author);

    if (m.b) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = "BOT";
      line.appendChild(t);
    } else if (m.s) {
      const t = document.createElement("span");
      t.className = "tag staff";
      t.textContent = "STAFF";
      line.appendChild(t);
    }

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmt(m.t) + (m.e ? " (edited)" : "");
    line.appendChild(time);
    body.appendChild(line);

    const content = document.createElement("div");
    content.className = "content";
    content.textContent = m.c || "";
    body.appendChild(content);

    for (const a of m.at || []) {
      if (IMAGE.test(a.n || "") || (a.ct || "").startsWith("image/")) {
        const pic = document.createElement("img");
        pic.className = "att-img";
        pic.loading = "lazy";
        pic.alt = a.n || "attachment";
        pic.src = a.u;
        body.appendChild(pic);
      }
      const link = document.createElement("a");
      link.className = "att";
      link.href = a.u;
      link.rel = "noopener noreferrer nofollow";
      link.target = "_blank";
      link.textContent = "📎 " + (a.n || "attachment");
      body.appendChild(link);
    }

    for (const e of m.em || []) {
      const box = document.createElement("div");
      box.className = "emb";
      if (e.t) {
        const t = document.createElement("div");
        t.className = "emb-title";
        t.textContent = e.t;
        box.appendChild(t);
      }
      if (e.d) {
        const d = document.createElement("div");
        d.className = "emb-desc";
        d.textContent = e.d;
        box.appendChild(d);
      }
      body.appendChild(box);
    }

    row.appendChild(body);
    return row;
  }

  const rows = data.messages.map((m) => {
    const el = build(m);
    list.appendChild(el);
    return el;
  });

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No messages were recorded in this ticket.";
    list.appendChild(empty);
  }

  const total = rows.length;
  const setCount = (n) => {
    count.textContent = n === total ? total + " messages" : n + " of " + total + " messages";
  };
  setCount(total);

  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (let i = 0; i < rows.length; i++) {
        const match = !q || rows[i].dataset.text.includes(q);
        rows[i].style.display = match ? "" : "none";
        rows[i].classList.toggle("hit", Boolean(q) && match);
        if (match) shown++;
      }
      setCount(shown);
    }, 120);
  });

  // Print-to-PDF rather than a generated file: it keeps this page dependency
  // free, and every browser's "Save as PDF" already produces a good result
  // from the print stylesheet above. Clear the filter first so the export is
  // always the whole conversation, not whatever was being searched.
  document.getElementById("pdf").addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
    setTimeout(() => window.print(), 200);
  });
})();
</script>
</body>
</html>`;
}

const DECISION = {
  accepted: { label: '✅ Accepted', cls: 'ok' },
  denied: { label: '❌ Denied', cls: 'bad' },
  resolved: { label: '✅ Resolved', cls: 'ok' },
  no_action: { label: '⚪ No action', cls: 'muted' },
  pending: { label: '⏳ Pending', cls: 'warn' },
};

/**
 * The summary block — what this ticket was about and how it ended, above the
 * conversation. Most readers only need this part.
 */
function renderSummary(transcript, meta) {
  const decision = DECISION[meta.decision] ?? DECISION.resolved;
  const context = transcript.playerContext ?? {};

  const rows = [
    ['Issue', meta.summary || meta.categoryLabel || meta.category],
    ['Player', meta.openerTag],
    ['Roblox', meta.robloxUsername || null],
    ['Handled by', meta.claimedByTag || 'Unclaimed'],
  ]
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<div class="sum-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
    )
    .join('');

  const reason = meta.closeReason
    ? `<div class="sum-row"><dt>Decision</dt><dd><span class="pill ${decision.cls}">${decision.label}</span>` +
      `<div class="reason">${escapeHtml(meta.closeReason).replaceAll('\n', '<br>')}</div></dd></div>`
    : `<div class="sum-row"><dt>Decision</dt><dd><span class="pill ${decision.cls}">${decision.label}</span></dd></div>`;

  return `<div class="panel summary">
    <h2>Summary</h2>
    <dl class="sum">${rows}${reason}</dl>
  </div>`;
}

function renderTimeline(timeline) {
  if (!timeline?.length) return '';

  const items = timeline
    .map((entry) => {
      const time = new Date(entry.at).toISOString().slice(11, 16);
      return `<li><span class="tl-time">${escapeHtml(time)}</span>
        <span class="tl-label">${escapeHtml(entry.label)}</span>
        ${entry.actor ? `<span class="tl-actor">${escapeHtml(entry.actor)}</span>` : ''}</li>`;
    })
    .join('');

  return `<div class="panel"><h2>Timeline</h2><ul class="timeline">${items}</ul>
    <div class="tl-note">Times are UTC on the day of the ticket.</div></div>`;
}

/**
 * Player context.
 *
 * A snapshot taken when the ticket closed, not a live lookup — which is the
 * point, and the footnote says so. Values that were never captured render as
 * "unknown", never as zero.
 */
function renderPlayerContext(context) {
  if (!context || Object.values(context).every((v) => v == null || (Array.isArray(v) && !v.length))) {
    return '';
  }

  const num = (v, suffix = '') =>
    v == null ? '<span class="unknown">unknown</span>' : escapeHtml(v.toLocaleString() + suffix);

  const playtime =
    context.playtimeMinutes == null
      ? '<span class="unknown">no game data</span>'
      : escapeHtml(
          context.playtimeMinutes >= 60
            ? `${Math.floor(context.playtimeMinutes / 60)}h ${context.playtimeMinutes % 60}m`
            : `${context.playtimeMinutes}m`,
        );

  const cards = [
    ['Roblox ID', context.robloxId ? escapeHtml(context.robloxId) : '<span class="unknown">not linked</span>'],
    ['Account age', context.accountAgeDays == null ? '<span class="unknown">unknown</span>' : `${context.accountAgeDays} days`],
    ['Previous tickets', num(context.previousTickets)],
    ['Active warnings', num(context.activeWarnings)],
    ['Total punishments', num(context.totalPunishments)],
    ['Playtime', playtime],
    ['Level', context.level == null ? '<span class="unknown">—</span>' : num(context.level)],
    ['Robux spent', context.robuxSpent == null ? '<span class="unknown">—</span>' : `R$ ${num(context.robuxSpent)}`],
  ]
    .map(([k, v]) => `<div class="card"><h3>${escapeHtml(k)}</h3><p>${v}</p></div>`)
    .join('');

  const purchases = (context.recentPurchases ?? []).length
    ? `<h2 style="margin-top:18px">Recent purchases</h2>
       <table class="tx"><thead><tr><th>Product</th><th>Robux</th><th>Status</th><th>Date</th><th>Transaction</th></tr></thead><tbody>${context.recentPurchases
         .map(
           (p) => `<tr>
             <td>${escapeHtml(p.productName)}</td>
             <td>${escapeHtml(String(p.robuxAmount ?? 0))}</td>
             <td><span class="pill ${p.status === 'completed' ? 'ok' : p.status === 'failed' ? 'bad' : 'muted'}">${escapeHtml(p.status)}</span></td>
             <td>${escapeHtml(isoDate(p.purchasedAt))}</td>
             <td class="mono">${escapeHtml(String(p.transactionId ?? '').slice(0, 20))}</td>
           </tr>`,
         )
         .join('')}</tbody></table>`
    : '';

  return `<div class="panel">
    <h2>Player context</h2>
    <div class="grid" style="margin-bottom:0">${cards}</div>
    ${purchases}
    <div class="tl-note">Captured when the ticket closed, not looked up now.</div>
  </div>`;
}

/** Error page, styled to match, for expired / revoked / unknown links. */
export function renderError(status, heading, detail) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${status} · Transcript unavailable</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#17181c; color:#e6e7ea; font:15px/1.6 "Segoe UI",system-ui,sans-serif; padding:24px; }
  .box { max-width:460px; text-align:center; background:#1e2025; border:1px solid #2f323a;
    border-radius:12px; padding:36px 28px; }
  .pizza { font-size:40px; }
  h1 { font-size:20px; margin:14px 0 8px; color:${BRAND}; }
  p { color:#9aa0ab; margin:0; }
  code { background:#24262c; padding:2px 6px; border-radius:4px; font-size:13px; }
</style></head>
<body><div class="box">
  <div class="pizza">🍕</div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(detail)}</p>
</div></body></html>`;
}
