/** Duration parsing and time formatting. */

const UNITS = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parses `10m`, `2h30m`, `7d`, `1w` into milliseconds.
 * Returns `null` for anything unparseable — callers decide what that means.
 */
export function parseDuration(input) {
  if (!input) return null;
  const text = String(input).trim().toLowerCase();
  const matches = [...text.matchAll(/(\d+)\s*(s|m|h|d|w)/g)];
  if (!matches.length) return null;

  // Reject trailing junk like "10mfoo" that the regex would otherwise ignore.
  const consumed = matches.reduce((sum, m) => sum + m[0].length, 0);
  if (consumed !== text.replace(/\s/g, '').length) return null;

  return matches.reduce((total, [, amount, unit]) => total + Number(amount) * UNITS[unit], 0);
}

/** `9000000` -> `2h 30m`. Empty string for zero/null. */
export function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  const parts = [];
  let remaining = ms;
  for (const [unit, size] of [
    ['w', UNITS.w],
    ['d', UNITS.d],
    ['h', UNITS.h],
    ['m', UNITS.m],
    ['s', UNITS.s],
  ]) {
    const value = Math.floor(remaining / size);
    if (value > 0) {
      parts.push(`${value}${unit}`);
      remaining -= value * size;
    }
  }
  return parts.slice(0, 2).join(' ');
}

/**
 * Discord timestamp markup. Renders in each viewer's own timezone, which is
 * why we never format dates as text in embeds.
 * Styles: t f R D — see Discord's message formatting docs.
 */
export function timestamp(date, style = 'f') {
  const seconds = Math.floor(new Date(date).getTime() / 1000);
  return `<t:${seconds}:${style}>`;
}

/** Both an absolute date and a relative one — what staff usually want. */
export function fullTimestamp(date) {
  return `${timestamp(date, 'f')} (${timestamp(date, 'R')})`;
}

export function accountAgeDays(createdAt) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / UNITS.d);
}

/** Discord's own hard cap on member timeouts. */
export const MAX_TIMEOUT_MS = 28 * UNITS.d;
