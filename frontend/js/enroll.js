// CallShield — customer voice enrollment (enroll.html)
import { api } from './api.js';
import { MicCapture, encodeWav, estimateSpeechSeconds, audioFileDuration, SAMPLE_RATE } from './audio.js';
import { $, $$, esc, fmtNum, fmtDateTime, ICONS, toast, showError, confirmDialog, initStatus } from './ui.js';

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MIN_TAKE = 20;     // enable submit from here
const API_MIN = 15;      // DetectifAI minimum
const API_MAX = 60;
const AUTO_STOP = 45;

const PASSAGES = {
  en: 'Hello, this is my voice for CallShield enrollment. I bank with you because I trust that my money is safe here. ' +
    'When I call the support desk, I usually ask about my account balance, a recent UPI payment, or the status of a cheque ' +
    'I deposited last week. I never share my OTP, PIN or password with anyone, not even with bank staff. If someone calls ' +
    'pretending to be me and asks to transfer money, add a new beneficiary or reset my SIM, please stop them and alert me ' +
    'on my phone right away. Thank you for keeping my account protected.',
  hi: 'नमस्ते, यह CallShield के लिए मेरी आवाज़ है। मैं इस बैंक पर भरोसा करता हूँ क्योंकि मेरा पैसा यहाँ सुरक्षित है। ' +
    'जब मैं कस्टमर केयर को फ़ोन करता हूँ, तो आम तौर पर अपने खाते का बैलेंस, किसी UPI पेमेंट या पिछले हफ़्ते जमा किए गए चेक ' +
    'के बारे में पूछता हूँ। मैं अपना OTP, PIN या पासवर्ड किसी के साथ साझा नहीं करता, बैंक कर्मचारियों के साथ भी नहीं। ' +
    'अगर कोई मेरी आवाज़ में फ़ोन करके पैसे ट्रांसफर करने, नया लाभार्थी जोड़ने या सिम बदलने को कहे, तो कृपया उसे रोकें ' +
    'और मुझे तुरंत मेरे फ़ोन पर सूचित करें। मेरे खाते को सुरक्षित रखने के लिए धन्यवाद।',
};

const mic = new MicCapture({ ringSeconds: 2 });
let status = null;
let customers = [];
let recording = false;
let take = null;          // { blob, seconds, speech, source: 'mic'|'file', name, url }
let idTouched = false;
let busy = false;

// ---------------------------------------------------------------- form
function validate() {
  const idEl = $('#cust-id'), nameEl = $('#cust-name'), phEl = $('#cust-phone');
  const id = idEl.value.trim();
  const idOk = ID_RE.test(id);
  idEl.classList.toggle('invalid', id.length > 0 && !idOk);
  const help = $('#id-help');
  const existing = customers.find((c) => c.customer_id === id);
  if (id && !idOk) { help.textContent = 'Only letters, digits and _ . : - are allowed (max 64).'; help.className = 'field-help error'; }
  else if (existing) { help.textContent = `Exists — will add a sample to ${existing.display_name || id}'s voiceprint.`; help.className = 'field-help'; }
  else { help.textContent = 'Letters, digits and _ . : - (max 64)'; help.className = 'field-help'; }
  const ph = phEl.value.trim();
  const phOk = ph === '' || /^\d{4}$/.test(ph);
  phEl.classList.toggle('invalid', !phOk);
  $('#phone-help').textContent = phOk ? 'Where alerts are pushed (registered device)' : 'Enter exactly 4 digits.';
  $('#phone-help').className = phOk ? 'field-help' : 'field-help error';
  const nameOk = nameEl.value.trim().length > 0;

  const takeOk = !!take && take.ok;
  const ok = idOk && phOk && nameOk && takeOk && !recording && !busy;
  $('#btn-submit').disabled = !ok;
  const hint = $('#submit-hint');
  if (busy) hint.textContent = 'Enrolling…';
  else if (!nameOk || !idOk) hint.textContent = 'Fill in the customer name and a valid ID.';
  else if (!phOk) hint.textContent = 'Phone last 4 must be 4 digits.';
  else if (recording) hint.textContent = 'Recording…';
  else if (!take) hint.textContent = `Record at least ${MIN_TAKE} s or upload a 15–60 s clip.`;
  else if (!take.ok) hint.textContent = take.problem || 'This take cannot be used.';
  else hint.textContent = status && status.state.mode === 'live' ? 'Ready — this uses ~50 DetectifAI credits.' : 'Ready.';
  return ok;
}

