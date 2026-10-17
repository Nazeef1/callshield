// CallShield Bank — the customer's phone app (app.html, hosted in the Android app's WebView).
// Set up who you are -> enroll your voice (recorded in the app) -> call the bank. Alerts tell the customer when
// a call made in their name was blocked or stepped up, and their answer goes back to the bank.
import { api, connectEvents } from './api.js';
import { callSocket, PeerLink, playStream, callCodecLoopback } from './call.js';
import { MicCapture, encodeWav, estimateSpeechSeconds, dropDigitalSilence, SAMPLE_RATE } from './audio.js';
import { $, $$, esc, fmtINR, fmtDateTime, toast, showError, ICONS } from './ui.js';

const ENROLL_TARGET_SECONDS = 22;   // this much audio once digital silence is removed (DetectifAI needs 15-60 s)...
const ENROLL_MIN_SPEECH = 14;       // ...of which at least this much speech (DetectifAI needs >= 10 s)
const ENROLL_MAX_SECONDS = 58;      // stop recording here and try with what we have

// Keep the raw voice: echo cancellation only (noise suppression / AGC smear what the deepfake check looks for).
const MIC = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } };

const ID_KEY = 'cs.app.identity';
const ENROLLED_KEY = 'cs.app.enrolled';   // customer_id last seen enrolled (first paint before the server answers)
const SCREENS = ['welcome', 'account', 'enroll', 'record', 'home', 'call'];

let identity = null;        // { customer_id, display_name, phone_last4 }
let enrolled = false;
let sock = null;
let link = null;
let micStream = null;
let remoteEl = null;
let state = 'idle';         // idle | ringing | connecting | on_call
let startedAt = 0;
let bankState = null;       // last `state` the bank sent during this call
let script = [];
let passphrase = '';        // from /voice/agent/prompts.json

// ---------------------------------------------------------------- identity + screens
function loadIdentity() {
  try { identity = JSON.parse(localStorage.getItem(ID_KEY) || 'null'); } catch { identity = null; }
}
function saveIdentity() {
  try { localStorage.setItem(ID_KEY, JSON.stringify(identity)); } catch { /* storage blocked */ }
}
function setEnrolled(v) {
  enrolled = v;
  try { localStorage.setItem(ENROLLED_KEY, v && identity ? identity.customer_id : ''); } catch { /* storage blocked */ }
}

function show(screen) {
  if (document.body.dataset.screen !== screen) window.scrollTo(0, 0);
  for (const s of SCREENS) $(`#scr-${s}`).hidden = s !== screen;
  document.body.dataset.screen = screen;
  $('#btn-bell').hidden = screen !== 'home';
}

function homeScreen() {
  if (state !== 'idle') { show('call'); return; }
  if (!identity) { show('welcome'); return; }
  if (!enrolled) { openEnroll(); return; }
  $('#home-name').textContent = identity.display_name;
  $('#pass-card').hidden = !passphrase;
  $('#home-pass').textContent = `“${passphrase}”`;
  renderAlerts();
  show('home');
}

async function refreshEnrolled() {
  if (!identity) { enrolled = false; return; }
  try {
    const res = await api.customers();
    if (identity) setEnrolled(((res && res.customers) || []).some((x) => x.customer_id === identity.customer_id));
  } catch { /* keep the last known state */ }
}

function onSetup(ev) {
  ev.preventDefault();
  const name = $('#in-name').value.trim();
  const last4 = $('#in-last4').value.trim();
  if (!name) { $('#setup-error').textContent = 'Enter your name.'; return; }
  if (!/^\d{4}$/.test(last4)) { $('#setup-error').textContent = 'Enter exactly 4 digits.'; return; }
  $('#setup-error').textContent = '';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'customer';
  identity = { customer_id: `cust-${slug}-${last4}`, display_name: name, phone_last4: last4 };
  saveIdentity();
  alerts.clear();
  refreshEnrolled().then(() => { homeScreen(); loadAlerts(); });
}

