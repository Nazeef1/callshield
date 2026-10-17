// CallShield final deck: a title slide, then 5 slides in the required order (Problem, Solution, DetectifAI, Impact, Scale).
//   cd pitch/build && node build_final.js   ->  pitch/CallShield_Final.pptx
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const { applyTheme } = require('./apply_theme.js');

const OUT = path.join(__dirname, '..', process.argv[2] || 'CallShield_Final.pptx');  // node build_final.js [out.pptx]
const THEME = {
  name: 'CallShield',
  headFontFace: 'Arial',
  bodyFontFace: 'Arial',
  colors: {
    dk1: '0B0D12', lt1: 'E8EBF2', dk2: '12151C', lt2: '8D95A8',
    accent1: 'D4FF2A', accent2: '3DDC84', accent3: 'F5B83D', accent4: 'FF5A4E', accent5: '181C25', accent6: '2F3646',
    hlink: 'D4FF2A', folHlink: '8D95A8',
  },
};
const HEX = { bg: '0B0D12', card: '12151C', card2: '181C25', line: '2F3646', text: 'E8EBF2', muted: '8D95A8',
  lime: 'D4FF2A', ok: '3DDC84', warn: 'F5B83D', danger: 'FF5A4E' };

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';  // 13.33 x 7.5 in
pres.title = 'CallShield';
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;
const W = 13.33;

pres.defineSlideMaster({
  title: 'CS_CONTENT',
  background: { color: C.text1 },
  objects: [
    { text: { text: 'CallShield · Powered by DetectifAI', options: { x: 0.6, y: 6.95, w: 6, h: 0.3, fontSize: 10, color: C.background2, isTextBox: true, margin: 0 } } },
  ],
  slideNumber: { x: 12.3, y: 6.95, w: 0.5, h: 0.3, fontSize: 10, color: C.background2, align: 'right' },
});

const t = (slide, text, o) => slide.addText(text, { isTextBox: true, margin: 0, color: C.background1, fontSize: 16, ...o });
const card = (slide, x, y, w, h, fill = C.text2, name) =>
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { color: C.accent6, width: 0.75 }, objectName: name });
const pill = (slide, x, y, w, label, color, name) => {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h: 0.5, rectRadius: 0.25, fill: { color, transparency: 82 }, line: { color, width: 1 }, objectName: name });
  t(slide, label, { x, y, w, h: 0.5, align: 'center', valign: 'middle', bold: true, fontSize: 15, color });
};
// Same position, size and style on every slide.
const head = (slide, kicker, title) => {
  t(slide, kicker, { x: 0.6, y: 0.5, w: 8, h: 0.35, fontSize: 13, bold: true, color: C.accent1, charSpacing: 3, objectName: 'kicker' });
  t(slide, title, { x: 0.6, y: 0.9, w: 12.1, h: 0.85, fontSize: 34, bold: true, valign: 'top', objectName: 'title' });
};

// ---------------------------------------------------------------- Title
pres.defineSlideMaster({ title: 'CS_TITLE', background: { color: C.text1 } });
{
  pres.addSection({ title: 'Title' });
  const s = pres.addSlide({ masterName: 'CS_TITLE', sectionTitle: 'Title' });
  const logo = fs.readFileSync(path.join(__dirname, 'logo.png')).toString('base64');
  s.addImage({ data: `image/png;base64,${logo}`, x: 0.72, y: 1.55, w: 1.25, h: 1.25, objectName: 'logo', altText: 'CallShield shield logo' });
  t(s, 'CallShield', { x: 0.9, y: 2.95, w: 9, h: 1.3, fontSize: 66, bold: true, objectName: 'name' });
  t(s, 'A voice-clone fraud guard for bank helpline calls', { x: 0.9, y: 4.25, w: 10, h: 0.6, fontSize: 24, color: C.background2, objectName: 'tagline' });
  t(s, [{ text: 'Powered by ', options: { color: C.background2 } }, { text: 'DetectifAI', options: { bold: true, color: C.accent1 } }],
    { x: 0.9, y: 4.9, w: 8, h: 0.5, fontSize: 18, objectName: 'powered' });
  t(s, 'UNCLONE AI Hackathon  ·  Track 01: Unclone Finance  ·  B.M.S. College of Engineering  ·  17 Oct 2026',
    { x: 0.9, y: 6.55, w: 11.5, h: 0.4, fontSize: 12, color: C.background2, objectName: 'event' });
  s.addNotes('Hi, we are team CallShield. Our product guards bank helpline calls against cloned voices, and DetectifAI is the engine that makes every decision.');
}

