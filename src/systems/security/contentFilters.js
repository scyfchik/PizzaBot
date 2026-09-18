/**
 * Content filtering — what a message *says*, rather than how fast it arrives.
 *
 * Kept as pure functions so they can be reasoned about and tested without a
 * Discord client. AntiSpam calls them inside its existing pass, so one message
 * is judged and deleted exactly once no matter how many rules it breaks.
 *
 * A deliberate bias toward false negatives. Over-blocking a Roblox community
 * means deleting children's normal conversation, and nothing erodes trust in a
 * moderation bot faster. Anything genuinely harmful that slips through is still
 * reportable by players through the ticket system.
 */

/**
 * Scam patterns.
 *
 * Each needs at least two independent signals before matching — "free robux"
 * alone is something players say to each other constantly, so it is only a scam
 * when paired with a link or an instruction to claim. Patterns are matched
 * against a normalised copy of the message (see `normalise`) so that
 * `f r e e  r o b u x` and `𝗳𝗿𝗲𝗲 𝗿𝗼𝗯𝘂𝘅` do not sail past.
 */
const SCAM_PATTERNS = [
  {
    name: 'free_robux_link',
    test: (text) => /free\s*robux|robux\s*generator|rbx\s*(gift|free)/.test(text) && hasLink(text),
  },
  {
    name: 'robux_claim_instruction',
    test: (text) =>
      /free\s*robux|robux\s*generator/.test(text) &&
      /claim|verify|redeem|enter\s*your|log\s*in|sign\s*in/.test(text),
  },
  {
    name: 'nitro_gift_scam',
    test: (text) =>
      /(free|gift)\s*(discord\s*)?nitro|nitro\s*(giveaway|gift|free)/.test(text) && hasLink(text),
  },
  {
    name: 'fake_verification',
    test: (text) =>
      /(verify|validate|authenticate)\s*(your)?\s*(account|discord|roblox)/.test(text) &&
      hasSuspiciousLink(text),
  },
  {
    name: 'credential_phish',
    test: (text) =>
      /(enter|type|give)\s*(your)?\s*(password|username\s*and\s*password|account\s*details)/.test(
        text,
      ),
  },
  {
    name: 'steam_style_trade_scam',
    test: (text) => /(free|giving\s*away)\s*(limiteds?|items?|skins?)/.test(text) && hasLink(text),
  },
];

/** Domains that are never legitimate in this context. */
const SUSPICIOUS_TLDS = /\.(tk|ml|ga|cf|gq|xyz|top|click|link|zip|mov)\b/;
const URL_SHORTENERS = /(bit\.ly|tinyurl|goo\.gl|t\.co|is\.gd|cutt\.ly|rb\.gy|shorturl)/;
const IMPERSONATION = /(d[i1l]sc[o0]rd|r[o0]bl[o0]x)[a-z0-9-]*\.(?!com\b|gg\b)[a-z]{2,}/;

function hasLink(text) {
  return /https?:\/\/|www\.|\.[a-z]{2,6}\//.test(text);
}

function hasSuspiciousLink(text) {
  return (
    hasLink(text) &&
    (SUSPICIOUS_TLDS.test(text) || URL_SHORTENERS.test(text) || IMPERSONATION.test(text))
  );
}

/**
 * Fold the tricks people use to dodge a plain string match.
 *
 * Handles: case, Unicode look-alikes and maths-alphanumeric characters, zero
 * width characters, and single-character padding (`f.r.e.e  r o b u x`).
 * This is not a complete defence — nothing is — but it costs one pass and
 * catches the copy-pasted scams that make up nearly all of the real volume.
 */
export function normalise(input) {
  return (
    String(input ?? '')
      .toLowerCase()
      // Decompose accents, and fold bold/italic maths letters to ASCII.
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      // Strip zero-width and bidirectional control characters.
      .replace(/[​-‏‪-‮⁠﻿]/g, '')
      // Common leetspeak.
      .replace(/[0]/g, 'o')
      .replace(/[1|]/g, 'l')
      .replace(/[3]/g, 'e')
      .replace(/[4@]/g, 'a')
      .replace(/[5$]/g, 's')
      .replace(/[7]/g, 't')
      // Collapse separator padding between single letters: "f r e e" -> "free".
      .replace(/(?<=\b\w)[\s._\-*]+(?=\w\b)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * @returns {{ name: string } | null} the first scam pattern matched.
 */
export function detectScam(content) {
  const text = normalise(content);
  if (text.length < 8) return null; // too short to carry two signals

  for (const pattern of SCAM_PATTERNS) {
    if (pattern.test(text)) return { name: pattern.name };
  }
  return null;
}

/**
 * Blacklist match.
 *
 * Matched on word boundaries against the normalised text, so `assassin` does
 * not trip a blacklisted `ass`. Multi-word phrases are matched literally.
 * Returns the matched term so the log says which one fired — a blacklist nobody
 * can debug gets switched off within a week.
 */
export function detectBlacklisted(content, blacklist) {
  if (!blacklist?.length) return null;
  const text = normalise(content);

  for (const rawTerm of blacklist) {
    const term = normalise(rawTerm);
    if (!term) continue;

    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, 'u');
    if (pattern.test(text)) return { term: rawTerm };
  }
  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