function switchAccount() {
  try { localStorage.removeItem(ID_KEY); } catch { /* ignore */ }
  identity = null;
  enrolled = false;
  alerts.clear();
  renderAlerts();
  $('#in-name').value = '';
  $('#in-last4').value = '';
  show('account');
}

// ---------------------------------------------------------------- enrollment (in the app, no call)
let enrolling = null;   // { mic, cancelled, live, cleanup }
let promptEl = null;

/** Play one of the bank assistant's prompts on the phone. Resolves when it ends. */
function playPrompt(id) {
  return new Promise((resolve) => {
    const el = new Audio(`/voice/agent/${id}.mp3`);
    promptEl = el;
    const done = () => { if (promptEl === el) promptEl = null; resolve(); };
    el.onended = done;
    el.onerror = done;
    el.play().catch(done);
  });
}

function openEnroll(error = '') {
  $('#enroll-step').hidden = enrolled;
  $('#enroll-title').textContent = enrolled ? 'Re-enroll your voice' : 'Enroll your voice';
  $('#btn-enroll-back').textContent = enrolled ? 'Not now' : 'Change account details';
  $('#enroll-error').textContent = error;
  show('enroll');
}

/** Recording screen status: dot = '' | 'on' | 'busy' | 'ok'. */
function setRec(dot, status, hint = '') {
  $('#rec-dot').className = `rec-dot ${dot}`;
  $('#rec-status').textContent = status;
  $('#rec-hint').textContent = hint;
  $('#rec-script').classList.toggle('live', dot === 'on');
}

function setLevel(el, v) { el.style.setProperty('--lvl', v.toFixed(2)); }

async function enrollFlow() {
  if (enrolling || state !== 'idle') return;
  const run = { mic: new MicCapture({ ringSeconds: 60 }), cancelled: false, live: false, cleanup: () => {} };
  enrolling = run;
  $('#rec-script').innerHTML = script.length
    ? script.map((l) => `<p>${esc(l)}</p>`).join('')
    : '<p>Tell us about your day, at your normal pace, until the assistant says thank you.</p>';
  $('#rec-fill').style.width = '0%';
  $('#rec-progress').textContent = '';
  $('#btn-rec-cancel').disabled = false;
  setRec('', 'Getting ready', 'Listen to the assistant');
  show('record');
  try {
    // Record what the bank will hear on a call: same mic settings, then through the call's WebRTC (Opus)
    // encode/decode, captured the same way the receive screen captures a caller.
    const raw = await navigator.mediaDevices.getUserMedia(MIC);
    let source = raw;
    let loop = null;
    try {
      loop = await callCodecLoopback(raw);
      source = loop.stream;
    } catch (e) {
      console.warn('call codec loopback unavailable; recording the mic directly', e);
    }
    const sink = loop ? playStream(source) : null;  // Chrome reads a WebRTC track only while it's attached
    if (sink) sink.muted = true;
    run.cleanup = () => {
      run.live = false;
      if (sink) sink.srcObject = null;
      if (loop) loop.close();
      raw.getTracks().forEach((t) => t.stop());
    };
    await run.mic.start({ stream: source });
    run.live = true;
  } catch (e) {
    run.cleanup();
    enrolling = null;
    toast(`Microphone blocked (${e.name || e.message}). Allow it and try again.`, { kind: 'error', title: 'No microphone' });
    homeScreen();
    return;
  }
  const lvl = $('#rec-lvl');
  const meter = () => {
    if (!run.live || run.cancelled) { setLevel(lvl, 0); return; }
    setLevel(lvl, Math.max(0, (run.mic.meterLevel - 0.3) / 0.7));
    requestAnimationFrame(meter);
  };
  requestAnimationFrame(meter);

  setRec('', 'Listen to the assistant', 'Recording starts when it finishes');
  await playPrompt('enroll_welcome');
  if (run.cancelled) return;

  setRec('on', 'Recording', 'Read the text below aloud, at your normal pace');
  run.mic.startRecording();
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    if (run.cancelled) return;
    const secs = run.mic.recordedSeconds;
    const voice = dropDigitalSilence(run.mic.getLast(Math.min(secs, 59)), SAMPLE_RATE);
    const voiceSecs = voice.length / SAMPLE_RATE;
    const speech = estimateSpeechSeconds(voice, SAMPLE_RATE);
    const done = Math.min(voiceSecs / ENROLL_TARGET_SECONDS, speech / ENROLL_MIN_SPEECH);
    $('#rec-fill').style.width = `${Math.min(100, done * 100)}%`;
    $('#rec-progress').textContent = `${Math.min(99, Math.floor(done * 100))}%`;
    if (secs >= 12 && speech < 4) setRec('on', 'Recording', 'Keep reading the text below aloud');
    if ((voiceSecs >= ENROLL_TARGET_SECONDS && speech >= ENROLL_MIN_SPEECH) || secs >= ENROLL_MAX_SECONDS) break;
  }
  // Same clean-up as the call audio it will be compared with: digital silence out, natural pauses kept.
  const samples = dropDigitalSilence(run.mic.stopRecording(), SAMPLE_RATE);
  run.mic.stop();
  run.cleanup();
  setRec('busy', 'Saving your voice', 'Thank you. This takes a few seconds');
  $('#rec-fill').style.width = '100%';
  $('#rec-progress').textContent = '100%';

  const fd = new FormData();
  fd.append('file', encodeWav(samples, SAMPLE_RATE), 'enroll.wav');
  fd.append('customer_id', identity.customer_id);
  fd.append('display_name', identity.display_name);
  fd.append('phone_last4', identity.phone_last4);
  let ok = false;
  let error = '';
  try {
    const [res] = await Promise.all([api.enroll(fd), playPrompt('enroll_hold')]);
    ok = !!(res && res.ok);
  } catch (e) {
    error = e.message;
  }
  if (run.cancelled) return;
  enrolling = null;
  $('#btn-rec-cancel').disabled = true;
  if (ok) {
    setEnrolled(true);
    setRec('ok', 'Your voice is enrolled', 'You can now call the bank');
    await playPrompt('enroll_done');
    homeScreen();
  } else {
    setRec('', 'Could not save your voice', error);
    await playPrompt('enroll_failed');
    openEnroll(`We couldn't save your voice${error ? ` (${error})` : ''}. Please try again.`);
  }
}

