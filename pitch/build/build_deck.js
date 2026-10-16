// Builds pitch/CallShield_Day1.pptx — 5 slides in the required order:
// Problem, Solution, DetectifAI, Impact, Scale (+ Day 2 plan). Run: node build_deck.js
const path = require("path");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fa = require("react-icons/fa6");
const { applyTheme } = require("./apply_theme.js");

const OUT = path.join(__dirname, "..", process.env.DECK_NAME || "CallShield_Day1.pptx");

// Dark product palette (matches the CallShield console). text1 is light because the deck is dark.
const THEME = {
  name: "CallShield",
  headFontFace: "Arial",
  bodyFontFace: "Calibri",
  colors: {
    dk1: "E8EAF0", lt1: "0F1115", dk2: "9AA3B2", lt2: "171A21",
    accent1: "D4FF2A", accent2: "FF4D3D", accent3: "FFB020", accent4: "2ECC71",
    accent5: "2A2F3A", accent6: "7AA2FF", hlink: "D4FF2A", folHlink: "9AA3B2",
  },
};
const HEX = { bg: "0F1115", panel: "171A21", border: "2A2F3A", text: "E8EAF0", muted: "9AA3B2",
  lime: "D4FF2A", red: "FF4D3D", amber: "FFB020", green: "2ECC71", grey: "5A6170" };

async function icon(Comp, hex, size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color: "#" + hex, size }));
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}

