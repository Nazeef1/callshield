# CallShield: 5-slide deck (Problem · Solution · DetectifAI · Impact · Scale)

Strict order, 5 slides only (rule 6.1 / 6.5). About 35 s of speaking per slide, roughly 3 minutes in total, which leaves room for the live demo.
Visual language matches the product: dark background `#0f1115`, lime accent `#d4ff2a`, red `#ff4d3d` for BLOCK, amber `#ffb020` for STEP UP, green `#2ecc71` for APPROVE.
Every statistic is sourced at the bottom of this file. Say the source out loud if asked.

---

## Slide 1: PROBLEM

### On-slide copy
**It sounds like your customer. It isn't.**

> 📞 *"Hi, it's Ramesh. I lost my phone. Reset my SIM and send the OTP to my new number."*

- **User:** the agent on a bank / UPI support helpline
- **Moment:** a caller with the account holder's **cloned voice** asks for a **SIM/OTP reset** or a **₹50,000 transfer**
- The agent has seconds to decide, and only a voice to go on

**47%** of Indian adults have faced, or know someone who faced, an AI voice scam
**69%** aren't confident they could tell a cloned voice from the real one
**Voice-ID alone** was beaten by a free AI clone (UK bank, 2023)

### Visual
Split screen. Left: a support agent with a headset and a CRM field reading "Request: SIM/OTP reset". Right: the caller's waveform with a red dashed box over one segment, labelled "SYNTHETIC". The quote is in big type across the top.

### Speaker notes (~35 s)
"Our user is the agent on a bank's support helpline. Here's the moment: a caller who sounds exactly like the account holder, Ramesh, says he lost his phone and asks for a SIM and OTP reset. Once that reset goes through, every OTP goes to the fraudster. The agent has a few seconds and only a voice to go on. McAfee's 2023 survey found 47% of Indian adults had faced, or knew someone who faced, an AI voice scam, and 69% weren't confident they could tell a clone from the real voice. Banks' own voice-ID isn't safe either: in 2023 a journalist got into his Lloyds account with a free AI clone of his voice."

---

## Slide 2: SOLUTION

### On-slide copy
**CallShield checks the voice at the moment money moves.**

1. **Listen** · rolling buffer of the caller's last few seconds. Costs nothing.
2. **Trigger** · caller asks for a transfer, SIM/OTP reset, limit change or new beneficiary
3. **Decide** · DetectifAI checks the clip, then **APPROVE** · **STEP UP** · **BLOCK**
4. **Alert** · the real customer's phone: *"Was this you?"* → **It was me / Not me**

*One request. A decision with reasons. The agent can't be talked out of a BLOCK.*

### Visual
A screenshot of the live console with a red **BLOCK** card (risk 90, reasons listed) and, next to it, a phone showing the alert with "Not me" highlighted. Small arrows link the 4 steps.

### Speaker notes (~35 s)
"CallShield sits on the agent's call. It keeps a short rolling buffer of the caller's voice locally, which costs nothing. When the caller asks for something dangerous (a transfer, a SIM or OTP reset, a limit change, a new beneficiary), CallShield sends those few seconds to DetectifAI. A deterministic risk engine turns the result into one of three decisions: approve, step up or block, with plain-language reasons on screen. On a step-up or block, the real customer gets an alert on their registered device and can say 'not me'. A fraudster can talk the agent round, but not the block."

---

## Slide 3: DETECTIFAI

### On-slide copy
**Two DetectifAI checks, one decision.**

| | |
|---|---|
| **WHICH API** | **Speaker Verification** (enroll + verify) **and Deepfake Detection** (`detect_deepfake=true`, same request). Deepfake-only `/deepfake/detect` for un-enrolled callers |
| **WHERE** | At the high-risk request, on the last 5–20 s of caller audio. Enrollment once, at onboarding |
| **DECISION** | `fake` → **BLOCK** · `no_match` → **STEP UP / BLOCK** · `not_sure` → **STEP UP** · `real` + `match` → **APPROVE**. Customer alerted on STEP UP / BLOCK |

**Why both:** a clone can still *match* the voiceprint. Deepfake detection catches it. A human impostor is *real*. Speaker verification catches them.
**Take DetectifAI out → no signal → no decision → no product.**

**Tools used:** DetectifAI Speaker Verification + Deepfake Detection APIs (+ feedback API) · Python / FastAPI · vanilla JS + Web Audio API · Server-Sent Events · Chrome Web Speech API (keyword trigger) · [clone tool] for the consenting teammate's voice clone

