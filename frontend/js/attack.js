// CallShield — Attack Lab (attack.html). Local red-team only: clone YOUR OWN voice (with consent) via the
// local cloning service, then fire the clone at /api/check and compare it with your real voice.
import { api } from './api.js';
import { MicCapture, encodeWav, estimateSpeechSeconds, audioFileDuration, SAMPLE_RATE } from './audio.js';
import {
  $, $$, esc, fmtINR, fmtNum, fmtTime, ACTIONS, decisionMeta, ICONS,
  toast, showError, confirmDialog, initStatus, randomId,
} from './ui.js';

const REF_MIN = 15;          // mic take minimum (s)
const REF_AUTO_STOP = 40;    // mic take auto-stop (s)
const UPLOAD_MIN = 6;
const UPLOAD_MAX = 60;
const CHECK_MIN = 4.2;       // DetectifAI deepfake check needs MORE than 4 s
const CHECK_MAX = 60;        // verify accepts up to 60 s
const MAX_TEXT = 400;

const DEFAULT_SCRIPT = "Hi, this is Zain. I'd like to transfer fifty thousand rupees from my savings account to my brother's account today, it's for his college fees.";
const SCRIPTS = [
  { id: 'transfer', label: 'Fund transfer ₹50,000', action: 'fund_transfer', amount: 50000, text: DEFAULT_SCRIPT },
  { id: 'sim', label: 'SIM–OTP reset', action: 'sim_otp_reset',
    text: "Hi, this is Zain. I've lost my phone while travelling, so please reset my SIM and send the OTP to my new number. I need this done on this call, it's really urgent." },
  { id: 'beneficiary', label: 'Add beneficiary', action: 'beneficiary_add',
    text: "Hello, this is Zain. I need to add a new beneficiary to my account today, it's my cousin's account in Mumbai. Please add it on this call so I can send the money tonight." },
  { id: 'limit', label: 'Limit increase', action: 'limit_change',
    text: "Hi, it's Zain here. Can you please increase my daily transfer limit to two lakh rupees? I have a big payment to make for my sister's wedding this week." },
];
const ENGINE_LABELS = { local: 'Local GPU model', elevenlabs: 'ElevenLabs' };

// ---------------------------------------------------------------- state
const mic = new MicCapture({ ringSeconds: 2 });
let status = null;          // header status controller
let lab = null;             // /api/attack/status
let customers = [];
let recording = false;
let ref = null;             // { blob, seconds, speech, source, name, url, ok, problem }
let clone = null;           // { blob, url, seconds, engine, model, genMs, text, createdAt }
let cloning = false;
let checking = null;        // 'real' | 'clone' | null
let liveAudio = null;
const labCallId = randomId('lab');
const results = { real: null, clone: null };

const isMock = () => !!status && status.state.mode === 'mock';

// ---------------------------------------------------------------- lab / cloner status
async function loadLab() {
  $('#cloner-state').innerHTML = '<span class="spinner"></span> Checking…';
  try {
    lab = await api.attackStatus(true);
  } catch (e) {
    lab = { enabled: false, reason: e.code === 'network' ? 'Cannot reach the CallShield server.' : e.message, cloner: null };
  }
  renderLab();
}

function engineInfo(name) {
  const engines = (lab && lab.cloner && lab.cloner.engines) || {};
  const e = engines[name];
  return e && typeof e === 'object' ? e : null;
}
const engineAvailable = (name) => { const e = engineInfo(name); return !!(e && e.available); };