(async () => {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
  pres.title = "CallShield — UNCLONE 2026";
  pres.author = "Team CallShield";
  pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
  const C = pres.SchemeColor;

  pres.defineSlideMaster({
    title: "CS_CONTENT",
    background: { color: HEX.bg },
    objects: [
      { placeholder: { options: { name: "kicker", type: "body", x: 0.5, y: 0.25, w: 7.5, h: 0.3,
        fontSize: 11, bold: true, color: C.accent1, charSpacing: 2, margin: 0, valign: "middle" }, text: "" } },
      { placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.55, w: 9.0, h: 0.7,
        fontSize: 24, bold: true, color: C.text1, margin: 0, valign: "middle", align: "left", fontFace: THEME.headFontFace }, text: "" } },
      { text: { text: "CallShield  ·  UNCLONE 2026  ·  Track 01 Unclone Finance",
        options: { x: 0.5, y: 5.27, w: 6, h: 0.25, fontSize: 10, color: C.text2, margin: 0, isTextBox: true } } },
    ],
    slideNumber: { x: 9.0, y: 5.27, w: 0.5, h: 0.25, fontSize: 10, color: HEX.muted, align: "right" },
  });

  const I = {
    headset: await icon(fa.FaHeadset, HEX.lime), warn: await icon(fa.FaTriangleExclamation, HEX.amber),
    robot: await icon(fa.FaRobot, HEX.red), phone: await icon(fa.FaPhoneVolume, HEX.text),
    engine: await icon(fa.FaGaugeHigh, HEX.text), bell: await icon(fa.FaBell, HEX.text),
    shield: await icon(fa.FaShieldHalved, HEX.lime), plug: await icon(fa.FaPlug, HEX.lime),
    finger: await icon(fa.FaFingerprint, HEX.bg), wave: await icon(fa.FaWaveSquare, HEX.bg),
    bolt: await icon(fa.FaBolt, HEX.lime),
  };

  const panel = (s, x, y, w, h, opts = {}) => s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, rectRadius: 0.08, fill: { color: opts.fill || HEX.panel },
    line: { color: opts.line || HEX.border, width: opts.lineW || 1 }, objectName: opts.name });
  const circleIcon = (s, data, x, y, d, fill) => {
    s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill } });
    s.addImage({ data, x: x + d * 0.22, y: y + d * 0.22, w: d * 0.56, h: d * 0.56 });
  };
  const pill = (s, text, x, y, w, color, size = 11) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h: 0.32, rectRadius: 0.16,
      fill: { color, transparency: 80 }, line: { color, width: 1 } });
    s.addText(text, { x, y, w, h: 0.32, fontSize: size, bold: true, color, align: "center",
      valign: "middle", margin: 0, isTextBox: true });
  };
  const arrow = (s, x1, y, x2) => s.addShape(pres.shapes.LINE, { x: x1, y, w: x2 - x1, h: 0,
    line: { color: HEX.muted, width: 1.5, endArrowType: "triangle" } });

  // ───────────── 1 · PROBLEM ─────────────
  pres.addSection({ title: "Problem" });
  let s = pres.addSlide({ masterName: "CS_CONTENT", sectionTitle: "Problem" });
  s.addText("01 · PROBLEM", { placeholder: "kicker" });
  s.addText("It sounds like your customer. It isn't.", { placeholder: "title" });

  circleIcon(s, I.headset, 0.5, 1.45, 0.62, HEX.panel);
  s.addText([
    { text: "Our user: ", options: { color: HEX.muted } },
    { text: "the agent on a bank / UPI support helpline", options: { bold: true, breakLine: true } },
    { text: "who has only a voice to decide who is calling.", options: { color: HEX.muted } },
  ], { x: 1.27, y: 1.4, w: 4.6, h: 0.72, fontSize: 14, color: HEX.text, margin: 0, valign: "middle", isTextBox: true });

  panel(s, 0.5, 2.3, 5.4, 1.5, { name: "moment" });
  s.addImage({ data: I.robot, x: 0.72, y: 2.47, w: 0.3, h: 0.3 });
  s.addText("THE MOMENT · the caller is an AI clone of the customer", { x: 1.12, y: 2.45, w: 4.6, h: 0.32,
    fontSize: 11, bold: true, color: HEX.red, charSpacing: 1, margin: 0, valign: "middle", isTextBox: true });
  s.addText("“Hi, it's Zain. I lost my phone — please reset my SIM and send the OTP to my new number.”",
    { x: 0.72, y: 2.85, w: 5.0, h: 0.85, fontSize: 16, italic: true, color: HEX.text, margin: 0, valign: "top", isTextBox: true });

  s.addImage({ data: I.warn, x: 0.62, y: 4.12, w: 0.38, h: 0.38 });
  s.addText([
    { text: "Stakes: ", options: { bold: true, color: HEX.amber } },
    { text: "reset the OTP and the fraudster controls every UPI payment and transfer on that account." },
  ], { x: 1.27, y: 3.98, w: 4.6, h: 0.7, fontSize: 14, color: HEX.text, margin: 0, valign: "middle", isTextBox: true });

  panel(s, 6.3, 1.45, 3.2, 1.6, { name: "stat-loss" });
  s.addText("₹22,845 cr", { x: 6.5, y: 1.55, w: 2.9, h: 0.65, fontSize: 34, bold: true, color: HEX.lime,
    margin: 0, fontFace: "Arial", isTextBox: true });
  s.addText("lost to cyber fraud in India in 2024", { x: 6.5, y: 2.2, w: 2.9, h: 0.45, fontSize: 12,
    color: HEX.text, margin: 0, isTextBox: true });
  s.addText("3× 2023 · MHA, Lok Sabha, Jul 2025", { x: 6.5, y: 2.68, w: 2.9, h: 0.25, fontSize: 10,
    color: HEX.muted, margin: 0, isTextBox: true });

  panel(s, 6.3, 3.2, 3.2, 1.6, { name: "stat-clone" });
  s.addText("~20 s", { x: 6.5, y: 3.3, w: 2.9, h: 0.65, fontSize: 34, bold: true, color: HEX.red,
    margin: 0, fontFace: "Arial", isTextBox: true });
  s.addText("of a voice note is all our open-source cloner needed", { x: 6.5, y: 3.95, w: 2.9, h: 0.45,
    fontSize: 12, color: HEX.text, margin: 0, isTextBox: true });
  s.addText("69% of Indians aren't sure they'd spot a clone (McAfee, 2023)", { x: 6.5, y: 4.4, w: 2.9, h: 0.32,
    fontSize: 10, color: HEX.muted, margin: 0, isTextBox: true });

  s.addNotes(`ZAIN · ~15 s
Meet a bank helpline agent. A caller sounds exactly like the customer: "I lost my phone, reset my SIM and send the OTP to my new number." It's an AI clone, made from twenty seconds of a voice note. Once the OTP moves, the money moves, and India lost twenty-two thousand crore rupees to cyber fraud last year.

Sources if asked: MHA written reply in the Lok Sabha, 22 Jul 2025 (₹22,845.73 cr in 2024 vs ₹7,465.18 cr in 2023). McAfee "Beware the Artificial Impostor", Apr 2023 (69% of Indian adults not confident they could identify a cloned voice). The "20 s" figure is our own Attack Lab test with the open-source Chatterbox model.`);

  // ───────────── 2 · SOLUTION ─────────────
  pres.addSection({ title: "Solution" });
  s = pres.addSlide({ masterName: "CS_CONTENT", sectionTitle: "Solution" });
  s.addText("02 · SOLUTION", { placeholder: "kicker" });
  s.addText("CallShield checks the voice when money moves", { placeholder: "title" });

  const steps = [
    ["Listen", "Keeps the caller's last 30 s of voice in a rolling buffer. Costs nothing."],
    ["Trigger", "Caller asks for a transfer, SIM/OTP reset, limit change or new payee: spoken keyword or agent click."],
    ["Decide", "Last 8 s → DetectifAI → APPROVE · STEP UP · BLOCK, with reasons."],
    ["Alert", "Real customer's phone: “Was this you?” → It was me / Not me."],
  ];
  steps.forEach(([h, d], i) => {
    const y = 1.45 + i * 0.86;
    s.addShape(pres.shapes.OVAL, { x: 0.5, y: y + 0.05, w: 0.42, h: 0.42, fill: { color: HEX.lime }, line: { color: HEX.lime } });
    s.addText(String(i + 1), { x: 0.5, y: y + 0.05, w: 0.42, h: 0.42, fontSize: 14, bold: true, color: HEX.bg,
      align: "center", valign: "middle", margin: 0, isTextBox: true });
    s.addText([
      { text: h, options: { bold: true, fontSize: 14, color: HEX.text, breakLine: true } },
      { text: d, options: { fontSize: 11, color: HEX.muted } },
    ], { x: 1.07, y, w: 3.3, h: 0.78, margin: 0, valign: "top", isTextBox: true });
  });

  panel(s, 4.6, 1.4, 4.95, 2.71, { line: HEX.red, lineW: 1.5, name: "screenshot-frame" });
  s.addImage({ path: path.join(__dirname, "console_block.jpg"), x: 4.65, y: 1.45, w: 4.85, h: 2.61,
    altText: "CallShield agent console showing a live BLOCK verdict: synthetic voice 1.00, voice match 0.81, risk 85" });
  s.addText("Live console, real DetectifAI result: an AI clone asks for a SIM/OTP reset → BLOCK in 3.4 s, customer alerted.",
    { x: 4.6, y: 4.2, w: 4.95, h: 0.45, fontSize: 11, color: HEX.muted, margin: 0, isTextBox: true });
  pill(s, "APPROVE", 4.6, 4.75, 1.5, HEX.green);
  pill(s, "STEP UP", 6.32, 4.75, 1.5, HEX.amber);
  pill(s, "BLOCK", 8.05, 4.75, 1.5, HEX.red);

  s.addNotes(`ZAIN · ~15 s
CallShield sits on the agent's screen. It listens to the call, and the moment the caller asks for something risky (a transfer, a SIM reset, a limit change or a new payee) it checks the last eight seconds of their voice and decides: approve, step up or block. If it blocks, the real customer's phone is alerted.

Screenshot: a real live check from today (check chk_37577004f12344df).`);

  // ───────────── 3 · DETECTIFAI ─────────────
  pres.addSection({ title: "DetectifAI" });
  s = pres.addSlide({ masterName: "CS_CONTENT", sectionTitle: "DetectifAI" });
  s.addText("03 · DETECTIFAI · BOTH APIS, ONE CALL", { placeholder: "kicker" });
  s.addText("Take DetectifAI out and nothing gets decided", { placeholder: "title" });

  // flow row
  panel(s, 0.5, 1.45, 1.55, 1.35, { name: "flow-trigger" });
  s.addImage({ data: I.phone, x: 1.1, y: 1.58, w: 0.36, h: 0.36 });
  s.addText("Risky request on the call (last 8 s)", { x: 0.58, y: 2.0, w: 1.4, h: 0.7, fontSize: 11, color: HEX.text,
    align: "center", margin: 0, isTextBox: true });
  arrow(s, 2.1, 2.12, 2.4);

  panel(s, 2.45, 1.4, 3.35, 1.45, { fill: "1D2410", line: HEX.lime, lineW: 2, name: "flow-detectif" });
  s.addText("DetectifAI · single verify request", { x: 2.6, y: 1.45, w: 3.1, h: 0.3, fontSize: 11, bold: true,
    color: HEX.lime, margin: 0, isTextBox: true });
  [[I.finger, "Speaker Verification", "Is it the enrolled customer?"], [I.wave, "Deepfake Detection", "Is the voice human or AI?"]]
    .forEach(([ic, h, d], i) => {
      const y = 1.8 + i * 0.5;
      circleIcon(s, ic, 2.6, y, 0.4, HEX.lime);
      s.addText([{ text: h, options: { bold: true, breakLine: true } }, { text: d, options: { color: HEX.muted, fontSize: 10 } }],
        { x: 3.08, y: y - 0.04, w: 2.65, h: 0.48, fontSize: 12, color: HEX.text, margin: 0, valign: "middle", isTextBox: true });
    });
  arrow(s, 5.85, 2.12, 6.15);

  panel(s, 6.2, 1.45, 1.35, 1.35, { name: "flow-engine" });
  s.addImage({ data: I.engine, x: 6.69, y: 1.58, w: 0.36, h: 0.36 });
  s.addText([{ text: "Risk engine", options: { breakLine: true } }, { text: "score 0–100" }], { x: 6.25, y: 2.0, w: 1.25, h: 0.7, fontSize: 11, color: HEX.text,
    align: "center", margin: 0, isTextBox: true });
  arrow(s, 7.6, 2.12, 7.9);

  pill(s, "APPROVE", 7.95, 1.45, 1.55, HEX.green, 10);
  pill(s, "STEP UP", 7.95, 1.83, 1.55, HEX.amber, 10);
  pill(s, "BLOCK", 7.95, 2.21, 1.55, HEX.red, 10);
  s.addImage({ data: I.bell, x: 7.98, y: 2.6, w: 0.2, h: 0.2 });
  s.addText("+ alert real customer", { x: 8.22, y: 2.57, w: 1.3, h: 0.26, fontSize: 10, color: HEX.muted, margin: 0, isTextBox: true });

  // decision rules
  const rules = [
    ["voice = fake", "BLOCK", "AI clone / synthetic", HEX.red],
    ["speaker = no match", "BLOCK / STEP UP", "human impostor", HEX.red],
    ["not sure / not enrolled", "STEP UP", "extra check, no false block", HEX.amber],
    ["real + match", "APPROVE", "genuine customer", HEX.green],
  ];
  rules.forEach(([cond, dec, sub, col], i) => {
    const x = 0.5 + i * 2.3;
    panel(s, x, 3.05, 2.15, 1.0, { name: "rule-" + i });
    s.addText([
      { text: "DetectifAI: " + cond, options: { fontSize: 10, color: HEX.muted, breakLine: true } },
      { text: dec, options: { fontSize: 15, bold: true, color: col, breakLine: true } },
      { text: sub, options: { fontSize: 10, color: HEX.muted } },
    ], { x: x + 0.12, y: 3.1, w: 1.95, h: 0.9, margin: 0, valign: "middle", isTextBox: true });
  });

  s.addImage({ data: I.bolt, x: 0.5, y: 4.27, w: 0.3, h: 0.3 });
  s.addText([
    { text: "Why both: ", options: { bold: true, color: HEX.lime } },
    { text: "our AI clone fooled the voiceprint (match 0.81 ≥ 0.53). Only deepfake detection caught it (0.998 fake) → BLOCK." },
  ], { x: 0.92, y: 4.17, w: 8.6, h: 0.5, fontSize: 13, color: HEX.text, margin: 0, valign: "middle", isTextBox: true });
  s.addText("Tools: DetectifAI Speaker Verification + Deepfake Detection APIs · Python / FastAPI · JavaScript + Web Audio API · " +
    "Chrome Web Speech API · Chatterbox (open-source voice cloning, red-team tests)",
    { x: 0.5, y: 4.7, w: 9.0, h: 0.45, fontSize: 10, color: HEX.muted, margin: 0, valign: "top", isTextBox: true });

  s.addNotes(`ZAIN · ~20 s
DetectifAI is the decision. In one request we run speaker verification (is this the customer?) and deepfake detection (is this voice real?). A fake voice is blocked. A wrong speaker is blocked. If it's unsure, we step up. Here's why we need both: our own AI clone fooled the voiceprint at 0.81, and only deepfake detection caught it. Our tools are listed at the bottom.

If asked "where in the flow": only at the risky-request moment, on the last 8 s of caller audio; enrollment happens once at onboarding. One /v1/speakers/verify request with detect_deepfake=true; /v1/deepfake/detect for callers who aren't enrolled.`);

  // ───────────── 4 · IMPACT ─────────────
  pres.addSection({ title: "Impact" });
  s = pres.addSlide({ masterName: "CS_CONTENT", sectionTitle: "Impact" });
  s.addText("04 · IMPACT · LIVE RESULTS FROM TODAY", { placeholder: "kicker" });
  s.addText("Clones and impostors blocked, customers approved", { placeholder: "title" });

  const stats = [["7 / 7", "live checks decided correctly", HEX.lime], ["~3 s", "from risky request to decision", HEX.text],
    ["2 / 2", "genuine callers approved, no false blocks", HEX.green]];
  stats.forEach(([n, l, col], i) => {
    const y = 1.45 + i * 1.12;
    panel(s, 0.5, y, 2.7, 0.98, { name: "stat-" + i });
    s.addText(n, { x: 0.68, y: y + 0.06, w: 2.4, h: 0.5, fontSize: 28, bold: true, color: col, margin: 0, fontFace: "Arial", isTextBox: true });
    s.addText(l, { x: 0.68, y: y + 0.56, w: 2.4, h: 0.34, fontSize: 11, color: HEX.muted, margin: 0, isTextBox: true });
  });

  const hdr = (t) => ({ text: t, options: { bold: true, color: HEX.muted, fill: { color: HEX.panel }, fontSize: 10 } });
  const cell = (t, o = {}) => ({ text: t, options: Object.assign({ color: HEX.text, fontSize: 12 }, o) });
  s.addTable([
    [hdr("WHO CALLED"), hdr("DETECTIFAI SAID"), hdr("CALLSHIELD DID")],
    [cell("Genuine customer (live mic)"), cell("real 0.004 · match 0.70"), cell("APPROVE", { bold: true, color: HEX.green })],
    [cell("Human impostor (live mic)"), cell("real 0.01 · no match 0.30"), cell("BLOCK · customer tapped “Not me”", { bold: true, color: HEX.red })],
    [cell("AI clone of the customer"), cell("fake 0.998 · match 0.81 (fooled)"), cell("BLOCK", { bold: true, color: HEX.red })],
    [cell("Unknown caller"), cell("real 0.02 · not enrolled"), cell("STEP UP", { bold: true, color: HEX.amber })],
  ], { x: 3.5, y: 1.45, w: 6.0, colW: [2.1, 1.95, 1.95], rowH: 0.42, fill: { color: HEX.bg },
    border: { type: "solid", pt: 0.75, color: HEX.border }, margin: 0.06, valign: "middle", fontFace: "Calibri" });

  s.addText([
    { text: "Customer ", options: { bold: true, color: HEX.text } }, { text: "keeps money + SIM, alerted in seconds   ·   " },
    { text: "Agent ", options: { bold: true, color: HEX.text } }, { text: "gets a decision with reasons, not a guess   ·   " },
    { text: "Bank ", options: { bold: true, color: HEX.text } }, { text: "logs every decision with DetectifAI request IDs" },
  ], { x: 3.5, y: 3.85, w: 6.0, h: 0.8, fontSize: 12, color: HEX.muted, margin: 0, valign: "top", isTextBox: true });

  s.addNotes(`NAZEEF · ~12 s
These are real results from today, all live DetectifAI calls. Seven out of seven decisions correct, in about three seconds. Genuine callers were approved. An impostor was blocked, and the real customer tapped "Not me". The clone was blocked too, even though it fooled the voiceprint.

Data: the CallShield audit log, 16 Oct 2026 (7 live assessments; latency 2.5–4.0 s end to end).`);

  // ───────────── 5 · SCALE + DAY 2 ─────────────
  pres.addSection({ title: "Scale" });
  s = pres.addSlide({ masterName: "CS_CONTENT", sectionTitle: "Scale" });
  s.addText("05 · SCALE + WHAT WE BUILT", { placeholder: "kicker" });
  s.addText("Pay per protected transaction, not per minute", { placeholder: "title" });

  s.addChart(pres.charts.BAR, [
    { name: "Scan the whole call every 20 s", labels: ["DetectifAI ops per call"], values: [15] },
    { name: "CallShield (risky moments only)", labels: ["DetectifAI ops per call"], values: [0.2] },
  ], { x: 0.5, y: 1.35, w: 4.4, h: 1.95, barDir: "bar", barGrouping: "clustered", barGapWidthPct: 40,
    chartColors: [HEX.grey, HEX.lime], showValue: true, dataLabelFormatCode: "0.0", dataLabelColor: HEX.text, dataLabelFontSize: 11,
    dataLabelFontFace: "+mn-lt", showLegend: true, legendPos: "b", legendColor: HEX.muted, legendFontSize: 10,
    legendFontFace: "+mn-lt", catAxisHidden: true, valAxisHidden: true, valGridLine: { style: "none" },
    catGridLine: { style: "none" }, showTitle: true, title: "API operations per call (illustrative)",
    titleColor: HEX.text, titleFontSize: 12, titleFontFace: "+mn-lt" });
  s.addText("1 lakh calls/day · 5-min calls · 1 in 10 has a risky request → ~75× fewer API calls.",
    { x: 0.5, y: 3.35, w: 4.4, h: 0.3, fontSize: 10, color: HEX.muted, margin: 0, isTextBox: true });

  panel(s, 0.5, 3.8, 4.4, 1.05, { name: "integration" });
  s.addImage({ data: I.plug, x: 0.68, y: 3.98, w: 0.32, h: 0.32 });
  s.addText([
    { text: "Plugs into the bank's existing contact centre", options: { bold: true, color: HEX.text, breakLine: true } },
    { text: "Exotel · Twilio · Genesys audio streams feed the same check. Same engine for UPI apps, NBFC, card and insurance helplines." },
  ], { x: 1.12, y: 3.88, w: 3.7, h: 0.9, fontSize: 11, color: HEX.muted, margin: 0, valign: "middle", isTextBox: true });

  panel(s, 5.2, 1.35, 4.3, 3.5, { name: "prototype" });
  s.addText("PROTOTYPE BUILT TODAY · working end to end", { x: 5.4, y: 1.45, w: 3.95, h: 0.32, fontSize: 11, bold: true,
    color: HEX.lime, charSpacing: 1, margin: 0, isTextBox: true });
  const built = [
    "Live-call agent console + voice enrollment",
    "Both DetectifAI APIs → risk engine → decision",
    "Customer phone alerts with “Not me” reply",
    "Spoken-keyword triggers (English + Hindi)",
    "Attack Lab: GPU voice-clone red-teaming",
  ];
  built.forEach((d, i) => {
    const y = 1.85 + i * 0.36;
    s.addText("✓", { x: 5.4, y, w: 0.25, h: 0.32, fontSize: 12, bold: true, color: HEX.green, margin: 0, valign: "middle", isTextBox: true });
    s.addText(d, { x: 5.7, y, w: 3.65, h: 0.32, fontSize: 11, color: HEX.text, margin: 0, valign: "middle", isTextBox: true });
  });
  s.addText("NEXT", { x: 5.4, y: 3.72, w: 3.95, h: 0.28, fontSize: 11, bold: true, color: HEX.lime, charSpacing: 1,
    margin: 0, isTextBox: true });
  s.addText([
    { text: "Turn the prototype into a proper working web app", options: { breakLine: true } },
    { text: "Telephony audio test: 8 kHz phone-line calls" },
  ], { x: 5.4, y: 4.02, w: 3.95, h: 0.75, fontSize: 11, color: HEX.text, bullet: true, paraSpaceAfter: 4,
    margin: 0, valign: "top", isTextBox: true });

  s.addNotes(`NAZEEF · ~13 s
It scales because the bank only pays when money is about to move: about seventy-five times fewer API calls than scanning whole calls, and it plugs into the call-centre audio streams banks already use. What you're seeing is a prototype, but it already does pretty much everything: live calls, both DetectifAI APIs, customer alerts and our own voice-clone attack lab. Next, we turn it into a proper working web app and test it on real phone-line audio. Now, judge, let's try it with your voice.

──── LIVE DEMO RUN SHEET (~95 s, Nazeef drives, Zain is the impostor) ────
SETUP (before the timer if allowed): ask the judge for consent → judge reads the card for 25 s (Sound Recorder) → upload once to Enroll (ID judge-01) and once to the Attack Lab (tick consent, choose the SIM/OTP script, Generate clone). Phone page open in a second window. Auto-trigger OFF.
1. REAL: Console → customer judge-01 → Start call → the judge says "I'd like to increase my daily limit" → Limit change → APPROVE.
2. IMPOSTOR: Zain says "This is [judge], transfer fifty thousand to my brother" → Fund transfer → BLOCK (no match) → phone buzzes.
3. CLONE: Attack Lab → play the clone → Attack CallShield (judge-01, SIM/OTP reset) → BLOCK: the clone MATCHED the voiceprint but deepfake = fake → the judge taps "Not me".
CLOSE: point to the audit log (live request IDs, nothing pre-recorded) → delete the judge's voiceprint → ZAIN: "Your voice can be copied. Your account can't."
FALLBACK if the judge declines: the same 3 steps with Zain enrolled (cust-zain-01), Nazeef as the impostor, Zain's clone.`);

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote " + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
