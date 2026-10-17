// CallShield — Attack Lab (attack.html). Laptop-only red-team tool: emulate a fraud call to the bank's
// virtual agent. Pick the victim, give the call a "request" clip and a "passphrase" clip (ready-made sample,
// uploaded file, or a clone of a consenting voice), then dial the receive screen exactly like the phone app.
// The call carries ONLY the clips (no microphone — the laptop also runs the receive screen). Clips are timed
// to Neerja by the `state` messages she forwards; manual play buttons are the fallback.
import { api, connectEvents } from './api.js';
import { callSocket, PeerLink, playStream } from './call.js';
import { MicCapture, encodeWav, estimateSpeechSeconds, SAMPLE_RATE } from './audio.js';
import { $, $$, esc, fmtNum, fmtTime, decisionMeta, ICONS, toast, showError } from './ui.js';

const REF_MIN = 15;          // mic reference minimum (s)
const REF_AUTO_STOP = 40;    // mic reference auto-stop (s)
const MAX_TEXT = 400;
const CLIP_KINDS = ['request', 'passphrase'];
const ENGINE_LABELS = { local: 'Local GPU model', elevenlabs: 'ElevenLabs' };

const DEFAULT_REQUEST_TEXT = "Hi, I'd like to transfer fifty thousand rupees to my brother's account, please.";

const STEPS = [
  { id: 'calling', label: 'Calling' },
  { id: 'greeting', label: 'Greeting' },
  { id: 'request', label: 'Request sent' },
  { id: 'passphrase', label: 'Passphrase sent' },
  { id: 'verifying', label: 'Verifying' },
  { id: 'outcome', label: 'Outcome' },
];
const STATE_TO_STEP = {
  greeting: 'greeting',
  listening_request: 'request',
  listening_passphrase: 'passphrase',
  verifying: 'verifying',
  approved: 'outcome', blocked: 'outcome', human: 'outcome',
};
const STATE_TEXT = {
  greeting: 'Neerja is greeting the caller.',
  listening_request: 'Neerja is listening — playing the request clip.',
  listening_passphrase: 'Neerja asked for the passphrase — playing the passphrase clip.',
  verifying: 'Neerja is verifying the voice with DetectifAI.',
  approved: 'Approved.',
  blocked: 'Blocked.',
  human: 'Handed to a human agent.',
};

// ---------------------------------------------------------------- state
const mic = new MicCapture({ ringSeconds: 2 });
let lab = null;                 // /api/attack/status
let prompts = null;
let customers = [];
let reference = null;           // { blob, name, seconds, source }
let recording = false;

const clips = { request: null, passphrase: null };

// live call
let sock = null, link = null, bankAudio = null;
let callCtx = null, callDest = null, monitorGain = null, callClips = null;
let callActive = false, dialed = false, callStartIso = null;
let latestAssessment = null;

// ---------------------------------------------------------------- clip model
function makeClip(kind) {
  return {
    kind,
    source: 'sample',
    sampleId: '',
    text: kind === 'request' ? DEFAULT_REQUEST_TEXT : '',
    engine: 'local',
    cloning: false,
    stores: { sample: null, upload: null, clone: null }, // each: { blob, name, url, seconds }
  };
}
function activeStore(kind) { const c = clips[kind]; return c.stores[c.source]; }
function clipReady(kind) { return !!activeStore(kind); }

function setStore(kind, source, blob, name) {
  const c = clips[kind];
  const old = c.stores[source];
  if (old && old.url) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(blob);
  const store = { blob, name, url, seconds: null };
  c.stores[source] = store;
  probeDuration(url).then((s) => { store.seconds = s; if (c.source === source) renderClip(kind); });
  renderClip(kind);
  updateCallControls();
}

function probeDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => resolve(null);
    a.src = url;
  });
}

// ---------------------------------------------------------------- cloner status
async function loadLab() {
  setClonerDot('warn', 'Checking…');
  try {
    lab = await api.attackStatus(true);
  } catch (e) {
    lab = { enabled: true, cloner: null, cloner_error: { message: e.message } };
  }
  renderCloner();
  syncEngineOptions();
}