function renderLab() {
  const enabled = !!(lab && lab.enabled);
  $('#lab-disabled').hidden = enabled;
  for (const s of $$('.lab-ref, .lab-script, .lab-attack')) s.hidden = !enabled;
  $('#cloner-box').hidden = !enabled;
  if (!enabled) {
    $('#lab-disabled-reason').textContent = (lab && lab.reason) || "The Attack Lab only runs on the presenter's laptop.";
    validate();
    return;
  }
  const st = $('#cloner-state');
  const eng = $('#cloner-engines');
  if (!lab.cloner) {
    const msg = (lab.cloner_error && lab.cloner_error.message) || 'The voice-cloning service is not reachable.';
    st.innerHTML = `<span class="chip danger">Offline</span>`;
    eng.innerHTML = `<p class="cloner-msg">${esc(msg)}</p><p class="faint small">Start it in a second terminal: <span class="mono">.\\run_cloner.ps1</span> (${esc(lab.cloner_url || 'http://127.0.0.1:8100')}), then Re-check. You can still run <b>Compare with your real voice</b>.</p>`;
    $('#btn-warmup').hidden = true;
  } else {
    const ok = lab.cloner.ok !== false;
    st.innerHTML = ok ? '<span class="chip ok">Online</span>' : '<span class="chip warn">Degraded</span>';
    const local = engineInfo('local');
    const el = engineInfo('elevenlabs');
    const localLine = local
      ? `${local.available ? '<span class="dot ok"></span>' : '<span class="dot off"></span>'}<b>Local GPU</b> <span class="mono faint">${esc([local.model, local.device].filter(Boolean).join(' · ') || '—')}</span> ${local.available ? (local.loaded ? '<span class="chip ok mini">loaded</span>' : '<span class="chip warn mini">cold</span>') : '<span class="chip neutral mini">unavailable</span>'}`
      : '<span class="dot off"></span><b>Local GPU</b> <span class="faint">not reported</span>';
    const elLine = `${el && el.available ? '<span class="dot ok"></span>' : '<span class="dot off"></span>'}<b>ElevenLabs</b> ${el && el.available ? '<span class="chip ok mini">ready</span>' : '<span class="chip neutral mini">not configured</span>'}`;
    eng.innerHTML = `<div class="eng-line">${localLine}</div><div class="eng-line">${elLine}</div>`;
    $('#btn-warmup').hidden = !(local && local.available && !local.loaded);
  }
  // engine selector: disable engines the cloner says are unavailable
  for (const r of $$('input[name="engine"]')) {
    const avail = engineAvailable(r.value);
    r.disabled = !avail;
    r.closest('label').classList.toggle('disabled', !avail);
    r.closest('label').title = avail ? '' : `${ENGINE_LABELS[r.value]} is not available on the cloner`;
  }
  const sel = selectedEngine();
  if (sel && !engineAvailable(sel)) {
    const alt = $$('input[name="engine"]').find((r) => !r.disabled);
    if (alt) alt.checked = true;
  }
  renderEngineNote();
  validate();
}

function selectedEngine() {
  const r = document.querySelector('input[name="engine"]:checked');
  return r ? r.value : null;
}

function renderEngineNote() {
  const e = selectedEngine();
  const info = e ? engineInfo(e) : null;
  const note = $('#engine-note');
  if (!lab || !lab.cloner) note.textContent = 'cloner offline';
  else if (e === 'local' && info && info.available && !info.loaded) note.textContent = 'first run loads the model — warm it up before the demo';
  else if (e === 'elevenlabs') note.textContent = 'cloud API — sends your reference to ElevenLabs';
  else note.textContent = '';
}

async function warmup() {
  const btn = $('#btn-warmup');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Warming up…';
  const t0 = performance.now();
  try {
    await api.attackWarmup();
    toast(`Model ready in ${((performance.now() - t0) / 1000).toFixed(1)} s.`, { kind: 'ok', title: 'Cloner warmed up' });
  } catch (e) {
    showError(e, 'Warm-up failed');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Warm up GPU model';
    loadLab();
  }
}

// ---------------------------------------------------------------- step 1: reference voice
async function toggleRecord() {
  if (recording) return stopRecord();
  if (cloning || checking) return;
  try {
    mic.reset();
    await mic.start();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? 'Microphone permission was denied. Allow mic access and try again.' : `Could not start the microphone: ${e.message || e}`, { kind: 'error', title: 'Microphone' });
    return;
  }
  clearRef();
  mic.startRecording();
  mic.onended = () => { if (recording) stopRecord(); };
  recording = true;
  const btn = $('#btn-rec');
  btn.classList.add('recording');
  setRecStatus('Recording — read the passage in your normal voice.', '');
  validate();
  requestAnimationFrame(recTick);
}

function recTick() {
  if (!recording) return;
  const s = mic.recordedSeconds;
  $('#rec-timer').innerHTML = `${s.toFixed(1)} <small>s</small>`;
  const fill = $('#rec-fill');
  fill.style.width = `${Math.min(100, (s / REF_AUTO_STOP) * 100)}%`;
  fill.classList.toggle('good', s >= REF_MIN);
  $('#rec-level').style.width = `${mic.meterLevel * 100}%`;
  $('#btn-rec').textContent = s >= REF_MIN ? 'Stop & review' : `Stop (min ${REF_MIN} s)`;
  if (s >= 20 && s < 20.1) setRecStatus('~20 s — that is all a fraudster needs. Stop now or keep going up to 40 s.', 'good');
  if (s >= REF_AUTO_STOP) { stopRecord(true); return; }
  requestAnimationFrame(recTick);
}