function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/\s+/)[0] || '';
}
function suggestId() {
  if (idTouched) return;
  const first = slug($('#cust-name').value);
  if (!first) { $('#cust-id').value = ''; return; }
  let n = 1, id;
  do { id = `cust-${first}-${String(n).padStart(2, '0')}`; n++; } while (customers.some((c) => c.customer_id === id) && n < 100);
  $('#cust-id').value = id.slice(0, 64);
}

// ---------------------------------------------------------------- recording
async function toggleRecord() {
  if (recording) return stopRecord();
  if (busy) return;
  try {
    mic.reset();
    await mic.start();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? 'Microphone permission was denied. Allow mic access and try again.' : `Could not start the microphone: ${e.message || e}`, { kind: 'error', title: 'Microphone' });
    return;
  }
  clearTake();
  mic.startRecording();
  mic.onended = () => { if (recording) stopRecord(); };
  recording = true;
  const btn = $('#btn-rec');
  btn.classList.add('recording');
  btn.classList.remove('btn-accent');
  setStatus('Recording — read the passage at a natural pace.', '');
  validate();
  requestAnimationFrame(recTick);
}

function recTick() {
  if (!recording) return;
  const s = mic.recordedSeconds;
  $('#rec-timer').innerHTML = `${s.toFixed(1)} <small>s</small>`;
  const fill = $('#rec-fill');
  fill.style.width = `${Math.min(100, (s / AUTO_STOP) * 100)}%`;
  fill.classList.toggle('good', s >= MIN_TAKE);
  $('#rec-level').style.width = `${mic.meterLevel * 100}%`;
  $('#btn-rec').textContent = s >= MIN_TAKE ? 'Stop & review' : `Stop (min ${MIN_TAKE} s)`;
  if (s >= MIN_TAKE && s < MIN_TAKE + 0.1) setStatus('Good — you can stop now, or keep reading until the end of the passage.', 'good');
  if (s >= AUTO_STOP) { stopRecord(true); return; }
  requestAnimationFrame(recTick);
}

function stopRecord(auto = false) {
  if (!recording) return;
  recording = false;
  const samples = mic.stopRecording();
  mic.stop();
  const btn = $('#btn-rec');
  btn.classList.remove('recording');
  btn.classList.add('btn-accent');
  btn.textContent = 'Record again';
  $('#rec-level').style.width = '0%';
  const seconds = samples.length / SAMPLE_RATE;
  const speech = estimateSpeechSeconds(samples, SAMPLE_RATE);
  const blob = encodeWav(samples, SAMPLE_RATE);
  let ok = true, problem = '';
  if (seconds < MIN_TAKE) { ok = false; problem = `Too short (${seconds.toFixed(1)} s) — record at least ${MIN_TAKE} s.`; }
  else if (speech < 6) { ok = false; problem = `Only ~${speech.toFixed(0)} s of speech detected — DetectifAI needs at least 10 s. Speak closer to the mic.`; }
  setTake({ blob, seconds, speech, source: 'mic', name: 'enroll.wav', ok, problem });
  if (!ok) setStatus(problem, 'error');
  else if (speech < 10) setStatus(`${auto ? 'Auto-stopped. ' : ''}${seconds.toFixed(1)} s recorded, ~${speech.toFixed(0)} s of speech (borderline — 10 s needed). Re-record if you can.`, '');
  else setStatus(`${auto ? 'Auto-stopped at 45 s. ' : ''}${seconds.toFixed(1)} s recorded · ~${speech.toFixed(0)} s of speech. Play it back, then enroll.`, 'good');
  validate();
}

function setStatus(text, kind) {
  const el = $('#rec-status');
  el.textContent = text;
  el.className = `rec-status ${kind || ''}`;
}

