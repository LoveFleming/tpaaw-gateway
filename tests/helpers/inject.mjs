/**
 * Zero-dependency in-process HTTP harness (ADR-004, TASK-025).
 *
 * The sandbox forbids `listen` (listen EPERM: 127.0.0.1), so the spawn-real-
 * server + fetch-a-socket style e2e tests cannot run. Node has no socketless
 * HTTP server — `http.Server` dispatch only happens through a real socket — so
 * the only way to exercise a request handler without binding is to import the
 * handler and drive it directly with mock `req`/`res` objects.
 *
 * This module provides exactly that:
 *   - mockReq(opts)  → IncomingMessage-shaped EventEmitter (no socket)
 *   - mockRes()      → ServerResponse-shaped recorder; end() resolves
 *   - call(target, opts) → builds req/res, awaits the handler, returns a result
 *
 * It intentionally does **not** spawn child processes or bind sockets. The only
 * network primitive it touches is monkeypatching `globalThis.fetch` (helper:
 * `withFetch`), used to remove outbound HTTP from a case deterministically.
 *
 * Fidelity notes (kept minimal on purpose):
 *   - req emits "data" chunks then "end" on nextTick, so a handler that attaches
 *     listeners synchronously (as readBody does) never misses a chunk.
 *   - req.destroy() is honoured: it flips `destroyed` and stops further emits
 *     (mirrors a client abort / server-side body-cap abort).
 *   - res.end() resolves the call promise with the buffered status/headers/body.
 */
import { EventEmitter } from "node:events";

/**
 * Build an IncomingMessage-shaped mock.
 *
 * Body sources (pick at most one):
 *   - `body`   : a Buffer/string → emitted as a single "data" chunk
 *   - `chunks` : an array of Buffer/string → emitted as multiple "data" chunks
 *                (lets a test simulate a chunked request with NO Content-Length)
 *   - neither  : an empty body → only "end" is emitted
 *
 * @param {object} [opts]
 * @param {string} [opts.method="GET"]
 * @param {string} [opts.url="/"]
 * @param {object} [opts.headers={}]
 * @param {Buffer|string} [opts.body]
 * @param {Array<Buffer|string>} [opts.chunks]
 * @param {string} [opts.remoteAddress="127.0.0.1"]
 * @param {boolean} [opts.emitError] if true, emit "error" after data (client reset)
 * @returns {EventEmitter & object} mock req
 */
export function mockReq(opts = {}) {
  const {
    method = "GET",
    url = "/",
    headers = {},
    body,
    chunks,
    remoteAddress = "127.0.0.1",
    emitError = false,
  } = opts;

  const req = new EventEmitter();
  // IncomingMessage surface used by the gateway handler / readBody.
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  // Some handlers read req.socket.remoteAddress for per-IP throttling.
  req.socket = { remoteAddress, destroyed: false };
  req.destroyed = false;
  req.complete = false;

  // Normalise the body into a chunk list (empty → no data events).
  const payload =
    chunks !== undefined
      ? chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
      : body !== undefined
        ? [Buffer.isBuffer(body) ? body : Buffer.from(String(body))]
        : [];

  /**
   * Destroy semantics: flip the flags, stop future emits, and (unless silent)
   * emit "error" so handlers that settle on stream error observe the reset.
   * readBody's abort() path calls destroy() *after* it has already settled, so
   * no listeners remain — emitting "error" then is a harmless no-op.
   */
  req.destroy = () => {
    if (req.destroyed) return req;
    req.destroyed = true;
    req.socket.destroyed = true;
    req.emit("close");
    return req;
  };

  // Emit the stream asynchronously so listeners registered synchronously by the
  // handler are attached before any chunk arrives (matches real socket timing).
  process.nextTick(() => {
    if (req.destroyed) return;
    for (const chunk of payload) {
      if (req.destroyed) return;
      req.emit("data", chunk);
    }
    if (req.destroyed) return;
    if (emitError) {
      req.emit("error", new Error("mock client reset"));
      return;
    }
    req.complete = true;
    req.emit("end");
  });

  return req;
}

/**
 * Build a ServerResponse-shaped mock that records everything the handler writes.
 *
 * The returned promise (via `done`) resolves once end() is called. `headersSent`
 * is tracked so writeHead/setHeader behave predictably.
 */
export function mockRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const res = {
    statusCode: null,
    headers: {},
    headersSent: false,
    body: "", // raw string (or Buffer if written as Buffer)
    chunks: [],
    destroyed: false,
    finished: false,
    writableEnded: false,
    _resolve: resolveDone,
    _promise: done,
  };

  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  res.getHeader = (name) => res.headers[String(name).toLowerCase()];
  res.removeHeader = (name) => {
    delete res.headers[String(name).toLowerCase()];
  };
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    res.headersSent = true;
    if (headers && typeof headers === "object") {
      for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v;
    }
    return res;
  };
  res.write = (chunk) => {
    res.chunks.push(chunk);
    res.body += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      res.chunks.push(chunk);
      res.body += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    }
    res.finished = true;
    res.writableEnded = true;
    res._resolve(res);
    return res;
  };
  res.destroy = () => {
    res.destroyed = true;
    res.finished = true;
    res.writableEnded = true;
    res._resolve(res);
    return res;
  };
  // EventEmitter no-ops some handlers may opt into.
  res.on = () => res;
  res.once = () => res;

  return res;
}

/** Parse a recorded body as JSON, or null when it is not valid JSON. */
function tryParse(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Drive a request handler in-process. Does NOT spawn or listen.
 *
 * @param {{ handler: (req: object, res: object) => any } | Function} target
 *   the app object returned by createApp() (uses target.handler), or a bare
 *   handler function (e.g. createUIHandler(deps)).
 * @param {object} [opts] same shape as mockReq opts, plus:
 *   @param {string} [opts.token] convenience → sets `authorization: Bearer <token>`
 * @returns {Promise<{ status: number|null, headers: object, body: string,
 *   data: any, reqDestroyed: boolean, resDestroyed: boolean }>}
 */
export async function call(target, opts = {}) {
  const handler = typeof target === "function" ? target : target.handler;

  const headers = { ...(opts.headers || {}) };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;

  const req = mockReq({ ...opts, headers });
  const res = mockRes();

  await handler(req, res);
  await res._promise; // ensure the response really ended

  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
    data: tryParse(res.body),
    reqDestroyed: req.destroyed,
    resDestroyed: res.destroyed,
  };
}

/**
 * Run `fn` with `globalThis.fetch` replaced by `impl`, restoring the original
 * afterwards. Used to remove outbound HTTP deterministically (e.g. the UI
 * /api/status `stable` probe) without a real fake server or a socket.
 *
 * @template T
 * @param {(...args: any[]) => Promise<any>} impl
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** A fetch impl that always refuses the connection (dead package server). */
export const refusingFetch = () => Promise.reject(new Error("ECONNREFUSED (in-process mock)"));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Temporarily apply env vars around a (possibly async) callback. Only the keys
 * in `env` are touched; anything set to `undefined` is deleted, and every key's
 * previous value is restored afterwards. Keeps env-derived config construction
 * (createConfig reads PAAW_CONFIG / PAAW_ROOT / PAAW_BACKUP_DIR / PAAW_EVENT_LOG)
 * deterministic and leak-free across cases.
 *
 * @template T
 * @param {Record<string, string|undefined>} env
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withEnv(env, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
