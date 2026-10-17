"""CallShield risk engine: deterministic, explainable, pure functions (see CONTRACT.md).

score = 0
deepfake.verdict: fake -> +70 ; not_sure -> +30 ; real -> + round(score*20)
deepfake missing (check failed / unavailable) -> +30, treated like not_sure: never APPROVE (fail closed)
speaker.decision: no_match -> +50 ; match with similarity < threshold+0.10 -> +10 (weak match)
speaker missing (unknown caller / no enrollment) -> +20
action: sim_otp_reset +15 ; fund_transfer +10 (+10 more if amount >= 50,000) ; limit_change +10 ; beneficiary_add +10
clamp 0..100
decision: BLOCK if verdict == fake or score >= 70 ; STEP_UP if score >= 35 or verdict == not_sure
          or deepfake missing ; else APPROVE
level: high (>=70) / medium (>=35) / low
"""
from __future__ import annotations

import math
from typing import Optional

ACTIONS = ("fund_transfer", "sim_otp_reset", "limit_change", "beneficiary_add")

ACTION_LABELS = {
    "fund_transfer": "Fund transfer",
    "sim_otp_reset": "SIM/OTP reset",
    "limit_change": "Limit change",
    "beneficiary_add": "Add beneficiary",
}

# Noun phrase used inside alert sentences ("... asked for a SIM/OTP reset").
_ACTION_PHRASES = {
    "fund_transfer": "fund transfer",
    "sim_otp_reset": "SIM/OTP reset",
    "limit_change": "transaction limit change",
    "beneficiary_add": "new beneficiary addition",
}

ACTION_POINTS = {"sim_otp_reset": 15, "fund_transfer": 10, "limit_change": 10, "beneficiary_add": 10}
LARGE_AMOUNT = 50_000
ALERT_CHANNEL = "CallShield app push (registered device)"


def _round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def format_inr(amount) -> str:
    """Indian digit grouping: 50000 -> ₹50,000 ; 100000 -> ₹1,00,000 ; 1234567.5 -> ₹12,34,567.50"""
    if amount is None:
        return ""
    value = float(amount)
    sign = "-" if value < 0 else ""
    value = abs(value)
    whole = int(value)
    frac = round(value - whole, 2)
    if frac >= 0.995:  # rounding carried over
        whole, frac = whole + 1, 0.0
    digits = str(whole)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join(groups + [tail])
    out = f"{sign}₹{digits}"
    if frac:
        out += f".{int(round(frac * 100)):02d}"
    return out


def action_label(action: str) -> str:
    return ACTION_LABELS.get(action, str(action).replace("_", " ").capitalize())


def _action_text(action: str, amount) -> str:
    label = action_label(action)
    if action == "fund_transfer" and amount is not None:
        return f"{label} {format_inr(amount)}"
    return label


def _fmt(x: Optional[float]) -> str:
    return "?" if x is None else f"{x:.2f}"


def level_for(score: int) -> str:
    return "high" if score >= 70 else "medium" if score >= 35 else "low"


