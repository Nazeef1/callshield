// CallShield — virtual helpline agent. Answers a phone call, takes the caller's request, asks for the voice
// passphrase, runs the DetectifAI check on the caller's own words, then approves, blocks or hands the call to a
// human agent (STEP UP / errors). The receive screen provides the hooks; this module is only the conversation.
import { detectAction, parseAmount } from './keywords.js';
import { SAMPLE_RATE, estimateSpeechSeconds, dropDigitalSilence } from './audio.js';

const SETTLE_MS = 1300;          // a reply is complete after this long without new words
const REPLY_TIMEOUT_MS = 15000;  // no reply at all -> reprompt (the caller can talk over the reprompt)
const MAX_CLIP_SECONDS = 20;
const VERIFY_MIN_SECONDS = 3.05;     // DetectifAI verify: >= 3 s of audio...
const VERIFY_MIN_SPEECH = 1.8;       // ...with ~2 s of speech; a short passphrase is asked for once more
const MAX_PASSPHRASE_RETRIES = 1;
const DEEPFAKE_MIN_SECONDS = 4.5;    // the deepfake check needs > 4 s
const ECHO_SKIP_SECONDS = 0.4;  // the caller's audio lags the prompt: skip its echo tail at the start of a reply

let promptsPromise = null;
export function loadPrompts() {
  if (!promptsPromise) {
    promptsPromise = fetch('/voice/agent/prompts.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return promptsPromise;
}

export class VoiceBot {
  /**
   * hooks: say(id) -> Promise (plays prompt into the call), stopSpeaking() (cut the current prompt short),
   *        freshTranscript() (new speech-recognition session for the next reply),
   *        log(who: 'agent'|'caller'|'system', text),
   *        state(name, text): greeting | listening_request | listening_passphrase | verifying | approved | blocked,
   *          text = what the agent says at that step,
   *        runCheck({ samples, deepfakeSamples, action, amount, transcript }) -> Promise<assessment>
   *          (samples = the spoken passphrase, for speaker verification; deepfakeSamples = the caller's
   *          request + passphrase, for the deepfake check, which needs > 4 s; both without digital silence),
   *        handOff(reason), hangUp()
   * mic:   the MicCapture holding the caller's audio
   */
  constructor({ mic, hooks, prompts }) {
    this.mic = mic;
    this.h = hooks;
    this.prompts = prompts;
    this.active = false;
    this.listening = null;       // 'request' | 'passphrase' | null
    this.heard = '';
    this.mark = 0;
    this.tries = 0;
    this.requestSeg = null;      // [from, to] sample counters of the caller's request
    this.passSegs = [];          // ... and of their passphrase reply (or replies)
    this.request = null;
    this.passTexts = [];
    this.timer = null;
    this.lastSaid = '';
  }

  async say(id) {
    if (!this.active) return;
    this.lastSaid = this.prompts.prompts[id];
    this.h.log('agent', this.lastSaid);
    await this.h.say(id);
  }

  async start() {
    this.active = true;
    this.h.state('greeting', this.prompts.prompts.greeting);
    await this.say('greeting');
    this.listen('request');
  }

  stop() {
    this.active = false;
    this.listening = null;
    clearTimeout(this.timer);
  }

  listen(kind) {
    if (!this.active) return;
    this.listening = kind;
    this.heard = '';
    this.mark = this.mic.total + Math.round(ECHO_SKIP_SECONDS * SAMPLE_RATE);
    this.h.freshTranscript();
    this.h.state(kind === 'request' ? 'listening_request' : 'listening_passphrase', this.lastSaid);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onSilence(), REPLY_TIMEOUT_MS);
  }

  /** Final transcript pieces of the caller's speech. */
  onUtterance(text) {
    if (!this.active || !this.listening || !text) return;
    this.heard = `${this.heard} ${text}`.trim();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onReply(), SETTLE_MS);
  }

  /** No reply yet: reprompt but keep listening, so a caller who talks over the reprompt is still heard. */
  async onSilence() {
    const kind = this.listening;
    if (!kind || this.heard) return;
    if (++this.tries > 2) { this.listening = null; await this.giveUp('The caller did not answer'); return; }
    await this.say(kind === 'request' ? 'didnt_catch' : 'passphrase_retry');
    if (this.listening === kind && !this.heard) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.onSilence(), REPLY_TIMEOUT_MS);
    }
  }

  async onReply() {
    const kind = this.listening;
    if (!kind) return;
    this.listening = null;
    clearTimeout(this.timer);
    this.h.stopSpeaking();  // barge-in: stop a reprompt the caller already answered
    const text = this.heard;
    const seg = [this.mark, this.mic.total];
    this.h.log('caller', text);
    if (kind === 'request') {
      const hit = detectAction(text);
      if (!hit) {
        if (++this.tries > 2) { await this.giveUp('Could not understand the request'); return; }
        await this.say('didnt_catch');
        this.listen('request');
        return;
      }
      this.tries = 0;
      this.requestSeg = seg;
      this.request = { action: hit.action, amount: hit.action === 'fund_transfer' ? parseAmount(text) : null, text };
      await this.say(`ack_${hit.action}`);
      await this.say('passphrase');
      this.listen('passphrase');
      return;
    }
    // passphrase
    this.passSegs.push(seg);
    this.passTexts.push(text);
    const pass = dropDigitalSilence(this.join(this.passSegs), SAMPLE_RATE);
    const secs = pass.length / SAMPLE_RATE;
    const speech = estimateSpeechSeconds(pass, SAMPLE_RATE);
    if ((secs < VERIFY_MIN_SECONDS || speech < VERIFY_MIN_SPEECH) && this.tries < MAX_PASSPHRASE_RETRIES) {
      this.tries++;  // too short to verify: hear it once more and use both
      await this.say('passphrase_retry');
      this.listen('passphrase');
      return;
    }
    // The deepfake check needs > 4 s: the passphrase alone when it's that long, else request + passphrase.
    const alone = secs >= DEEPFAKE_MIN_SECONDS;
    const natural = alone ? pass
      : dropDigitalSilence(this.join([this.requestSeg, ...this.passSegs].filter(Boolean)), SAMPLE_RATE);
    this.h.log('system', `Voice match on ${secs.toFixed(1)} s of passphrase · deepfake check on `
      + `${(natural.length / SAMPLE_RATE).toFixed(1)} s (${alone ? 'passphrase' : 'request + passphrase'})`);
    await this.verify(pass, natural, this.passTexts.join(' / '));
  }

  /** The caller's audio for these [from, to] windows, as recorded (no trimming), newest MAX_CLIP_SECONDS. */
  join(segs) {
    const parts = segs.map(([a, b]) => this.mic.getRange(a, b));
    let n = 0;
    for (const p of parts) n += p.length;
    const all = new Float32Array(n);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    const max = MAX_CLIP_SECONDS * SAMPLE_RATE;
    return all.length > max ? all.subarray(all.length - max) : all;
  }

  async verify(samples, deepfakeSamples, passText) {
    this.h.state('verifying', this.prompts.prompts.verifying);
    const transcript = `${this.request.text} | passphrase: ${passText}`.slice(-300);
    const [assessment] = await Promise.all([
      this.h.runCheck({ samples, deepfakeSamples, action: this.request.action, amount: this.request.amount, transcript })
        .catch((e) => { console.warn('virtual agent check failed', e); return null; }),
      this.say('verifying'),
    ]);
    if (!this.active) return;
    const decision = assessment && assessment.risk && assessment.risk.decision;
    if (decision === 'APPROVE') {
      this.h.state('approved', this.prompts.prompts.approve);
      await this.say('approve');
      this.stop();
      this.h.hangUp();
    } else if (decision === 'BLOCK') {
      this.h.state('blocked', this.prompts.prompts.block);
      await this.say('block');
      this.stop();
      this.h.hangUp();
    } else if (decision === 'STEP_UP') {
      await this.say('step_up');
      this.stop();
      this.h.handOff('STEP UP: the voice check needs a human');
    } else {
      await this.say('error');
      this.stop();
      this.h.handOff('The voice check could not run');
    }
  }

  async giveUp(reason) {
    await this.say('handoff');
    this.stop();
    this.h.handOff(reason);
  }
}