function setTake(t) {
  clearTake();
  take = t;
  take.url = URL.createObjectURL(t.blob);
  $('#preview').src = take.url;
  $('#take').hidden = false;
  $('#take-label').textContent = t.source === 'mic' ? `Recording · ${t.seconds.toFixed(1)} s` : `File${t.seconds ? ` · ${t.seconds.toFixed(1)} s` : ''}`;
  $('#take-label').className = `chip ${t.ok ? 'ok' : 'danger'}`;
}

function clearTake() {
  if (take && take.url) URL.revokeObjectURL(take.url);
  take = null;
  $('#preview').removeAttribute('src');
  $('#take').hidden = true;
  validate();
}

async function onFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (recording) stopRecord();
  setStatus('Reading file…', '');
  const d = await audioFileDuration(f);
  let ok = true, problem = '';
  if (d != null && (d < API_MIN || d > API_MAX)) { ok = false; problem = `Clip is ${d.toFixed(1)} s — enrollment audio must be ${API_MIN}–${API_MAX} s.`; }
  setTake({ blob: f, seconds: d, speech: null, source: 'file', name: f.name || 'enroll-upload', ok, problem });
  $('#rec-timer').innerHTML = `${d != null ? d.toFixed(1) : '?'} <small>s</small>`;
  if (ok) setStatus(`Using “${f.name}”${d != null ? ` (${d.toFixed(1)} s)` : ''}. Play it back, then enroll.`, 'good');
  else setStatus(problem, 'error');
  validate();
}

// ---------------------------------------------------------------- submit
async function submit() {
  if (!validate()) return;
  const live = status && status.state.mode === 'live';
  if (live) {
    const ok = await confirmDialog({
      title: 'Enroll this voice on DetectifAI?',
      body: 'Enrollment is a live DetectifAI operation and uses <b>~50 credits</b>. Make sure the customer has consented to voice enrollment.',
      ok: 'Enroll (~50 credits)',
    });
    if (!ok) return;
  }
  busy = true;
  validate();
  const btn = $('#btn-submit');
  btn.innerHTML = '<span class="spinner"></span> Enrolling…';
  const fd = new FormData();
  fd.append('file', take.blob, take.name);
  fd.append('customer_id', $('#cust-id').value.trim());
  fd.append('display_name', $('#cust-name').value.trim());
  const ph = $('#cust-phone').value.trim();
  if (ph) fd.append('phone_last4', ph);
  try {
    const res = await api.enroll(fd);
    renderResult(res);
    toast(`${(res.customer && res.customer.display_name) || 'Customer'} enrolled.`, { kind: 'ok', title: 'Voiceprint saved' });
    if (res.credits && typeof res.credits.balance === 'number') status.setBalance(res.credits.balance);
    status.refresh();
    await loadCustomers();
  } catch (e) {
    showError(e, 'Enrollment failed');
  } finally {
    busy = false;
    btn.textContent = 'Enroll voiceprint';
    validate();
  }
}

function renderResult(res) {
  const c = res.customer || {};
  const q = res.quality || {};
  const speech = Number(q.speech_seconds);
  const dur = Number(q.duration_seconds);
  const qTone = isNaN(speech) ? 'neutral' : speech >= 15 ? 'ok' : speech >= 10 ? 'warn' : 'danger';
  const qText = isNaN(speech) ? 'unknown' : speech >= 15 ? 'good' : speech >= 10 ? 'fair' : 'low';
  const mock = res.mode === 'mock';
  $('#result').innerHTML = `
    <div class="result-card">
      <h3>${ICONS.shieldCheck.replace('<svg ', '<svg width="22" height="22" style="color:var(--ok)" ')} ${esc(c.display_name || c.customer_id || 'Customer')} enrolled
        ${mock ? '<span class="badge badge-mock">Mock</span>' : '<span class="badge badge-live">Live · DetectifAI</span>'}</h3>
      <div class="result-stats">
        <div class="stat"><b>${isNaN(speech) ? '—' : speech.toFixed(1) + ' s'}</b><span>speech <span class="chip ${qTone}" style="height:18px;font-size:.62rem">${qText}</span></span></div>
        <div class="stat"><b>${isNaN(dur) ? '—' : dur.toFixed(1) + ' s'}</b><span>audio length</span></div>
        <div class="stat"><b>${res.credits ? fmtNum(res.credits.charged) : '0'}</b><span>credits charged${res.credits && typeof res.credits.balance === 'number' ? ` · bal ${fmtNum(res.credits.balance)}` : ''}</span></div>
      </div>
      <div class="mono muted">customer <b>${esc(c.customer_id || '')}</b>${c.samples != null ? ` · samples ${esc(c.samples)}` : ''}${res.request_id ? ` · request ${esc(res.request_id)}` : ''}</div>
      <div style="margin-top:10px"><a href="/">Go to the agent console →</a></div>
    </div>`;
}

