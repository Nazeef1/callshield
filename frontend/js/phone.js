// CallShield — simulated customer phone / bank-app push channel (phone.html)
import { api, connectEvents } from './api.js';
import { $, esc, fmtINR, fmtTime, ICONS, replyOf, toast, showError, initStatus, setSseDot } from './ui.js';

const params = new URLSearchParams(location.search);
const filter = (params.get('customer') || '').trim() || null;

const alerts = new Map(); // check_id -> alert
let activeId = null;
let audioCtx = null;
let pushTimer = null;

// ---------------------------------------------------------------- helpers
// "Fund transfer" -> "fund transfer", but keep acronyms like "SIM/OTP reset"
const lowerLabel = (l) => (!l ? 'request' : /^[A-Z][a-z]/.test(l) ? l[0].toLowerCase() + l.slice(1) : l);

function toAlert(a) {
  // Assessment -> alert shape used by SSE `alert` events
  return {
    check_id: a.check_id,
    customer_id: a.customer_id,
    customer_name: a.customer_name,
    action_label: a.action_label,
    amount: a.action === 'fund_transfer' ? a.amount : (a.amount || null),
    decision: a.risk && a.risk.decision,
    message: a.alert && a.alert.message,
    created_at: a.created_at,
    mode: a.mode,
    response: replyOf(a),
  };
}

function headline(al) {
  const what = `${al.amount ? fmtINR(al.amount) + ' ' : ''}${lowerLabel(al.action_label)}`;
  return al.decision === 'BLOCK' ? `Blocked: ${what}` : `Confirm: ${what} request`;
}

function fallbackMessage(al) {
  const what = `${al.amount ? fmtINR(al.amount) + ' ' : ''}${lowerLabel(al.action_label)}`;
  return al.decision === 'BLOCK'
    ? `CallShield blocked a ${what} requested on a call claiming to be you. If this wasn't you, no action is needed — your money is safe.`
    : `A call claiming to be you asked for a ${what}. Confirm in the app if this was you.`;
}

const matchesFilter = (al) => !filter || al.customer_id === filter;

// ---------------------------------------------------------------- sound / vibration
function unlockSound() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const b = $('#btn-sound');
    b.textContent = 'Sound & vibration on';
    b.disabled = true;
  } catch (e) { console.warn(e); }
}

function beep(urgent) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const notes = urgent ? [[880, 0], [660, 0.18], [880, 0.36], [660, 0.54]] : [[740, 0], [988, 0.16]];
  const t0 = audioCtx.currentTime + 0.02;
  for (const [f, dt] of notes) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.15);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.17);
  }
}

