// CallShield — transcript keyword rules + Indian-English amount parsing for auto-trigger.
// Pure functions (no DOM), so they can be unit-tested in Node.

// Order matters: more specific intents first ("transfer limit" -> limit_change).
export const RULES = [
  {
    action: 'beneficiary_add',
    re: /\b(?:beneficiar(?:y|ies)|payees?|add (?:a |an |one |new )?(?:account|payee))\b|लाभार्थी|बेनिफिशियरी|पेयी/i,
  },
  {
    action: 'sim_otp_reset',
    re: /\b(?:new sim|sim swap|sim card|e-?sim|sim|otp|one[- ]time password|reset)\b|सिम|ओटीपी|रीसेट/i,
  },
  {
    action: 'limit_change',
    re: /\b(?:limits?)\b|लिमिट|सीमा/i,
  },
  {
    action: 'fund_transfer',
    re: /\b(?:transfer(?:s|red|ring)?|send (?:the |some |me )?(?:money|amount|funds|rupees|payment)|neft|imps|rtgs|upi)\b|ट्रांसफर|ट्रान्सफर|पैसे भेज|भेज दो|भेज दीजिए|यूपीआई|नेफ्ट|आईएमपीएस/i,
  },
];

/** Returns { action, match } for the first rule that matches, or null. */
export function detectAction(text) {
  if (!text) return null;
  for (const r of RULES) {
    const m = text.match(r.re);
    if (m) return { action: r.action, match: m[0] };
  }
  return null;
}

/** Character ranges of every keyword hit, for highlighting. */
export function keywordRanges(text) {
  const ranges = [];
  for (const r of RULES) {
    const g = new RegExp(r.re.source, 'gi');
    let m;
    while ((m = g.exec(text))) {
      if (!m[0]) { g.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const rg of ranges) {
    const last = merged[merged.length - 1];
    if (last && rg[0] <= last[1]) last[1] = Math.max(last[1], rg[1]);
    else merged.push([rg[0], rg[1]]);
  }
  return merged;
}

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // Hindi (common in hi-IN transcripts)
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  'बीस': 20, 'पच्चीस': 25, 'तीस': 30, 'चालीस': 40, 'पचास': 50, 'साठ': 60, 'सत्तर': 70, 'अस्सी': 80, 'नब्बे': 90,
};
const HUNDRED = new Set(['hundred', 'सौ']);
const BIG = {
  thousand: 1e3, k: 1e3, 'हज़ार': 1e3, 'हजार': 1e3,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, lakh_: 1e5, 'लाख': 1e5,
  million: 1e6, crore: 1e7, crores: 1e7, cr: 1e7, 'करोड़': 1e7, 'करोड': 1e7,
};
const JOINERS = new Set(['and', 'point']);

/**
 * Parse an INR amount from speech-to-text. Handles "50,000", "50000", "50k", "₹ 2 lakh",
 * "fifty thousand", "one lakh fifty thousand", "1.5 lakh", "2,00,000", "पचास हज़ार".
 * Returns the largest plausible amount (>= 100) or null.
 */
export function parseAmount(text) {
  if (!text) return null;
  let t = String(text).toLowerCase()
    .replace(/(\d),(?=\d)/g, '$1')        // 2,00,000 -> 200000
    .replace(/(\d)\s*k\b/g, '$1 thousand') // 50k -> 50 thousand
    .replace(/(\d)\s*(lakhs?|lacs?|crores?|cr)\b/g, '$1 $2')
    .replace(/₹|\brs\.?|\binr\b/g, ' ')
    .replace(/-/g, ' ');
  const tokens = t.split(/[\s,!?;:()"'/]+/).map((s) => s.replace(/^\.+|\.+$/g, '')).filter(Boolean);

  let best = null;
  let total = 0, current = 0, active = false, lastWasNumber = false;
  const flush = () => {
    if (active) {
      const v = total + current;
      if (v >= 100 && v <= 1e9 && (best === null || v > best)) best = v;
    }
    total = 0; current = 0; active = false; lastWasNumber = false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    if (/^\d+(\.\d+)?$/.test(tok)) {
      if (active && lastWasNumber) flush(); // two bare numbers in a row = separate amounts
      current += parseFloat(tok);
      active = true; lastWasNumber = true;
    } else if (Object.prototype.hasOwnProperty.call(SMALL, tok)) {
      current += SMALL[tok];
      active = true; lastWasNumber = false;
    } else if ((tok === 'a' || tok === 'an') && next && (HUNDRED.has(next) || BIG[next])) {
      flush();
      current = 1; active = true; lastWasNumber = false;
    } else if (HUNDRED.has(tok)) {
      if (active) { current = (current || 1) * 100; lastWasNumber = false; }
    } else if (Object.prototype.hasOwnProperty.call(BIG, tok)) {
      if (active) { total += (current || 1) * BIG[tok]; current = 0; lastWasNumber = false; }
    } else if (JOINERS.has(tok) && active) {
      // "one lakh and fifty thousand" — keep going
    } else {
      flush();
    }
  }
  flush();
  return best == null ? null : Math.round(best);
}
