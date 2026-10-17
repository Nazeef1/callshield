// CallShield — shared UI helpers: formatting, decision labels, toasts, icons.
import { ApiError } from './api.js';

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

const DECISIONS = {
  APPROVE: { word: 'Approved', tone: 'ok', sub: 'Voice verified. The request goes ahead.' },
  STEP_UP: { word: 'Step up', tone: 'warn', sub: 'Not conclusive. A human agent verifies the caller.' },
  BLOCK: { word: 'Blocked', tone: 'danger', sub: 'Likely voice fraud. The request is refused.' },
};
export const decisionMeta = (d) => DECISIONS[d] || { word: d || '—', tone: 'neutral', sub: '' };

// ---------- icons (inline SVG, stroke = currentColor) ----------
const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SHIELD = '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/>';
const HANDSET = '<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z"/>';
export const ICONS = {
  shield: svg(SHIELD),
  shieldCheck: svg(`${SHIELD}<path d="M8.5 12l2.5 2.5 4.5-5"/>`),
  shieldX: svg(`${SHIELD}<path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>`),
  alert: svg('<path d="M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  phone: svg(HANDSET),
  phoneOff: svg(`${HANDSET}<path d="M22 2L2 22"/>`),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v4"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>'),
  bell: svg('<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 003.4 0"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  play: svg('<path d="M7 4v16l13-8z"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  wave: svg('<path d="M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h-2"/>'),
  bolt: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>'),
};

// ---------- toasts ----------
let toastHost = null;
export function toast(message, { kind = 'info', title = '', timeout = 4500 } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.id = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}<span>${esc(message)}</span>`;
  toastHost.appendChild(el);
  while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); };
  el.addEventListener('click', remove);
  if (timeout) setTimeout(remove, timeout);
  return el;
}

const FRIENDLY = {
  insufficient_credits: 'Not enough DetectifAI credits.',
  audio_too_short: 'The recording is too short.',
  upstream_error: 'DetectifAI returned an error.',
  network: 'Cannot reach the CallShield server.',
  timeout: 'The request timed out.',
};
export function showError(err, title = 'Something went wrong') {
  console.error(err);
  const code = err && err.code;
  const msg = (code && FRIENDLY[code]) || (err && err.message) || String(err);
  toast(msg, { kind: 'error', title, timeout: 7000 });
}

export function randomId(prefix) {
  const r = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${Date.now().toString(36)}${r}`;
}

export { ApiError };