function engineInfo(name) {
  const engines = (lab && lab.cloner && lab.cloner.engines) || {};
  const e = engines[name];
  return e && typeof e === 'object' ? e : null;
}
const engineAvailable = (name) => { const e = engineInfo(name); return !!(e && e.available); };
const clonerReady = () => !!(lab && lab.cloner);

function setClonerDot(tone, text) {
  const dot = $('#cloner-dot');
  dot.className = `dot ${tone === 'ok' ? 'live' : tone}`;
  $('#cloner-pill').textContent = text;
}

function renderCloner() {
  const state = $('#cloner-state');
  const eng = $('#cloner-engines');
  if (!clonerReady()) {
    const msg = (lab && lab.cloner_error && lab.cloner_error.message) || 'The voice-cloning service is not reachable.';
    setClonerDot('danger', 'Cloner offline');
    state.innerHTML = '<span class="badge danger">Offline</span>';
    eng.innerHTML = `${esc(msg)} Sample and upload clips still work; cloning needs the cloner.`;
    $('#btn-warmup').hidden = true;
  } else {
    const ok = lab.cloner.ok !== false;
    setClonerDot(ok ? 'ok' : 'warn', ok ? 'Cloner online' : 'Cloner degraded');
    state.innerHTML = ok ? '<span class="badge ok">Online</span>' : '<span class="badge warn">Degraded</span>';
    const local = engineInfo('local');
    const el = engineInfo('elevenlabs');
    const localLine = local
      ? `${local.available ? '<span class="dot live"></span>' : '<span class="dot"></span>'} Local GPU ${local.available ? (local.loaded ? '<span class="badge ok">loaded</span>' : '<span class="badge warn">cold</span>') : '<span class="badge neutral">unavailable</span>'}`
      : '<span class="dot"></span> Local GPU <span class="faint">not reported</span>';
    const elLine = `${el && el.available ? '<span class="dot live"></span>' : '<span class="dot"></span>'} ElevenLabs ${el && el.available ? '<span class="badge ok">ready</span>' : '<span class="badge neutral">not configured</span>'}`;
    eng.innerHTML = `<span class="eng">${localLine}</span><span class="eng">${elLine}</span>`;
    $('#btn-warmup').hidden = !(local && local.available && !local.loaded);
  }
  syncEngineOptions();
}

async function warmup() {
  const btn = $('#btn-warmup');
  btn.disabled = true;
  const t0 = performance.now();
  try {
    await api.attackWarmup();
    toast(`Model ready in ${((performance.now() - t0) / 1000).toFixed(1)} s.`, { kind: 'ok', title: 'Cloner warmed up' });
  } catch (e) {
    showError(e, 'Warm-up failed');
  } finally {
    btn.disabled = false;
    loadLab();
  }
}

// ---------------------------------------------------------------- reference voice (shared, for cloning)
async function toggleRecord() {
  if (recording) return stopRecord();
  try {
    mic.reset();
    await mic.start();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? 'Microphone permission was denied.' : `Could not start the microphone: ${e.message || e}`, { kind: 'error', title: 'Microphone' });
    return;
  }
  clearReference();
  mic.startRecording();
  mic.onended = () => { if (recording) stopRecord(); };
  recording = true;
  $('#btn-rec').classList.add('recording');
  $('#btn-rec').textContent = `Stop (min ${REF_MIN} s)`;
  setRecStatus('Recording — read aloud at a natural pace.', '');
  requestAnimationFrame(recTick);
}

function recTick() {
  if (!recording) return;
  const s = mic.recordedSeconds;
  $('#rec-timer').textContent = `${s.toFixed(1)} s`;
  $('#rec-level').style.width = `${Math.round(mic.meterLevel * 100)}%`;
  $('#btn-rec').textContent = s >= REF_MIN ? 'Stop & review' : `Stop (min ${REF_MIN} s)`;
  if (s >= REF_AUTO_STOP) { stopRecord(true); return; }
  requestAnimationFrame(recTick);
}

