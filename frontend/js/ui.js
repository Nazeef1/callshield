// CallShield — shared UI helpers: formatting, toasts, confirm dialog, header status pill, icons.
import { api, ApiError } from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat('en-IN');
export const fmtINR = (n) => (n == null || n === '' || isNaN(Number(n)) ? '' : inrFmt.format(Number(n)));
export const fmtNum = (n) => (n == null || isNaN(Number(n)) ? '—' : numFmt.format(Number(n)));

export function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
export function fmtDateTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

export const ACTIONS = {
  fund_transfer: 'Fund transfer',
  sim_otp_reset: 'SIM / OTP reset',
  limit_change: 'Limit change',
  beneficiary_add: 'Add beneficiary',
};
export const TRIGGERS = { manual: 'Manual', keyword: 'Auto (keyword)', upload: 'Uploaded clip' };

export const DECISIONS = {
  APPROVE: { word: 'APPROVE', tone: 'ok', sub: 'Voice verified — proceed with the request.' },
  STEP_UP: { word: 'STEP UP', tone: 'warn', sub: 'Hold — verify via OTP on the registered device before proceeding.' },
  BLOCK: { word: 'BLOCK', tone: 'danger', sub: 'Do not proceed — likely voice fraud. Request blocked.' },
};
export const decisionMeta = (d) => DECISIONS[d] || { word: d || '—', tone: 'neutral', sub: '' };

/** Normalise the customer's reply stored on an assessment (string or object). */
export function replyOf(a) {
  if (!a) return null;
  const r = a.customer_response;
  if (!r) return null;
  if (typeof r === 'string') return r;
  return r.response || null;
}

// ---------- icons (inline SVG, stroke = currentColor) ----------
const svg = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  shield: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/>'),
  shieldCheck: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
  shieldX: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>'),
  alert: svg('<path d="M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  bell: svg('<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 003.4 0"/>'),
  transfer: svg('<path d="M4 7h13l-3-3M20 17H7l3 3"/>'),
  sim: svg('<path d="M7 3h7l5 5v12a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><rect x="9" y="11" width="6" height="6" rx="1"/>'),
  limit: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  userPlus: svg('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M19 8v6M16 11h6"/>'),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v4"/>'),
  phoneOff: svg('<path d="M10.7 13.3a16 16 0 003.4 2.6l1.3-1.3a2 2 0 012.1-.4c.8.3 1.7.5 2.6.6a2 2 0 011.7 2v3a2 2 0 01-2.2 2A19.8 19.8 0 013 4.2 2 2 0 015 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.6a2 2 0 01-.4 2.1L8.9 9.7"/><path d="M22 2L2 22"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  thumbUp: svg('<path d="M7 10v11H4a1 1 0 01-1-1v-9a1 1 0 011-1h3zM7 10l4-8a3 3 0 013 3v4h5.5a2 2 0 012 2.3l-1.4 8A2 2 0 0118.1 21H7"/>'),
  thumbDown: svg('<path d="M17 14V3h3a1 1 0 011 1v9a1 1 0 01-1 1h-3zM17 14l-4 8a3 3 0 01-3-3v-4H4.5a2 2 0 01-2-2.3l1.4-8A2 2 0 015.9 3H17"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  coins: svg('<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.7-2.7-3-6-3"/>'),
};

// ---------- toasts ----------
let toastHost = null;
export function toast(message, { kind = 'info', title = '', timeout = 4500 } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}${esc(message)}`;
  toastHost.appendChild(el);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 260); };
  el.addEventListener('click', remove);
  if (timeout) setTimeout(remove, timeout);
  return el;
}

const FRIENDLY = {
  insufficient_credits: 'Not enough DetectifAI credits for a live check.',
  audio_too_short: 'The clip is too short — keep the caller talking and try again.',
  upstream_error: 'DetectifAI returned an error.',
  network: 'Cannot reach the CallShield server — is the backend running?',
  timeout: 'The request timed out.',
};
export function showError(err, title = 'Something went wrong') {
  console.error(err);
  const code = err && err.code;
  let msg = (err && err.message) || String(err);
  if (code && FRIENDLY[code] && !msg.toLowerCase().includes(FRIENDLY[code].slice(0, 12).toLowerCase())) {
    msg = `${FRIENDLY[code]} ${code === 'network' || code === 'timeout' ? '' : `(${msg})`}`.trim();
  }
  toast(msg, { kind: 'error', title, timeout: 7000 });
}

// ---------- confirm dialog ----------
export function confirmDialog({ title, body, ok = 'Continue', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<h3>${esc(title)}</h3><p>${body}</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-r="0">${esc(cancel)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-accent'}" data-r="1">${esc(ok)}</button>
      </div>`;
    document.body.appendChild(d);
    let result = false;
    d.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) { result = b.dataset.r === '1'; d.close(); }
    });
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    d.showModal();
    d.querySelector('[data-r="1"]').focus();
  });
}