function cancelEnroll() {
  if (!enrolling) return;
  enrolling.cancelled = true;
  enrolling.mic.stop();
  enrolling.cleanup();
  enrolling = null;
  if (promptEl) { promptEl.pause(); promptEl = null; }
  homeScreen();
}

// ---------------------------------------------------------------- calls
// What the phone shows for each `state` the bank's virtual agent reports.
const BANK_STATES = {
  greeting: { status: 'Connected', caption: 'The assistant is greeting you' },
  listening_request: {
    status: 'Tell the assistant what you need',
    caption: 'Transfer money, reset your SIM or OTP, change a limit or add a beneficiary',
  },
  listening_passphrase: { status: 'Say your passphrase', tone: 'accent', pass: true },
  verifying: { status: 'Verifying your voice…', caption: 'This takes a few seconds', busy: true },
  approved: { status: 'Voice verified', caption: 'Your request is approved', tone: 'ok', icon: 'shieldCheck', final: true },
  blocked: { status: 'Request blocked', caption: 'We could not verify your voice', tone: 'danger', icon: 'shieldX', final: true },
  human: { status: 'Connected to a bank officer', caption: 'An officer will help you from here', tone: 'accent', icon: 'user' },
};

function setCall({ status, caption = '', tone = '', icon = '', busy = false, pass = false }) {
  $('#call-status').textContent = status;
  $('#call-status').className = `call-status ${tone}`;
  $('#call-caption').textContent = caption;
  const ic = $('#call-icon');
  ic.className = `call-icon ${tone}`;
  ic.innerHTML = busy ? '<div class="call-busy"></div>' : icon ? ICONS[icon] : '';
  $('#call-pass').hidden = !(pass && passphrase);
}

function onBankState(msg) {
  if (state === 'idle') return;
  const meta = BANK_STATES[msg.state];
  bankState = msg.state;
  if (!meta) { if (msg.text) setCall({ status: msg.text }); return; }
  setCall({ ...meta, caption: msg.text || meta.caption || '' });
}