function stopRecord(auto = false) {
  if (!recording) return;
  recording = false;
  const samples = mic.stopRecording();
  mic.stop();
  $('#btn-rec').classList.remove('recording');
  $('#btn-rec').textContent = 'Record reference';
  $('#rec-level').style.width = '0%';
  const seconds = samples.length / SAMPLE_RATE;
  const speech = estimateSpeechSeconds(samples, SAMPLE_RATE);
  let ok = true, problem = '';
  if (seconds < REF_MIN) { ok = false; problem = `Too short (${seconds.toFixed(1)} s) — record at least ${REF_MIN} s.`; }
  else if (speech < 6) { ok = false; problem = `Only ~${speech.toFixed(0)} s of speech — speak closer to the mic.`; }
  if (!ok) { setRecStatus(problem, 'error'); return; }
  setReference({ blob: encodeWav(samples, SAMPLE_RATE), name: 'reference.wav', seconds, source: 'mic' });
  setRecStatus(`${auto ? `Auto-stopped at ${REF_AUTO_STOP} s. ` : ''}${seconds.toFixed(1)} s recorded. Tick consent, then generate a clone.`, 'ok');
}

function setRecStatus(text, kind) {
  const el = $('#rec-status');
  el.textContent = text;
  el.className = `rec-status small ${kind === 'error' ? 'is-error' : kind === 'ok' ? 'is-ok' : 'muted'}`;
}

function setReference(ref) {
  clearReference();
  reference = ref;
  reference.url = URL.createObjectURL(ref.blob);
  $('#ref-preview').src = reference.url;
  $('#ref-take').hidden = false;
  $('#ref-label').textContent = ref.source === 'mic' ? `Recorded · ${ref.seconds.toFixed(1)} s` : `File${ref.seconds ? ` · ${ref.seconds.toFixed(1)} s` : ''}`;
  updateCloneControls();
}

function clearReference() {
  if (reference && reference.url) URL.revokeObjectURL(reference.url);
  reference = null;
  $('#ref-preview').removeAttribute('src');
  $('#ref-take').hidden = true;
  updateCloneControls();
}

async function onRefFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (recording) stopRecord();
  const url = URL.createObjectURL(f);
  const seconds = await probeDuration(url);
  URL.revokeObjectURL(url);
  setReference({ blob: f, name: f.name || 'reference-upload', seconds, source: 'file' });
  setRecStatus(`Using "${f.name}"${seconds != null ? ` (${seconds.toFixed(1)} s)` : ''}. It must be your own voice.`, 'ok');
}

// ---------------------------------------------------------------- clip cards
function clipTitle(kind) { return kind === 'request' ? 'Request clip' : 'Passphrase clip'; }
function clipSub(kind) {
  return kind === 'request' ? 'What the fraudster asks for.' : "The victim's spoken passphrase.";
}

