// -----------------------------------------------------------------------------
// The only place that talks to the network: `fetch` with a timeout, the
// module's User-Agent, the key and the token in the Authorization header
// (never in the URL: it would land in logs), and a body read up to a bound,
// never whole. No redirect is followed (the credentials never leave for
// another host). Neither the key nor the token appears in an error.
// -----------------------------------------------------------------------------

import { ERROR_BYTES, HTTP_TIMEOUT, USER_AGENT } from './constants.js';

export class TrelloError extends Error {
  /**
   * `code`: 'unauthorized' (401: the caller decides what it means on its
   * route), 'forbidden' (403), 'not_found' (404), 'bad_request' (400, 422),
   * 'rate_limited' (429), 'server' (5xx), 'http', 'network', 'timeout',
   * 'too_large', 'invalid' (not the expected JSON), and, raised before any
   * request: 'paused', 'budget', 'busy', 'refused', 'not_ready', 'stopped'.
   * `sent`: false when nothing can have reached Trello, true when Trello
   * answered, 'unknown' when the request may have left without an answer.
   * `auth`: on a 401, 'key' or 'token' when Trello's text names it.
   */
  constructor(code, message, { status, retryAfter, sent = false, auth } = {}) {
    super(message);
    this.name = 'TrelloError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.sent = sent;
    this.auth = auth;
  }
}

/** The Authorization header Trello documents for a key and a token. */
export const authorization = (key, token) =>
  `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`;

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent or invalid. */
export function retryAfterMs(value, now) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  if (/^\d{1,9}$/.test(value.trim())) return Number(value.trim()) * 1000;
  if (!/^[A-Za-z]{3}, /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The body as text, refused past `limit` bytes (read in chunks, never whole). */
export async function readBounded(response, limit) {
  const tooLarge = () =>
    new TrelloError('too_large', `The answer is larger than ${limit} bytes`, { sent: true });
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Errors that happen before a request can leave (no connection, no name, TLS). */
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function networkError(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  if (timedOut) {
    return new TrelloError('timeout', 'Trello did not answer in time', { sent: 'unknown' });
  }
  const code = err?.cause?.code ?? err?.code;
  return new TrelloError('network', 'Trello is unreachable (network error)', {
    sent: NOT_SENT.has(code) ? false : 'unknown',
  });
}

/** Trello's plain-text reason of a 401, read to tell the key from the token. */
function authOf(text) {
  if (/invalid key/i.test(text)) return 'key';
  if (/invalid token|expired token|token (?:not found|revoked)/i.test(text)) return 'token';
  return undefined;
}

/**
 * One request. `query` goes in the URL (never a secret, never user text),
 * `json` in the body. Resolves `{ body, date }` (the parsed JSON, the server
 * time of the answer or undefined), throws a TrelloError otherwise. `limit`
 * bounds the body, `timeout` (or `signal`) the whole exchange (body included).
 */
export async function request(
  base,
  method,
  path,
  {
    query,
    json,
    key,
    token,
    limit,
    timeout = HTTP_TIMEOUT,
    signal,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = {},
) {
  const url = `${base}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    Authorization: authorization(key, token),
  };
  // `signal`: the caller's deadline (its own clock); else a timer of ours.
  const init = {
    method,
    headers,
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(timeout),
  };
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    throw networkError(err);
  }
  const { status } = response;
  const served = Date.parse(response.headers?.get?.('date') ?? '');
  const date = Number.isFinite(served) ? served : undefined;
  if (status >= 200 && status < 300) {
    let text;
    try {
      text = await readBounded(response, limit);
    } catch (err) {
      if (err instanceof TrelloError) throw err;
      const e = networkError(err);
      // The answer started: Trello did the work, the body was lost.
      e.sent = 'unknown';
      throw e;
    }
    try {
      return { body: JSON.parse(text), date };
    } catch {
      throw new TrelloError('invalid', 'Trello answered something else than JSON', {
        status,
        sent: 'unknown',
      });
    }
  }
  let text = '';
  try {
    text = await readBounded(response, ERROR_BYTES);
  } catch {
    // An error body too large or cut: its reason stays unknown.
  }
  const opts = { status, sent: true };
  if (status === 401) {
    throw new TrelloError('unauthorized', 'Trello answered 401', { ...opts, auth: authOf(text) });
  }
  if (status === 403) throw new TrelloError('forbidden', 'Trello answered 403', opts);
  if (status === 404) throw new TrelloError('not_found', 'Trello answered 404', opts);
  if (status === 400 || status === 422) {
    throw new TrelloError('bad_request', `Trello answered ${status}`, opts);
  }
  if (status === 429 || status >= 500) {
    throw new TrelloError(status === 429 ? 'rate_limited' : 'server', `Trello answered ${status}`, {
      ...opts,
      retryAfter: retryAfterMs(response.headers?.get?.('retry-after'), date ?? now()),
    });
  }
  throw new TrelloError('http', `Trello answered ${status}`, opts);
}
