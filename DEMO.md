# CallShield: 3-minute live demo script

Three scenes with the same customer and the same console, ending in three different decisions: **APPROVE → BLOCK → STEP UP**.
Every result on stage is a real DetectifAI call. The `LIVE · DetectifAI` pill must be green the whole time.

**Cast**
- **Agent** (drives the laptop): plays the bank's support agent.
- **Customer** (team member enrolled as the account holder): speaks in scene A and holds the "customer's phone".
- **Impostor** (the other teammate): speaks in scene C.
- The **clone** of the Customer's voice was made in advance **by the Customer, with their written consent**, and is used only in scene B.

> The spoken lines below assume a female Customer ("she/her"); change the pronouns to match your teammate.
> Button and label names below follow CONTRACT.md. Before the demo, check them against the final `frontend/index.html` and fix this file if they changed.

---

## Pre-demo checklist (T-30 min)

**Credits and mode**
- [ ] `GET /api/status` (or the status pill) shows **`LIVE · DetectifAI`** and **credits ≥ 300** (≥ 400 gives one retry). If below 300, tell the team now: do not demo live on an empty wallet.
- [ ] `CALLSHIELD_MODE` is **not** set to `mock` in the terminal that runs the server.
- [ ] DetectifAI health = `ok` in the status pill.

**Customer and audio**
- [ ] The **Customer** team member is already enrolled through `/enroll.html` (15–60 s, ≥ 10 s of speech, quiet room). Shows in the console's customer list with `samples ≥ 1`.
- [ ] Clone clip ready on the laptop: `clone_sim_reset.wav`, **8–15 s**, with the request in it ("...I've lost my phone, please reset my SIM and send the OTP to my new number...").
- [ ] If cloning live in the Attack Lab: `.\run_cloner.ps1` running, `/attack.html` shows the cloner **Online**, **Warm up GPU model** pressed (Local GPU shows *loaded*). Keep `clone_sim_reset.wav` as the fallback.
- [ ] Mic test in the console: speak and check the level meter moves. Use the same mic for enrolment and demo (a laptop mic and a headset sound different).
- [ ] Close other tabs and apps using the mic (Meet, Zoom, WhatsApp desktop).
- [ ] Chrome mic permission set to **Allow** for the demo URL.

