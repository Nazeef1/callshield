# CallShield

**A voice-clone fraud guard for bank helpline calls. Powered by DetectifAI.**

UNCLONE AI Hackathon · DetectifAI × B.M.S. College of Engineering · 16–17 Oct 2026 · **Track 01: Unclone Finance**

> A caller phones the bank, sounds exactly like the account holder and asks for a ₹50,000 transfer or a SIM/OTP reset.
> CallShield's virtual agent takes the request, asks for the customer's **voice passphrase**, and asks DetectifAI two
> questions about that voice: **is it real?** and **is it the enrolled customer?** It then **approves**, **blocks**, or
> **hands the call to a human agent**, and alerts the real customer in their banking app.

---

## 1. Problem: one user, one moment

| | |
|---|---|
| **User** | The bank's helpline, which has to decide on the spot whether to carry out what the caller asks. |
| **Who gets hurt** | The **account holder**, whose voice has been cloned from voice notes, reels or an earlier "survey" call. |
| **The moment** | A caller who sounds like the customer asks for a **high-risk action**: fund transfer, SIM/OTP reset, limit change, new beneficiary. |
| **Why today's checks fail** | Knowledge questions can be answered by anyone with leaked data. Voice-ID alone has been beaten by an off-the-shelf clone (Vice/Lloyds Bank, Feb 2023). A human ear can't tell a good clone from the real person. |

What CallShield changes: **the high-risk action does not go through until DetectifAI says the voice is real and belongs to the customer.**

## 2. The three surfaces

| Surface | Who | What it does |
|---|---|---|
| **CallShield Bank app** (Android, `android/` → `/app.html`) | The customer | **Enroll** their voice (reads a short script; ~25 s), **call the bank**, and an **alerts inbox** ("a call claiming to be you was blocked — *It was me* / *Not me*"). |
| **Receive screen** (`/`) | The bank (laptop) | **Go online** once; every incoming call is answered by the virtual agent **Neerja**. Shows the live conversation, the verdict (voice match + deepfake + reasons) and recent calls. A human can **Take over** at any time; STEP UP hands the call to them automatically. |
| **Attack Lab** (`/attack.html`, laptop-only) | The red team | Emulate a fraud call: pick a victim, give the call a **request** clip and a **passphrase** clip (ready-made sample, uploaded file, or a clone generated on the local GPU from a consenting person's voice), **Place call**. The clips play automatically when Neerja is listening; the page reports whether the attack got through. Never uses the microphone. |

## 3. How a call works

```
 Phone app ──WebRTC audio──▶ Receive screen (laptop browser)                       DetectifAI
   dial                       Neerja: greeting ─▶ hears the request (Chrome speech recognition
                              on the call audio) ─▶ "say your voice passphrase"
                              passphrase audio ── digital silence removed ──▶ POST /api/check ─▶ /v1/speakers/verify
                              (deepfake clip: passphrase if ≥ 4.5 s, else request + passphrase)  /v1/deepfake/detect
                              ◀── risk engine: APPROVE / STEP UP / BLOCK ◀──────────────────────
   ◀── call state ("Say your passphrase", "Verifying…", outcome) over the signaling socket
   ◀── alert in the app on STEP UP / BLOCK ── "It was me" / "Not me" ─▶ DetectifAI feedback (automatic)
```

- **Speaker verification runs on the passphrase only**: *"My voice is my password, and I am calling CallShield Bank to
  approve my own request."* (`frontend/voice/agent/prompts.json`). If it is under DetectifAI's 3 s minimum, Neerja asks once more.
- **Call audio is cleaned the same way for enrollment and checks.** A WebRTC call sends long runs of *digital silence*
  (exact zeros) while the caller is quiet; in our tests they were 60–70 % of a clip and dragged a genuine caller's match
  from **0.85 to 0.21** and made the deepfake check spike. `dropDigitalSilence` removes only those runs; natural pauses
  stay (cutting natural silence splices the audio, which makes real voices look synthetic).
- **Enrollment goes through the call's audio path.** The app records the customer through a local WebRTC loopback (the
  same Opus encode/decode as a call), so the voiceprint sounds like the calls it is compared with.
