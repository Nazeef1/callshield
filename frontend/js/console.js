// CallShield — Agent Console (index.html)
import { api, connectEvents } from './api.js';
import { MicCapture, encodeWav, drawPeaks, estimateSpeechSeconds, SAMPLE_RATE } from './audio.js';
import { detectAction, parseAmount, keywordRanges } from './keywords.js';
import { callSocket, PeerLink, playStream } from './call.js';
import {
  $, $$, esc, fmtINR, fmtNum, fmtTime, ACTIONS, TRIGGERS, decisionMeta, replyOf, ICONS,
  toast, showError, confirmDialog, initStatus, setSseDot, randomId,
} from './ui.js';

const CLIP_SECONDS = 8;
const MIN_SECONDS = 5;
const MIN_SPEECH_SECONDS = 1.5;
const AUTO_COOLDOWN_MS = 30000;
const PENDING_AUTO_TTL_MS = 10000;

// ---------------------------------------------------------------- state
const mic = new MicCapture({ ringSeconds: 30 });
let status = null;               // header status controller
let customers = [];
let customersLoaded = false;
let callActive = false;
let callStartedAt = 0;
let callId = null;
let inFlight = false;
let lastAutoAt = 0;
let pendingAuto = null;          // keyword hit waiting for enough buffered audio
let current = null;              // assessment currently shown in the verdict panel
const assessments = new Map();   // check_id -> assessment (newest first via order array)
let order = [];
const feedbackGiven = new Set();
let uploadFile = null;

const isMock = () => status && status.state.mode === 'mock';
const isLive = () => status && status.state.mode === 'live';

// ---------------------------------------------------------------- static UI bits
function initStaticUi() {
  $('#btn-start').innerHTML = `${ICONS.mic}<span>Start call</span>`;
  $('#btn-end').innerHTML = `${ICONS.phoneOff}<span>End call</span>`;
  $('#idle-icon').innerHTML = ICONS.shield;
  const icons = { fund_transfer: ICONS.transfer, sim_otp_reset: ICONS.sim, limit_change: ICONS.limit, beneficiary_add: ICONS.userPlus };
  for (const b of $$('.action-btn')) {
    const a = b.dataset.action;
    b.innerHTML = `${icons[a]}<span>${esc(ACTIONS[a])}</span>`;
    b.title = `Check the caller's last ${CLIP_SECONDS} s of voice before allowing: ${ACTIONS[a]}`;
  }
}

function renderCostNote() {
  const el = $('#cost-note');
  if (isMock()) el.innerHTML = `<span class="badge badge-mock">Mock</span> no credits used`;
  else {
    const cost = (status && status.state.cost_per_check) || 100;
    el.innerHTML = `${ICONS.coins.replace('<svg ', '<svg width="15" height="15" ')}each check uses <b>~${cost} credits</b>`;
  }
  $('#mock-scenarios').hidden = !isMock();
}

// ---------------------------------------------------------------- customers
async function loadCustomers() {
  try {
    const res = await api.customers();
    customers = (res && res.customers) || [];
  } catch (e) {
    customers = [];
    if (e.code !== 'network') showError(e, 'Could not load customers');
  }
  const sel = $('#customer-select');
  const prev = customersLoaded ? sel.value : sessionGet('cs.customer'); // null = never chosen
  customersLoaded = true;
  sel.innerHTML = `<option value="">Unknown caller (deepfake check only)</option>` +
    customers.map((c) => {
      const tail = c.phone_last4 ? ` · ••${esc(c.phone_last4)}` : '';
      return `<option value="${esc(c.customer_id)}">${esc(c.display_name || c.customer_id)} · ${esc(c.customer_id)}${tail}</option>`;
    }).join('');
  if (prev === '' || (prev && customers.some((c) => c.customer_id === prev))) sel.value = prev;
  else if (customers.length) sel.value = customers[0].customer_id;
  onCustomerChange();
}

function selectedCustomer() {
  const id = $('#customer-select').value;
  return customers.find((c) => c.customer_id === id) || null;
}

function onCustomerChange() {
  const c = selectedCustomer();
  sessionSet('cs.customer', c ? c.customer_id : '');
  const hint = $('#customer-hint');
  const phoneUrl = c ? `/phone.html?customer=${encodeURIComponent(c.customer_id)}` : '/phone.html';
  $('#nav-phone').href = phoneUrl;
  if (c) {
    hint.innerHTML = `Voiceprint enrolled · checks run <b>speaker verification + deepfake detection</b> · <a href="${phoneUrl}" target="_blank" rel="noopener">open ${esc(c.display_name || c.customer_id)}'s phone ↗</a>`;
  } else if (customers.length === 0) {
    hint.innerHTML = `No customers enrolled yet — <a href="/enroll.html">enroll a voice</a> to enable speaker verification.`;
  } else {
    hint.textContent = 'Unknown caller: only deepfake detection runs; identity is unverified.';
  }
}

// ---------------------------------------------------------------- call control
async function startCall() {
  const btn = $('#btn-start');
  btn.disabled = true;
  try {
    mic.reset();
    await mic.start();
  } catch (e) {
    btn.disabled = false;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? 'Microphone permission was denied. Allow mic access in the address bar and try again.'
      : e && e.name === 'NotFoundError' ? 'No microphone found.' : `Could not start the microphone: ${e.message || e}`,
    { kind: 'error', title: 'Microphone' });
    return;
  }
  mic.onended = () => { if (callActive) { toast('Microphone disconnected.', { kind: 'warn' }); endCall(); } };
  btn.disabled = false;
  beginCall('On call');
  startRecognition();
}

function beginCall(label) {
  callActive = true;
  callStartedAt = performance.now();
  callId = randomId('call');
  pendingAuto = null;
  transcriptLines = [];
  renderTranscript('');
  $('#btn-start').hidden = true;
  $('#btn-end').hidden = false;
  $('#call-state').textContent = label;
  $('#call-state').classList.add('on');
  $('#wave-empty').hidden = true;
}

function endCall({ remote = false } = {}) {
  callActive = false;
  pendingAuto = null;
  stopRecognition();
  stopCallerAsr();
  mic.stop();
  if (phone) {
    if (!remote) callSock.send({ type: 'hangup' });
    phone.link.close();
    phone.local.getTracks().forEach((t) => t.stop());
    if (phone.el) phone.el.srcObject = null;
    phone = null;
    $('#manual-actions').hidden = true;
  }
  $('#btn-start').hidden = false;
  $('#btn-end').hidden = true;
  $('#call-state').textContent = 'Call ended';
  $('#call-state').classList.remove('on');
}

