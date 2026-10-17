# CallShield: presentation script (≈5 minutes)

Deck: `pitch/CallShield_Final.pptx`. Flow: **Problem → Solution → live demo → DetectifAI → Impact → Scale**.
*Italics* = what to do. Plain text = what to say. Speak slowly; the pauses are where the demo breathes.

**Setup before you start** (see `DEMO.md`): laptop tab 1 = Receive screen, **online**; tab 2 = Attack Lab with the
victim and both clips ready; phone on the CallShield Bank home screen, enrolled; laptop volume up.

---

## Title slide (≈5 s)

*Title slide on screen as you start.*

Hi, we're CallShield. We stop cloned voices from moving money over a bank's helpline, and DetectifAI makes every
decision.

## Slide 1: Problem (≈35 s)

*Slide 1 on screen. Pause one beat before speaking.*

"Hi, it's Ramesh. I've got a new number. Please update the phone number on my account."

That's a call a bank helpline gets every day. Once that number changes, every OTP goes to whoever made the call. The
voice sounds exactly like Ramesh. It isn't him. It's a clone, made
from a reel or a voice note.

Today the bank checks this with security questions, but those answers are already in leaked data. Voice-ID on its own
has been beaten by a free AI clone, at Lloyds Bank in 2023. And people can't hear the difference: sixty-nine percent
of Indians aren't confident they could tell a cloned voice from the real one.

So the question we answer is simple: at the moment someone asks to move money, **is this really the customer?**

## Slide 2: Solution (≈35 s)

*Next slide.*

CallShield answers that in four steps.

One: the customer enrolls their voice once, in our CallShield Bank app. It takes about twenty-five seconds.

Two: when they call the bank, Neerja, our virtual agent, picks up, hears what they want, and asks for their voice
passphrase.

Three: DetectifAI checks that voice, and the call is approved, handed to a human agent, or blocked, with the reasons
on screen.

Four: if anything looks wrong, the real customer gets an alert in their app: "Was this you?"

No forms, no OTP. The customer just talks. Let me show you.

## Live demo (≈2 min)

### Scene 1: the real customer (≈60 s)

*Switch to the laptop Receive screen. Pick up the phone, hold it so everyone can see it.*

This is the bank's screen. Neerja is online. And this is me, the customer, on the CallShield Bank app.

*Tap **Call CallShield Bank**. Neerja's greeting plays on the laptop.*

*Say into the phone:* "I want to transfer fifty thousand rupees to my brother."

*Neerja confirms and asks for the passphrase. Point at the phone: the passphrase appears on screen.*

*Say:* "My voice is my password, and I am calling CallShield Bank to approve my own request."

*Verdict appears: **Approved**. Point at it.*

Approved. Voice match well above the threshold, and the deepfake check says real voice. Neerja confirms the transfer
and hangs up. I never typed a thing.

### Scene 2: the clone (≈60 s)

*Switch to the Attack Lab tab.*

Now I'm the fraudster. I have a clone of the customer's voice, made with consent from a team member's own recording.
Same request. Same passphrase. Same voice to your ear.

*Click **Place call**. Let the call play out: greeting, the clone's request, the clone's passphrase.*

Listen. To a person on the helpline, that's the customer.

*Verdict appears: **Blocked**. Switch to the Receive screen and point at the deepfake score.*

Blocked. DetectifAI flags the voice as synthetic, and that blocks the request every time.

*Hold up the phone: the alert has arrived.*

And the real customer gets this alert in their app. I tap **Not me**, and that answer goes straight back to DetectifAI
as feedback.

*Tap **Not me**. Back to the deck.*

## Slide 3: DetectifAI (≈40 s)

*Slide 3.*

What you just saw is DetectifAI doing the deciding. Take it out and nothing gets decided.

It answers two questions. **Is it them?** Speaker verification compares the passphrase with the customer's enrolled
voiceprint. **Is it real?** Deepfake detection checks the same call audio for synthetic speech.

We need both. A good clone can match the voiceprint; deepfake detection catches it. A human impostor sounds real;
speaker verification catches them.

The rules are strict. A synthetic voice is always blocked. If DetectifAI is unsure, or doesn't answer at all, the call
goes to a human: we fail closed, never open.

And one thing we learned the hard way: phone calls insert digital silence. Left in, a genuine customer's match fell
from 0.85 to 0.21. We strip it before every check. Today, real customers matched at 0.83 to 0.89 and were approved;
clones scored 0.999 synthetic and were blocked.

## Slide 4: Impact (≈30 s)

*Slide 4.*

India lost twenty-two thousand eight hundred crore rupees to cyber fraud last year, about three times the year
before. We don't claim to fix all of it. We close one door: the helpline call where a fraudster pretends to be you.

For the customer, the money never moves, and they know within seconds. For the bank, there's no guesswork, and every
decision is logged with its reasons.

And this is measured, not promised: four out of four genuine calls approved, two out of two clone attacks blocked,
about seven seconds to a verdict while Neerja asks the caller to hold.

## Slide 5: Scale (≈35 s)

*Slide 5.*

Banks pay per protected transaction, not per call minute. CallShield uses two DetectifAI checks only when someone
asks to move money, and nothing for the rest of the call. That's about seventy-five times fewer checks than scanning
whole calls.

It plugs into what contact centres already have. Exotel, Twilio and Genesys all stream call audio, so Neerja becomes
one step in the bank's existing phone menu.

The risks have answers: phone audio is measured and fixed; a replayed recording still needs a live passphrase and
triggers an alert; and enrollment is opt-in, with deletion on request under the DPDP Act.

*Close, looking at the audience.*

A fraudster can copy your voice. CallShield makes sure it can't move your money. Thank you.

---

## If something goes wrong

| Problem | Say / do |
|---|---|
| Neerja doesn't pick up | "Let me bring the line back online." Click **Go offline**, then **Go online**, call again. |
| The real call gets **Step up** instead of Approved | "Borderline match, so it goes to a human. That's the safe default: a real customer is never blocked by one score." Click **Take over**. |
| Neerja asks for the passphrase again | Say it again, clearly. "She needs about three seconds of voice." |
| Wi-Fi / DetectifAI is slow | "This is a live call to DetectifAI over a phone hotspot." Wait; the verdict usually lands within ten seconds. |
| Demo fails completely | Open the Recent calls table on the Receive screen: "Here are today's live results: the same calls, approved and blocked." |