async function dial() {
  if (state !== 'idle' || !sock || !sock.isOpen) {
    toast('Not connected to the bank yet. Check your internet connection and try again.', { kind: 'warn' });
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia(MIC);
  } catch (e) {
    toast(`Microphone blocked (${e.name || e.message}). Allow it and try again.`, { kind: 'error', title: 'No microphone' });
    return;
  }
  state = 'ringing';
  bankState = null;
  $('#call-timer').textContent = '';
  $('#btn-hangup').disabled = false;
  $('#call-avatar').classList.add('ringing');
  setCall({ status: 'Calling…' });
  show('call');
  sock.send({ type: 'dial', ...identity });
}

function onMessage(msg) {
  switch (msg.type) {
    case 'ringing': if (state === 'ringing') setCall({ status: 'Ringing…' }); break;
    case 'no_agent': endLocal({ status: 'The bank is not answering', caption: 'No one is online right now. Try again in a moment.' }); break;
    case 'declined': endLocal({ status: 'The bank declined the call' }); break;
    case 'accepted': onAccepted(); break;
    case 'signal': if (link) link.handleSignal(msg.data).catch((e) => console.error(e)); break;
    case 'state': onBankState(msg); break;
    case 'hangup': endLocal({ status: 'Call ended', caption: 'The bank ended the call' }); break;
    default: break;
  }
}

async function onAccepted() {
  state = 'connecting';
  setCall({ status: 'Connecting…' });
  link = new PeerLink({
    sendSignal: (data) => sock.send({ type: 'signal', data }),
    onRemoteStream: (stream) => { if (!remoteEl) remoteEl = playStream(stream); },
    onState: (s) => {
      if (s === 'connected' && state !== 'on_call') {
        state = 'on_call';
        startedAt = Date.now();
        $('#call-avatar').classList.remove('ringing');
        if (!bankState) setCall({ status: 'Connected', caption: 'Tell the assistant what you need' });
        startLevels();
      } else if (s === 'failed') {
        hangup({ status: 'The call could not connect', caption: 'Check your internet connection and try again.' });
      }
    },
  });
  link.addStream(micStream);
  try { await link.offer(); } catch (e) { console.error(e); hangup({ status: 'Could not start the call' }); }
}

function hangup(end = { status: 'Call ended' }) {
  if (state === 'idle') return;
  if (sock) sock.send({ type: 'hangup' });
  endLocal(end);
}

async function endLocal(end) {
  if (state === 'idle') return;
  state = 'idle';
  stopLevels();
  if (link) { link.close(); link = null; }
  if (remoteEl) { remoteEl.srcObject = null; remoteEl = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  $('#call-avatar').classList.remove('ringing');
  $('#btn-hangup').disabled = true;
  const verdict = BANK_STATES[bankState] && BANK_STATES[bankState].final;
  if (verdict) $('#call-timer').textContent = 'Call ended';   // keep the verdict on screen
  else { $('#call-timer').textContent = ''; setCall(end); }
  // Back home after a moment, so the last status stays readable.
  await new Promise((r) => setTimeout(r, verdict ? 3000 : 1800));
  if (state === 'idle' && document.body.dataset.screen === 'call') homeScreen();
}

// Speaking indicators from the call's own WebRTC stats (audioLevel 0..1), so no extra audio graph.
let levelTimer = null;
const toLevel = (a) => Math.max(0, Math.min(1, (20 * Math.log10((a || 0) + 1e-6) + 50) / 40));

function startLevels() {
  stopLevels();
  const pc = link && link.pc;
  if (!pc || !pc.getStats) return;
  const bank = $('#call-avatar');
  const you = $('#mic-lvl');
  levelTimer = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let inLvl = 0, outLvl = 0;
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.audioLevel != null) inLvl = r.audioLevel;
        if (r.type === 'media-source' && r.kind === 'audio' && r.audioLevel != null) outLvl = r.audioLevel;
      });
      if (!levelTimer) return;
      setLevel(bank, toLevel(inLvl));
      setLevel(you, toLevel(outLvl));
    } catch { /* stats are cosmetic */ }
  }, 150);
}