// ---------------------------------------------------------------- phone calls (caller.html -> this console)
let callSock = null;
let phone = null;                // { callerId, link, local, el } while a phone call is up
const ringing = new Map();       // caller_id -> {customer_id, display_name}

function onCallMessage(msg) {
  switch (msg.type) {
    case 'incoming':
      ringing.set(msg.caller_id, { customer_id: msg.customer_id, display_name: msg.display_name });
      renderIncoming();
      if (!callActive) toast(`Incoming call${msg.display_name ? ` from ${msg.display_name}` : ''}.`, { kind: 'info', title: 'Phone line' });
      break;
    case 'cancel':
    case 'taken':
      ringing.delete(msg.caller_id);
      renderIncoming();
      if (phone && phone.callerId === msg.caller_id && !mic.running) { toast('The caller hung up.', { kind: 'warn' }); endCall({ remote: true }); }
      break;
    case 'signal':
      if (phone) phone.link.handleSignal(msg.data).catch((e) => console.error(e));
      break;
    case 'transcript':
      // Optional phone-side transcript: only used when the laptop can't transcribe.
      if (!phone || !callActive || asrWorks !== false) break;
      if (msg.final) { onFinalTranscript(String(msg.text || '').trim()); renderTranscript(''); }
      else renderTranscript(String(msg.text || ''));
      break;
    case 'hangup':
      if (phone) { toast('The caller hung up.', { kind: 'info', title: 'Phone line' }); endCall({ remote: true }); }
      break;
    default: break;
  }
}

function onCallSocketState(st) {
  const el = $('#phone-line');
  el.textContent = st === 'open' ? `Phone line: ready. Callers dial in from ${location.origin}/caller.html`
    : st === 'denied' ? 'Phone line: wrong access code (open this page with ?code=…).'
      : 'Phone line: connecting…';
  if (st !== 'open') { ringing.clear(); renderIncoming(); }
}

function renderIncoming() {
  const first = [...ringing.entries()].pop();
  $('#incoming').hidden = !first || callActive;
  if (!first) return;
  const [, r] = first;
  $('#incoming-who').textContent = `Incoming call · ${r.display_name || 'unknown caller'}${ringing.size > 1 ? ` (+${ringing.size - 1} waiting)` : ''}`;
}

async function answerPhone() {
  const first = [...ringing.entries()].pop();
  if (!first || callActive) return;
  const [callerId, r] = first;
  let local;
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
  } catch (e) {
    toast(`Allow the microphone so the caller can hear you (${e.name || e.message}).`, { kind: 'error', title: 'Microphone' });
    return;
  }
  ringing.delete(callerId);
  const sel = $('#customer-select');
  if (r.customer_id && [...sel.options].some((o) => o.value === r.customer_id)) sel.value = r.customer_id;
  else sel.value = '';
  onCustomerChange();
  phone = { callerId, local, el: null, link: null };
  phone.link = new PeerLink({
    sendSignal: (data) => callSock.send({ type: 'signal', data }),
    onRemoteStream: (stream) => startPhoneCapture(stream),
    onState: (s) => {
      if (s === 'failed' && phone) { toast('The call audio connection failed.', { kind: 'error', title: 'Phone line' }); endCall(); }
    },
  });
  phone.link.addStream(local);
  callSock.send({ type: 'accept', caller_id: callerId });
  beginCall('Connecting…');
  $('#manual-actions').hidden = false;
  renderIncoming();
}

async function startPhoneCapture(stream) {
  if (!phone || phone.el) return;
  phone.el = playStream(stream);
  try {
    mic.reset();
    await mic.start({ stream });
  } catch (e) {
    toast(`Could not capture the caller's audio: ${e.message || e}`, { kind: 'error' });
    return;
  }
  mic.onended = null;
  // Transcribe the caller on this laptop: Chrome speech recognition fed the call's audio track; if this
  // Chrome can't do that, the local Whisper service (if running); otherwise the agent uses the buttons.
  try {
    if (!SR) throw new Error('no SpeechRecognition');
    startRecognition({ track: mic.tapTrack() });
    setTranscriptNote("Transcribing the caller's call audio on this laptop.");
  } catch (e) {
    console.warn('SpeechRecognition cannot take the call audio track; trying local Whisper', e);
    stopRecognition();
    startCallerAsr();
  }
  callStartedAt = performance.now();
  $('#call-state').textContent = 'On call · phone';
}

// ---------------------------------------------------------------- laptop transcription of the caller (phone calls)
// The caller's audio is already in `mic`; cut it into utterances at pauses and transcribe them with the
// local Whisper service (/api/transcribe). No cloud speech service and nothing runs on the phone.
const UTT_PREROLL = 0.3;        // s of audio kept before speech starts
const UTT_END_SILENCE = 0.7;    // s of silence that ends an utterance
const UTT_MAX = 8;              // s, hard cut for long monologues
const UTT_MIN_VOICED = 0.5;     // s of voiced audio needed to bother transcribing
const VOICE_RMS = 0.01;         // ~ -40 dBFS
let asr = null;                 // { off, seg, segLen, voiced, silence, queue, busy }
let asrWorks = null;            // null = untested, true = transcribing on the laptop, false = service missing

function startCallerAsr() {
  stopCallerAsr();
  asr = { seg: null, segLen: 0, voiced: 0, silence: 0, queue: [], busy: false };
  asr.off = mic.onData(onCallerAudio);
}

function stopCallerAsr() {
  if (asr && asr.off) asr.off();
  asr = null;
}

function onCallerAudio(x) {
  if (!asr) return;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const secs = x.length / SAMPLE_RATE;
  const voiced = Math.sqrt(sum / x.length) > VOICE_RMS;
  if (!asr.seg) {
    if (!voiced) return;
    asr.seg = [mic.getLast(UTT_PREROLL + secs)];  // ring buffer already holds x
    asr.segLen = asr.seg[0].length / SAMPLE_RATE;
    asr.voiced = secs;
    asr.silence = 0;
    return;
  }
  asr.seg.push(x);
  asr.segLen += secs;
  if (voiced) { asr.voiced += secs; asr.silence = 0; } else asr.silence += secs;
  if (asr.silence >= UTT_END_SILENCE || asr.segLen >= UTT_MAX) flushUtterance();
}