// ---------------------------------------------------------------- 1. Problem
{
  pres.addSection({ title: 'Problem' });
  const s = pres.addSlide({ masterName: 'CS_CONTENT', sectionTitle: 'Problem' });
  head(s, 'PROBLEM', 'It sounds like your customer. It isn\'t.');
  card(s, 0.6, 2.05, 7.3, 1.55, C.text2, 'quote');
  t(s, '“Hi, it’s Ramesh. I’ve got a new number. Please update the phone number on my account.”',
    { x: 0.95, y: 2.2, w: 6.7, h: 1.25, fontSize: 21, italic: true, valign: 'middle' });
  const rows = [
    ['The moment', 'A cloned voice asks the bank to change the phone number, so every OTP goes to the fraudster.'],
    ['Why it works', 'Security questions use leaked data. Voice-ID alone was beaten by a free clone (Lloyds Bank, 2023).'],
    ['Who loses', 'The account holder, whose voice came from a reel, a voice note or a "survey" call.'],
  ];
  rows.forEach(([k, v], i) => {
    const y = 4.0 + i * 0.85;
    t(s, k, { x: 0.6, y, w: 2.0, h: 0.6, bold: true, fontSize: 15, color: C.accent1, valign: 'top' });
    t(s, v, { x: 2.6, y, w: 5.3, h: 0.7, fontSize: 15, color: C.background1, valign: 'top' });
  });
  card(s, 8.6, 2.05, 4.1, 4.45, C.text2, 'stat');
  t(s, '69%', { x: 8.9, y: 2.55, w: 3.5, h: 1.5, fontSize: 80, bold: true, color: C.accent4, align: 'left' });
  t(s, 'of Indians aren’t confident they could tell a cloned voice from the real one.',
    { x: 8.9, y: 4.15, w: 3.5, h: 1.2, fontSize: 16, color: C.background1, valign: 'top' });
  t(s, 'McAfee, “Beware the Artificial Impostor”, 2023', { x: 8.9, y: 5.75, w: 3.5, h: 0.4, fontSize: 10, color: C.background2 });
  s.addNotes('Our user is the bank helpline. The moment: a caller who sounds exactly like the account holder asks to change the registered phone number. Once that goes through, every OTP goes to the fraudster, and the next request is a 50,000 rupee transfer. Security questions are answered with leaked data, and voice-ID on its own was beaten by a free AI clone at Lloyds in 2023. 69% of Indians aren\'t confident they could tell a clone from the real voice (McAfee 2023), and neither can an agent.');
}

// ---------------------------------------------------------------- 2. Solution
{
  pres.addSection({ title: 'Solution' });
  const s = pres.addSlide({ masterName: 'CS_CONTENT', sectionTitle: 'Solution' });
  head(s, 'SOLUTION', 'Neerja checks the voice before money moves');
  const steps = [
    ['1', 'Enroll', 'The customer reads a short script in the CallShield Bank app. About 25 seconds, once.'],
    ['2', 'Call', 'Neerja, the virtual agent, hears the request and asks for the voice passphrase.'],
    ['3', 'Decide', 'DetectifAI checks the voice. Approve, hand to a human, or block, with reasons.'],
    ['4', 'Alert', 'The real customer gets “Was this you?” in the app and taps It was me / Not me.'],
  ];
  const cw = 2.85, gap = 0.27;
  steps.forEach(([n, k, v], i) => {
    const x = 0.6 + i * (cw + gap);
    card(s, x, 2.15, cw, 2.75, C.text2, `step${n}`);
    s.addShape(pres.shapes.OVAL, { x: x + 0.3, y: 2.45, w: 0.62, h: 0.62, fill: { color: C.accent1 }, line: { color: C.accent1 }, objectName: `step${n}-dot` });
    t(s, n, { x: x + 0.3, y: 2.45, w: 0.62, h: 0.62, align: 'center', valign: 'middle', bold: true, fontSize: 18, color: C.text1 });
    t(s, k, { x: x + 0.3, y: 3.25, w: cw - 0.6, h: 0.45, bold: true, fontSize: 20 });
    t(s, v, { x: x + 0.3, y: 3.75, w: cw - 0.55, h: 1.05, fontSize: 14, color: C.background2, valign: 'top' });
  });
  t(s, 'Every outcome', { x: 0.6, y: 5.35, w: 2.3, h: 0.5, bold: true, fontSize: 15, color: C.background2, valign: 'middle' });
  pill(s, 2.8, 5.35, 2.2, 'Approve', C.accent2, 'approve');
  pill(s, 5.2, 5.35, 2.9, 'Hand to a human', C.accent3, 'stepup');
  pill(s, 8.3, 5.35, 2.2, 'Block', C.accent4, 'block');
  t(s, 'No forms, no OTP. The customer just talks.', { x: 0.6, y: 6.15, w: 9, h: 0.4, fontSize: 14, italic: true, color: C.background2 });
  s.addNotes('Four steps. The customer enrolls their voice once in our app. When they call, Neerja, our virtual agent, takes the request and asks for the voice passphrase. DetectifAI checks that voice, and the call is approved, handed to a human agent, or blocked, with reasons on screen. On a step-up or block the real customer is alerted in the app and can say "not me". We will show it live.');
}