function stopLevels() {
  clearInterval(levelTimer);
  levelTimer = null;
  setLevel($('#call-avatar'), 0);
  setLevel($('#mic-lvl'), 0);
}

// ---------------------------------------------------------------- alerts
const alerts = new Map();   // check_id -> { check_id, created_at, action_label, amount, decision, response, busy }
const ALERT_DECISIONS = {
  BLOCK: { word: 'Blocked', tone: 'danger', icon: 'shieldX', title: 'A call claiming to be you was blocked' },
  STEP_UP: { word: 'Needs confirmation', tone: 'warn', icon: 'alert', title: 'A call claiming to be you needs confirmation' },
};
const alertMeta = (d) => ALERT_DECISIONS[d] || ALERT_DECISIONS.STEP_UP;
const responseOf = (r) => (r && typeof r === 'object' ? r.response : r) || null;
const isMine = (x) => !!identity && !!x && x.customer_id === identity.customer_id;
const alertWhat = (a) => `${a.action_label || 'A request'}${a.amount ? ` of ${fmtINR(a.amount)}` : ''}`;

function fromAssessment(a) {
  return {
    check_id: a.check_id,
    created_at: a.created_at,
    action_label: a.action_label,
    amount: a.amount,
    decision: a.risk && a.risk.decision,
    response: responseOf(a.customer_response),
  };
}

/** Add or update an alert; true if it is new. */
function upsertAlert(a) {
  if (!a || !a.check_id) return false;
  const old = alerts.get(a.check_id);
  alerts.set(a.check_id, { ...old, ...a, response: a.response || (old && old.response) || null });
  return !old;
}

async function loadAlerts() {
  if (!identity) return;
  const id = identity.customer_id;
  try {
    const res = await api.assessments(50);
    if (!identity || identity.customer_id !== id) return;
    for (const a of (res && res.assessments) || []) {
      if (a.customer_id === id && a.alert && a.alert.sent) upsertAlert(fromAssessment(a));
    }
  } catch (e) {
    console.warn('could not load alerts', e);
  }
  renderAlerts();
}

function notifyAlert(a) {
  const meta = alertMeta(a.decision);
  const el = toast(`It asked for ${alertWhat(a)}. Tell us if it was you.`,
    { kind: a.decision === 'BLOCK' ? 'error' : 'warn', title: meta.title, timeout: 9000 });
  el.addEventListener('click', () => { if (document.body.dataset.screen === 'home') scrollToAlerts(); });
  try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch { /* not allowed */ }
  a.fresh = true;
}

function onAlertEvent(a) {
  if (upsertAlert(a)) notifyAlert(alerts.get(a.check_id));
  renderAlerts();
}