function flushUtterance() {
  const { seg, voiced } = asr;
  asr.seg = null;
  if (voiced < UTT_MIN_VOICED) return;
  let n = 0;
  for (const p of seg) n += p.length;
  const all = new Float32Array(n);
  let o = 0;
  for (const p of seg) { all.set(p, o); o += p.length; }
  if (asr.queue.length >= 3) asr.queue.shift();  // falling behind: drop the oldest
  asr.queue.push(all);
  pumpAsr();
}

async function pumpAsr() {
  if (!asr || asr.busy || !asr.queue.length) return;
  const mine = asr;
  mine.busy = true;
  const samples = mine.queue.shift();
  renderTranscript('…');
  try {
    const fd = new FormData();
    fd.append('file', encodeWav(samples, SAMPLE_RATE), 'utterance.wav');
    fd.append('language', $('#lang-select').value);
    const res = await api.transcribe(fd);
    if (asrWorks !== true) { asrWorks = true; setTranscriptNote('Transcribing the caller on this laptop (local Whisper).'); }
    const text = String((res && res.text) || '').trim();
    if (text && phone && callActive) onFinalTranscript(text);
  } catch (e) {
    if (e.code === 'asr_unavailable' || e.code === 'network') {
      asrWorks = false;
      setTranscriptNote('Laptop transcription is off: start the GPU service (.\\run_cloner.ps1). Use the action buttons meanwhile.');
      mine.queue.length = 0;
    } else {
      console.warn('transcribe failed', e);
    }
  } finally {
    mine.busy = false;
    if (phone && callActive) renderTranscript('');
    pumpAsr();
  }
}

function declinePhone() {
  const first = [...ringing.entries()].pop();
  if (!first) return;
  callSock.send({ type: 'decline', caller_id: first[0] });
  ringing.delete(first[0]);
  renderIncoming();
}

// ---------------------------------------------------------------- speech recognition
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recWanted = false;
let recNetErrors = 0;
let transcriptLines = []; // {text, auto}

/** Live transcript. With `track` (a phone call's incoming audio) Chrome transcribes the caller instead of the
 *  laptop mic; throws if this Chrome can't take an audio track. */
function startRecognition({ track = null } = {}) {
  if (!SR) return;
  recWanted = true;
  setTranscriptNote('');
  rec = new SR();
  rec.lang = $('#lang-select').value;
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
    renderTranscript(interim);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      recWanted = false;
      setTranscriptNote('Speech recognition was blocked — keyword auto-trigger is unavailable. Use the action buttons.');
    } else if (e.error === 'network') {
      recNetErrors++;
      setTranscriptNote('Speech service unreachable (Chrome needs internet for live transcripts). Use the action buttons.');
      if (recNetErrors >= 3) recWanted = false;
    } else if (e.error === 'audio-capture') {
      setTranscriptNote('Speech recognition could not access the microphone.');
    }
  };
  rec.onend = () => {
    if (rec !== me) return;
    if (recWanted && callActive) {
      setTimeout(() => {
        if (rec === me && recWanted && callActive) { try { track ? me.start(track) : me.start(); } catch { /* already started */ } }
      }, 250);
    }
  };
  if (track) { rec.start(track); return; }
  try { rec.start(); } catch (e) { console.warn('SpeechRecognition start failed', e); }
}

function stopRecognition() {
  recWanted = false;
  const r = rec;
  rec = null;
  if (r) { try { r.onend = null; r.stop(); } catch { /* ignore */ } }
  renderTranscript('');
}

function setTranscriptNote(t) { $('#transcript-note').textContent = t; }

function highlight(text) {
  const ranges = keywordRanges(text);
  let html = '', at = 0;
  for (const [a, b] of ranges) {
    html += esc(text.slice(at, a)) + `<mark>${esc(text.slice(a, b))}</mark>`;
    at = b;
  }
  return html + esc(text.slice(at));
}

function renderTranscript(interim) {
  const box = $('#transcript');
  if (!transcriptLines.length && !interim) {
    box.innerHTML = callActive
      ? `<span class="faint">Listening… (${esc($('#lang-select').selectedOptions[0].textContent)})</span>`
      : `<span class="faint">Transcript appears here during the call.</span>`;
    return;
  }
  const lines = transcriptLines.slice(-30).map((l) => `<p class="line">${highlight(l.text)}</p>`).join('');
  box.innerHTML = lines + (interim ? `<p class="line interim">${esc(interim)}</p>` : '');
  box.scrollTop = box.scrollHeight;
}

function onFinalTranscript(text) {
  if (!text) return;
  transcriptLines.push({ text });
  if (transcriptLines.length > 200) transcriptLines.shift();
  maybeAutoTrigger(text);
}

// ---------------------------------------------------------------- keyword auto-trigger
function maybeAutoTrigger(text) {
  if (!$('#auto-toggle').checked || !callActive) return;
  const hit = detectAction(text);
  if (!hit) return;
  const now = Date.now();
  if (now - lastAutoAt < AUTO_COOLDOWN_MS) return;
  if (inFlight) return;
  let amount = null;
  if (hit.action === 'fund_transfer') {
    amount = parseAmount(text);
    if (amount) setAmount(amount);
  }
  pendingAuto = { action: hit.action, amount, transcript: text.slice(-300), at: now, match: hit.match };
  tryFirePendingAuto();
}

function tryFirePendingAuto() {
  if (!pendingAuto) return;
  if (Date.now() - pendingAuto.at > PENDING_AUTO_TTL_MS || !callActive || !$('#auto-toggle').checked) { pendingAuto = null; return; }
  if (inFlight || mic.bufferedSeconds < MIN_SECONDS) return;
  const p = pendingAuto;
  pendingAuto = null;
  lastAutoAt = Date.now();
  flashAction(p.action);
  toast(`Heard “${p.match}” — checking the caller's voice for ${ACTIONS[p.action]}${p.amount ? ` ${fmtINR(p.amount)}` : ''}.`, { kind: 'info', title: 'Auto-trigger', timeout: 3500 });
  runMicCheck({ action: p.action, trigger: 'keyword', transcript: p.transcript, amount: p.action === 'fund_transfer' ? (p.amount || getAmount()) : null });
}

