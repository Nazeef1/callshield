// CallShield — receive screen (index.html): the bank side. Once online, the virtual agent answers every call.
import { api, connectEvents } from './api.js';
import { MicCapture, encodeWav, SAMPLE_RATE } from './audio.js';
import { callSocket, PeerLink, playStream } from './call.js';
import { VoiceBot, loadPrompts } from './voicebot.js';
import { $, esc, fmtINR, fmtNum, fmtTime, ACTIONS, decisionMeta, ICONS, toast, showError, randomId } from './ui.js';

const ANSWER_DELAY_MS = 1200;   // a ring, then the virtual agent picks up
const RECENT_ROWS = 10;
const LANG = 'en-IN';
const STATES = {
  greeting: { label: 'Greeting', tone: 'accent' },
  listening_request: { label: 'Listening for request', tone: 'accent' },
  listening_passphrase: { label: 'Listening for passphrase', tone: 'accent' },
  verifying: { label: 'Verifying voice', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  blocked: { label: 'Blocked', tone: 'danger' },
  human: { label: 'Human agent', tone: 'warn' },
};

// ---------------------------------------------------------------- state
const mic = new MicCapture({ ringSeconds: 60 });  // a virtual-agent call can span ~40 s of replies
let online = false;
let callSock = null;
let lineState = 'offline';
const ringing = new Map();       // caller_id -> {customer_id, display_name}
let answering = false;
let phone = null;                // { callerId, customerId, cid, name, local, el, link, out, agentGain, agentSrc, srTrack } while a call is up
let shownCall = null;            // { name, cid } of the call on the card (stays after it ends)
let callActive = false;
let callStartedAt = 0;
let callEndedAt = 0;
let callId = null;
let bot = null;
let sharedCtx = null;
let speaking = null;             // { stop() } for the prompt being played
let customers = [];
let lines = [];                  // conversation: {who: agent|caller|system, text}
let liveCaller = '';             // caller words heard so far in the reply the virtual agent is waiting for
let liveInterim = '';
let inFlight = false;
let current = null;              // assessment shown in the verdict card
const assessments = new Map();   // check_id -> assessment
let order = [];                  // check_ids, newest first
const replyOf = (a) => (a && a.customer_response && a.customer_response.response) || null;

// ---------------------------------------------------------------- status bar
async function refreshStatus() {
  let s = null;
  try { s = await api.status(); } catch { s = null; }
  const dot = $('#st-health');
  dot.className = `dot ${!s ? '' : s.health === 'ok' ? 'live' : 'danger'}`;
  $('#st-detectif').title = !s ? 'CallShield server unreachable'
    : `DetectifAI ${s.health === 'ok' ? 'reachable' : 'unreachable'} · ~${s.cost_per_check || 100} credits per check`;
  const c = s && s.credits;
  if (c) setCredits(c.unlimited ? null : c.available, !!c.unlimited);
}

function setCredits(available, unlimited = false) {
  $('#st-credits').textContent = unlimited ? 'unlimited' : typeof available === 'number' ? `${fmtNum(available)} credits` : '—';
}

async function revealAttackLab() {
  try {
    const s = await api.attackStatus(false);
    $('#nav-attack').hidden = !(s && s.enabled);
  } catch { /* not available from this device */ }
}

function renderLine() {
  const text = { offline: 'Line offline', connecting: 'Line connecting', open: 'Line ready', closed: 'Line reconnecting', denied: 'Wrong access code' };
  $('#st-line-text').textContent = text[lineState] || lineState;
  $('#st-line-dot').className = `dot ${lineState === 'open' ? 'live' : lineState === 'denied' ? 'danger' : lineState === 'offline' ? '' : 'warn'}`;
  $('#st-line').title = lineState === 'denied' ? 'Open this page with ?code=… (the server sets a call access code)' : 'Phone line';
}

// ---------------------------------------------------------------- online / offline
/** One AudioContext for the outgoing call mix; created on the "Go online" click. */
async function audioCtx() {
  if (!sharedCtx) sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sharedCtx.state === 'suspended') await sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

async function goOnline() {
  const btn = $('#btn-online');
  btn.disabled = true;
  try {
    await audioCtx();  // this click unlocks audio for calls answered later without a click
    const prompts = await loadPrompts();
    if (!prompts) { toast('The virtual agent voice files are missing (frontend/voice/agent).', { kind: 'error' }); return; }
    // Ask for the agent mic now, so an auto-answered call never waits on a permission prompt.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      toast(`Allow the microphone: calls are handed to you when the virtual agent needs a human (${e.name || e.message}).`,
        { kind: 'error', title: 'Microphone' });
      return;
    }
    if (!SR) toast('This browser has no speech recognition, so every call goes straight to you. Use Google Chrome.', { kind: 'warn', title: 'Virtual agent', timeout: 9000 });
    online = true;
    callSock = callSocket('agent', { onMessage: onCallMessage, onState: (st) => { lineState = st; onLineState(st); } });
    renderOnline();
  } finally {
    btn.disabled = false;
  }
}