// ---------- header status (mode pill + credits) ----------
/**
 * Polls /api/status and renders #mode-pill, #credits-val, #checks-left, #mock-banner.
 * Returns { refresh(), get state() }. onChange(state) fires after every refresh.
 */
export function initStatus({ onChange, interval = 20000 } = {}) {
  const pill = $('#mode-pill');
  const val = $('#credits-val');
  const sub = $('#checks-left');
  const banner = $('#mock-banner');
  const box = val ? val.closest('.credits') : null;
  let state = { mode: null, credits: null, health: 'unknown', cost_per_check: 100, reachable: false };
  let inflight = null;

  function render() {
    const { mode, credits, health, cost_per_check, reachable } = state;
    if (pill) {
      pill.className = 'pill';
      if (!reachable) { pill.classList.add('pill-down'); pill.textContent = 'Server offline'; }
      else if (mode === 'mock') { pill.classList.add('pill-mock'); pill.textContent = 'MOCK MODE'; }
      else if (mode === 'live' && health === 'down') { pill.classList.add('pill-down'); pill.textContent = 'LIVE · DetectifAI down'; }
      else if (mode === 'live') { pill.classList.add('pill-live'); pill.textContent = 'LIVE · DetectifAI'; }
      else { pill.textContent = 'Connecting…'; }
      pill.title = reachable ? `Mode: ${mode} · DetectifAI health: ${health}` : 'Cannot reach /api/status';
    }
    if (banner) banner.hidden = !(reachable && mode === 'mock');
    const avail = credits && typeof credits.available === 'number' ? credits.available : null;
    const cost = cost_per_check || 100;
    const unlimited = !!(credits && credits.unlimited);
    if (val) val.textContent = unlimited ? 'Unlimited' : avail == null ? '—' : `${fmtNum(avail)} credits`;
    if (sub) {
      if (unlimited) sub.textContent = 'unlimited plan';
      else if (avail == null) sub.textContent = mode === 'mock' ? 'mock: no credits spent' : 'credits unavailable';
      else sub.textContent = `≈${fmtNum(Math.floor(avail / cost))} checks left`;
    }
    if (box) box.classList.toggle('low', !unlimited && avail != null && avail < cost * 2);
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const s = await api.status();
        state = {
          mode: s.mode,
          credits: s.credits || null,
          health: s.health || 'unknown',
          cost_per_check: s.cost_per_check || 100,
          reachable: true,
        };
      } catch (e) {
        state = { ...state, reachable: false };
      }
      render();
      try { onChange && onChange(state); } catch (e) { console.error(e); }
      inflight = null;
      return state;
    })();
    return inflight;
  }

  render();
  refresh();
  revealAttackNav();
  setInterval(refresh, interval);
  return {
    refresh,
    get state() { return state; },
    /** Apply a fresh balance from a check/enroll response without waiting for the poll. */
    setBalance(balance) {
      if (typeof balance !== 'number') return;
      state = { ...state, credits: { ...(state.credits || {}), available: balance } };
      render();
    },
  };
}

/**
 * Show the "Attack Lab" nav link (#nav-attack, hidden by default) only when the backend says the lab is
 * enabled for this request — i.e. on the presenter's laptop, never through the public tunnel.
 */
let attackNavChecked = false;
export async function revealAttackNav() {
  const link = $('#nav-attack');
  if (!link || attackNavChecked) return;
  attackNavChecked = true;
  try {
    const s = await api.attackStatus(false);
    link.hidden = !(s && s.enabled === true);
  } catch {
    link.hidden = true;
  }
}

export function setSseDot(state) {
  const dot = $('#sse-dot');
  if (!dot) return;
  dot.className = `sse-dot ${state}`;
  dot.title = state === 'open' ? 'Live event stream connected' : 'Event stream reconnecting…';
}

export function randomId(prefix) {
  const r = (crypto && crypto.getRandomValues) ? Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('') : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${r}`;
}

export { ApiError };
