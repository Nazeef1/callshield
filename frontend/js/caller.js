// CallShield — caller page (caller.html): the phone that rings the bank's agent console.
import { api } from './api.js';
import { callSocket, PeerLink, playStream } from './call.js';
import { $, esc } from './ui.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

let sock = null;
let link = null;
let state = 'idle';        // idle | ringing | connecting | on_call
let customers = [];
let samples = [];
let startedAt = 0;
let remoteEl = null;

// Outgoing audio: mic (+ optional sample) mixed in Web Audio, sent as one track.
let micStream = null;
let ctx = null;
let micGain = null;
let dest = null;
let sampleEl = null;

let rec = null;
let recWanted = false;
let lines = [];

function setStatus(html) { $('#call-status').innerHTML = html; }

function render() {
  const idle = state === 'idle';
  $('#btn-call').hidden = !idle;
  $('#btn-hangup').hidden = idle;
  $('#btn-call').disabled = !(sock && sock.isOpen);
  $('#as-select').disabled = !idle;
  $('#btn-sample').disabled = state !== 'on_call' || !$('#sample-pick').value;
}

// ---------------------------------------------------------------- socket
function onMessage(msg) {
  switch (msg.type) {
    case 'ringing': setStatus('Ringing the bank…'); break;
    case 'no_agent': setStatus('No agent is online. Open the agent console on the laptop.'); teardown(); break;
    case 'declined': setStatus('The agent declined the call.'); teardown(); break;
    case 'accepted': onAccepted(); break;
    case 'signal': if (link) link.handleSignal(msg.data).catch((e) => console.error(e)); break;
    case 'hangup': setStatus('The bank ended the call.'); teardown(); break;
    default: break;
  }
}

function onSocketState(st) {
  if (st === 'open' && state === 'idle') setStatus('Ready. Pick who you are calling as and press <b>Call bank</b>.');
  else if (st === 'denied') setStatus('Wrong access code. Open this page with <span class="mono">?code=…</span>.');
  else if (st === 'closed') { setStatus('Lost connection to the bank, reconnecting…'); if (state !== 'idle') teardown(); }
  render();
}

// ---------------------------------------------------------------- call
async function dial() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setStatus(`Microphone blocked (${esc(e.name || e.message)}). Allow the mic and try again.`);
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  micGain = ctx.createGain();
  dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(micStream).connect(micGain);
  micGain.connect(dest);

  const c = customers.find((x) => x.customer_id === $('#as-select').value);
  state = 'ringing';
  render();
  setStatus('Calling…');
  sock.send({ type: 'dial', customer_id: c ? c.customer_id : '', display_name: c ? (c.display_name || c.customer_id) : '' });
}

async function onAccepted() {
  state = 'connecting';
  setStatus('Agent answered, connecting audio…');
  link = new PeerLink({
    sendSignal: (data) => sock.send({ type: 'signal', data }),
    onRemoteStream: (stream) => { if (!remoteEl) remoteEl = playStream(stream); },
    onState: (s) => {
      if (s === 'connected' && state !== 'on_call') {
        state = 'on_call';
        startedAt = Date.now();
        setStatus('<b>On call with the bank.</b>');
        startRecognition();
        render();
      } else if (s === 'failed') {
        setStatus('Audio connection failed (are both devices on the same network?).');
        hangup();
      }
    },
  });
  link.addStream(dest.stream);
  try {
    await link.offer();
  } catch (e) {
    console.error(e);
    setStatus('Could not start the call.');
    hangup();
  }
}

function hangup() {
  if (sock) sock.send({ type: 'hangup' });
  if (state !== 'idle') setStatus('Call ended.');
  teardown();
}