function buzz(urgent) {
  try { if (navigator.vibrate) navigator.vibrate(urgent ? [220, 120, 220, 120, 400] : [200, 100, 200]); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- rendering
function showPush(al) {
  const p = $('#push');
  $('#push-icon').innerHTML = al.decision === 'BLOCK' ? ICONS.shieldX : ICONS.alert;
  $('#push-title').textContent = headline(al) + (al.mode === 'mock' ? ' (MOCK)' : '');
  $('#push-text').textContent = al.message || fallbackMessage(al);
  p.classList.remove('show');
  void p.offsetWidth;
  p.classList.add('show');
  p.onclick = () => { p.classList.remove('show'); openAlert(al.check_id); };
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => p.classList.remove('show'), 6000);
}

function openAlert(id) {
  activeId = id;
  renderAlert();
  renderHistory();
  $('#phone-body').scrollTop = 0;
}

function renderAlert() {
  const view = $('#alert-view');
  const al = activeId && alerts.get(activeId);
  $('#idle').hidden = !!al;
  view.hidden = !al;
  if (!al) { view.innerHTML = ''; return; }
  const block = al.decision === 'BLOCK';
  const tone = block ? 'danger' : 'warn';
  const title = block ? 'We blocked a suspicious request' : 'Was this you?';
  const amount = al.amount ? `<div class="alert-amount">${esc(fmtINR(al.amount))}</div>` : '';
  let actions;
  if (al.response === 'not_me') {
    actions = `<div class="alert-done not_me">${ICONS.shieldX}<span><b>Fraud reported.</b> The request was stopped and the bank's fraud team has been notified. Never share your OTP or PIN on a call.</span></div>`;
  } else if (al.response === 'me') {
    actions = `<div class="alert-done me">${ICONS.shieldCheck}<span><b>Thanks for confirming.</b> The agent will complete additional verification before proceeding.</span></div>`;
  } else {
    actions = `<div class="alert-actions">
        <button type="button" class="btn btn-danger" data-resp="not_me">Not me — report fraud</button>
        <button type="button" class="btn" data-resp="me">This was me</button>
      </div>`;
  }
  view.innerHTML = `
    <div class="alert-card tone-${tone}">
      <div class="alert-icon">${block ? ICONS.shieldX : ICONS.alert}</div>
      <h2>${esc(title)}</h2>
      ${amount}
      <div class="alert-what">${esc(al.action_label || 'High-risk request')} · on a support call claiming to be ${esc(al.customer_name || 'you')}</div>
      <p class="alert-msg">${esc(al.message || fallbackMessage(al))}</p>
      <div class="alert-meta">
        <span class="chip ${tone}">${block ? 'Blocked' : 'Step-up'}</span>
        <span>${esc(fmtTime(al.created_at))}</span>
        ${al.mode === 'mock' ? '<span class="badge badge-mock">Mock</span>' : ''}
      </div>
      ${actions}
    </div>
    ${al.response ? '<button type="button" class="btn btn-ghost btn-sm" id="btn-home" style="align-self:center">Done</button>' : ''}`;
  view.querySelectorAll('[data-resp]').forEach((b) => b.addEventListener('click', () => respond(al, b.dataset.resp)));
  const home = view.querySelector('#btn-home');
  if (home) home.addEventListener('click', () => { activeId = null; renderAlert(); renderHistory(); });
}

function renderHistory() {
  const list = [...alerts.values()].filter(matchesFilter)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .filter((a) => a.check_id !== activeId)
    .slice(0, 8);
  $('#history').hidden = list.length === 0;
  $('#history-list').innerHTML = list.map((al) => {
    const tone = al.decision === 'BLOCK' ? 'danger' : 'warn';
    const reply = al.response === 'not_me' ? '<span class="reply not_me">Not me</span>'
      : al.response === 'me' ? '<span class="reply me">Me</span>'
        : `<span class="chip ${tone}">${al.decision === 'BLOCK' ? 'Blocked' : 'Confirm'}</span>`;
    return `<li data-id="${esc(al.check_id)}"><div class="h-main"><b>${esc(headline(al))}</b><small>${esc(fmtTime(al.created_at))}${al.mode === 'mock' ? ' · MOCK' : ''}</small></div>${reply}</li>`;
  }).join('');
}

async function respond(al, response) {
  const view = $('#alert-view');
  view.querySelectorAll('[data-resp]').forEach((b) => { b.disabled = true; });
  try {
    await api.respond(al.check_id, response);
    al.response = response;
    renderAlert();
    renderHistory();
  } catch (e) {
    showError(e, 'Could not send your reply');
    view.querySelectorAll('[data-resp]').forEach((b) => { b.disabled = false; });
  }
}

// ---------------------------------------------------------------- events
function onAlert(data) {
  if (!data || !data.check_id) return;
  const al = { ...data, response: data.response || null };
  if (!matchesFilter(al)) return;
  if (!al.decision || al.decision === 'APPROVE') return;
  alerts.set(al.check_id, al);
  const urgent = al.decision === 'BLOCK';
  showPush(al);
  beep(urgent);
  buzz(urgent);
  openAlert(al.check_id);
}

function onCustomerResponse(r) {
  if (!r || !r.check_id) return;
  const al = alerts.get(r.check_id);
  if (!al || al.response === r.response) return;
  al.response = r.response;
  if (activeId === r.check_id) renderAlert();
  renderHistory();
}

async function loadHistory() {
  try {
    const res = await api.assessments(30);
    for (const a of (res && res.assessments) || []) {
      if (!a.alert || !a.alert.sent) continue;
      const al = toAlert(a);
      if (matchesFilter(al) && !alerts.has(al.check_id)) alerts.set(al.check_id, al);
    }
    renderHistory();
  } catch (e) {
    if (e.code !== 'network') console.warn('history load failed', e);
  }
}

async function loadWho() {
  const chip = $('#who-chip');
  if (!filter) { chip.innerHTML = 'Showing alerts for <b>all customers</b> (demo)'; return; }
  chip.innerHTML = `Registered device of <b>${esc(filter)}</b>`;
  try {
    const res = await api.customers();
    const c = ((res && res.customers) || []).find((x) => x.customer_id === filter);
    if (c) chip.innerHTML = `Registered device of <b>${esc(c.display_name || c.customer_id)}</b>${c.phone_last4 ? ` · ••${esc(c.phone_last4)}` : ''}`;
  } catch { /* keep id */ }
}

function clock() {
  const d = new Date();
  $('#sb-time').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function main() {
  $('#idle-shield').innerHTML = ICONS.shieldCheck;
  $('#this-url').textContent = location.href;
  clock();
  setInterval(clock, 10000);
  $('#btn-sound').addEventListener('click', unlockSound);
  document.addEventListener('pointerdown', () => { if (!audioCtx) unlockSound(); }, { once: true });
  $('#history-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) openAlert(li.dataset.id);
  });
  initStatus({});
  loadWho();
  loadHistory();
  connectEvents({ alert: onAlert, customer_response: onCustomerResponse }, {
    onState: (s) => {
      setSseDot(s);
      $('#conn-text').textContent = s === 'open' ? 'secure link' : 'reconnecting…';
    },
    onReconnect: loadHistory,
  });
  if (!('EventSource' in window)) toast('This browser cannot receive live alerts.', { kind: 'error', timeout: 0 });
}

main();