### Visual
A horizontal flow: *Caller audio → Rolling buffer → [Trigger] → DetectifAI box (two stacked chips: "Is it real?" / "Is it them?") → Risk engine → three coloured outcome pills → Customer phone*. The DetectifAI box is the only lime-filled element on the slide. The tools line runs in small type along the bottom.

### Speaker notes (~35 s)
"We use both DetectifAI APIs in a single request. Speaker verification asks whether this is the enrolled customer. Deepfake detection asks whether this is a real human voice. They sit at exactly one point in the flow: the moment a high-risk action is requested. Each covers the other's blind spot. A clone of the customer can still match their voiceprint, and the deepfake check catches it. A human impostor sounds real, and speaker verification catches them. A fake verdict always blocks. Without DetectifAI there's no signal and nothing to decide on. Our tools are listed at the bottom."

---

## Slide 4: IMPACT

### On-slide copy
**₹22,845 crore lost to cyber fraud in 2024. We close the helpline door.**

- **36.4 lakh** financial-fraud reports in 2024, **~10,000 a day**
- Losses up **~3×** in a year (₹7,465 cr in 2023 → ₹22,845 cr in 2024)

| For… | What changes |
|---|---|
| **Customer** | The SIM/OTP reset or transfer never happens, and they know within seconds |
| **Agent** | A decision with reasons instead of a guess, and cover for saying no |
| **Bank** | Account takeovers stopped at the call that starts them; an audit trail per decision |

**Live today:** 3 calls → APPROVE · BLOCK · STEP UP, all on real DetectifAI results.

### Visual
One huge number, **₹22,845 cr**, with a small "2024 · MHA" source tag. Below it, three icons (customer / agent / bank) with one line each. A bottom strip shows the three decision pills from the demo in green, red and amber.

### Speaker notes (~35 s)
"The Ministry of Home Affairs told Parliament that Indians lost ₹22,845 crore to cyber fraud in 2024, about three times 2023, across 36 lakh financial-fraud reports. That's around ten thousand a day. We aren't claiming to fix all of it. We close one specific door: the support call where a fraudster pretends to be the customer to reset a SIM or move money. For the customer, the money stays put and they hear about it immediately. For the agent, it's a decision instead of a guess. For the bank, every decision is logged with its reasons. And you just saw it make three different decisions live."

---

## Slide 5: SCALE

### On-slide copy
**Pay per protected transaction, not per call minute.**

- **2 DetectifAI operations** per high-risk request, **0** for everything else
- *Illustrative:* 1 lakh calls/day × 5 min. Scanning every 20 s = **15 ops per call**. CallShield, if 1 in 10 calls has a high-risk request = **0.2 ops per call**, so **~75× fewer**
- **Plugs into the contact centre the bank already has:** real-time media streams (Exotel, Twilio, Genesys AudioHook) feed the same buffer. No new agent hardware
- **Same engine, more desks:** UPI app support · NBFC & card helplines · insurer claims · treasury "verify-before-you-pay" callbacks
- **24 billion** UPI transactions in September 2026, all secured by a SIM and an OTP. We guard the call that resets them

### Visual
Left: two bars, "Continuous scan: 15 ops/call" (tall, grey) vs "CallShield: 0.2 ops/call" (short, lime), with "75× fewer" called out. Right: a row of logos-as-text (no real brand logos): "CCaaS media stream → CallShield → DetectifAI".

### Speaker notes (~35 s)
"The design is also the business model. We don't stream every minute of every call to the API. We spend two operations only when someone asks to move money or change a SIM. Take a contact centre with a lakh calls a day: scanning everything every 20 seconds costs about 15 operations a call, and CallShield costs about 0.2. That's around 75 times fewer, and the assumptions are on the slide. Integration uses the real-time audio streams that Exotel, Twilio and Genesys already expose, so agents keep their desks. UPI did 24 billion transactions in September, and every one depends on a SIM and an OTP. We protect the call that resets them."

---

## Day 2 plan (08:00–17:00, 9 hours): tied to the gaps judges can see