function teardown() {
  state = 'idle';
  stopRecognition();
  stopSample();
  if (link) { link.close(); link = null; }
  if (remoteEl) { remoteEl.srcObject = null; remoteEl = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  micGain = null;
  dest = null;
  $('#call-timer').textContent = '';
  render();
}

// ---------------------------------------------------------------- sample playback into the call
function stopSample() {
  if (sampleEl) { sampleEl.pause(); sampleEl = null; }
  if (micGain) micGain.gain.value = 1;
  $('#btn-sample').textContent = '▶ Play';
}

function toggleSample() {
  if (sampleEl) { stopSample(); return; }
  const s = samples.find((x) => x.id === $('#sample-pick').value);
  if (!s || !ctx) return;
  sampleEl = new Audio('/' + s.file);
  const src = ctx.createMediaElementSource(sampleEl);
  src.connect(dest);
  src.connect(ctx.destination);   // the caller hears it too
  micGain.gain.value = 0;
  sampleEl.onended = stopSample;
  sampleEl.play().catch(() => stopSample());
  $('#btn-sample').textContent = '■ Stop';
}

// ---------------------------------------------------------------- live transcript -> agent
function startRecognition() {
  if (!SR) { $('#tx-note').textContent = 'Speech recognition is not available in this browser; the agent can trigger checks by hand.'; return; }
  if (!$('#tx-toggle').checked) return;
  recWanted = true;
  rec = new SR();
  rec.lang = 'en-IN';
  rec.continuous = true;
  rec.interimResults = true;
  const me = rec;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0] ? r[0].transcript.trim() : '';
      if (!text) continue;
      if (r.isFinal) {
        lines.push(text);
        sock.send({ type: 'transcript', text, final: true });
      } else {
        interim += text + ' ';
      }
    }
    if (interim) sock.send({ type: 'transcript', text: interim.trim(), final: false });
    renderTranscript(interim);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
      recWanted = false;
      $('#tx-note').textContent = `Speech recognition stopped (${e.error}); the agent can trigger checks by hand.`;
    }
  };
  rec.onend = () => {
    if (rec === me && recWanted && state === 'on_call') setTimeout(() => { try { me.start(); } catch { /* running */ } }, 250);
  };
  try { rec.start(); } catch (e) { console.warn(e); }
}

function stopRecognition() {
  recWanted = false;
  const r = rec;
  rec = null;
  if (r) { try { r.onend = null; r.stop(); } catch { /* ignore */ } }
}

function renderTranscript(interim) {
  const box = $('#transcript');
  box.innerHTML = lines.slice(-20).map((l) => `<p class="line">${esc(l)}</p>`).join('') +
    (interim ? `<p class="line interim">${esc(interim)}</p>` : '');
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- setup
async function loadLists() {
  try {
    customers = ((await api.customers()) || {}).customers || [];
  } catch { customers = []; }
  $('#as-select').innerHTML = '<option value="">Don\'t say (unknown caller)</option>' +
    customers.map((c) => `<option value="${esc(c.customer_id)}">${esc(c.display_name || c.customer_id)}</option>`).join('');
  if (customers.length) $('#as-select').value = customers[0].customer_id;

  try {
    const r = await fetch('/samples/samples.json', { cache: 'no-store' });
    if (r.ok) samples = (await r.json()).samples || [];
  } catch { samples = []; }
  if (samples.length) {
    $('#sample-pick').innerHTML += samples.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
    $('#sample-wrap').hidden = false;
  }
}

function main() {
  $('#btn-call').addEventListener('click', dial);
  $('#btn-hangup').addEventListener('click', hangup);
  $('#btn-sample').addEventListener('click', toggleSample);
  $('#sample-pick').addEventListener('change', render);
  $('#tx-toggle').addEventListener('change', () => {
    if (state !== 'on_call') return;
    if ($('#tx-toggle').checked) startRecognition(); else stopRecognition();
  });
  setInterval(() => {
    if (state !== 'on_call') return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('#call-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  window.addEventListener('beforeunload', () => { if (state !== 'idle') hangup(); });
  if (!window.isSecureContext) setStatus('This page needs HTTPS (or localhost) for the microphone.');
  loadLists();
  sock = callSocket('caller', { onMessage, onState: onSocketState });
  render();
}

main();