function flashAction(action) {
  const b = $(`.action-btn[data-action="${action}"]`);
  if (!b) return;
  b.classList.remove('fired');
  void b.offsetWidth;
  b.classList.add('fired');
}

function renderAutoStatus() {
  const el = $('#auto-status');
  if (!SR) { el.textContent = 'Live transcript is not available in this browser — open the page in Google Chrome.'; el.className = 'auto-status'; return; }
  const left = AUTO_COOLDOWN_MS - (Date.now() - lastAutoAt);
  if (pendingAuto) { el.textContent = 'keyword heard — waiting for 5 s of audio…'; el.className = 'auto-status armed'; }
  else if (inFlight) { el.textContent = 'check in progress…'; el.className = 'auto-status'; }
  else if (left > 0) { el.textContent = `next check possible in ${Math.ceil(left / 1000)} s`; el.className = 'auto-status'; }
  else if (callActive) { el.textContent = '● Listening — say a request with one of the keywords above'; el.className = 'auto-status armed'; }
  else { el.textContent = 'Press Start call to begin listening.'; el.className = 'auto-status'; }
}

// ---------------------------------------------------------------- amount
function getAmount() {
  const v = Math.round(Number($('#amount').value));
  return v > 0 ? v : null;
}
function setAmount(v) {
  $('#amount').value = String(v);
  renderAmount();
}
function renderAmount() {
  const v = getAmount();
  $('#amount-fmt').textContent = v ? fmtINR(v) : '';
}

// ---------------------------------------------------------------- checks
async function ensureLiveConsent(kind) {
  if (!isLive()) return true;
  if (sessionGet('cs.liveConsent') === '1') return true;
  const cost = (status && status.state.cost_per_check) || 100;
  const avail = status && status.state.credits && status.state.credits.available;
  const ok = await confirmDialog({
    title: 'Run a live DetectifAI check?',
    body: `This ${kind} runs speaker verification + deepfake detection on DetectifAI and uses <b>~${cost} credits</b>` +
      (typeof avail === 'number' ? ` (${fmtNum(avail)} available).` : '.') +
      ` You won't be asked again this session.`,
    ok: 'Run live check',
  });
  if (ok) sessionSet('cs.liveConsent', '1');
  return ok;
}

async function onActionClick(action) {
  if (inFlight) { toast('A check is already running — one at a time to save credits.', { kind: 'warn' }); return; }
  const buffered = mic.bufferedSeconds;
  if (!mic.running && buffered === 0) {
    toast('Start the call first — CallShield needs the caller\'s voice.', { kind: 'warn', title: 'No audio' });
    return;
  }
  if (buffered < MIN_SECONDS) {
    toast(`Keep talking… need at least ${MIN_SECONDS} s of the caller's voice (have ${buffered.toFixed(1)} s).`, { kind: 'warn', title: 'Not enough audio' });
    return;
  }
  if (!(await ensureLiveConsent('check'))) return;
  flashAction(action);
  runMicCheck({ action, trigger: 'manual', amount: action === 'fund_transfer' ? getAmount() : null, transcript: lastTranscriptText() });
}

function lastTranscriptText() {
  const last = transcriptLines[transcriptLines.length - 1];
  return last ? last.text.slice(-300) : '';
}

function runMicCheck({ action, trigger, amount, transcript }) {
  const secs = Math.min(CLIP_SECONDS, mic.bufferedSeconds);
  if (secs < MIN_SECONDS) {
    toast(`Keep talking… need ${MIN_SECONDS} s of audio (have ${secs.toFixed(1)} s).`, { kind: 'warn' });
    return;
  }
  const samples = mic.getLast(secs);
  const speech = estimateSpeechSeconds(samples, SAMPLE_RATE);
  if (speech < MIN_SPEECH_SECONDS) {
    toast(`Only ~${speech.toFixed(1)} s of speech in the last ${secs.toFixed(0)} s — keep talking (no credits spent).`, { kind: 'warn', title: 'Too quiet' });
    return;
  }
  const blob = encodeWav(samples, SAMPLE_RATE);
  return submitCheck({ blob, filename: 'clip.wav', seconds: secs, action, trigger, amount, transcript, source: 'mic' });
}

async function onUploadCheck() {
  if (!uploadFile) return;
  if (inFlight) { toast('A check is already running.', { kind: 'warn' }); return; }
  if (!(await ensureLiveConsent('uploaded-clip check'))) return;
  const action = $('#upload-action').value;
  return submitCheck({
    blob: uploadFile, filename: uploadFile.name || 'upload.wav', seconds: null, action, trigger: 'upload',
    amount: action === 'fund_transfer' ? getAmount() : null, transcript: '', source: 'upload',
  });
}

// Ready-made deepfake samples (frontend/samples/samples.json): pick one -> it becomes the upload clip,
// with the matching target customer and action preselected. Judges can then press "Check clip".
let sampleAudio = null;
async function setupSamples() {
  let list = [];
  try {
    const r = await fetch('/samples/samples.json', { cache: 'no-store' });
    if (r.ok) list = (await r.json()).samples || [];
  } catch { /* no samples shipped */ }
  if (!list.length) return;
  const pick = $('#sample-pick');
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.label;
    pick.appendChild(o);
  }
  $('#sample-row').hidden = false;
  pick.addEventListener('change', async () => {
    const s = list.find((x) => x.id === pick.value);
    if (sampleAudio) { sampleAudio.pause(); sampleAudio = null; }
    $('#btn-sample-play').disabled = !s;
    if (!s) return;
    try {
      const r = await fetch('/' + s.file);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      uploadFile = new File([blob], s.file.split('/').pop(), { type: blob.type || 'audio/wav' });
      $('#upload-name').textContent = `Sample: ${s.label}`;
      if (s.action) $('#upload-action').value = s.action;
      const sel = $('#customer-select');
      if (s.customer_id && [...sel.options].some((o) => o.value === s.customer_id)) {
        sel.value = s.customer_id;
        sel.dispatchEvent(new Event('change'));
      }
      $('#btn-upload').disabled = inFlight;
    } catch (e) {
      toast(`Couldn't load the sample (${e.message}).`, { kind: 'error' });
    }
  });
  $('#btn-sample-play').addEventListener('click', () => {
    const s = list.find((x) => x.id === pick.value);
    if (!s) return;
    if (sampleAudio && !sampleAudio.paused) { sampleAudio.pause(); return; }
    sampleAudio = new Audio('/' + s.file);
    sampleAudio.play().catch(() => toast('Tap again to play audio.', { kind: 'warn' }));
  });
}