function stopRecord(auto = false) {
  if (!recording) return;
  recording = false;
  const samples = mic.stopRecording();
  mic.stop();
  const btn = $('#btn-rec');
  btn.classList.remove('recording');
  btn.textContent = 'Record again';
  $('#rec-level').style.width = '0%';
  const seconds = samples.length / SAMPLE_RATE;
  const speech = estimateSpeechSeconds(samples, SAMPLE_RATE);
  let ok = true, problem = '';
  if (seconds < REF_MIN) { ok = false; problem = `Too short (${seconds.toFixed(1)} s) — record at least ${REF_MIN} s.`; }
  else if (speech < 6) { ok = false; problem = `Only ~${speech.toFixed(0)} s of speech detected — speak closer to the mic and record again.`; }
  setRef({ blob: encodeWav(samples, SAMPLE_RATE), seconds, speech, source: 'mic', name: 'reference.wav', ok, problem });
  if (!ok) setRecStatus(problem, 'error');
  else setRecStatus(`${auto ? `Auto-stopped at ${REF_AUTO_STOP} s. ` : ''}${seconds.toFixed(1)} s recorded · ~${speech.toFixed(0)} s of speech. Tick consent, then generate the clone.`, 'good');
  validate();
}

function setRecStatus(text, kind) {
  const el = $('#rec-status');
  el.textContent = text;
  el.className = `rec-status ${kind || ''}`;
}

function setRef(t) {
  clearRef();
  ref = t;
  ref.url = URL.createObjectURL(t.blob);
  $('#ref-preview').src = ref.url;
  $('#ref-take').hidden = false;
  const lbl = $('#ref-label');
  lbl.textContent = t.source === 'mic' ? `Your voice · ${t.seconds.toFixed(1)} s` : `File${t.seconds ? ` · ${t.seconds.toFixed(1)} s` : ''}`;
  lbl.className = `chip ${t.ok ? 'ok' : 'danger'}`;
  results.real = null;
  renderVerdictEmpty('real');
}

function clearRef() {
  if (ref && ref.url) URL.revokeObjectURL(ref.url);
  ref = null;
  $('#ref-preview').removeAttribute('src');
  $('#ref-take').hidden = true;
  validate();
}

async function onRefFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (recording) stopRecord();
  setRecStatus('Reading file…', '');
  const d = await audioFileDuration(f);
  let ok = true, problem = '';
  if (d != null && d < UPLOAD_MIN) { ok = false; problem = `Clip is ${d.toFixed(1)} s — use at least ${UPLOAD_MIN} s (15–40 s works best).`; }
  else if (d != null && d > UPLOAD_MAX) { ok = false; problem = `Clip is ${d.toFixed(1)} s — trim it to at most ${UPLOAD_MAX} s.`; }
  setRef({ blob: f, seconds: d, speech: null, source: 'file', name: f.name || 'reference-upload', ok, problem });
  $('#rec-timer').innerHTML = `${d != null ? d.toFixed(1) : '?'} <small>s</small>`;
  if (ok) setRecStatus(`Using “${f.name}”${d != null ? ` (${d.toFixed(1)} s)` : ''}. It must be your own voice.`, 'good');
  else setRecStatus(problem, 'error');
  validate();
}

// ---------------------------------------------------------------- step 2: script + clone
function renderChips() {
  $('#script-chips').innerHTML = SCRIPTS.map((s) =>
    `<button type="button" class="script-chip" data-id="${esc(s.id)}">${esc(s.label)}</button>`).join('');
}

function pickScript(id) {
  const s = SCRIPTS.find((x) => x.id === id);
  if (!s) return;
  $('#script').value = s.text;
  $('#lab-action').value = s.action;
  if (s.amount) $('#lab-amount').value = String(s.amount);
  markChip(id);
  renderAction();
  renderCount();
  validate();
}

function markChip(id) {
  for (const b of $$('.script-chip')) b.classList.toggle('active', b.dataset.id === id);
}

function renderCount() {
  const n = $('#script').value.length;
  const el = $('#script-count');
  el.textContent = `${n} / ${MAX_TEXT}`;
  el.classList.toggle('over', n > MAX_TEXT);
}