function goOffline() {
  if (callActive) endCall();
  online = false;
  if (callSock) { callSock.close(); callSock = null; }
  ringing.clear();
  shownCall = null;
  lineState = 'offline';
  renderLine();
  renderOnline();
}

function renderOnline() {
  $('#hero').hidden = online;
  $('#online-bar').hidden = !online;
  renderCall();
}

// ---------------------------------------------------------------- phone line
function onCallMessage(msg) {
  switch (msg.type) {
    case 'incoming':
      ringing.set(msg.caller_id, { customer_id: msg.customer_id, display_name: msg.display_name });
      renderCall();
      if (!callActive) setTimeout(() => { if (!callActive) answerPhone(); }, ANSWER_DELAY_MS);
      break;
    case 'cancel':
    case 'taken':
      ringing.delete(msg.caller_id);
      renderCall();
      if (phone && phone.callerId === msg.caller_id && !mic.running) { toast('The caller hung up.', { kind: 'warn' }); endCall({ remote: true }); }
      break;
    case 'signal':
      if (phone) phone.link.handleSignal(msg.data).catch((e) => console.error(e));
      break;
    case 'hangup':
      if (phone) { toast('The caller hung up.', { kind: 'info', title: 'Phone line' }); endCall({ remote: true }); }
      break;
    default: break;
  }
}

function onLineState(st) {
  renderLine();
  if (st === 'open') { renderCall(); return; }
  ringing.clear();
  // The server hangs up a call whose agent socket dropped.
  if (phone) { toast('The phone line dropped.', { kind: 'warn', title: 'Phone line' }); endCall({ remote: true }); }
  renderCall();
}

const sendState = (state, text) => { if (callSock) callSock.send({ type: 'state', state, ...(text ? { text } : {}) }); };

async function answerPhone() {
  const first = [...ringing.entries()].pop();
  if (!first || callActive || answering || !online) return;
  answering = true;
  try {
    const [callerId, r] = first;
    let local;
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
    } catch (e) {
      toast(`Allow the microphone so the caller can hear you (${e.name || e.message}).`, { kind: 'error', title: 'Microphone' });
      return;
    }
    if (!ringing.has(callerId) || !online) { local.getTracks().forEach((t) => t.stop()); return; }
    ringing.delete(callerId);
    if (r.customer_id && !customers.some((c) => c.customer_id === r.customer_id)) await loadCustomers();
    const cust = customers.find((c) => c.customer_id === r.customer_id) || null;
    // What the caller hears: the agent's mic (muted while the virtual agent talks) + the virtual agent's voice.
    const actx = await audioCtx();
    const out = actx.createMediaStreamDestination();
    const agentGain = actx.createGain();
    agentGain.gain.value = 0;
    const agentSrc = actx.createMediaStreamSource(local);
    agentSrc.connect(agentGain).connect(out);
    phone = {
      callerId, local, el: null, link: null, out, agentGain, agentSrc, srTrack: null,
      customerId: cust ? cust.customer_id : '',
      cid: r.customer_id || '',
      name: (cust && cust.display_name) || r.display_name || 'Unknown caller',
    };
    phone.link = new PeerLink({
      sendSignal: (data) => callSock && callSock.send({ type: 'signal', data }),
      onRemoteStream: (stream) => startPhoneCapture(stream),
      onState: (s) => {
        if (s === 'failed' && phone) { toast('The call audio connection failed.', { kind: 'error', title: 'Phone line' }); endCall(); }
      },
    });
    phone.link.addStream(out.stream);
    shownCall = { name: phone.name, cid: phone.cid };
    callSock.send({ type: 'accept', caller_id: callerId });
    beginCall();
  } finally {
    answering = false;
  }
}