async function submitCheck({ blob, filename, seconds, action, trigger, amount, transcript, source }) {
  if (inFlight) return;
  inFlight = true;
  setActionsDisabled(true);
  const cust = selectedCustomer();
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('customer_id', cust ? cust.customer_id : '');
  fd.append('action', action);
  if (amount != null && action === 'fund_transfer') fd.append('amount', String(amount));
  fd.append('call_id', callId || randomId('call'));
  fd.append('trigger', trigger);
  if (transcript) fd.append('transcript', transcript);
  if (isMock()) {
    const sc = document.querySelector('input[name="scenario"]:checked');
    fd.append('mock_scenario', sc ? sc.value : 'genuine');
  }
  const t0 = performance.now();
  showBusy({ seconds, source, action, amount, cust });
  try {
    const a = await api.check(fd);
    const rtt = Math.round(performance.now() - t0);
    a._rtt = rtt;
    upsertAssessment(a, true);
    renderAssessment(a, { animate: true });
    if (a.credits && typeof a.credits.balance === 'number') status.setBalance(a.credits.balance);
    status.refresh();
  } catch (e) {
    showVerdict(current ? 'result' : 'idle');
    showError(e, 'Check failed');
    status.refresh();
  } finally {
    stopBusy();
    inFlight = false;
    setActionsDisabled(false);
  }
}

function setActionsDisabled(d) {
  for (const b of $$('.action-btn')) b.disabled = d;
  $('#btn-upload').disabled = d || !uploadFile;
}

// ---------------------------------------------------------------- verdict panel
function showVerdict(which) {
  $('#verdict-idle').hidden = which !== 'idle';
  $('#verdict-busy').hidden = which !== 'busy';
  $('#verdict-result').hidden = which !== 'result';
}