function renderClipCards() {
  $('#clips').innerHTML = CLIP_KINDS.map((kind) => `
    <div class="clip" data-kind="${kind}">
      <div class="clip-head"><div class="card-title">${esc(clipTitle(kind))}</div><div class="card-sub">${esc(clipSub(kind))}</div></div>
      <div class="segmented" role="radiogroup" aria-label="Source for ${esc(clipTitle(kind))}">
        <label><input type="radio" name="src-${kind}" value="sample" checked><span>Sample</span></label>
        <label><input type="radio" name="src-${kind}" value="upload"><span>Upload</span></label>
        <label><input type="radio" name="src-${kind}" value="clone"><span>Clone</span></label>
      </div>
      <div class="src-panel" data-src="sample">
        <label class="field">
          <span class="label">Ready-made sample</span>
          <select id="sample-${kind}" aria-label="Sample clip"></select>
        </label>
      </div>
      <div class="src-panel" data-src="upload" hidden>
        <label class="btn btn-ghost btn-block file-btn"><input type="file" id="file-${kind}" accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac"><span>Upload an audio file</span></label>
      </div>
      <div class="src-panel" data-src="clone" hidden>
        <label class="field">
          <span class="label">Text to say</span>
          <textarea id="text-${kind}" rows="3" maxlength="${MAX_TEXT}" spellcheck="true"></textarea>
        </label>
        <div class="row">
          <div class="segmented small" role="radiogroup" aria-label="Cloning engine">
            <label><input type="radio" name="engine-${kind}" value="local" checked><span>Local GPU</span></label>
            <label><input type="radio" name="engine-${kind}" value="elevenlabs"><span>ElevenLabs</span></label>
          </div>
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm" id="clone-${kind}">Generate clone</button>
        </div>
        <p class="clone-hint small muted" id="clone-hint-${kind}"></p>
      </div>
      <div class="clip-preview">
        <audio id="preview-${kind}" controls preload="metadata"></audio>
        <span class="badge neutral" id="dur-${kind}"></span>
      </div>
    </div>`).join('');

  for (const kind of CLIP_KINDS) {
    clips[kind] = makeClip(kind);
    $(`#text-${kind}`).value = clips[kind].text;
    for (const r of $$(`input[name="src-${kind}"]`)) {
      r.addEventListener('change', () => { clips[kind].source = r.value; showSrcPanel(kind); renderClip(kind); updateCallControls(); });
    }
    $(`#sample-${kind}`).addEventListener('change', (e) => onSamplePick(kind, e.target.value));
    $(`#file-${kind}`).addEventListener('change', (e) => onClipFile(kind, e));
    $(`#text-${kind}`).addEventListener('input', (e) => { clips[kind].text = e.target.value; updateCloneControls(); });
    for (const r of $$(`input[name="engine-${kind}"]`)) {
      r.addEventListener('change', () => { clips[kind].engine = r.value; updateCloneControls(); });
    }
    $(`#clone-${kind}`).addEventListener('click', () => generateClone(kind));
    showSrcPanel(kind);
    renderClip(kind);
  }
}

function showSrcPanel(kind) {
  const card = $(`.clip[data-kind="${kind}"]`);
  for (const p of $$('.src-panel', card)) p.hidden = p.dataset.src !== clips[kind].source;
}

function renderClip(kind) {
  const store = activeStore(kind);
  const el = $(`#preview-${kind}`);
  const dur = $(`#dur-${kind}`);
  if (store) {
    if (el.src !== store.url) el.src = store.url;
    dur.hidden = false;
    dur.textContent = store.seconds != null ? `${store.seconds.toFixed(1)} s` : 'clip ready';
  } else {
    el.removeAttribute('src');
    dur.hidden = true;
  }
}

function fillSampleSelects() {
  const opts = '<option value="">Choose a sample…</option>' +
    currentSamples.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  for (const kind of CLIP_KINDS) $(`#sample-${kind}`).innerHTML = opts;
}