let cloneTimer = null;
async function generateClone() {
  if (!validate() || cloning) return;
  const engine = selectedEngine();
  const text = $('#script').value.trim();
  cloning = true;
  validate();
  stopLive();
  $('#clone-busy').hidden = false;
  const local = engineInfo('local');
  $('#clone-busy-note').textContent = engine === 'local' && local && !local.loaded
    ? 'first local run loads the model — this can take a minute' : `${ENGINE_LABELS[engine]}`;
  const t0 = performance.now();
  clearInterval(cloneTimer);
  cloneTimer = setInterval(() => { $('#clone-elapsed').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
  const fd = new FormData();
  fd.append('reference', ref.blob, ref.name);
  fd.append('text', text);
  fd.append('engine', engine);
  fd.append('language', 'en');
  fd.append('consent', 'true');
  try {
    const res = await api.attackClone(fd);
    const elapsed = performance.now() - t0;
    const seconds = await audioFileDuration(res.blob);
    setClone({ ...res, text, seconds, elapsedMs: elapsed, engine: res.engine || engine, createdAt: new Date().toISOString() });
    toast(`Clone ready${seconds ? ` · ${seconds.toFixed(1)} s of audio` : ''}. Now attack CallShield with it.`, { kind: 'ok', title: 'Voice cloned' });
    if (engine === 'local' && local && !local.loaded) loadLab();
  } catch (e) {
    showError(e, 'Cloning failed');
    if (e.code === 'cloner_unavailable') loadLab();
  } finally {
    clearInterval(cloneTimer);
    cloneTimer = null;
    cloning = false;
    $('#clone-busy').hidden = true;
    validate();
  }
}

function setClone(c) {
  if (clone && clone.url) URL.revokeObjectURL(clone.url);
  clone = c;
  clone.url = URL.createObjectURL(c.blob);
  $('#clone-audio').src = clone.url;
  const dl = $('#clone-download');
  dl.href = clone.url;
  dl.download = `callshield-clone-${clone.engine || 'voice'}-${Date.now().toString(36)}.wav`;
  const gen = clone.genMs != null ? clone.genMs : clone.elapsedMs;
  const parts = [
    ENGINE_LABELS[clone.engine] || clone.engine || 'engine ?',
    clone.model || null,
    gen != null ? `generated in ${(gen / 1000).toFixed(1)} s` : null,
    clone.seconds ? `${clone.seconds.toFixed(1)} s audio` : null,
  ].filter(Boolean);
  $('#clone-meta').textContent = parts.join(' · ');
  $('#clone-result').hidden = false;
  results.clone = null;
  renderVerdictEmpty('clone');
  if (clone.seconds != null && clone.seconds <= CHECK_MIN) {
    toast(`The clone is only ${clone.seconds.toFixed(1)} s — the deepfake check needs more than 4 s. Use a longer script.`, { kind: 'warn', title: 'Clone too short' });
  }
}

// ---------------------------------------------------------------- play into live call
function playLive() {
  if (!clone) return;
  if (liveAudio && !liveAudio.paused) { stopLive(); return; }
  try { $('#clone-audio').pause(); } catch { /* ignore */ }
  liveAudio = new Audio(clone.url);
  liveAudio.volume = 1;
  liveAudio.addEventListener('ended', stopLive);
  liveAudio.play().then(() => {
    $('#btn-play-live').innerHTML = '<span class="live-dot"></span> Stop playback';
    $('#btn-play-live').classList.add('playing');
    toast('Playing the clone at full volume — keep the Agent Console call running so its mic picks it up.', { kind: 'info', title: 'Into the live call', timeout: 5000 });
  }).catch((e) => { showError(e, 'Playback failed'); stopLive(); });
}

function stopLive() {
  if (liveAudio) { try { liveAudio.pause(); } catch { /* ignore */ } liveAudio = null; }
  const b = $('#btn-play-live');
  b.textContent = 'Play into live call';
  b.classList.remove('playing');
}

// ---------------------------------------------------------------- step 3: attack CallShield
async function loadCustomers() {
  try {
    const res = await api.customers();
    customers = (res && res.customers) || [];
  } catch (e) {
    customers = [];
    if (e.code !== 'network') showError(e, 'Could not load customers');
  }
  const sel = $('#target');
  const prev = sel.dataset.loaded ? sel.value : sessionGet('cs.lab.target');
  sel.dataset.loaded = '1';
  sel.innerHTML = '<option value="">Unknown caller (deepfake check only)</option>' +
    customers.map((c) => `<option value="${esc(c.customer_id)}">${esc(c.display_name || c.customer_id)} · ${esc(c.customer_id)}</option>`).join('');
  if (prev === '' || (prev && customers.some((c) => c.customer_id === prev))) sel.value = prev;
  else if (customers.length) sel.value = customers[0].customer_id;
  renderTarget();
}

function selectedCustomer() {
  const id = $('#target').value;
  return customers.find((c) => c.customer_id === id) || null;
}

function renderTarget() {
  const c = selectedCustomer();
  sessionSet('cs.lab.target', c ? c.customer_id : '');
  const hint = $('#target-hint');
  if (c) hint.innerHTML = `The clone claims to be <b>${esc(c.display_name || c.customer_id)}</b> — speaker verification + deepfake detection run against that voiceprint. Pick the customer whose voice you recorded.`;
  else if (!customers.length) hint.innerHTML = `No customers enrolled — <a href="/enroll.html">enroll your real voice</a> first so the clone has someone to impersonate.`;
  else hint.textContent = 'Unknown caller: only deepfake detection runs.';
  validate();
}

function renderAction() {
  $('#amount-wrap').hidden = $('#lab-action').value !== 'fund_transfer';
}

function getAmount() {
  const v = Math.round(Number($('#lab-amount').value));
  return v > 0 ? v : null;
}

function renderCostNote() {
  const el = $('#cost-note');
  if (isMock()) el.innerHTML = '<span class="badge badge-mock">Mock</span> no credits used';
  else {
    const cost = (status && status.state.cost_per_check) || 100;
    el.innerHTML = `${ICONS.coins.replace('<svg ', '<svg width="15" height="15" ')}each check uses <b>~${cost} credits</b>`;
  }
  validate();
}

async function ensureLiveConsent(kind) {
  if (isMock()) return true;
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

function clipProblem(seconds, enrolled) {
  if (seconds == null) return null;
  if (seconds <= CHECK_MIN) return `is ${seconds.toFixed(1)} s — the deepfake check needs more than 4 s`;
  const max = enrolled ? CHECK_MAX : 120;
  if (seconds > max) return `is ${seconds.toFixed(1)} s — send at most ${max} s`;
  return null;
}

async function runCheck(kind) {
  if (checking || cloning) return;
  const src = kind === 'clone' ? clone : ref;
  if (!src) return;
  const cust = selectedCustomer();
  const problem = clipProblem(src.seconds, !!cust);
  if (problem) { toast(`The ${kind === 'clone' ? 'clone' : 'reference'} ${problem}.`, { kind: 'warn', title: 'Clip length' }); return; }
  if (!(await ensureLiveConsent(kind === 'clone' ? 'attack' : 'real-voice check'))) return;
  const action = $('#lab-action').value;
  const amount = action === 'fund_transfer' ? getAmount() : null;
  const fd = new FormData();
  fd.append('file', src.blob, kind === 'clone' ? 'clone.wav' : (ref.name || 'reference.wav'));
  fd.append('customer_id', cust ? cust.customer_id : '');
  fd.append('action', action);
  if (amount != null) fd.append('amount', String(amount));
  fd.append('call_id', labCallId);
  fd.append('trigger', 'upload');
  fd.append('transcript', kind === 'clone' ? clone.text : 'Attack Lab · real-voice reference (control)');
  if (isMock()) fd.append('mock_scenario', kind === 'clone' ? 'deepfake' : 'genuine');
  checking = kind;
  validate();
  stopLive();
  const t0 = performance.now();
  const timer = renderVerdictBusy(kind, { cust, action, amount, t0 });
  try {
    const a = await api.check(fd);
    a._rtt = Math.round(performance.now() - t0);
    results[kind] = a;
    renderVerdict(kind, a);
    if (a.credits && typeof a.credits.balance === 'number') status.setBalance(a.credits.balance);
    status.refresh();
  } catch (e) {
    renderVerdictEmpty(kind, `Check failed: ${e.message}`);
    showError(e, 'Check failed');
    status.refresh();
  } finally {
    clearInterval(timer);
    checking = null;
    validate();
    renderSummary();
  }
}

// ---------------------------------------------------------------- compact verdicts
function verdictBox(kind) { return $(kind === 'clone' ? '#v-clone' : '#v-real'); }

function titleHtml(kind, a) {
  const chip = kind === 'clone' ? '<span class="chip danger">Clone</span>' : '<span class="chip ok">Real voice</span>';
  const sub = kind === 'clone' ? 'synthetic copy of your voice' : 'your reference recording';
  let badge = '';
  if (a) badge = a.mode === 'mock' ? '<span class="badge badge-mock">Mock</span>' : '<span class="badge badge-live">Live · DetectifAI</span>';
  else if (isMock()) badge = '<span class="badge badge-mock">Mock</span>';
  const time = a && a.created_at ? `<span class="faint small mono">${esc(fmtTime(a.created_at))}</span>` : '';
  return `<div class="lv-title">${chip}<span class="faint small">${sub}</span><span class="spacer"></span>${badge}${time}</div>`;
}

function renderVerdictEmpty(kind, message) {
  const el = verdictBox(kind);
  const text = message ? esc(message) : kind === 'clone'
    ? 'Run <b>Attack CallShield</b> to send the clone through the real check.'
    : 'Run <b>Compare with your real voice</b> to check the reference itself as the same customer.';
  el.className = 'lab-verdict';
  el.innerHTML = `${titleHtml(kind, null)}<div class="lv-body lv-empty">${text}</div>`;
  renderSummary();
}

function renderVerdictBusy(kind, { cust, action, amount, t0 }) {
  const el = verdictBox(kind);
  el.className = 'lab-verdict busy';
  const who = cust ? esc(cust.display_name || cust.customer_id) : 'unknown caller';
  el.innerHTML = `${titleHtml(kind, null)}<div class="lv-body lv-busy"><div class="spinner big-spinner"></div>
    <div><b>Checking ${esc(ACTIONS[action])}${amount ? ` ${esc(fmtINR(amount))}` : ''}</b><br><span class="muted small">caller claims: ${who} · ${cust ? 'verify + deepfake' : 'deepfake only'}</span></div>
    <div class="busy-timer lv-timer">0.0 s</div></div>`;
  const tEl = el.querySelector('.lv-timer');
  return setInterval(() => { tEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
}

function reasonTone(r) {
  const s = r.toLowerCase();
  if (/inconclusive|not sure|uncertain|unavailable|could not|error/.test(s)) return 'r-warn';
  if (/synthetic|fake|does not match|no match|not match|blocked|deepfake/.test(s)) return 'r-danger';
  if (/high-risk|not enrolled|unverified|weak|skipped/.test(s)) return 'r-warn';
  if (/real|human|match|verified|genuine/.test(s)) return 'r-ok';
  return '';
}

function renderVerdict(kind, a) {
  const el = verdictBox(kind);
  const risk = a.risk || {};
  const d = decisionMeta(risk.decision);
  const mock = a.mode === 'mock';
  const df = a.deepfake;
  const sp = a.speaker;
  const dfVerdict = df ? (df.verdict || '').toLowerCase() : null;
  const dfTone = dfVerdict === 'fake' ? 'danger' : dfVerdict === 'real' ? 'ok' : 'warn';
  const dfWord = dfVerdict === 'fake' ? 'Synthetic' : dfVerdict === 'real' ? 'Real human' : df ? 'Not sure' : 'n/a';
  const dfSub = df ? `score ${Number(df.score || 0).toFixed(2)} · thr ${Number(df.threshold != null ? df.threshold : 0.62).toFixed(2)}` : 'no deepfake result';
  let spTone = 'neutral', spWord = 'Not checked', spSub = a.customer_id ? 'no voiceprint result' : 'unknown caller';
  if (sp) {
    const sim = Number(sp.similarity) || 0;
    const thr = typeof sp.threshold === 'number' ? sp.threshold : 0.5;
    const match = sp.decision === 'match';
    const weak = match && sim < thr + 0.1;
    spTone = !match ? 'danger' : weak ? 'warn' : 'ok';
    spWord = !match ? 'No match' : weak ? 'Weak match' : 'Match';
    spSub = `similarity ${sim.toFixed(2)} · thr ${thr.toFixed(2)}`;
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(risk.score) || 0)));
  const level = risk.level || (score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low');
  const lvTone = level === 'high' ? 'danger' : level === 'medium' ? 'warn' : 'ok';
  const credits = a.credits
    ? `<b>${fmtNum(a.credits.charged)}</b><small>${typeof a.credits.balance === 'number' ? `bal ${fmtNum(a.credits.balance)}` : 'charged'}</small>`
    : `<b>0</b><small>${mock ? 'mock · none spent' : 'not reported'}</small>`;
  const reasons = Array.isArray(risk.reasons) ? risk.reasons : [];
  const icon = d.tone === 'danger' ? ICONS.shieldX : d.tone === 'warn' ? ICONS.alert : ICONS.shieldCheck;
  const clonesMatch = kind === 'clone' && sp && sp.decision === 'match' && dfVerdict === 'fake'
    ? '<p class="lv-note">The clone still <b>matches</b> your voiceprint — that is why voice-ID alone fails. The deepfake signal catches it.</p>' : '';
  const escaped = kind === 'clone' && d.word === 'APPROVE'
    ? '<p class="lv-note danger">The clone got through on this clip. This is why CallShield layers speaker verification, the out-of-band customer alert and DetectifAI feedback on top of the detector.</p>' : '';
  el.className = `lab-verdict done tone-${d.tone}`;
  el.innerHTML = `${titleHtml(kind, a)}
    <div class="lv-banner tone-${d.tone}">
      <div class="lv-icon">${icon}</div>
      <div class="lv-word">${esc(d.word)}${mock ? ' <span class="badge badge-mock">Mock</span>' : ''}</div>
      <div class="lv-ctx"><b>${esc(a.action_label || ACTIONS[a.action] || '')}${a.action === 'fund_transfer' && a.amount ? ` ${esc(fmtINR(a.amount))}` : ''}</b><span>claims: ${esc(a.customer_name || a.customer_id || 'Unknown caller')}</span></div>
    </div>
    <div class="lv-stats">
      <div class="lv-stat"><span class="k">Deepfake</span><b class="t-${dfTone}">${esc(dfWord)}</b><small>${esc(dfSub)}</small></div>
      <div class="lv-stat"><span class="k">Speaker</span><b class="t-${spTone}">${esc(spWord)}</b><small>${esc(spSub)}</small></div>
      <div class="lv-stat"><span class="k">Risk</span><b class="t-${lvTone}">${score}</b><small>${esc(level)} risk</small></div>
      <div class="lv-stat"><span class="k">Credits</span>${credits}</div>
    </div>
    ${reasons.length ? `<ul class="reasons lv-reasons">${reasons.map((r) => `<li class="${reasonTone(r)}">${esc(r)}</li>`).join('')}</ul>` : ''}
    ${clonesMatch}${escaped}
    <div class="lv-foot">
      <a href="/?check=${encodeURIComponent(a.check_id || '')}" target="_blank" rel="noopener">Open in Agent Console ↗</a>
      <span class="mono faint">${esc(a.check_id || '')}${a.latency_ms != null ? ` · ${fmtNum(Math.round(a.latency_ms))} ms` : ''}${a.audio_seconds != null ? ` · ${Number(a.audio_seconds).toFixed(1)} s audio` : ''}</span>
    </div>`;
  void el.offsetWidth;
  el.querySelector('.lv-banner').classList.add('animate');
}

function renderSummary() {
  const el = $('#compare-summary');
  const r = results.real, c = results.clone;
  if (!r || !c) { el.hidden = true; return; }
  const dr = decisionMeta(r.risk && r.risk.decision), dc = decisionMeta(c.risk && c.risk.decision);
  const caught = dc.word !== 'APPROVE';
  const mock = r.mode === 'mock' || c.mode === 'mock';
  el.hidden = false;
  el.className = `compare-summary ${caught ? 'caught' : 'missed'}`;
  el.innerHTML = `${caught ? ICONS.shieldCheck : ICONS.alert}<span>Real voice → <b class="t-${dr.tone}">${esc(dr.word)}</b> · Clone → <b class="t-${dc.tone}">${esc(dc.word)}</b>. ` +
    `${caught ? 'CallShield told your real voice and your clone apart.' : 'The clone was not stopped on this clip.'}</span>` +
    (mock ? ' <span class="badge badge-mock">Mock</span>' : '');
}

// ---------------------------------------------------------------- validation / button states
function validate() {
  const enabled = !!(lab && lab.enabled);
  const consent = $('#consent').checked;
  const text = $('#script').value.trim();
  const engine = selectedEngine();
  const refOk = !!ref && ref.ok;
  const engineOk = !!engine && engineAvailable(engine);
  const canClone = enabled && refOk && consent && text.length > 0 && text.length <= MAX_TEXT && engineOk && !recording && !cloning && !checking;
  $('#btn-clone').disabled = !canClone;
  $('#btn-clone').innerHTML = cloning ? '<span class="spinner"></span> Cloning…' : 'Generate clone';
  const hint = $('#clone-hint');
  if (!enabled) hint.textContent = '';
  else if (cloning) hint.textContent = 'Generating…';
  else if (recording) hint.textContent = 'Recording…';
  else if (!ref) hint.textContent = 'Record or upload your reference voice first.';
  else if (!ref.ok) hint.textContent = ref.problem || 'This reference cannot be used.';
  else if (!consent) hint.textContent = 'Tick the consent box — only your own voice.';
  else if (!text) hint.textContent = 'Write what the clone should say.';
  else if (text.length > MAX_TEXT) hint.textContent = `Script is too long (max ${MAX_TEXT} characters).`;
  else if (!lab.cloner) hint.textContent = 'Cloner offline — run .\\run_cloner.ps1, then Re-check.';
  else if (!engineOk) hint.textContent = 'No cloning engine is available.';
  else hint.textContent = 'Ready.';
  $('#consent-wrap').classList.toggle('need', !!ref && !consent);

  const busy = !!checking || cloning || recording;
  const cloneProblem = clone ? clipProblem(clone.seconds, !!selectedCustomer()) : null;
  const refProblem = ref ? clipProblem(ref.seconds, !!selectedCustomer()) : null;
  $('#btn-attack').disabled = !enabled || !clone || busy || !!cloneProblem;
  $('#btn-attack').innerHTML = checking === 'clone' ? '<span class="spinner"></span> Attacking…' : 'Attack CallShield with the clone';
  $('#btn-compare').disabled = !enabled || !ref || !ref.ok || !consent || busy || !!refProblem;
  $('#btn-compare').innerHTML = checking === 'real' ? '<span class="spinner"></span> Checking…' : 'Compare with your real voice';
  $('#btn-play-live').disabled = !clone;
  const ah = $('#attack-hint');
  const cost = isMock() ? 'mock — no credits' : `~${(status && status.state.cost_per_check) || 100} credits each`;
  if (checking) ah.textContent = 'Checking…';
  else if (!clone) ah.textContent = `Generate a clone first · ${cost}`;
  else if (cloneProblem) ah.textContent = `Clone ${cloneProblem}.`;
  else ah.textContent = cost;
  return canClone;
}

// ---------------------------------------------------------------- session storage helpers
function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------------------------------------------------------------- wiring
function main() {
  renderChips();
  pickScript('transfer');
  renderAction();
  renderVerdictEmpty('real');
  renderVerdictEmpty('clone');

  $('#btn-rec').addEventListener('click', toggleRecord);
  $('#ref-file').addEventListener('change', onRefFile);
  $('#btn-ref-discard').addEventListener('click', () => {
    clearRef();
    setRecStatus('Reference discarded.', '');
    $('#rec-timer').innerHTML = '0.0 <small>s</small>';
    $('#rec-fill').style.width = '0%';
    $('#btn-rec').textContent = 'Record my voice';
  });
  $('#consent').addEventListener('change', validate);
  $('#script-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.script-chip');
    if (b) pickScript(b.dataset.id);
  });
  $('#script').addEventListener('input', () => { markChip(null); renderCount(); validate(); });
  for (const r of $$('input[name="engine"]')) r.addEventListener('change', () => { renderEngineNote(); validate(); });
  $('#btn-clone').addEventListener('click', generateClone);
  $('#btn-play-live').addEventListener('click', playLive);
  $('#btn-recheck').addEventListener('click', loadLab);
  $('#btn-warmup').addEventListener('click', warmup);
  $('#target').addEventListener('change', renderTarget);
  $('#lab-action').addEventListener('change', () => { renderAction(); validate(); });
  $('#btn-attack').addEventListener('click', () => runCheck('clone'));
  $('#btn-compare').addEventListener('click', () => runCheck('real'));
  window.addEventListener('focus', () => { if (!checking && !cloning) loadCustomers(); });
  window.addEventListener('beforeunload', () => {
    mic.stop();
    stopLive();
    if (ref && ref.url) URL.revokeObjectURL(ref.url);
    if (clone && clone.url) URL.revokeObjectURL(clone.url);
  });
  if (!MicCapture.isSupported()) {
    $('#btn-rec').disabled = true;
    setRecStatus('This browser cannot record from the microphone — upload a file instead.', 'error');
  }

  status = initStatus({ onChange: renderCostNote });
  renderCostNote();
  loadLab();
  loadCustomers();
}

main();