function renderAlerts() {
  const list = [...alerts.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const unread = list.filter((a) => !a.response).length;
  $('#bell-count').hidden = !unread;
  $('#bell-count').textContent = String(unread);
  $('#btn-bell').classList.toggle('has-unread', unread > 0);
  $('#btn-bell').setAttribute('aria-label', unread ? `Alerts, ${unread} unanswered` : 'Alerts');
  $('#alerts-count').hidden = !unread;
  $('#alerts-count').textContent = `${unread} new`;
  if (!list.length) {
    $('#alert-list').innerHTML = `<div class="empty">${ICONS.bell}<span>No alerts. If anyone calls the bank pretending to be you, you'll see it here.</span></div>`;
    return;
  }
  $('#alert-list').innerHTML = list.map((a) => {
    const meta = alertMeta(a.decision);
    const reply = a.response === 'me'
      ? `<p class="alert-reply">${ICONS.check}You confirmed this was you.</p>`
      : a.response === 'not_me'
        ? `<p class="alert-reply notme">${ICONS.shieldX}You said this wasn't you. It was reported as fraud.</p>`
        : `<div class="alert-actions">
             <button class="btn" type="button" data-check="${esc(a.check_id)}" data-resp="me"${a.busy ? ' disabled' : ''}>It was me</button>
             <button class="btn btn-notme" type="button" data-check="${esc(a.check_id)}" data-resp="not_me"${a.busy ? ' disabled' : ''}>Not me</button>
           </div>`;
    return `<article class="alert-item${a.response ? '' : ' unread'}${a.fresh ? ' fresh' : ''}">
        <div class="alert-icon ${meta.tone}">${ICONS[meta.icon]}</div>
        <div class="alert-body">
          <span class="alert-kicker">A call claiming to be you asked for</span>
          <span class="alert-what">${esc(alertWhat(a))}</span>
          <div class="alert-meta"><span class="badge ${meta.tone}">${meta.word}</span><span>${esc(fmtDateTime(a.created_at))}</span></div>
        </div>
        ${reply}
      </article>`;
  }).join('');
  for (const a of list) a.fresh = false;
}

async function respond(checkId, response) {
  const a = alerts.get(checkId);
  if (!a || a.busy || a.response) return;
  a.busy = true;
  renderAlerts();
  try {
    await api.respond(checkId, response);
    a.response = response;
  } catch (e) {
    showError(e, 'Could not send your answer');
  }
  a.busy = false;
  renderAlerts();
}

function scrollToAlerts() { $('#alerts').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// ---------------------------------------------------------------- setup
async function main() {
  for (const el of $$('[data-icon]')) el.innerHTML = ICONS[el.dataset.icon] || '';
  $('#btn-start').addEventListener('click', () => show('account'));
  $('#form-account').addEventListener('submit', onSetup);
  $('#btn-enroll').addEventListener('click', enrollFlow);
  $('#btn-enroll-back').addEventListener('click', () => (enrolled ? homeScreen() : show('account')));
  $('#btn-reenroll').addEventListener('click', () => openEnroll());
  $('#btn-rec-cancel').addEventListener('click', cancelEnroll);
  $('#btn-call').addEventListener('click', dial);
  $('#btn-hangup').addEventListener('click', () => hangup());
  $('#btn-switch').addEventListener('click', switchAccount);
  $('#btn-bell').addEventListener('click', scrollToAlerts);
  $('#alert-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-check]');
    if (b) respond(b.dataset.check, b.dataset.resp);
  });
  setInterval(() => {
    if (state !== 'on_call') return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('#call-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);

  try {
    const r = await fetch('/voice/agent/prompts.json', { cache: 'no-store' });
    if (r.ok) { const p = await r.json(); script = p.enroll_script || []; passphrase = p.passphrase || ''; }
  } catch { /* no script / passphrase card */ }
  $('#call-pass-text').textContent = `“${passphrase}”`;

  loadIdentity();
  if (identity) { $('#in-name').value = identity.display_name; $('#in-last4').value = identity.phone_last4; }
  try { enrolled = !!identity && localStorage.getItem(ENROLLED_KEY) === identity.customer_id; } catch { enrolled = false; }
  homeScreen();
  const was = enrolled;
  refreshEnrolled().then(() => {
    const screen = document.body.dataset.screen;
    if (enrolled !== was && state === 'idle' && !enrolling && (screen === 'home' || screen === 'enroll')) homeScreen();
  });
  loadAlerts();
  connectEvents({
    alert: (d) => { if (isMine(d)) onAlertEvent({ ...d, response: null }); },
    assessment: (a) => { if (isMine(a) && a.alert && a.alert.sent) onAlertEvent(fromAssessment(a)); },
    customer_response: (d) => {
      const a = alerts.get(d && d.check_id);
      if (a) { a.response = d.response; renderAlerts(); }
    },
  }, { onReconnect: loadAlerts });

  sock = callSocket('caller', {
    onMessage,
    onState: (st) => {
      $('#line-dot').className = `dot${st === 'open' ? ' live' : st === 'denied' ? ' danger' : ''}`;
      $('#line-text').textContent = st === 'open' ? 'Bank line ready'
        : st === 'denied' ? 'Wrong access code for the bank line' : 'Connecting to the bank…';
      if (st === 'closed' && state !== 'idle') endLocal({ status: 'Lost the connection to the bank' });
    },
  });
}

main();