let busyTimer = null;
function showBusy({ seconds, source, action, amount, cust }) {
  showVerdict('busy');
  $('#verdict-badge').innerHTML = isMock() ? '<span class="badge badge-mock">Mock</span>' : '';
  const who = cust ? esc(cust.display_name || cust.customer_id) : 'unknown caller';
  $('#busy-title').innerHTML = `Checking ${esc(ACTIONS[action])}${amount && action === 'fund_transfer' ? ` ${esc(fmtINR(amount))}` : ''} for ${who}`;
  const steps = [
    source === 'mic' ? `Captured last ${seconds.toFixed(1)} s of caller audio · 16 kHz WAV` : 'Uploaded clip attached',
    cust ? 'DetectifAI · speaker verification + deepfake detection (one request)' : 'DetectifAI · deepfake detection',
    'CallShield risk engine → decision',
  ];
  const ul = $('#busy-steps');
  ul.innerHTML = steps.map((s, i) => `<li class="${i === 0 ? 'done' : i === 1 ? 'active' : ''}"><span class="tick">${i === 0 ? ICONS.check : i === 1 ? '<span class="spinner" style="width:14px;height:14px"></span>' : '•'}</span>${esc(s)}</li>`).join('');
  const t0 = performance.now();
  clearInterval(busyTimer);
  busyTimer = setInterval(() => { $('#busy-timer').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
}
function stopBusy() { clearInterval(busyTimer); busyTimer = null; }

function toneForScore(score, thr) {
  if (score >= thr) return 'danger';
  if (score >= thr * 0.6) return 'warn';
  return 'ok';
}

function renderAssessment(a, { animate = false } = {}) {
  current = a;
  showVerdict('result');
  const risk = a.risk || {};
  const d = decisionMeta(risk.decision);
  const mock = a.mode === 'mock';
  $('#verdict-badge').innerHTML = mock ? '<span class="badge badge-mock">Mock result</span>' : '<span class="badge badge-live">Live · DetectifAI</span>';
  $('#verdict-time').textContent = a.created_at ? fmtTime(a.created_at) : '';

  // banner
  const banner = $('#decision-banner');
  banner.className = `decision-banner tone-${d.tone}`;
  $('#decision-icon').innerHTML = d.tone === 'danger' ? ICONS.shieldX : d.tone === 'warn' ? ICONS.alert : ICONS.shieldCheck;
  $('#decision-word').innerHTML = `${esc(d.word)}${mock ? ' <span class="badge badge-mock">Mock</span>' : ''}`;
  $('#decision-sub').textContent = d.sub;
  const who = a.customer_name || a.customer_id || 'Unknown caller';
  const amt = a.action === 'fund_transfer' && a.amount ? `<span class="amt">${esc(fmtINR(a.amount))}</span><br>` : '';
  $('#decision-ctx').innerHTML = `<b>${esc(a.action_label || ACTIONS[a.action] || a.action || '')}</b>${amt}caller claims: ${esc(who)}<br><span class="faint">${esc(TRIGGERS[a.trigger] || a.trigger || '')}</span>`;
  if (animate) { void banner.offsetWidth; banner.classList.add('animate'); }

  // gauge
  const score = Math.max(0, Math.min(100, Math.round(Number(risk.score) || 0)));
  const gv = $('#gauge-value');
  const toneColor = { ok: '#2ecc71', warn: '#ffb020', danger: '#ff4d3d' }[score >= 70 ? 'danger' : score >= 35 ? 'warn' : 'ok'];
  gv.setAttribute('stroke', toneColor);
  if (animate) { gv.style.transition = 'none'; gv.setAttribute('stroke-dashoffset', '100'); void gv.getBoundingClientRect(); gv.style.transition = ''; }
  requestAnimationFrame(() => gv.setAttribute('stroke-dashoffset', String(100 - Math.max(score, 0.5))));
  countUp($('#risk-num'), score, animate ? 900 : 0);
  const lvl = $('#risk-level');
  const level = risk.level || (score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low');
  lvl.className = `chip gauge-level ${level === 'high' ? 'danger' : level === 'medium' ? 'warn' : 'ok'}`;
  lvl.textContent = `${level} risk`;

  // reasons
  const reasons = Array.isArray(risk.reasons) ? risk.reasons : [];
  $('#reasons').innerHTML = reasons.length
    ? reasons.map((r) => `<li class="${reasonTone(r)}">${esc(r)}</li>`).join('')
    : '<li>No risk factors.</li>';
  renderAlertLine(a);

  // signals
  renderDeepfakeCard(a);
  renderSpeakerCard(a);

  // proof + feedback
  renderProof(a);
  renderFeedback(a);
  highlightLogRow(a.check_id);
}

function reasonTone(r) {
  const s = r.toLowerCase();
  if (/inconclusive|not sure|uncertain|unavailable|could not|error/.test(s)) return 'r-warn';
  if (/synthetic|fake|does not match|no match|not match|blocked|deepfake/.test(s)) return 'r-danger';
  if (/high-risk|not enrolled|unverified|weak|uncertain|not sure|unavailable|error|skipped/.test(s)) return 'r-warn';
  if (/real|human|match|verified|genuine/.test(s)) return 'r-ok';
  return '';
}

function renderAlertLine(a) {
  const el = $('#alert-line');
  const alert = a.alert || {};
  const reply = replyOf(a);
  let replyHtml = '';
  if (reply === 'not_me') replyHtml = '<span class="reply not_me">Customer replied: NOT ME — fraud reported</span>';
  else if (reply === 'me') replyHtml = '<span class="reply me">Customer confirmed: it was me</span>';
  else if (alert.sent) replyHtml = '<span class="reply pending">Awaiting customer response…</span>';
  if (alert.sent) {
    el.innerHTML = `${ICONS.bell}<span>Customer alerted via <b>${esc(alert.channel || 'trusted channel')}</b></span>${replyHtml ? ' · ' + replyHtml : ''}`;
  } else {
    el.innerHTML = `${ICONS.shieldCheck}<span class="muted">No customer alert needed.</span>${replyHtml ? ' · ' + replyHtml : ''}`;
  }
}

function barHtml({ value, min = 0, max = 1, threshold, tone, thLabel }) {
  const pct = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  return `<div class="bar">
      <div class="bar-fill ${tone}" data-w="${pct(value).toFixed(1)}"></div>
      ${threshold != null ? `<div class="bar-th" style="left:${pct(threshold).toFixed(1)}%"><span>${esc(thLabel || threshold)}</span></div>` : ''}
      <span class="bar-scale l">${min}</span><span class="bar-scale r">${max}</span>
    </div>`;
}

function animateBars(root) {
  const fills = root.querySelectorAll('.bar-fill');
  requestAnimationFrame(() => requestAnimationFrame(() => { fills.forEach((f) => { f.style.width = `${f.dataset.w}%`; }); }));
}

function renderDeepfakeCard(a) {
  const el = $('#sig-deepfake');
  const df = a.deepfake;
  const head = (chip) => `<div class="sig-head"><h3>Is this voice real?</h3>${chip}</div>`;
  if (!df) {
    el.innerHTML = head('<span class="chip neutral">Not available</span>') +
      `<div class="sig-empty">Deepfake detection didn't return a result for this clip — see the reasons.</div>`;
    return;
  }
  const thr = typeof df.threshold === 'number' ? df.threshold : 0.62;
  const score = Number(df.score) || 0;
  const verdict = (df.verdict || '').toLowerCase();
  const chip = verdict === 'fake' ? '<span class="chip danger">Synthetic</span>'
    : verdict === 'real' ? '<span class="chip ok">Real human</span>'
      : '<span class="chip warn">Not sure</span>';
  const tone = verdict === 'fake' ? 'danger' : verdict === 'real' ? toneForScore(score, thr) : 'warn';
  const segs = Array.isArray(df.segments) ? df.segments : [];
  const dur = Math.max(Number(a.audio_seconds) || 0, Number(df.duration_seconds) || 0, ...segs.map((s) => Number(s.end) || 0)) || 1;
  const strip = segs.length
    ? `<div class="seg-strip" title="Per-segment synthetic score">${segs.map((s) => {
      const st = Math.max(0, Number(s.start) || 0), en = Math.min(dur, Number(s.end) || 0);
      const sc = Number(s.score) || 0;
      const col = { ok: '46,204,113', warn: '255,176,32', danger: '255,77,61' }[toneForScore(sc, thr)];
      return `<i style="left:${(st / dur * 100).toFixed(2)}%;width:${(Math.max(0, en - st) / dur * 100).toFixed(2)}%;background:rgba(${col},${(0.45 + 0.55 * Math.min(1, sc)).toFixed(2)})" title="${st.toFixed(1)}–${en.toFixed(1)} s · ${sc.toFixed(2)}"></i>`;
    }).join('')}</div><div class="seg-scale"><span>0 s</span><span>segment timeline</span><span>${dur.toFixed(1)} s</span></div>`
    : '';
  el.innerHTML = head(chip) +
    `<div class="sig-value"><span class="num" style="color:var(--${tone === 'ok' ? 'text' : tone})">${score.toFixed(2)}</span><span class="cap">synthetic-voice score</span></div>` +
    barHtml({ value: score, threshold: thr, tone, thLabel: `threshold ${thr.toFixed(2)}` }) + strip +
    (df.decided_by ? `<div class="sig-foot">decided by <span class="mono">${esc(df.decided_by)}</span></div>` : '');
  animateBars(el);
}

function renderSpeakerCard(a) {
  const el = $('#sig-speaker');
  const sp = a.speaker;
  const head = (chip) => `<div class="sig-head"><h3>Is this the claimed speaker?</h3>${chip}</div>`;
  if (!sp) {
    const enrolled = a.customer_id && customers.some((c) => c.customer_id === a.customer_id);
    el.innerHTML = head('<span class="chip neutral">Not checked</span>') +
      `<div class="sig-empty">${a.customer_id ? (enrolled ? 'Speaker verification did not return a result.' : 'Customer has no enrolled voiceprint.') : 'Unknown caller — no voiceprint to compare against. Identity unverified.'}</div>`;
    return;
  }
  const sim = Number(sp.similarity) || 0;
  const thr = typeof sp.threshold === 'number' ? sp.threshold : 0.5;
  const match = sp.decision === 'match';
  const weak = match && sim < thr + 0.1;
  const tone = !match ? 'danger' : weak ? 'warn' : 'ok';
  const chip = !match ? '<span class="chip danger">No match</span>' : weak ? '<span class="chip warn">Weak match</span>' : '<span class="chip ok">Match</span>';
  const min = sim < 0 ? -1 : 0;
  el.innerHTML = head(chip) +
    `<div class="sig-value"><span class="num" style="color:var(--${tone === 'ok' ? 'text' : tone})">${sim.toFixed(2)}</span><span class="cap">voice similarity to ${esc(a.customer_name || a.customer_id || 'customer')}</span></div>` +
    barHtml({ value: sim, min, max: 1, threshold: thr, tone, thLabel: `threshold ${thr.toFixed(2)}` }) +
    `<div class="sig-foot">${match ? 'Voice matches the enrolled voiceprint' : 'Voice does not match the enrolled voiceprint'}${a.deepfake && a.deepfake.verdict === 'fake' && match ? ' — <b style="color:var(--warn)">clones often still match; the deepfake signal catches them</b>' : ''}</div>`;
  animateBars(el);
}

function renderProof(a) {
  const sep = '<span class="sep">·</span>';
  const parts = [];
  parts.push(a.mode === 'mock' ? '<b style="color:var(--warn)">MOCK</b>' : '<b style="color:var(--ok)">LIVE</b>');
  if (a.latency_ms != null) parts.push(`<b>${fmtNum(Math.round(a.latency_ms))} ms</b> server`);
  if (a._rtt != null) parts.push(`${fmtNum(a._rtt)} ms round-trip`);
  if (a.credits) parts.push(`<b>${fmtNum(a.credits.charged)}</b> credits charged${typeof a.credits.balance === 'number' ? ` (bal ${fmtNum(a.credits.balance)})` : ''}`);
  else parts.push('0 credits');
  if (a.audio_seconds != null) parts.push(`${Number(a.audio_seconds).toFixed(1)} s audio`);
  const ids = [];
  if (a.check_id) ids.push(`check <b>${esc(a.check_id)}</b>`);
  (a.request_ids || []).forEach((r) => ids.push(`req <b>${esc(r)}</b>`));
  if (a.deepfake && a.deepfake.operation_id) ids.push(`deepfake op <b>${esc(a.deepfake.operation_id)}</b>`);
  if (a.speaker && a.speaker.operation_id) ids.push(`verify op <b>${esc(a.speaker.operation_id)}</b>`);
  $('#proof').innerHTML = parts.join(sep) + (ids.length ? `<br>${ids.join(sep)}` : '');
}

function renderFeedback(a) {
  const el = $('#feedback');
  const op = a.deepfake && a.deepfake.operation_id;
  if (!op) { el.innerHTML = ''; return; }
  if (feedbackGiven.has(a.check_id)) { el.innerHTML = '<span class="muted">Thanks — feedback recorded.</span>'; return; }
  el.innerHTML = `<span>Was this right?</span>
    <button type="button" class="btn btn-ghost" data-correct="true" title="Yes, correct">${ICONS.thumbUp}<span>Yes</span></button>
    <button type="button" class="btn btn-ghost" data-correct="false" title="No, wrong">${ICONS.thumbDown}<span>No</span></button>`;
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const correct = b.dataset.correct === 'true';
    el.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try {
      const res = await api.feedback(op, correct);
      feedbackGiven.add(a.check_id);
      if (res && res.ok === false) {
        el.innerHTML = '<span class="muted">Feedback noted locally (DetectifAI did not accept it).</span>';
      } else {
        el.innerHTML = `<span class="muted">Thanks — feedback ${a.mode === 'mock' ? 'recorded (mock)' : 'sent to DetectifAI'}.</span>`;
      }
    } catch (e) {
      el.innerHTML = `<span class="muted">Feedback not sent (${esc(e.message)}).</span>`;
    }
  }));
}

