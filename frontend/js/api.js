// CallShield — fetch wrappers + SSE helper for the backend API defined in CONTRACT.md.
// All URLs are same-origin and relative to the site root.

export class ApiError extends Error {
  constructor(message, { code = 'error', status = 0, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

// Pull {code, message} out of whatever error shape the server returned:
//   {"error": {"code", "message"}}            (contract)
//   {"detail": {"error": {...}}}               (FastAPI HTTPException(detail={...}))
//   {"detail": "text"} / {"detail": [{msg}]}   (FastAPI defaults / validation errors)
function extractError(body, res) {
  if (body && typeof body === 'object') {
    let e = body.error;
    if (!e && body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail)) {
      e = body.detail.error || body.detail;
    }
    if (e && typeof e === 'object' && (e.message || e.code)) {
      return { code: e.code || e.type || `http_${res.status}`, message: e.message || e.code };
    }
    if (typeof e === 'string') return { code: `http_${res.status}`, message: e };
    if (typeof body.detail === 'string') return { code: `http_${res.status}`, message: body.detail };
    if (Array.isArray(body.detail)) {
      const msg = body.detail.map((d) => `${(d.loc || []).slice(1).join('.') || 'request'}: ${d.msg}`).join('; ');
      return { code: 'validation_error', message: msg || 'Invalid request' };
    }
  }
  return { code: `http_${res.status}`, message: `HTTP ${res.status} ${res.statusText || ''}`.trim() };
}

async function request(method, url, { json, form, timeout = 60000 } = {}) {
  const opts = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form; // browser sets the multipart boundary
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  opts.signal = ctrl.signal;

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new ApiError('The request timed out', { code: 'timeout' });
    throw new ApiError('Cannot reach the CallShield server', { code: 'network' });
  }
  let text = '';
  try {
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  const hasErrorObj = body && typeof body === 'object' && body.error && typeof body.error === 'object';
  if (!res.ok || hasErrorObj) {
    const { code, message } = extractError(body, res);
    throw new ApiError(message, { code, status: res.status, body });
  }
  return body;
}

export const api = {
  status: () => request('GET', '/api/status', { timeout: 15000 }),
  customers: () => request('GET', '/api/customers', { timeout: 15000 }),
  /** form: FormData with file, customer_id, display_name, phone_last4 */
  enroll: (form) => request('POST', '/api/enroll', { form, timeout: 120000 }),
  /** form: FormData with file, customer_id, action, amount, call_id, trigger, transcript, mock_scenario */
  check: (form) => request('POST', '/api/check', { form, timeout: 120000 }),
  assessments: (limit = 50) => request('GET', `/api/assessments?limit=${encodeURIComponent(limit)}`, { timeout: 15000 }),
  respond: (checkId, response) =>
    request('POST', `/api/alerts/${encodeURIComponent(checkId)}/respond`, { json: { response } }),
  feedback: (operation_id, correct) => request('POST', '/api/feedback', { json: { operation_id, correct } }),
  /** Attack Lab (laptop-only). probe=false skips the cloner health probe (used for the nav link). */
  attackStatus: (probe = true) => request('GET', `/api/attack/status${probe ? '' : '?probe=0'}`, { timeout: 10000 }),
  attackWarmup: () => request('POST', '/api/attack/warmup', { timeout: 200000 }),
  /** form: FormData with reference, text, engine, language, consent=true -> { blob, engine, model, genMs } */
  async attackClone(form, { timeout = 200000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch('/api/attack/clone', { method: 'POST', body: form, cache: 'no-store', signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new ApiError('Cloning timed out', { code: 'timeout' });
      throw new ApiError('Cannot reach the CallShield server', { code: 'network' });
    }
    try {
      const ctype = (res.headers.get('Content-Type') || '').toLowerCase();
      if (!res.ok || ctype.includes('json')) {
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        const { code, message } = extractError(body, res);
        throw new ApiError(message, { code, status: res.status, body });
      }
      const blob = await res.blob();
      const gen = Number(res.headers.get('X-Gen-Ms'));
      return {
        blob: blob.type ? blob : new Blob([blob], { type: 'audio/wav' }),
        engine: res.headers.get('X-Engine') || null,
        model: res.headers.get('X-Model') || null,
        genMs: Number.isFinite(gen) && gen > 0 ? gen : null,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Subscribe to /api/events (SSE). handlers = { assessment(data), alert(data), customer_response(data) }.
 * onState(state) receives 'connecting' | 'open' | 'reconnecting'. Reconnects with backoff if the
 * browser gives up (EventSource already retries transient drops on its own).
 */
export function connectEvents(handlers, { onState, onReconnect } = {}) {
  let es = null;
  let closed = false;
  let retry = 1000;
  let timer = null;
  let everOpened = false;
  let wasDown = false;

  const setState = (s) => { try { onState && onState(s); } catch (e) { console.error(e); } };

  function open() {
    if (closed) return;
    setState(everOpened ? 'reconnecting' : 'connecting');
    es = new EventSource('/api/events');
    es.onopen = () => {
      retry = 1000;
      setState('open');
      if (everOpened && wasDown && onReconnect) {
        try { onReconnect(); } catch (e) { console.error(e); }
      }
      everOpened = true;
      wasDown = false;
    };
    es.onerror = () => {
      if (closed) return;
      wasDown = true;
      if (es.readyState === EventSource.CLOSED) {
        setState('reconnecting');
        es.close();
        clearTimeout(timer);
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 15000);
      } else {
        setState('reconnecting');
      }
    };
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, (ev) => {
        let data = ev.data;
        try { data = JSON.parse(ev.data); } catch { /* keep raw */ }
        try { fn(data, ev); } catch (e) { console.error(`SSE ${name} handler failed`, e); }
      });
    }
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      if (es) es.close();
    },
  };
}