- Signaling: `WS /api/call/ws` (`backend/calls.py`) relays call setup and the agent's `state` messages; audio flows
  peer to peer. Phone and laptop on the same network (e.g. a phone hotspot) is the reliable setup.

## 4. Risk engine (`backend/risk.py`): deterministic and explainable

| Signal | Points |
|---|---|
| Deepfake verdict `fake` | **+70** |
| Deepfake verdict `not_sure` | +30 |
| Deepfake verdict `real` | + round(score × 20) (0–20) |
| Deepfake result missing (DetectifAI error) | +30, and **never APPROVE** (fails closed) |
| Speaker `no_match` | **+50** |
| Speaker `match` but similarity < threshold + 0.10 (weak match) | +10 |
| No speaker check (caller not enrolled / passphrase too short) | +20 |
| Action `sim_otp_reset` | +15 |
| Action `fund_transfer` | +10 (**+10 more** if amount ≥ ₹50,000) |
| Action `limit_change` / `beneficiary_add` | +10 |

| Decision | Rule | What happens |
|---|---|---|
| **BLOCK** | verdict `fake` **or** score ≥ 70 | Neerja refuses and hangs up; the customer is alerted in the app |
| **STEP UP** | score ≥ 35 **or** verdict `not_sure` **or** no deepfake verdict | Neerja hands the call to the human agent; the customer is asked to confirm in the app |
| **APPROVE** | otherwise | Neerja confirms the request and hangs up |

Every assessment lists its reasons in plain language. The customer's *It was me* / *Not me* reply is reported to
DetectifAI's feedback API automatically: what it proves about each verdict, once per check.

## 5. Setup and run (Windows)

Requirements: Python 3.15 venv at `.venv` (`pip install -r requirements.txt`), desktop Chrome, and a DetectifAI key in
`.env` (never committed):

```powershell
# .env
DETECTIF_API_KEY=dtf_live_xxxxxxxxxxxxxxxx

.\run.ps1                       # http://localhost:8000  (Receive screen at /, Attack Lab at /attack.html)
```

**Phone app** (JDK 17 + Android SDK 34 + Gradle 8.7; no Android Studio needed):

```bash
cd android && gradle assembleDebug          # sdk.dir in android/local.properties
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8000 tcp:8000               # the app opens http://localhost:8000/app.html by default
# public server instead:  adb shell am start -n com.callshield.bank/.MainActivity -e url https://<host>/app.html
```

**Voice cloning for the Attack Lab** (local GPU, laptop only): `.\run_cloner.ps1` (listens on `127.0.0.1:8100`).

**Neerja's voice** is pre-generated (Microsoft neural TTS `en-IN-NeerjaNeural` via edge-tts):
`python tools/make_agent_voice.py` regenerates `frontend/voice/agent/*.mp3` from `prompts.json`.

| Setting | Effect |
|---|---|
| `CALLSHIELD_ATTACK_LAB=0` | Turns the Attack Lab off (it is otherwise served only to laptop-local requests: loopback client, loopback Host/Origin, no proxy/tunnel headers) |
| `CALLSHIELD_CALL_CODE=…` | Requires `?code=…` on the call socket (leave unset on a public demo link) |
| `CALLSHIELD_DEBUG_AUDIO=1` | Keeps a copy of enrollment / check audio in `data/debug/` for diagnosis |
| `CALLSHIELD_CLONER_URL`, `CALLSHIELD_CLONER_TOKEN` | Where the cloning service runs and its shared secret |

Delete voiceprints (DetectifAI + local record): `python tools/delete_enrollments.py <customer_id>…` or `--all`.
Tests: `.venv\Scripts\python -m unittest` (a fake DetectifAI client; no credits used).