**Customer's phone**
- [ ] `phone.html` open on a **second device** (Customer's phone), screen on, auto-lock off, brightness up.
  - Same Wi-Fi: `http://<laptop-LAN-IP>:8000/phone.html` (server started with `--host 0.0.0.0`; allow it through Windows Firewall), **or**
  - the public tunnel URL `https://<x>.trycloudflare.com/phone.html`.
- [ ] Confirm phone.html is connected (SSE connected indicator / no error), and that an alert from a **mock-mode** run reached it during rehearsal. **Do not spend live credits to test the phone.**

**Screen**
- [ ] Console at 1366×768 or projector resolution, zoom 100–110 %, history cleared or scrolled so the new card is visible.
- [ ] Deck open in another window on slide 3 (DetectifAI) for Q&A.
- [ ] Laptop on charger; notifications off (Focus Assist on).

**Fallback if Wi-Fi dies**
1. Switch the laptop to a **phone hotspot** (pre-paired, tested), restart the tunnel if one is used and reload the pages. This takes about 60 s.
2. If DetectifAI is unreachable (health `down`, `upstream_error`): say so plainly and use the **last real live results** in the console's history (`GET /api/assessments`, each card shows its real `request_id`, timestamp and `live` badge). Present them as *earlier live runs, not live now*.
3. Last resort: restart with `CALLSHIELD_MODE=mock`. The UI then shows **MOCK MODE** everywhere. Say: *"This is mock mode, clearly labelled; it shows the flow, not a detection."* Never present mock as live (rule 5.4).

---

## The script (3:00)

### 0:00–0:20 · Set-up (Agent)
**On screen:** console at `/`, pill `LIVE · DetectifAI · 1,9xx credits`. Customer holds the phone with `phone.html` showing "No alerts".

> "This is a bank's support desk. I'm the agent. Callers ask me to move money and reset SIMs all day, and I have to decide from a voice.
> [Customer's name] is our account holder. She enrolled her voice once, at onboarding. CallShield sits on my call and only acts when a caller asks for something dangerous."

### 0:20–1:00 · Scene A: genuine customer → APPROVE
**Click path:** Customer selector → **[Customer's name]** → **Start call** (mic on) → Customer speaks into the mic →
the keyword trigger catches "transfer" (or Agent picks **Action: Fund transfer**, **Amount: 50000**, clicks **Check now**).

**Customer (live, into the mic, ~8–10 s):**
> "Hi, this is [name], my account ends 4821. I'd like to transfer fifty thousand rupees to my landlord. It's the same account I paid last month."

**On screen:** decision card **APPROVE**, risk ~20 (low). Speaker **match** (similarity vs threshold), deepfake **real**, latency in ms, credits −100.

**Agent:**
> "One request to DetectifAI checked two things: is this the enrolled voice, and is it a real human voice. Both pass, so it's approved. That cost us one check, only because she asked to move money."

### 1:00–2:05 · Scene B: voice clone → BLOCK → customer alerted → "Not me"
**Click path:** **New call** → Customer selector stays **[Customer's name]** (the caller *claims* to be her) → **Action: SIM / OTP reset** →
**Upload clip** → `clone_sim_reset.wav` → **Check** (trigger = upload).
*(Optional if rehearsal showed it works: play the clip from a phone speaker into the mic instead of uploading.)*

**Option: make the clone live in the Attack Lab** (presenter's laptop only, `http://localhost:8000/attack.html`; needs `.\run_cloner.ps1` running and the
local model warmed up beforehand. On the public tunnel the page and its nav link are blocked/hidden.)
1. **Attack Lab** tab → **Record my voice**: the Customer reads the passage for ~20 s (*"that's all a fraudster needs from a reel"*) → ticks
   **"This is my own voice and I consent to cloning it for this test."**
2. Quick-pick **SIM–OTP reset** (sets the script and the action) → engine **Local GPU model** → **Generate clone** (spinner + elapsed time; a warm model
   takes seconds) → play it once for the room.
3. **Caller claims to be** = [Customer's name] → **Attack CallShield with the clone** → compact verdict **BLOCK** (deepfake *Synthetic*, speaker often
   still *Match*) → **Compare with your real voice** → **APPROVE**. The summary line reads *Real voice → APPROVE · Clone → BLOCK*.
   Both checks are live (~100 credits each, confirmed once) and also land in the console's audit log; **Open in Agent Console ↗** shows the full card.
4. Theatre variant: with a console call running (another window), press **Play into live call**: the clone plays at full volume into the console mic.
   Chrome's echo cancellation can suppress audio played by the same machine, so rehearse it; otherwise play the downloaded WAV from a phone next to the mic.
   This variant replaces the upload check above; don't run both (credits).

**Agent (while it runs):**
> "Now a caller who sounds exactly like her. This is a voice clone. [Name] made it of herself, with consent, for this demo. It asks for a SIM and OTP reset, which is how accounts get taken over."

**On screen:** **BLOCK**, risk 85–100 (high). Reasons: *Synthetic voice detected (score 0.xx)* and *High-risk action: SIM/OTP reset*.
Point at the speaker result: **it may still say `match`.**

**Agent:**
> "Look at this: speaker verification may say it *matches*. A good clone sounds like her, which is why voice-ID alone has been beaten in the real world. DetectifAI's deepfake detector says it's synthetic, so CallShield blocks the reset. I couldn't override it if I wanted to."

**On the Customer's phone:** alert *"CallShield blocked a SIM/OTP reset requested on a call claiming to be you…"* → Customer taps **Not me**.
**On the console:** customer response **"Not me"** appears on the card.

**Customer:**
> "That wasn't me. I'm standing right here."

### 2:05–2:45 · Scene C: human impostor → STEP UP
**Click path:** **New call** → Customer selector **[Customer's name]** → **Start call** → Impostor speaks → **Action: Add beneficiary** → **Check now**.

**Impostor (live, own voice, ~8–10 s):**
> "Hello, I'm [Customer's name]. I'm travelling and I need to add a new beneficiary urgently, my brother's account. Please do it on this call."

**On screen:** **STEP UP**, risk ~60 (medium). Deepfake **real** (it *is* a real human) and speaker **no_match** (it isn't her). Customer's phone gets *"Confirm in the app if this was you"* → Customer taps **Not me**.

**Agent:**
> "A real human, so the deepfake check passes. But it isn't her voice, and speaker verification catches it. CallShield steps up: I need extra verification, and the real customer has already said 'not me'. If he had asked for ₹50,000 instead, it would have been a straight block."

### 2:45–3:00 · Close (Agent)
> "Three calls and three decisions, all made on DetectifAI's result. Take DetectifAI out and CallShield has nothing to decide on. We spend credits only when money or a SIM is about to move. That's 300 credits for this demo, and it's how this scales: cost per protected transaction, not per call minute."

---

## Credit budget for this demo

| Item | Operations | Credits |
|---|---|---|
| Customer enrolment (done before judging) | 1 | 50 |
| Scene A: verify + deepfake | 2 | 100 |
| Scene B: verify + deepfake | 2 | 100 |
| Scene C: verify + deepfake | 2 | 100 |
| **Demo total** | **6** | **300** (+50 enrolment beforehand) |
| Reserve for one retry | 2 | 100 |

Phone alerts, customer responses, history, health/credits checks and feedback are **free**.

## If something goes off-script

- **Scene A comes back STEP UP** (weak match, noisy room): say so. *"Borderline voice match, so it steps up instead of approving. That's the safe failure: the genuine customer gets one extra check, not a block."* Do not re-run more than once.
- **Scene B clone comes back `not_sure`** → STEP UP: *"The detector isn't certain, so we don't approve. Not sure always means step up."*
- **Scene B clone comes back `real`**: be honest. *"This clone got past the detector on this clip; that's why speaker verification and the customer alert are layered on top."* Do not re-run hoping for a better number.
- **`audio_too_short`**: the clip had < 2 s of speech (verify) or ≤ 4 s audio (deepfake). Speak for ~8 s and re-check.
- **`insufficient_credits`**: stop live checks and show earlier live results from history (see Fallback).

---

## Likely judge questions: crisp answers

**"What about false positives? You'll block real customers."**
Only a `fake` verdict or a score ≥ 70 blocks. Uncertain signals (`not_sure`, weak match, borderline score) **step up**: the agent falls back to the bank's existing extra verification, and the customer can confirm on the trusted channel. A block stops *one action*, not the account or the call. Every decision shows its reasons, and confirmed outcomes go back to DetectifAI through the feedback API.

**"Latency?"**
One API request per high-risk action: verify and deepfake run in the same call. The card shows DetectifAI's own `latency_ms` for every check, so you're seeing the real number, not a claim. It happens while the agent is still typing the request, and nothing is checked during normal conversation.

**"Phone calls are 8 kHz, not a laptop mic."**
True. Our prototype captures 16 kHz in the browser. Bank telephony streams (Exotel's stream applet, for example) deliver 8 kHz 16-bit PCM. Day 2 item #1 is to downsample our clips to the 8 kHz telephony band and re-run them live to measure the effect on scores and thresholds. We haven't measured it yet, and we won't claim a number until we have.

**"Hindi / Kannada / code-mixed callers?"**
The trigger and the detection are separate. The DetectifAI checks run on the voice itself. We'll test Hindi speech live on Day 2 rather than assume. The keyword trigger is the language-dependent part: today it's English keywords. On Day 2 we add Hindi phrases ("paise transfer", "SIM band", "OTP") through the Web Speech API's Hindi locale, and the agent's manual **Check now** button works in any language.

**"Isn't storing voiceprints a privacy risk?"**
Enrolment is opt-in, like setting up a UPI PIN. The voiceprint lives with DetectifAI under the customer id, and CallShield keeps metadata and results. Under India's DPDP Act 2023 this needs consent, purpose limitation and deletion on request. A voiceprint also can't be used to *make* a call; it's only compared against.

**"Why not just OTP?"**
OTP proves you have the phone. The **SIM/OTP reset** call is exactly how fraudsters get the phone number moved to their SIM, after which every OTP goes to them. CallShield guards the call that would otherwise break OTP, and it alerts the customer on a channel the fraudster doesn't control.

**"How does this plug into a real bank's IVR / contact centre (Exotel, Ozonetel, Genesys)?"**
CallShield only needs a copy of the caller's audio and a "high-risk action" event. CCaaS platforms expose real-time media streams over WebSocket (e.g. Exotel's stream applet, Twilio Media Streams, Genesys Cloud AudioHook). That stream feeds the same rolling buffer that the browser mic feeds today. The action event comes from the agent desktop/CRM (the agent clicks "SIM reset"), and the decision goes back as an approve / step-up / block flag on that action. Building the Twilio/Exotel stream path is on our Day 2 plan.

**"Cost per check?"**
Here it's 2 DetectifAI operations (100 credits) per high-risk request. The point is *what we don't spend*: no credits for small talk or balance queries. A bank pays per protected transaction, not per call minute. (Commercial pricing per operation is DetectifAI's to set; our design minimises operations per call.)

**"What if the fraudster just stays silent, or plays music?"**
Then there's nothing to verify, and **no verification never means approve.** The API needs ≥ 2 s of speech for verification and > 4 s of audio for deepfake detection. Without it the check returns `audio_too_short`, and the agent cannot get an APPROVE for the high-risk action. The bank's normal step-up applies. A caller who wants money moved has to speak, and that's when we check.

**"What if they record the real customer and replay it?"**
A replayed recording is real speech from the real person, so it can match. Two mitigations: the clip is taken **at the moment of the request** (the fraudster has to say *this* request, in *this* conversation), and the customer alert on the trusted channel catches what slips through. Day 2+: prompted phrases (a random phrase the caller must repeat) make replay much harder.

**"What if the clone gets better than the detector?"**
That's why there are three layers: deepfake detection, speaker verification **and** the out-of-band customer alert. The feedback API sends confirmed misses back to DetectifAI, so the model keeps improving.

**"Why not check the whole call continuously?"**
We could (the registration idea streams the call). It's also the most expensive way to do it. Risk is concentrated in the few seconds where someone asks for money or a SIM change, so we check that moment. A continuous deepfake sweep is a premium option for high-value accounts (see Scale slide).

**"Is anything hard-coded?"**
No. Every live card shows DetectifAI's `request_id`, `operation_id`, real latency and the credit balance going down. Mock mode exists for development and is labelled MOCK everywhere.

**"What did you use to build it?"**
DetectifAI Speaker Verification + Deepfake Detection APIs, Python/FastAPI, vanilla JS + Web Audio API, Chrome Web Speech API, Server-Sent Events, Claude Code as our coding assistant, and [clone tool] to make the consenting teammate's clone. All of it is listed on the DetectifAI slide.