function beginCall() {
  callActive = true;
  callStartedAt = performance.now();
  callId = randomId('call');
  lines = [];
  liveCaller = '';
  liveInterim = '';
  setBadge(null, 'Connecting');
  renderCall();
  renderConvo();
}

async function startPhoneCapture(stream) {
  if (!phone || phone.el) return;
  phone.el = playStream(stream);
  try {
    mic.reset();
    await mic.start({ stream });
  } catch (e) {
    console.error(e);
    handOff("Could not capture the caller's audio");
    return;
  }
  mic.onended = null;
  callStartedAt = performance.now();
  // Chrome speech recognition rejects the remote WebRTC track; it takes a Web Audio copy of it.
  try {
    if (!SR) throw new Error('no SpeechRecognition');
    phone.srTrack = mic.tapTrack();
    startRecognition(phone.srTrack);
  } catch (e) {
    console.warn('SpeechRecognition cannot take the call audio track', e);
    stopRecognition();
    handOff('Speech recognition is not available in this browser');
    return;
  }
  startBot();
}

function endCall({ remote = false } = {}) {
  if (!callActive && !phone) return;
  callActive = false;
  callEndedAt = performance.now();
  stopRecognition();
  if (bot) { bot.stop(); bot = null; }
  if (speaking) speaking.stop();
  mic.stop();
  if (phone) {
    if (!remote && callSock) callSock.send({ type: 'hangup' });
    phone.link.close();
    phone.local.getTracks().forEach((t) => t.stop());
    try { phone.agentSrc.disconnect(); phone.out.disconnect(); } catch { /* ignore */ }
    if (phone.el) phone.el.srcObject = null;
    phone = null;
  }
  liveCaller = '';
  liveInterim = '';
  setBadge(null, 'Call ended');
  renderCall();
  renderConvo();
  // Someone else may have been waiting while this call was up.
  if (online && ringing.size) setTimeout(() => { if (!callActive) answerPhone(); }, ANSWER_DELAY_MS);
}

// ---------------------------------------------------------------- virtual agent
async function startBot() {
  const prompts = await loadPrompts();
  if (!phone || !prompts || !callActive) return;
  bot = new VoiceBot({
    mic,
    prompts,
    hooks: {
      say: playPrompt,
      stopSpeaking: () => { if (speaking) speaking.stop(); },
      // One recognition session per reply: a long-running session on the call track can go quiet.
      freshTranscript: () => {
        if (!phone || !phone.srTrack) return;
        stopRecognition();
        try { startRecognition(phone.srTrack); } catch (e) { console.warn('transcript restart failed', e); }
      },
      log: (who, text) => {
        if (who === 'caller') { liveCaller = ''; liveInterim = ''; }
        addLine(who, text);
      },
      state: (name, text) => { setBadge(name); sendState(name, text); },
      runCheck: ({ samples, deepfakeSamples, action, amount, transcript }) => submitCheck({
        passphrase: encodeWav(samples, SAMPLE_RATE),
        deepfake: deepfakeSamples ? encodeWav(deepfakeSamples, SAMPLE_RATE) : null,
        action,
        amount: action === 'fund_transfer' ? amount : null,
        transcript,
      }),
      handOff,
      hangUp: () => setTimeout(() => { if (callActive) endCall(); }, 800),
    },
  });
  bot.start();
  renderCall();
}