| # | Time | Task | Why (the gap) | Credits |
|---|---|---|---|---|
| 1 | 08:00–09:30 | **8 kHz telephony robustness:** downsample our 3 demo clips to the 8 kHz phone band (what Exotel streams), re-run them live, adjust the STEP UP band if scores shift | "Phone audio isn't a laptop mic" | ~200–300 |
| 2 | 09:30–12:00 | **Telephony audio path (proof):** Twilio Media Streams / Exotel stream applet WebSocket → same rolling buffer → `/api/check`. **Hard stop at 12:00**: if it isn't working, cut it and keep the browser mic | "How does this reach a real call?" | 0 (mock) + 100 for one live call |
| 3 | 12:00–13:00 | **Multi-sample enrollment:** a 2nd enrollment sample per customer (DetectifAI `samples` count), "re-enroll" button | Fewer false `no_match` / weak matches on genuine customers | 50–100 |
| 4 | 13:00–13:45 | **Feedback loop:** customer "It was me / Not me" plus an agent override → DetectifAI `POST /operations/{id}/feedback` automatically | Deeper DetectifAI use; the model learns from outcomes | 0 (free) |
| 5 | 13:45–14:45 | **Hindi keyword triggers:** add Hindi phrases ("paise transfer", "SIM band", "OTP", "naya beneficiary") via the Web Speech API's Hindi locale; test one live Hindi check | "Indian callers don't speak English keywords" | 100 |
| 6 | 14:45–15:30 | **Silent-caller policy + agent policy config:** `audio_too_short` → automatic STEP UP; per-bank JSON policy for action weights and thresholds, shown in the console | "What if they stay silent?" and "every bank has different risk appetite" | 0 |
| 7 | 15:30–16:15 | **Analytics strip:** checks, blocks, step-ups, credits spent, **credits per protected transaction** | Turns the Scale slide claim into a live number | 0 |
| 8 | 16:15–17:00 | Update the Impact/Scale slides with measured numbers, full rehearsal ×2 (1 live, 1 mock) | Demo and communication | 100 |

**Ordering rule:** items 1, 3, 4 and 6 must ship; 2, 5 and 7 are stretch goals in that order.

### What we cut (deliberately)
- Real SMS / push / WhatsApp delivery: the trusted-channel page stands in for the bank app.
- Production CCaaS integration, auth/multi-tenant, an agent CRM: a proof stream at most (item 2).
- Continuous whole-call deepfake streaming: it contradicts the credit design. It goes on the Scale slide as a premium option, not a Day 2 build.
- Our own ML models or thresholds learned from data: we don't have the data. We stay deterministic and explainable.
- Native mobile app, Kannada/Tamil triggers (after Hindi), prompted-phrase anti-replay (noted for later).

---

## Sources (cite verbally if asked)

| Claim | Source |
|---|---|
| ₹22,845.73 crore lost to cyber fraud in 2024; ₹7,465.18 crore in 2023 (~206% rise); 36,37,288 financial-fraud incidents reported on NCRP + CFCFRMS in 2024 | Ministry of Home Affairs, written reply in Lok Sabha, 22 Jul 2025, reported by PTI / The Week (theweek.in, 22 Jul 2025) and Scroll (scroll.in, 23 Jul 2025) |
| "~10,000 a day" | Our arithmetic: 36,37,288 ÷ 366 days ≈ 9,940 |
| 47% of Indian adults experienced or know someone who experienced an AI voice scam; 69% not confident they can identify a cloned voice; 83% of Indian victims lost money | McAfee, "Beware the Artificial Impostor" survey, fieldwork 13–19 Apr 2023 (7,054 adults in 7 countries, 1,010 in India), reported by BOOM Live, May 2023 |
| Journalist used an AI voice clone (ElevenLabs) to pass Lloyds Bank's Voice ID | Joseph Cox, Vice/Motherboard, 23 Feb 2023 (also reported by Futurism) |
| "AI has fully defeated" voiceprint authentication (optional line for Q&A) | Sam Altman, Federal Reserve conference, Washington, 22 Jul 2025 (AP via The Week / local10) |
| UAE bank manager moved $35M after a call in a cloned director's voice (optional, for Q&A) | Forbes, 14 Oct 2021, citing a court filing (attack in early 2020) |
| UPI: 24.07 billion transactions in Sept 2026 (~802 million/day) | NPCI data as reported by StartupTalky / Chronicle India / FintechBizNews, Oct 2026. Re-check on npci.org.in before the pitch |
| Exotel streams call audio as 16-bit, 8 kHz, mono PCM over WebSocket | Exotel developer docs, "Working with the Stream and Voicebot Applet" |
| 75× fewer operations | Our illustrative model, assumptions on the slide (1 lakh calls/day, 5 min average, 20-s scan windows, 10% of calls with a high-risk request) |

**Not used (couldn't verify well enough):** specific Indian SIM-swap loss totals, RBI digital-payment-fraud counts (RBI FY26 figures cover only frauds ≥ ₹1 lakh and were reclassified, so they're misleading on a slide), and Truecaller fraud-call counts.
