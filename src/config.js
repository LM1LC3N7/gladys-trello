// -----------------------------------------------------------------------------
// The configuration form (manifest config_schema), normalized and checked, and
// the 8-bit tag of refused credentials (the only trace of them in /data).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  BOUNDS,
  CONFIG_BOARDS,
  CONFIG_KEY,
  CONFIG_POLL,
  CONFIG_SOON,
  CONFIG_TOKEN,
  CONFIG_TZ,
  DEFAULT_TZ,
  DEFAULTS,
  MAX_BOARDS,
  NAME_MAX,
} from './constants.js';

/** A Trello API key: 32 hexadecimal characters. */
const KEY = /^[0-9a-f]{32}$/i;
/** A Trello token: letters and digits only ("ATTA" + 64 hex today, 64 hex before). */
const TOKEN = /^[A-Za-z0-9]{32,256}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function number(raw, key) {
  const [min, max] = BOUNDS[key];
  if (raw === '' || raw === null || raw === undefined) return DEFAULTS[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return DEFAULTS[key];
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** An IANA time zone Node knows, else the default. */
export function timeZoneOf(raw) {
  const zone = typeof raw === 'string' ? raw.trim() : '';
  if (!zone || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return DEFAULT_TZ;
  try {
    // Kept as typed once Node knows it (America/Montreal stays itself).
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TZ;
  }
}

/** "Home, Work" -> ['Home', 'Work'] (at most MAX_BOARDS, duplicates dropped, case ignored). */
export function boardRefs(raw) {
  if (typeof raw !== 'string') return { refs: [], tooMany: false };
  const refs = [];
  const seen = new Set();
  let tooMany = false;
  for (const part of raw.split(/[,\n;]/)) {
    const ref = part.replace(/\s+/g, ' ').trim();
    if (!ref || CONTROL.test(ref) || ref.length > NAME_MAX) continue;
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    if (refs.length >= MAX_BOARDS) {
      tooMany = true;
      break;
    }
    seen.add(key);
    refs.push(ref);
  }
  return { refs, tooMany };
}

/**
 * `{ key, token, problem, refs, tooMany, pollMinutes, soonHours, timeZone }`. `problem`:
 * 'missing' (key or token empty), 'bad_key', 'bad_token': nothing is sent.
 */
export function normalizeConfig(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const key = text(value[CONFIG_KEY]);
  // A token pasted with its "token=" prefix (from the authorize page URL) still reads.
  const token = text(value[CONFIG_TOKEN]).replace(/^token=/i, '');
  const { refs, tooMany } = boardRefs(value[CONFIG_BOARDS]);
  let problem;
  if (!key || !token) problem = 'missing';
  else if (!KEY.test(key)) problem = 'bad_key';
  else if (!TOKEN.test(token)) problem = 'bad_token';
  return {
    key: problem ? '' : key,
    token: problem ? '' : token,
    problem,
    refs,
    tooMany,
    pollMinutes: number(value[CONFIG_POLL], CONFIG_POLL),
    soonHours: number(value[CONFIG_SOON], CONFIG_SOON),
    timeZone: timeZoneOf(value[CONFIG_TZ]),
  };
}

/** The credentials as one string (memory only, never written). */
export const credentialsOf = (config) => `${config.key}\u0000${config.token}`;

/**
 * 8 bits of a salted SHA-256 of refused credentials: enough to know after a
 * restart that the same ones are still configured (1 chance in 256 of taking
 * new ones for them, lifted by the test button), far too little to find them.
 */
export const tagOf = (salt, credentials) =>
  createHash('sha256').update(`${salt}\u0000${credentials}`, 'utf8').digest()[0];

/** A refusal read back from /data: `{ salt, tag, kind }`, or undefined. */
export function validRefused(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(value.salt) &&
    Number.isInteger(value.tag) &&
    value.tag >= 0 &&
    value.tag < 256
    ? { salt: value.salt, tag: value.tag, kind: value.kind === 'key' ? 'key' : 'token' }
    : undefined;
}