/** Play one of the virtual agent's prompts into the call (the agent hears it too). Resolves when it ends
 *  or is cut short (caller barge-in). */
async function playPrompt(id) {
  if (!phone) return;
  if (speaking) speaking.stop();
  // A reply was heard and Neerja answers: don't keep showing "Listening for …" while she talks.
  if (/^listening/.test($('#call-badge').dataset.state || '')) setBadge(null, 'Neerja speaking');
  const actx = await audioCtx();
  const el = new Audio(`/voice/agent/${id}.mp3`);
  const src = actx.createMediaElementSource(el);
  src.connect(phone.out);
  src.connect(actx.destination);
  const me = {};
  speaking = me;
  await new Promise((resolve) => {
    me.stop = () => { el.pause(); resolve(); };
    el.onended = resolve;
    el.onerror = resolve;
    el.play().catch(resolve);
  });
  if (speaking === me) speaking = null;
  try { src.disconnect(); } catch { /* ignore */ }
  // A reprompt ends with Neerja still waiting for the same reply.
  if (bot && bot.active && bot.listening && !$('#call-badge').dataset.state) setBadge(`listening_${bot.listening}`);
}

function handOff(reason) {
  if (bot) bot.stop();
  if (phone) phone.agentGain.gain.value = 1;
  liveCaller = '';
  liveInterim = '';
  setBadge('human');
  sendState('human', 'You are speaking with a customer care officer.');
  addLine('system', `${reason}. Your mic is live with the caller.`);
  renderCall();
  toast(`${reason}. You are now live with the caller.`, { kind: 'warn', title: 'Take over the call', timeout: 9000 });
}

function takeOver() {
  if (!bot || !bot.active) return;
  if (speaking) speaking.stop();
  handOff('You took over the call');
}

// ---------------------------------------------------------------- speech recognition (caller's call audio)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recWanted = false;
let recNetErrors = 0;

/** Transcribe the call's incoming audio. Throws if this Chrome can't take an audio track. */
function startRecognition(track) {
  recWanted = true;
  rec = new SR();
  rec.lang = LANG;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  const me = rec;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0] ? r[0].transcript : '';
      if (r.isFinal) onFinalTranscript(text.trim());
      else interim += text;
    }
    recNetErrors = 0;
    liveInterim = interim.trim();
    renderConvo();
  };
  rec.onerror = (e) => {
    console.debug('[transcript] error', e.error);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      recWanted = false;
      toast('Speech recognition was blocked, so the virtual agent cannot hear the caller.', { kind: 'error' });
    } else if (e.error === 'network') {
      recNetErrors++;
      if (recNetErrors >= 3) {
        recWanted = false;
        toast('Speech service unreachable (Chrome needs internet for speech recognition).', { kind: 'error' });
      }
    }
  };
  rec.onend = () => {
    if (rec !== me) return;
    if (recWanted && callActive) {
      setTimeout(() => {
        if (rec === me && recWanted && callActive) {
          try { me.start(track); } catch (e) { console.debug('[transcript] restart failed', e.name, e.message); }
        }
      }, 250);
    }
  };
  rec.start(track);
}

function stopRecognition() {
  recWanted = false;
  const r = rec;
  rec = null;
  if (r) { try { r.onend = null; r.onresult = null; r.abort(); } catch { /* ignore */ } }
  liveInterim = '';
}

function onFinalTranscript(text) {
  if (!text) return;
  if (bot && bot.active && bot.listening) {
    liveCaller = `${liveCaller} ${text}`.trim();
    bot.onUtterance(text);  // the virtual agent runs the conversation
  } else {
    addLine('caller', text);
  }
}