// ---------------------------------------------------------------- 3. DetectifAI
{
  pres.addSection({ title: 'DetectifAI' });
  const s = pres.addSlide({ masterName: 'CS_CONTENT', sectionTitle: 'DetectifAI' });
  head(s, 'DETECTIFAI', 'Take DetectifAI out and nothing gets decided');
  const q = [
    ['Is it them?', 'Speaker Verification', 'Voiceprint from enrollment vs the spoken passphrase.'],
    ['Is it real?', 'Deepfake Detection', 'Synthetic-speech check on the same live call audio.'],
  ];
  q.forEach(([k, api, v], i) => {
    const y = 2.1 + i * 1.6;
    card(s, 0.6, y, 5.6, 1.35, C.text2, `q${i}`);
    t(s, k, { x: 0.9, y: y + 0.18, w: 5, h: 0.45, bold: true, fontSize: 20, color: C.accent1 });
    t(s, api, { x: 0.9, y: y + 0.62, w: 5, h: 0.3, bold: true, fontSize: 13, color: C.background1 });
    t(s, v, { x: 0.9, y: y + 0.92, w: 5.1, h: 0.3, fontSize: 12, color: C.background2 });
  });
  const rules = [
    ['Synthetic voice', 'Block, always', C.accent4],
    ['Not the customer', 'Block or human', C.accent4],
    ['Unsure, or no result', 'Human (fails closed)', C.accent3],
    ['Real and a match', 'Approve', C.accent2],
  ];
  t(s, 'Decision rules', { x: 6.75, y: 2.1, w: 6, h: 0.4, bold: true, fontSize: 15, color: C.background2 });
  rules.forEach(([k, v, col], i) => {
    const y = 2.6 + i * 0.55;
    t(s, k, { x: 6.75, y, w: 3.0, h: 0.45, fontSize: 15, valign: 'middle' });
    t(s, v, { x: 9.8, y, w: 2.9, h: 0.45, fontSize: 15, bold: true, color: col, valign: 'middle' });
  });
  t(s, 'Every “It was me / Not me” is sent back to DetectifAI as feedback.',
    { x: 6.75, y: 4.9, w: 5.95, h: 0.5, fontSize: 13, italic: true, color: C.background2 });
  card(s, 0.6, 5.45, 12.1, 1.15, C.text2, 'live');
  t(s, 'LIVE TODAY', { x: 0.9, y: 5.6, w: 2.2, h: 0.35, bold: true, fontSize: 12, color: C.accent1, charSpacing: 2 });
  t(s, [
    { text: 'Real customer: ', options: { bold: true } }, { text: 'voice match 0.83–0.89 → Approved', options: { color: C.accent2 } },
    { text: '     Clone: ', options: { bold: true } }, { text: 'deepfake 0.999 → Blocked', options: { color: C.accent4 } },
  ], { x: 0.9, y: 5.95, w: 11.6, h: 0.45, fontSize: 17 });
  s.addNotes('Two DetectifAI questions drive one decision: is it the enrolled customer (speaker verification on the passphrase) and is it a real voice (deepfake detection). A synthetic verdict always blocks; uncertain or missing results go to a human, so the system fails closed. We also fixed a real edge case: WebRTC calls insert digital silence that dropped a genuine caller\'s match from 0.85 to 0.21; we strip only that silence and enroll through the same call audio path. Today, real customers matched at 0.83 to 0.89 and were approved; clones scored 0.999 synthetic and were blocked.');
}

