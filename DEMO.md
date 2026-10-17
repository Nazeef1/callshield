# CallShield: live demo (≈3 minutes)

## Setup

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