## 6. Backend API (same origin)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | DetectifAI health, credits, `cost_per_check` |
| GET / DELETE | `/api/customers`, `/api/customers/{id}` | Enrolled customers; delete a voiceprint (DPDP: deletion on request) |
| POST | `/api/enroll` | multipart `file` (15–60 s), `customer_id`, `display_name`, `phone_last4?` |
| POST | `/api/check` | multipart `file` (passphrase, verified), `deepfake_file?` (> 4 s, deepfake check), `customer_id`, `action`, `amount?`, `call_id`, `transcript?` → assessment |
| GET | `/api/assessments` | History, newest first |
| GET | `/api/events` | Server-Sent Events: `assessment`, `alert`, `customer_response` |
| POST | `/api/alerts/{check_id}/respond` | `{"response": "me" \| "not_me"}` → automatic DetectifAI feedback |
| POST | `/api/feedback` | `{operation_id, correct}` |
| WS | `/api/call/ws?role=caller\|agent` | Call signaling + the agent's `state` messages |
| GET/POST | `/api/attack/status`, `/api/attack/warmup`, `/api/attack/clone` | Attack Lab (laptop-only) |

DetectifAI upstream: `https://platform.detectif.ai/v1`, Bearer auth, an `Idempotency-Key` per paid request. 429/503
are retried after `Retry-After`; dropped connections, timeouts and 502/504 are retried once with the same key, so a
retry can never run or charge a check twice.

## 7. Credits: spend only at the high-risk moment

CallShield doesn't stream every second of every call to the API. A call costs credits only when a caller asks for a
high-risk action and says the passphrase: one verification + one deepfake check (~100 credits). Enrollment is one
operation (50). This is also the business model: **cost per protected transaction, not per call minute**.

## 8. Consent and ethics

- **Only consented voices.** Every voice in the demo belongs to a team member who agreed to it; clones are made only
  from a consenting member's own voice (the Attack Lab requires a consent tick; clones are never stored by CallShield).
- **Live means live.** Every result comes from a real DetectifAI call.
- **Voiceprints:** enrollment is opt-in; the voiceprint is held by DetectifAI under the customer id and can be deleted
  on request. In a bank deployment this falls under India's DPDP Act 2023 (consent, purpose limitation, deletion).
- **Explainable, not a black box.** Every decision lists its reasons. Uncertain signals STEP UP to a human instead of
  blocking, so a genuine customer is never locked out by one borderline score.
- The live transcript uses Chrome's speech recognition (audio goes to Google). A bank would use its own transcription.

## 9. Tools used (disclosure, rule 5.2)

- **DetectifAI** Speaker Verification (enroll, verify), Deepfake Detection (detect), feedback API
- **Python 3.15 / FastAPI / uvicorn / httpx / python-dotenv** (backend)
- **Vanilla HTML/CSS/JS, Web Audio API, WebRTC, Server-Sent Events**; **Chrome Web Speech API** (live transcript)
- **Android** (Java WebView shell, `android/`)
- **edge-tts** (Microsoft neural voice `en-IN-NeerjaNeural`) for Neerja's pre-generated prompts
- **Chatterbox** (Resemble AI, open-source, local GPU) and optionally **ElevenLabs** for consented test clones
- cloudflared (public HTTPS link), if used

## 10. Team

| Name | Role | College / programme |
|---|---|---|
| [Member 1] | [e.g. backend + DetectifAI integration] | [ ] |
| [Member 2] | [e.g. frontend + audio] | [ ] |
| [Member 3] | [e.g. product, pitch, demo; enrolled "customer" voice] | [ ] |

More: [`DEMO.md`](DEMO.md) (live demo runbook), [`pitch/script.md`](pitch/script.md) (presentation script), `pitch/CallShield_Final.pptx` (deck).