def assess(deepfake: Optional[dict], speaker: Optional[dict], action: str, amount=None, *,
           speaker_note: Optional[str] = None, deepfake_note: Optional[str] = None) -> dict:
    """Combine the DetectifAI signals into {score, level, decision, reasons}.

    deepfake: {verdict, score, threshold, ...} or None (check did not run / failed)
    speaker:  {decision, similarity, threshold, ...} or None (unknown caller / not enrolled / failed)
    speaker_note: replaces the default "not enrolled" reason when speaker is None for another cause.
    deepfake_note: reason added when deepfake is None (e.g. embedded deepfake error).
    """
    score = 0
    reasons: list[str] = []
    verdict = deepfake.get("verdict") if deepfake else None

    # --- deepfake ---
    if deepfake:
        df_score = deepfake.get("score")
        if verdict == "fake":
            score += 70
            reasons.append(f"Synthetic voice detected (score {_fmt(df_score)})")
        elif verdict == "not_sure":
            score += 30
            reasons.append(f"Deepfake check inconclusive (score {_fmt(df_score)}) — verify another way")
        elif verdict == "real":
            pts = _round_half_up(float(df_score or 0.0) * 20)
            score += pts
            reasons.append(f"Voice sounds human (deepfake score {_fmt(df_score)})")
        else:
            reasons.append(f"Unrecognised deepfake verdict: {verdict}")
    else:
        # Fail closed: without a deepfake verdict the voice is unverified, so the action can't be approved.
        score += 30
        reasons.append(deepfake_note or "Deepfake check did not run — voice not verified as human")

    # --- speaker ---
    if speaker:
        sim, thr = speaker.get("similarity"), speaker.get("threshold")
        if speaker.get("decision") == "no_match":
            score += 50
            reasons.append(f"Voice does not match enrolled customer ({_fmt(sim)} < {_fmt(thr)})")
        elif speaker.get("decision") == "match":
            if sim is not None and thr is not None and sim < thr + 0.10:
                score += 10
                reasons.append(f"Weak voice match ({_fmt(sim)}, threshold {_fmt(thr)})")
            else:
                reasons.append(f"Voice matches enrolled customer ({_fmt(sim)} ≥ {_fmt(thr)})")
    else:
        score += 20
        reasons.append(speaker_note or "Caller not enrolled — identity unverified")

    # --- action ---
    score += ACTION_POINTS.get(action, 0)
    if action == "fund_transfer" and amount is not None and float(amount) >= LARGE_AMOUNT:
        score += 10
    reasons.append(f"High-risk action: {_action_text(action, amount)}")

    score = max(0, min(100, int(score)))
    if verdict == "fake" or score >= 70:
        decision = "BLOCK"
    elif score >= 35 or verdict == "not_sure" or not deepfake:
        decision = "STEP_UP"
    else:
        decision = "APPROVE"
    return {"score": score, "level": level_for(score), "decision": decision, "reasons": reasons}


def feedback_from_response(assessment: dict, response: str) -> list[dict]:
    """What the customer's reply on the trusted channel proves about each DetectifAI verdict.

    "me"     -> the caller was the real customer: deepfake real = correct, fake = wrong;
                speaker match = correct, no_match = wrong.
    "not_me" -> the caller was not the customer: speaker match = wrong, no_match = correct;
                deepfake fake = correct; real proves nothing (a human impostor is real speech).
    not_sure verdicts are never reported. Returns [{operation_id, signal, correct}].
    """
    out = []
    df = assessment.get("deepfake") or {}
    sp = assessment.get("speaker") or {}
    verdict, decision = df.get("verdict"), sp.get("decision")
    if df.get("operation_id"):
        correct = None
        if response == "me" and verdict in ("real", "fake"):
            correct = verdict == "real"
        elif response == "not_me" and verdict == "fake":
            correct = True
        if correct is not None:
            out.append({"operation_id": df["operation_id"], "signal": "deepfake", "correct": correct})
    if sp.get("operation_id") and decision in ("match", "no_match"):
        correct = (decision == "match") if response == "me" else (decision == "no_match")
        out.append({"operation_id": sp["operation_id"], "signal": "speaker", "correct": correct})
    return out


def _action_phrase(action: str, amount, with_article: bool = True) -> str:
    phrase = _ACTION_PHRASES.get(action, action_label(action).lower())
    if action == "fund_transfer" and amount is not None:
        phrase = f"{format_inr(amount)} {phrase}"
    return f"a {phrase}" if with_article else phrase


def alert_message(decision: str, action: str, amount=None) -> Optional[str]:
    if decision == "BLOCK":
        return (f"CallShield blocked {_action_phrase(action, amount)} requested on a call claiming to be you. "
                "If this wasn't you, no action is needed — your money is safe.")
    if decision == "STEP_UP":
        return (f"A call claiming to be you asked for {_action_phrase(action, amount)}. "
                "Confirm in the app if this was you.")
    return None


def build_alert(decision: str, action: str, amount=None) -> dict:
    sent = decision in ("BLOCK", "STEP_UP")
    return {"sent": sent, "channel": ALERT_CHANNEL, "message": alert_message(decision, action, amount)}