// ---------------------------------------------------------------- live call card
function setBadge(name, label) {
  const el = $('#call-badge');
  const st = name ? STATES[name] : null;
  el.hidden = false;
  el.dataset.state = name || '';
  el.className = `badge ${st ? st.tone : 'neutral'}`;
  el.textContent = st ? st.label : label;
}

function renderCall() {
  const r = [...ringing.values()].pop();
  const view = callActive ? 'live' : online && r ? 'ringing' : online && shownCall ? 'live' : 'idle';
  $('#call-idle').hidden = view !== 'idle';
  $('#call-ringing').hidden = view !== 'ringing';
  $('#call-live').hidden = view !== 'live';
  if (view !== 'live') $('#call-badge').hidden = true;
  if (view === 'idle') {
    $('#call-idle-icon').innerHTML = online ? ICONS.phone : ICONS.phoneOff;
    $('#call-idle-title').textContent = online ? 'Waiting for calls' : 'Offline';
    $('#call-idle-sub').textContent = online
      ? (lineState === 'open' ? 'Neerja picks up as soon as a call rings.' : 'Connecting the phone line…')
      : 'Go online to take calls.';
  } else if (view === 'ringing') {
    $('#ring-who').textContent = `Incoming call · ${r.display_name || 'Unknown caller'}`;
    $('#ring-sub').textContent = `Neerja is picking up…${ringing.size > 1 ? ` (${ringing.size - 1} more waiting)` : ''}`;
  } else {
    $('#caller-avatar').textContent = initials(shownCall.name);
    $('#caller-name').textContent = shownCall.name;
    $('#caller-cid').textContent = shownCall.cid || 'no customer id';
    $('#btn-takeover').hidden = !(callActive && bot && bot.active);
    $('#call-actions').hidden = !callActive;
  }
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function addLine(who, text) {
  if (!text) return;
  lines.push({ who, text });
  if (lines.length > 200) lines.shift();
  renderConvo();
}

function renderConvo() {
  const box = $('#convo');
  const live = `${liveCaller} ${liveInterim}`.trim();
  if (!lines.length && !live) {
    box.innerHTML = `<p class="convo-empty faint small">${callActive ? 'Connecting the call audio…' : 'No conversation.'}</p>`;
    return;
  }
  const who = { agent: 'Neerja', caller: 'Caller' };
  box.innerHTML = lines.map((l) => (l.who === 'system'
    ? `<p class="msg system">${esc(l.text)}</p>`
    : `<div class="msg ${l.who}"><span class="msg-who">${who[l.who] || ''}</span>${esc(l.text)}</div>`)).join('')
    + (live && callActive ? `<div class="msg caller live"><span class="msg-who">Caller</span>${esc(live)}</div>` : '');
  box.scrollTop = box.scrollHeight;
}

function tick() {
  if (shownCall) {
    const s = Math.floor(((callActive ? performance.now() : callEndedAt) - callStartedAt) / 1000);
    $('#call-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    $('#level-fill').style.width = `${(mic.running ? mic.meterLevel : 0) * 100}%`;
  }
  if (busyStart) $('#busy-timer').textContent = `${((performance.now() - busyStart) / 1000).toFixed(1)} s`;
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- customers
async function loadCustomers() {
  try {
    const res = await api.customers();
    customers = (res && res.customers) || [];
  } catch (e) {
    if (e.code !== 'network') showError(e, 'Could not load customers');
  }
}

// ---------------------------------------------------------------- checks
let busyStart = 0;

async function submitCheck({ passphrase, deepfake, action, amount, transcript }) {
  if (inFlight || !phone) return;
  inFlight = true;
  const fd = new FormData();
  fd.append('file', passphrase, 'passphrase.wav');
  if (deepfake) fd.append('deepfake_file', deepfake, 'natural.wav');
  fd.append('customer_id', phone.customerId);
  fd.append('action', action);
  if (amount != null && action === 'fund_transfer') fd.append('amount', String(amount));
  fd.append('call_id', callId || randomId('call'));
  fd.append('trigger', 'voicebot');
  if (transcript) fd.append('transcript', transcript);
  showVerdict('busy');
  $('#busy-sub').textContent = `${ACTIONS[action] || action}${amount ? ` ${fmtINR(amount)}` : ''} · ${phone.name}`;
  busyStart = performance.now();
  try {
    const a = await api.check(fd);
    upsertAssessment(a);
    renderAssessment(a);
    if (a.credits && typeof a.credits.balance === 'number') setCredits(a.credits.balance);
    return a;
  } catch (e) {
    showVerdict(current ? 'result' : 'idle');
    showError(e, 'Check failed');
    return null;
  } finally {
    busyStart = 0;
    inFlight = false;
    refreshStatus();
  }
}

// ---------------------------------------------------------------- verdict card
function showVerdict(which) {
  $('#verdict-idle').hidden = which !== 'idle';
  $('#verdict-busy').hidden = which !== 'busy';
  $('#verdict-result').hidden = which !== 'result';
}

function renderAssessment(a) {
  current = a;
  showVerdict('result');
  const risk = a.risk || {};
  const d = decisionMeta(risk.decision);
  $('#verdict-time').textContent = a.created_at ? fmtTime(a.created_at) : '';
  const box = $('#decision');
  box.className = `decision tone-${d.tone}`;
  $('#decision-icon').innerHTML = d.tone === 'danger' ? ICONS.shieldX : d.tone === 'warn' ? ICONS.alert : ICONS.shieldCheck;
  $('#decision-word').textContent = d.word;
  $('#decision-sub').textContent = d.sub;
  const amt = a.action === 'fund_transfer' && a.amount ? ` <b>${esc(fmtINR(a.amount))}</b>` : '';
  $('#request-line').innerHTML = `<span class="label">Request</span><span><b>${esc(a.action_label || ACTIONS[a.action] || a.action || '—')}</b>${amt}`
    + ` <span class="muted">for ${esc(a.customer_name || a.customer_id || 'unknown caller')}</span></span>`;
  $('#sig-voice').innerHTML = voiceSignal(a);
  $('#sig-deepfake').innerHTML = deepfakeSignal(a);
  const reasons = (Array.isArray(risk.reasons) ? risk.reasons : []).slice(0, 4);
  $('#reasons').innerHTML = reasons.map((r) => `<li>${esc(r)}</li>`).join('');
  $('#reasons').hidden = !reasons.length;
  renderAlertLine(a);
  renderRecent();
}

/** One signal row: name, badge, value vs threshold on a 0..1 track. */
function signalRow({ name, badge, tone, value, threshold, caption, min = 0 }) {
  const pct = (v) => Math.max(0, Math.min(100, ((v - min) / (1 - min)) * 100));
  const bar = value == null ? '' : `<div class="sig-track"><span class="sig-fill ${tone}" style="width:${pct(value).toFixed(1)}%"></span>`
    + `${threshold != null ? `<span class="sig-th" style="left:${pct(threshold).toFixed(1)}%"></span>` : ''}</div>`;
  return `<div class="sig-head"><span class="sig-name">${esc(name)}</span><span class="badge ${tone}">${esc(badge)}</span></div>`
    + bar + `<div class="sig-cap faint small">${caption}</div>`;
}

function voiceSignal(a) {
  const sp = a.speaker;
  if (!sp) {
    return signalRow({ name: 'Voice match', badge: 'Not checked', tone: 'neutral',
      caption: a.customer_id ? 'No voiceprint result' : 'Not a registered customer' });
  }
  const sim = Number(sp.similarity) || 0;
  const thr = typeof sp.threshold === 'number' ? sp.threshold : null;
  const match = sp.decision === 'match';
  return signalRow({ name: 'Voice match', badge: match ? 'Match' : 'No match', tone: match ? 'ok' : 'danger',
    value: sim, threshold: thr, min: sim < 0 ? -1 : 0,
    caption: `similarity ${sim.toFixed(2)}${thr != null ? ` · threshold ${thr.toFixed(2)}` : ''}` });
}

function deepfakeSignal(a) {
  const df = a.deepfake;
  if (!df) return signalRow({ name: 'Deepfake', badge: 'No result', tone: 'neutral', caption: 'Deepfake check did not return' });
  const v = String(df.verdict || '').toLowerCase();
  const score = Number(df.score) || 0;
  const thr = typeof df.threshold === 'number' ? df.threshold : null;
  const [badge, tone] = v === 'fake' ? ['Synthetic', 'danger'] : v === 'real' ? ['Real voice', 'ok'] : ['Not sure', 'warn'];
  return signalRow({ name: 'Deepfake', badge, tone, value: score, threshold: thr,
    caption: `score ${score.toFixed(2)}${thr != null ? ` · threshold ${thr.toFixed(2)}` : ''}` });
}

function renderAlertLine(a) {
  const el = $('#alert-line');
  const alert = a.alert || {};
  const reply = replyOf(a);
  const replyText = reply === 'not_me' ? '<span class="reply danger">Customer: not me</span>'
    : reply === 'me' ? '<span class="reply ok">Customer: it was me</span>'
      : alert.sent ? '<span class="faint">awaiting reply</span>' : '';
  el.innerHTML = alert.sent
    ? `${ICONS.bell}<span>Customer alerted on their phone</span>${replyText ? `<span class="faint">·</span>${replyText}` : ''}`
    : `${ICONS.shieldCheck}<span class="muted">No customer alert needed</span>${replyText ? `<span class="faint">·</span>${replyText}` : ''}`;
}

// ---------------------------------------------------------------- recent calls
function upsertAssessment(a) {
  if (!a || !a.check_id) return;
  const prev = assessments.get(a.check_id);
  if (prev && replyOf(prev) && !replyOf(a)) a.customer_response = prev.customer_response;
  assessments.set(a.check_id, a);
  if (!prev) {
    order.unshift(a.check_id);
    order.sort((x, y) => String(assessments.get(y).created_at || '').localeCompare(String(assessments.get(x).created_at || '')));
    for (const id of order.splice(50)) assessments.delete(id);
  }
  if (current && current.check_id === a.check_id) current = a;
  renderRecent();
}

function renderRecent() {
  const body = $('#recent-body');
  if (!order.length) {
    body.innerHTML = '<tr><td colspan="7" class="recent-empty faint">No calls yet.</td></tr>';
    return;
  }
  body.innerHTML = order.slice(0, RECENT_ROWS).map((id) => {
    const a = assessments.get(id);
    const d = decisionMeta(a.risk && a.risk.decision);
    const sp = a.speaker;
    const voice = !sp ? '<span class="faint">—</span>'
      : `<span class="${sp.decision === 'match' ? 'ok' : 'danger'}">${sp.decision === 'match' ? 'Match' : 'No match'}</span> <span class="faint mono">${(Number(sp.similarity) || 0).toFixed(2)}</span>`;
    const v = a.deepfake ? String(a.deepfake.verdict || '').toLowerCase() : '';
    const df = !a.deepfake ? '<span class="faint">—</span>'
      : `<span class="${v === 'fake' ? 'danger' : v === 'real' ? 'ok' : 'warn'}">${v === 'fake' ? 'Synthetic' : v === 'real' ? 'Real' : 'Not sure'}</span> <span class="faint mono">${(Number(a.deepfake.score) || 0).toFixed(2)}</span>`;
    const reply = replyOf(a);
    const replyHtml = reply === 'not_me' ? '<span class="danger">Not me</span>'
      : reply === 'me' ? '<span class="ok">It was me</span>'
        : a.alert && a.alert.sent ? '<span class="faint">Awaiting</span>' : '<span class="faint">—</span>';
    const amt = a.action === 'fund_transfer' && a.amount ? ` <span class="muted">${esc(fmtINR(a.amount))}</span>` : '';
    const sel = current && current.check_id === id;
    return `<tr data-id="${esc(id)}" tabindex="0" class="${sel ? 'selected' : ''}">
      <td class="mono muted">${esc(fmtTime(a.created_at))}</td>
      <td>${esc(a.customer_name || a.customer_id || 'Unknown caller')}</td>
      <td>${esc(a.action_label || ACTIONS[a.action] || a.action || '')}${amt}</td>
      <td><span class="badge ${d.tone}">${esc(d.word)}</span></td>
      <td class="col-sig">${voice}</td>
      <td class="col-sig">${df}</td>
      <td>${replyHtml}</td>
    </tr>`;
  }).join('');
}

function onRecentPick(e) {
  const tr = e.target.closest('tr[data-id]');
  if (!tr || inFlight) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  if (e.type === 'keydown') e.preventDefault();
  const a = assessments.get(tr.dataset.id);
  if (a) renderAssessment(a);
}

async function loadAssessments() {
  try {
    const res = await api.assessments(50);
    for (const a of ((res && res.assessments) || []).slice().reverse()) upsertAssessment(a);
  } catch (e) {
    if (e.code !== 'network') showError(e, 'Could not load recent calls');
  }
}

/** Show the latest verdict, or /?check=<check_id> (e.g. a link from the Attack Lab). */
function openInitialCheck() {
  let id = null;
  try { id = new URLSearchParams(location.search).get('check'); } catch { id = null; }
  const a = assessments.get(id) || assessments.get(order[0]);
  if (a && !inFlight && !current) renderAssessment(a);
}

function onCustomerResponse(r) {
  if (!r || !r.check_id) return;
  const a = assessments.get(r.check_id);
  if (a) {
    a.customer_response = { response: r.response, created_at: r.created_at };
    renderRecent();
    if (current && current.check_id === r.check_id) renderAlertLine(a);
  }
  const who = a ? (a.customer_name || a.customer_id || 'Customer') : 'Customer';
  if (r.response === 'not_me') toast(`${who} says the call was not them. Treat it as fraud.`, { kind: 'error', title: 'Customer: not me', timeout: 9000 });
  else if (r.response === 'me') toast(`${who} confirmed it was them.`, { kind: 'ok', title: 'Customer: it was me' });
}

// ---------------------------------------------------------------- wiring
function main() {
  $('#btn-online').innerHTML = `${ICONS.phone}<span>Go online</span>`;
  $('#btn-takeover').innerHTML = `${ICONS.mic}<span>Take over</span>`;
  $('#btn-end').innerHTML = `${ICONS.phoneOff}<span>End call</span>`;
  $('#ring-icon').innerHTML = ICONS.phone;
  $('#verdict-idle-icon').innerHTML = ICONS.shield;
  $('#btn-online').addEventListener('click', goOnline);
  $('#btn-offline').addEventListener('click', goOffline);
  $('#btn-takeover').addEventListener('click', takeOver);
  $('#btn-end').addEventListener('click', () => endCall());
  $('#recent-body').addEventListener('click', onRecentPick);
  $('#recent-body').addEventListener('keydown', onRecentPick);
  window.addEventListener('beforeunload', () => { if (callActive) endCall(); });
  if (!MicCapture.isSupported()) {
    $('#btn-online').disabled = true;
    toast('This browser cannot capture call audio. Use desktop Chrome on localhost or https.', { kind: 'error', timeout: 0 });
  }

  renderLine();
  renderOnline();
  renderConvo();
  renderRecent();
  showVerdict('idle');
  refreshStatus();
  setInterval(refreshStatus, 30000);
  revealAttackLab();
  loadCustomers();
  loadAssessments().then(openInitialCheck);
  connectEvents({
    assessment: (a) => upsertAssessment(a),
    customer_response: onCustomerResponse,
  }, {
    onReconnect: () => { loadAssessments(); refreshStatus(); },
  });
  requestAnimationFrame(tick);
}

main();