// ---------------------------------------------------------------- customers list
async function loadCustomers() {
  try {
    const res = await api.customers();
    customers = (res && res.customers) || [];
  } catch (e) {
    customers = [];
    if (e.code !== 'network') showError(e, 'Could not load customers');
    $('#cust-body').innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}</td></tr>`;
    return;
  }
  $('#cust-count').textContent = customers.length ? `${customers.length} enrolled` : '';
  $('#cust-body').innerHTML = customers.length
    ? customers.map((c) => `<tr class="clickable" data-id="${esc(c.customer_id)}">
        <td><b>${esc(c.display_name || '—')}</b></td>
        <td class="mono">${esc(c.customer_id)}</td>
        <td class="mono">${c.phone_last4 ? '••' + esc(c.phone_last4) : '—'}</td>
        <td class="tnum">${c.samples != null ? esc(c.samples) : '—'}</td>
        <td class="muted">${esc(fmtDateTime(c.enrolled_at))}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No customers enrolled yet.</td></tr>';
  validate();
}

function renderPassage() {
  const lang = (document.querySelector('input[name="passage"]:checked') || {}).value || 'en';
  const el = $('#passage');
  el.textContent = PASSAGES[lang];
  el.lang = lang;
}

function renderCost() {
  const el = $('#cost-banner');
  if (status && status.state.mode === 'mock') {
    el.innerHTML = `${ICONS.alert}<span><b>Mock mode:</b> enrollment is simulated and costs nothing. Results are labelled MOCK.</span>`;
  } else {
    el.innerHTML = `${ICONS.coins}<span>Enrollment is a live DetectifAI operation and uses <b>~50 credits</b>. Get the customer's consent before recording their voice.</span>`;
  }
  validate();
}

function main() {
  renderPassage();
  for (const r of $$('input[name="passage"]')) r.addEventListener('change', renderPassage);
  $('#cust-name').addEventListener('input', () => { suggestId(); validate(); });
  $('#cust-id').addEventListener('input', () => { idTouched = $('#cust-id').value.trim() !== ''; validate(); });
  $('#cust-phone').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); validate(); });
  $('#btn-rec').addEventListener('click', toggleRecord);
  $('#btn-discard').addEventListener('click', () => { clearTake(); setStatus('Take discarded.', ''); $('#rec-timer').innerHTML = '0.0 <small>s</small>'; $('#rec-fill').style.width = '0%'; $('#btn-rec').textContent = 'Start recording'; });
  $('#enroll-file').addEventListener('change', onFile);
  $('#btn-submit').addEventListener('click', submit);
  $('#enroll-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('#cust-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const c = customers.find((x) => x.customer_id === tr.dataset.id);
    if (!c) return;
    $('#cust-name').value = c.display_name || '';
    $('#cust-id').value = c.customer_id;
    $('#cust-phone').value = c.phone_last4 || '';
    idTouched = true;
    validate();
    $('#cust-name').focus();
  });
  if (!MicCapture.isSupported()) {
    $('#btn-rec').disabled = true;
    setStatus('This browser cannot record from the microphone — upload a file instead.', 'error');
  }
  window.addEventListener('beforeunload', () => mic.stop());
  status = initStatus({ onChange: renderCost });
  renderCost();
  loadCustomers();
}

main();