// ---------------------------------------------------------------- 4. Impact
{
  pres.addSection({ title: 'Impact' });
  const s = pres.addSlide({ masterName: 'CS_CONTENT', sectionTitle: 'Impact' });
  head(s, 'IMPACT', 'We close the helpline door');
  t(s, '₹22,845 cr', { x: 0.6, y: 2.0, w: 6.6, h: 1.4, fontSize: 72, bold: true, color: C.accent1 });
  t(s, 'lost to cyber fraud in India in 2024, about 3× the year before.', { x: 0.6, y: 3.4, w: 6.2, h: 0.75, fontSize: 18, valign: 'top' });
  t(s, 'Ministry of Home Affairs, Lok Sabha, Jul 2025', { x: 0.6, y: 4.15, w: 6, h: 0.35, fontSize: 10, color: C.background2 });
  const who = [
    ['Customer', 'The transfer or SIM reset never happens, and they know within seconds.'],
    ['Bank', 'No agent guesswork. Every decision is logged with its reasons.'],
  ];
  who.forEach(([k, v], i) => {
    const y = 4.75 + i * 0.75;
    t(s, k, { x: 0.6, y, w: 1.6, h: 0.6, bold: true, fontSize: 15, color: C.accent1, valign: 'top' });
    t(s, v, { x: 2.2, y, w: 4.9, h: 0.65, fontSize: 15, valign: 'top' });
  });
  card(s, 7.6, 2.05, 5.1, 4.45, C.text2, 'measured');
  t(s, 'MEASURED TODAY, LIVE', { x: 7.95, y: 2.3, w: 4.5, h: 0.35, bold: true, fontSize: 12, color: C.background2, charSpacing: 2 });
  const stats = [['4 / 4', 'genuine calls approved', C.accent2], ['2 / 2', 'clone attacks blocked', C.accent4], ['~7 s', 'to a verdict, while the caller holds', C.accent1]];
  stats.forEach(([n, l, col], i) => {
    const y = 2.85 + i * 1.15;
    t(s, n, { x: 7.95, y, w: 1.9, h: 0.9, fontSize: 36, bold: true, color: col, valign: 'middle' });
    t(s, l, { x: 9.9, y, w: 2.6, h: 0.9, fontSize: 15, valign: 'middle' });
  });
  s.addNotes('India lost 22,845 crore rupees to cyber fraud in 2024, about three times 2023 (MHA, Lok Sabha). We close one specific door: the support call where a fraudster pretends to be the customer. For the customer, the money never moves and they hear about it in seconds. For the bank, there is no guesswork and every decision is logged. Measured live today: four of four genuine calls approved, two of two clone attacks blocked, a verdict in about seven seconds while Neerja asks the caller to hold.');
}

// ---------------------------------------------------------------- 5. Scale
{
  pres.addSection({ title: 'Scale' });
  const s = pres.addSlide({ masterName: 'CS_CONTENT', sectionTitle: 'Scale' });
  head(s, 'SCALE', 'Pay per protected transaction, not per call minute');
  s.addChart(pres.charts.BAR, [{ name: 'DetectifAI checks per call', labels: ['Scan the whole call', 'CallShield'], values: [15, 0.2] }], {
    x: 0.6, y: 2.0, w: 5.6, h: 3.6, barDir: 'bar', chartColors: ['2F3646', 'D4FF2A'], showValue: true, dataLabelPosition: 'outEnd',
    dataLabelColor: 'E8EBF2', dataLabelFontSize: 14, dataLabelFormatCode: 'General', dataLabelFontFace: '+mn-lt', catAxisLabelColor: 'E8EBF2', catAxisLabelFontSize: 13,
    catAxisLabelFontFace: '+mn-lt', valAxisHidden: true, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
    showLegend: false, showTitle: true, title: 'DetectifAI checks per call (illustrative)', titleColor: '8D95A8', titleFontSize: 13,
    titleFontFace: '+mn-lt', objectName: 'ops-chart',
  });
  t(s, '~75× fewer checks: 1 lakh calls/day, 5 min each, 1 in 10 with a high-risk request.',
    { x: 0.6, y: 5.7, w: 5.6, h: 0.6, fontSize: 12, color: C.background2 });
  const rows = [
    ['Who pays', 'Banks, UPI apps and NBFC helplines, per protected request (2 checks). Nothing for the rest of the call.'],
    ['Route in', 'Contact centres already stream call audio (Exotel, Twilio, Genesys). Neerja becomes one step in the bank’s phone menu.'],
    ['Risks', 'Phone audio: measured and fixed. Replays: live passphrase plus in-app alert. Privacy: opt-in, delete on request (DPDP).'],
  ];
  rows.forEach(([k, v], i) => {
    const y = 2.05 + i * 1.45;
    card(s, 6.75, y, 5.95, 1.25, C.text2, `scale${i}`);
    t(s, k, { x: 7.05, y: y + 0.15, w: 5.4, h: 0.35, bold: true, fontSize: 15, color: C.accent1 });
    t(s, v, { x: 7.05, y: y + 0.5, w: 5.45, h: 0.7, fontSize: 13, valign: 'top' });
  });
  s.addNotes('The design is the business model: banks pay per protected transaction, two DetectifAI checks per high-risk request and nothing for the rest of the call, about 75 times fewer checks than scanning whole calls (assumptions on the slide). Integration uses the audio streams contact centres already expose, so Neerja becomes one step in the bank\'s phone menu. Risks we have answers for: phone audio (measured and fixed), replay (live passphrase plus customer alert, prompted phrases next), and privacy (opt-in enrollment, delete on request under DPDP).');
}

(async () => {
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log('wrote', OUT);
})();