function countUp(el, to, ms) {
  if (!ms) { el.textContent = String(to); return; }
  const t0 = performance.now();
  const from = 0;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = String(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- audit log
function upsertAssessment(a, fresh = false) {
  if (!a || !a.check_id) return;
  const existed = assessments.has(a.check_id);
  const prev = assessments.get(a.check_id);
  if (prev && prev._rtt != null && a._rtt == null) a._rtt = prev._rtt;
  if (prev && replyOf(prev) && !replyOf(a)) a.customer_response = prev.customer_response;
  assessments.set(a.check_id, a);
  if (!existed) {
    order.unshift(a.check_id);
    order.sort((x, y) => String(assessments.get(y).created_at || '').localeCompare(String(assessments.get(x).created_at || '')));
    if (order.length > 100) { for (const id of order.splice(100)) assessments.delete(id); }
  }
  renderLog(!existed && fresh ? a.check_id : null);
}

function renderLog(freshId) {
  const body = $('#log-body');
  $('#log-count').textContent = order.length ? `${order.length} assessment${order.length === 1 ? '' : 's'}` : '';
  if (!order.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No assessments yet.</td></tr>'; return; }
  body.innerHTML = order.slice(0, 50).map((id) => {
    const a = assessments.get(id);
    const d = decisionMeta(a.risk && a.risk.decision);
    const reply = replyOf(a);
    const replyHtml = reply === 'not_me' ? '<span class="reply not_me">NOT ME</span>'
      : reply === 'me' ? '<span class="reply me">It was me</span>'
        : a.alert && a.alert.sent ? '<span class="reply pending">awaiting…</span>' : '<span class="faint">—</span>';
    const amt = a.action === 'fund_transfer' && a.amount ? ` <span class="muted">${esc(fmtINR(a.amount))}</span>` : '';
    const cls = ['clickable', current && current.check_id === id ? 'selected' : '', freshId === id ? 'fresh' : ''].join(' ');
    return `<tr class="${cls}" data-id="${esc(id)}">
      <td class="mono">${esc(fmtTime(a.created_at))}</td>
      <td>${esc(a.customer_name || a.customer_id || 'Unknown caller')}</td>
      <td>${esc(a.action_label || ACTIONS[a.action] || a.action || '')}${amt}</td>
      <td><span class="chip ${d.tone} dec-cell">${esc(d.word)}</span></td>
      <td class="tnum"><b>${a.risk ? esc(a.risk.score) : '—'}</b></td>
      <td class="muted">${esc(TRIGGERS[a.trigger] || a.trigger || '')}</td>
      <td>${a.mode === 'mock' ? '<span class="badge badge-mock">Mock</span>' : '<span class="badge badge-live">Live</span>'}</td>
      <td>${replyHtml}</td>
    </tr>`;
  }).join('');
}

function highlightLogRow(id) {
  for (const tr of $$('#log-body tr[data-id]')) tr.classList.toggle('selected', tr.dataset.id === id);
}

async function loadAssessments() {
  try {
    const res = await api.assessments(50);
    for (const a of ((res && res.assessments) || []).slice().reverse()) upsertAssessment(a);
  } catch (e) {
    if (e.code !== 'network') showError(e, 'Could not load the audit log');
  }
}

/** /?check=<check_id> (e.g. the Attack Lab's "Open in Agent Console" link) opens that verdict. */
function openCheckFromUrl() {
  let id = null;
  try { id = new URLSearchParams(location.search).get('check'); } catch { id = null; }
  const a = id ? assessments.get(id) : null;
  if (a && !inFlight) renderAssessment(a, { animate: true });
}

function onCustomerResponse(r) {
  if (!r || !r.check_id) return;
  const a = assessments.get(r.check_id);
  if (a) {
    a.customer_response = { response: r.response, created_at: r.created_at };
    renderLog();
    if (current && current.check_id === r.check_id) renderAlertLine(a);
  }
  const who = a ? (a.customer_name || a.customer_id || 'Customer') : 'Customer';
  if (r.response === 'not_me') toast(`${who} replied NOT ME on their registered phone — treat this call as fraud.`, { kind: 'error', title: 'Customer replied: NOT ME', timeout: 9000 });
  else if (r.response === 'me') toast(`${who} confirmed it was them.`, { kind: 'ok', title: 'Customer replied: it was me' });
  const fb = (r.auto_feedback || []).filter((f) => f.ok);
  if (fb.length) {
    const parts = fb.map((f) => `${f.signal} verdict ${f.correct ? 'correct' : 'wrong'}`).join(', ');
    toast(`Reported to DetectifAI: ${parts}.`, { kind: 'info', title: 'Feedback loop', timeout: 6000 });
  }
}

// ---------------------------------------------------------------- render loop
const canvas = () => $('#wave');
function tick() {
  const buffered = mic.bufferedSeconds;
  const winSecs = Math.min(CLIP_SECONDS, buffered);
  drawPeaks(canvas(), mic.getPeaks(), { highlightFrac: buffered >= 0.1 ? winSecs / 10 : 0 });
  const fill = $('#buffer-fill');
  fill.style.width = `${(winSecs / CLIP_SECONDS) * 100}%`;
  const ready = buffered >= MIN_SECONDS;
  fill.classList.toggle('ready', ready);
  const lbl = $('#buffer-label');
  lbl.textContent = `buffer: ${winSecs.toFixed(1)} s`;
  lbl.classList.toggle('ready', ready);
  $('#level-fill').style.width = `${(mic.running ? mic.meterLevel : 0) * 100}%`;
  if (callActive) {
    const s = Math.floor((performance.now() - callStartedAt) / 1000);
    $('#call-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  tryFirePendingAuto();
  renderAutoStatus();
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- session storage helpers
function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------------------------------------------------------------- wiring
function wire() {
  $('#btn-start').addEventListener('click', startCall);
  $('#btn-end').addEventListener('click', () => endCall());
  $('#btn-answer').addEventListener('click', answerPhone);
  $('#btn-decline').addEventListener('click', declinePhone);
  $('#customer-select').addEventListener('change', onCustomerChange);
  $('#lang-select').addEventListener('change', () => {
    sessionSet('cs.lang', $('#lang-select').value);
    if (callActive && SR && !phone) { stopRecognition(); startRecognition(); }
    renderTranscript('');
  });
  for (const b of $$('.action-btn')) b.addEventListener('click', () => onActionClick(b.dataset.action));
  $('#amount').addEventListener('input', renderAmount);
  $('#auto-toggle').addEventListener('change', () => { sessionSet('cs.auto', $('#auto-toggle').checked ? '1' : '0'); if (!$('#auto-toggle').checked) pendingAuto = null; });
  for (const r of $$('input[name="scenario"]')) r.addEventListener('change', () => sessionSet('cs.scenario', r.value));
  $('#upload-file').addEventListener('change', (e) => {
    uploadFile = e.target.files && e.target.files[0] ? e.target.files[0] : null;
    $('#upload-action').value = 'fund_transfer';
    $('#upload-name').textContent = uploadFile ? `${uploadFile.name} · ${(uploadFile.size / 1024).toFixed(0)} KB` : 'No file chosen';
    $('#btn-upload').disabled = !uploadFile || inFlight;
  });
  $('#btn-upload').addEventListener('click', onUploadCheck);
  setupSamples();
  $('#log-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || inFlight) return;
    const a = assessments.get(tr.dataset.id);
    if (a) renderAssessment(a, { animate: true });
  });
  window.addEventListener('focus', () => { if (!inFlight) loadCustomers(); });
  window.addEventListener('beforeunload', () => { if (phone) endCall(); stopRecognition(); mic.stop(); });

  // restore per-session preferences
  const lang = sessionGet('cs.lang');
  if (lang) $('#lang-select').value = lang;
  $('#auto-toggle').checked = true;  // checks are triggered by spoken keywords only
  const sc = sessionGet('cs.scenario');
  if (sc) { const r = document.querySelector(`input[name="scenario"][value="${sc}"]`); if (r) r.checked = true; }

  if (!SR) {
    $('#transcript-wrap').hidden = true;
    $('#transcript-unsupported').hidden = false;
    $('#auto-toggle').checked = false;
    $('#auto-toggle').disabled = true;
    $('#auto-wrap').title = 'Needs Chrome speech recognition';
  }
  if (!MicCapture.isSupported()) {
    $('#btn-start').disabled = true;
    toast('This browser cannot capture the microphone. Use desktop Chrome on localhost/https.', { kind: 'error', timeout: 0 });
  }
}

function main() {
  initStaticUi();
  wire();
  renderAmount();
  renderTranscript('');
  showVerdict('idle');
  status = initStatus({ onChange: renderCostNote });
  renderCostNote();
  loadCustomers();
  loadAssessments().then(openCheckFromUrl);
  connectEvents({
    assessment: (a) => upsertAssessment(a, true),
    customer_response: onCustomerResponse,
  }, {
    onState: setSseDot,
    onReconnect: () => { loadAssessments(); status.refresh(); },
  });
  callSock = callSocket('agent', { onMessage: onCallMessage, onState: onCallSocketState });
  requestAnimationFrame(tick);
}

main();
