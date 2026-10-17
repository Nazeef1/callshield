# CallShield: judge demo (≈3 minutes)

## Before the judges arrive

1. Laptop: `.\run.ps1` (live DetectifAI key in `.env`) and, for live clones, `.\run_cloner.ps1`.
2. Laptop Chrome, tab 1: `http://localhost:8000/` → **Go online**. Tab 2: `http://localhost:8000/attack.html`.
3. Phone (same hotspot as the laptop): `adb reverse tcp:8000 tcp:8000`, open **CallShield Bank**. The presenter's
   account is set up and **enrolled** (the app shows "Voice enrolled").
4. Attack Lab: victim = the presenter's account; request + passphrase clips ready (a consented clone of the
   presenter, or the ready-made samples). Preview both once.

## The demo

**Scene 1: the real customer (≈60 s).** On the phone: **Call CallShield Bank**. Neerja greets you on the laptop
speakers. Say *"I want to transfer fifty thousand rupees to my brother."* Neerja confirms and asks for the passphrase;
the app shows it. Say it. The receive screen shows **Approved**, with voice match ~0.85 and deepfake "real". Neerja
confirms and hangs up.

> "The customer never typed anything. Neerja checked the voice itself: real, and really them."

**Scene 2: the clone (≈60 s).** In the Attack Lab: **Place call**. The clone asks for the same transfer, then says
the passphrase in the customer's voice. The receive screen shows **Blocked** (deepfake: synthetic) and Neerja refuses.
The phone app pops an alert: *"A call claiming to be you asked for a fund transfer of ₹50,000 · Blocked"* → tap
**Not me**. That reply goes back to DetectifAI as feedback automatically.

> "Same words, same passphrase, same voice to a human ear. DetectifAI tells the clone apart; the real customer hears
> about it on a channel the fraudster doesn't control."

**Scene 3 (if time): a human impostor.** A teammate calls from the app signed in as the presenter's account. Real
voice, wrong person: speaker **no match** → Blocked, or STEP UP to the human agent for a smaller request. Show
**Take over**: the agent's mic goes live.

## Likely judge questions

**"False positives? You'll block real customers."**
Only a `fake` verdict or a score ≥ 70 blocks. Uncertain signals (`not_sure`, weak match, borderline score) **step
up** to a human agent, and the customer can confirm in the app. A block stops one action, not the account. Every
decision lists its reasons.

**"Why a passphrase, and why is the identity check only on the passphrase?"**
It gives every caller the same, known amount of speech to compare, at the moment they ask for money. DetectifAI
needs ≥ 2 s of speech to verify; our passphrase is ~4 s. The deepfake check needs > 4 s: it runs on the passphrase
when it's long enough, otherwise on the request + passphrase.

**"Phone audio isn't a laptop mic."**
Right, and we measured what matters: a WebRTC call inserts long runs of digital silence while the caller is quiet.
Left in, a genuine caller's match dropped from 0.85 to 0.21. We strip only that digital silence (never natural
pauses, which would splice the audio and look synthetic) and we enroll through the same call audio path, so the
voiceprint sounds like the calls it is checked against.

**"What if the fraudster stays silent or plays music?"**
No verification never means approve. Without enough speech DetectifAI returns an error, the risk engine fails
closed (a missing deepfake verdict can never APPROVE), and the call goes to a human.

**"What if they record the real customer and replay it?"**
A replay is real speech from the real person, so it can match. Mitigations: the passphrase is said live in this
call after a specific request, the customer is alerted in the app on any step-up or block, and a prompted random
phrase is the next step.

**"How does this plug into a real bank's contact centre?"**
CallShield needs a copy of the caller's audio and the request. Contact-centre platforms already stream call audio
over WebSocket (Exotel stream applet, Twilio Media Streams, Genesys AudioHook); that replaces our WebRTC leg, and the
verdict goes back as approve / step-up / block on the request.

**"Cost per check?"**
One verification + one deepfake check (~100 credits) per high-risk request, nothing for the rest of the call. A bank
pays per protected transaction, not per call minute.

**"Is anything simulated?"**
No. Every result is a live DetectifAI call; the receive screen shows the scores, thresholds and reasons for each.

**"Privacy?"**
Enrollment is opt-in. The voiceprint lives with DetectifAI under the customer id and can be deleted on request
(`DELETE /api/customers/{id}`), as India's DPDP Act 2023 requires.