async function onSamplePick(kind, id) {
  clips[kind].sampleId = id;
  if (!id) { setStore(kind, 'sample', null); return; }
  const s = currentSamples.find((x) => x.id === id);
  if (!s) return;
  try {
    const res = await fetch(`/${s.file.replace(/^\/+/, '')}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    setStore(kind, 'sample', blob, s.file.split('/').pop());
  } catch (e) {
    toast(`Could not load sample "${s.label}".`, { kind: 'error', title: 'Sample' });
    console.error(e);
  }
}

function onClipFile(kind, e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  setStore(kind, 'upload', f, f.name || 'clip-upload');
}

async function generateClone(kind) {
  const c = clips[kind];
  if (c.cloning) return;
  if (!reference) { toast('Add a reference voice first.', { kind: 'warn', title: 'Clone' }); return; }
  if (!$('#consent').checked) { toast('Tick the consent box — only your own voice.', { kind: 'warn', title: 'Consent' }); return; }
  const text = $(`#text-${kind}`).value.trim();
  if (!text) { toast('Write what the clone should say.', { kind: 'warn', title: 'Clone' }); return; }
  if (!clonerReady()) { toast('The cloner is offline.', { kind: 'warn', title: 'Clone' }); return; }
  const engine = c.engine;
  if (!engineAvailable(engine)) { toast(`${ENGINE_LABELS[engine]} is not available.`, { kind: 'warn', title: 'Clone' }); return; }

  const btn = $(`#clone-${kind}`);
  c.cloning = true;
  btn.disabled = true;
  btn.textContent = 'Cloning…';
  const fd = new FormData();
  fd.append('reference', reference.blob, reference.name);
  fd.append('text', text);
  fd.append('engine', engine);
  fd.append('language', 'en');
  fd.append('consent', 'true');
  try {
    const res = await api.attackClone(fd);
    setStore(kind, 'clone', res.blob, `clone-${kind}.wav`);
    // switch the clip to the fresh clone
    c.source = 'clone';
    const radio = $(`input[name="src-${kind}"][value="clone"]`);
    if (radio) radio.checked = true;
    showSrcPanel(kind);
    renderClip(kind);
    updateCallControls();
    toast(`${clipTitle(kind)} cloned with ${ENGINE_LABELS[res.engine || engine] || engine}.`, { kind: 'ok', title: 'Voice cloned' });
    if (engine === 'local') loadLab();
  } catch (e) {
    showError(e, 'Cloning failed');
    if (e.code === 'cloner_unavailable') loadLab();
  } finally {
    c.cloning = false;
    btn.disabled = false;
    btn.textContent = 'Generate clone';
    updateCloneControls();
  }
}

function syncEngineOptions() {
  for (const kind of CLIP_KINDS) {
    for (const r of $$(`input[name="engine-${kind}"]`)) {
      const avail = engineAvailable(r.value);
      r.disabled = !avail;
      r.closest('label').classList.toggle('disabled', !avail);
    }
    const sel = clips[kind] && $(`input[name="engine-${kind}"]:checked`);
    if (sel && sel.disabled) {
      const alt = $$(`input[name="engine-${kind}"]`).find((r) => !r.disabled);
      if (alt) { alt.checked = true; clips[kind].engine = alt.value; }
    }
  }
  updateCloneControls();
}

function updateCloneControls() {
  const consent = $('#consent').checked;
  $('#consent-wrap').classList.toggle('need', !!reference && !consent);
  for (const kind of CLIP_KINDS) {
    const c = clips[kind];
    const btn = $(`#clone-${kind}`);
    const engineOk = engineAvailable(c.engine);
    const canClone = clonerReady() && !!reference && consent && c.text.trim().length > 0 && engineOk && !c.cloning;
    btn.disabled = !canClone;
    const hint = $(`#clone-hint-${kind}`);
    if (!clonerReady()) hint.textContent = 'Cloner offline.';
    else if (!reference) hint.textContent = 'Add a reference voice above.';
    else if (!consent) hint.textContent = 'Tick the consent box above.';
    else if (!engineOk) hint.textContent = 'This engine is unavailable.';
    else if (!c.text.trim()) hint.textContent = 'Write what the clone should say.';
    else hint.textContent = 'Ready to generate.';
  }
}

// ---------------------------------------------------------------- target
async function loadCustomers() {
  try {
    const res = await api.customers();
    customers = (res && res.customers) || [];
  } catch (e) {
    customers = [];
    if (e.code !== 'network') showError(e, 'Could not load customers');
  }
  const sel = $('#target');
  const prev = sel.value;
  sel.innerHTML = customers.map((c) => `<option value="${esc(c.customer_id)}">${esc(c.display_name || c.customer_id)} · ${esc(c.customer_id)}</option>`).join('');
  $('#target-empty').hidden = customers.length > 0;
  sel.disabled = customers.length === 0;
  if (prev && customers.some((c) => c.customer_id === prev)) sel.value = prev;
  renderTarget();
}

function selectedCustomer() {
  const id = $('#target').value;
  return customers.find((c) => c.customer_id === id) || null;
}

function renderTarget() {
  const box = $('#passphrase-box');
  const c = selectedCustomer();
  const phrase = prompts && prompts.passphrase;
  box.hidden = !(c && phrase);
  if (c && phrase) $('#passphrase-text').textContent = phrase;
  updateCallControls();
}

// ---------------------------------------------------------------- live call
function updateCallControls() {
  const ready = !!selectedCustomer() && clipReady('request') && clipReady('passphrase');
  const btn = $('#btn-call');
  btn.disabled = !ready || callActive;
  const hint = $('#call-hint');
  if (callActive) hint.textContent = 'Call in progress.';
  else if (!selectedCustomer()) hint.textContent = 'Pick a victim in step 1.';
  else if (!clipReady('request')) hint.textContent = 'Set the request clip in step 2.';
  else if (!clipReady('passphrase')) hint.textContent = 'Set the passphrase clip in step 2.';
  else hint.textContent = 'Make sure the receive screen is online, then place the call.';
}

async function buildCallClips() {
  const AC = window.AudioContext || window.webkitAudioContext;
  callCtx = new AC();
  if (callCtx.state === 'suspended') { try { await callCtx.resume(); } catch { /* ignore */ } }
  callDest = callCtx.createMediaStreamDestination();
  monitorGain = callCtx.createGain();
  monitorGain.gain.value = 0.85;           // let the presenter hear the clips locally
  monitorGain.connect(callCtx.destination);
  callClips = {};
  for (const kind of CLIP_KINDS) {
    const store = activeStore(kind);
    if (!store) continue;
    const el = new Audio();
    el.preload = 'auto';
    el.src = store.url;
    const node = callCtx.createMediaElementSource(el);
    node.connect(callDest);            // into the outgoing WebRTC stream
    node.connect(monitorGain);         // and quietly to the local speakers
    callClips[kind] = { el, node };
  }
}

function playClipIntoCall(kind) {
  const c = callClips && callClips[kind];
  if (!c) return;
  try {
    c.el.pause();
    c.el.currentTime = 0;
    c.el.play().catch((e) => console.warn('clip playback blocked', e));
  } catch (e) { console.warn(e); }
}

async function placeCall() {
  if ($('#btn-call').disabled) return;
  const cust = selectedCustomer();
  if (!cust) return;
  try {
    await buildCallClips();
  } catch (e) {
    showError(e, 'Audio setup failed');
    return;
  }
  callActive = true;
  dialed = false;
  latestAssessment = null;
  callStartIso = new Date().toISOString();
  $('#btn-call').hidden = true;
  $('#btn-hangup').hidden = false;
  $('#manual').hidden = false;
  $('#outcome').hidden = true;
  renderTracker('calling');
  setStateLine('calling', 'Calling the bank…');
  updateCallControls();

  sock = callSocket('caller', {
    onMessage: onCallMessage,
    onState: (st) => {
      if (st === 'open' && callActive && !dialed) {
        dialed = true;
        sock.send({ type: 'dial', customer_id: cust.customer_id, display_name: cust.display_name || cust.customer_id });
      } else if (st === 'denied') {
        toast('The call socket rejected this connection.', { kind: 'error', title: 'Call' });
        endCall();
      }
    },
  });
}

function onCallMessage(msg) {
  switch (msg.type) {
    case 'ringing':
      renderTracker('calling');
      setStateLine('calling', 'Ringing the bank…');
      break;
    case 'no_agent':
      toast('No bank agent online. Open the receive screen and click Go online.', { kind: 'warn', title: 'No agent' });
      endCall();
      break;
    case 'declined':
      toast('The bank declined the call.', { kind: 'warn', title: 'Declined' });
      endCall();
      break;
    case 'accepted':
      startPeer();
      setStateLine('calling', 'Connected — waiting for Neerja.');
      break;
    case 'signal':
      if (link) link.handleSignal(msg.data);
      break;
    case 'state':
      onBotState(msg.state, msg.text);
      break;
    case 'hangup':
      setStateLine(null, 'The bank ended the call.');
      finishCall();
      break;
    default:
      break;
  }
}

async function startPeer() {
  link = new PeerLink({
    sendSignal: (data) => sock && sock.send({ type: 'signal', data }),
    onRemoteStream: (stream) => { if (!bankAudio) bankAudio = playStream(stream); },
    onState: (st) => { if (st === 'failed') toast('The call connection failed.', { kind: 'error', title: 'Call' }); },
  });
  link.addStream(callDest.stream);
  try {
    await link.offer();
  } catch (e) {
    showError(e, 'Could not start the call');
    endCall();
  }
}

function onBotState(state, text) {
  const step = STATE_TO_STEP[state];
  if (step) renderTracker(step);
  setStateLine(state, text || STATE_TEXT[state] || state);
  if (state === 'listening_request') playClipIntoCall('request');
  else if (state === 'listening_passphrase') playClipIntoCall('passphrase'); // replays on a repeated ask
  else if (state === 'approved' || state === 'blocked' || state === 'human') {
    // Neerja hangs up right after; keep the outcome and resolve it from the assessment.
    resolveOutcome();
  }
}

function setStateLine(state, text) {
  const line = $('#state-line');
  line.hidden = false;
  $('#state-text').textContent = text || '';
  const dot = line.querySelector('.dot');
  const terminal = state === 'approved' || state === 'blocked' || state === 'human' || state == null;
  dot.className = terminal ? 'dot' : 'dot live';
}

function renderTracker(activeId) {
  const activeIdx = STEPS.findIndex((s) => s.id === activeId);
  $('#tracker').innerHTML = STEPS.map((s, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    return `<li class="${cls}"><span class="t-dot"></span>${esc(s.label)}</li>`;
  }).join('');
}

function hangUp() {
  if (sock) sock.send({ type: 'hangup' });
  setStateLine(null, 'You ended the call.');
  finishCall();
}

// end the call with no outcome resolution (ringing failures, denials)
function endCall() {
  teardown();
  renderTracker(null);
  $('#state-line').hidden = true;
}

// end the call and try to show the verdict
function finishCall() {
  teardown();
  renderTracker('outcome');
  resolveOutcome();
}

function teardown() {
  callActive = false;
  dialed = false;
  if (sock) { try { sock.close(); } catch { /* ignore */ } sock = null; }
  if (link) { try { link.close(); } catch { /* ignore */ } link = null; }
  if (bankAudio) { try { bankAudio.pause(); bankAudio.srcObject = null; } catch { /* ignore */ } bankAudio = null; }
  if (callClips) { for (const k of Object.keys(callClips)) { try { callClips[k].el.pause(); } catch { /* ignore */ } } }
  callClips = null;
  if (callCtx) { try { callCtx.close(); } catch { /* ignore */ } callCtx = null; }
  callDest = null; monitorGain = null;
  $('#btn-call').hidden = false;
  $('#btn-hangup').hidden = true;
  $('#manual').hidden = true;
  updateCallControls();
}

// ---------------------------------------------------------------- outcome
async function resolveOutcome() {
  if (latestAssessment) { renderOutcome(latestAssessment); return; }
  try {
    const res = await api.assessments(20);
    const list = (res && res.assessments) || [];
    const cust = selectedCustomer();
    const start = callStartIso ? Date.parse(callStartIso) - 2000 : 0;
    const match = list.find((a) => a.customer_id === (cust && cust.customer_id) && Date.parse(a.created_at) >= start);
    if (match) { latestAssessment = match; renderOutcome(match); }
    else showOutcomePending();
  } catch (e) {
    console.warn('could not load assessment', e);
    showOutcomePending();
  }
}

function showOutcomePending() {
  const box = $('#outcome');
  box.hidden = false;
  box.className = 'outcome';
  box.innerHTML = `<span class="muted small">Call ended. Waiting for CallShield's verdict…</span>`;
}

function renderOutcome(a) {
  const box = $('#outcome');
  const risk = a.risk || {};
  const d = decisionMeta(risk.decision);
  const icon = d.tone === 'danger' ? ICONS.shieldX : d.tone === 'warn' ? ICONS.alert : ICONS.shieldCheck;

  const sp = a.speaker;
  let spTone = 'neutral', spWord = 'Not checked';
  if (sp) {
    const sim = Number(sp.similarity) || 0;
    const thr = typeof sp.threshold === 'number' ? sp.threshold : 0.5;
    const match = sp.decision === 'match';
    spTone = match ? 'ok' : 'danger';
    spWord = `${match ? 'Match' : 'No match'} · ${sim.toFixed(2)}`;
  }
  const df = a.deepfake;
  const dfVerdict = df ? (df.verdict || '').toLowerCase() : null;
  const dfTone = dfVerdict === 'fake' ? 'danger' : dfVerdict === 'real' ? 'ok' : 'warn';
  const dfWord = dfVerdict === 'fake' ? 'Synthetic' : dfVerdict === 'real' ? 'Real human' : df ? 'Not sure' : 'n/a';
  const dfSub = df ? ` · ${Number(df.score || 0).toFixed(2)}` : '';

  const gotThrough = risk.decision === 'APPROVE';
  box.hidden = false;
  box.className = `outcome tone-${d.tone}`;
  box.innerHTML = `
    <div class="outcome-head">
      <span class="outcome-icon">${icon}</span>
      <div>
        <div class="outcome-word">${esc(d.word)}</div>
        <div class="muted small">${gotThrough ? 'The attack got through on this call.' : 'CallShield stopped the attack.'}</div>
      </div>
      <span class="spacer"></span>
      <span class="faint small mono">${esc(fmtTime(a.created_at))}</span>
    </div>
    <div class="outcome-stats">
      <span class="badge ${spTone}">Voice ${esc(spWord)}</span>
      <span class="badge ${dfTone}">Deepfake ${esc(dfWord)}${esc(dfSub)}</span>
      <span class="badge neutral">Risk ${fmtNum(Math.round(Number(risk.score) || 0))}</span>
    </div>`;
}

function onAssessmentEvent(a) {
  const cust = selectedCustomer();
  if (!cust || a.customer_id !== cust.customer_id) return;
  const start = callStartIso ? Date.parse(callStartIso) - 2000 : 0;
  if (Date.parse(a.created_at) < start) return;
  latestAssessment = a;
  if (!callActive) renderOutcome(a);
}

// ---------------------------------------------------------------- bootstrap
let currentSamples = [];

async function loadPrompts() {
  try {
    const r = await fetch('/voice/agent/prompts.json', { cache: 'no-store' });
    prompts = r.ok ? await r.json() : null;
  } catch { prompts = null; }
  if (prompts && prompts.passphrase) $('#text-passphrase').value = prompts.passphrase;
  if (clips.passphrase) clips.passphrase.text = (prompts && prompts.passphrase) || '';
  renderTarget();
  updateCloneControls();
}

async function loadSamples() {
  try {
    const r = await fetch('/samples/samples.json', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    currentSamples = (j && Array.isArray(j.samples)) ? j.samples : [];
  } catch { currentSamples = []; }
  fillSampleSelects();
}

function main() {
  renderClipCards();
  renderTracker(null);

  $('#btn-rec').addEventListener('click', toggleRecord);
  $('#ref-file').addEventListener('change', onRefFile);
  $('#btn-ref-discard').addEventListener('click', () => { clearReference(); setRecStatus('Reference discarded.', ''); });
  $('#consent').addEventListener('change', updateCloneControls);
  $('#btn-recheck').addEventListener('click', loadLab);
  $('#btn-warmup').addEventListener('click', warmup);
  $('#target').addEventListener('change', renderTarget);
  $('#btn-call').addEventListener('click', placeCall);
  $('#btn-hangup').addEventListener('click', hangUp);
  $('#btn-play-request').addEventListener('click', () => playClipIntoCall('request'));
  $('#btn-play-passphrase').addEventListener('click', () => playClipIntoCall('passphrase'));

  if (!MicCapture.isSupported()) {
    $('#btn-rec').disabled = true;
    setRecStatus('This browser cannot record audio — upload a reference instead.', 'error');
  }

  connectEvents({ assessment: onAssessmentEvent });

  loadLab();
  loadSamples();
  loadPrompts();
  loadCustomers();

  window.addEventListener('focus', () => { if (!callActive) loadCustomers(); });
  window.addEventListener('beforeunload', () => {
    if (callActive) { try { if (sock) sock.send({ type: 'hangup' }); } catch { /* ignore */ } }
    mic.stop();
    teardown();
    clearReference();
    for (const kind of CLIP_KINDS) {
      const c = clips[kind];
      if (!c) continue;
      for (const s of Object.values(c.stores)) if (s && s.url) URL.revokeObjectURL(s.url);
    }
  });

  updateCallControls();
  updateCloneControls();
}

main();
