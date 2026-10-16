# CallShield — build contract (shared by all agents)

CallShield is a real-time fraud guard for bank / UPI support calls (UNCLONE hackathon, Track 01 Finance).
While a support agent is on a call, the browser keeps a rolling buffer of the caller's audio. When the caller
asks for a **high-risk action** (fund transfer, SIM/OTP reset, limit change, add beneficiary), CallShield sends
the last few seconds of audio to DetectifAI for **speaker verification + deepfake detection in one request**,
turns both signals into a **risk score**, and **APPROVES / STEPS UP / BLOCKS** the action. On STEP_UP or BLOCK
it **alerts the real customer on a trusted channel** (the "customer phone" page, pushed live over SSE).

## Hard constraints
- **Credits are scarce**: 2,000 credits, **50 credits per DetectifAI operation**; verify+deepfake = 2 operations = ~100.
  Agents must NOT make paid DetectifAI calls (enroll / verify / detect) while building. Free calls are OK:
  `GET /v1/health`, `GET /v1/credits`, `GET /v1/speakers`. All development/testing uses **mock mode**.
- **Hackathon rule 5.4**: results shown as live must be real. Mock results must be visibly labelled `MOCK` everywhere
  in the UI (badge on every result + global banner). Never present mock as live.
- No secrets in code. API key comes from `.env` (`DETECTIF_API_KEY=dtf_live_...`), loaded with python-dotenv.
  Never log or return the key.
- Python 3.15, venv at `.venv` (fastapi, uvicorn, httpx, python-multipart, python-dotenv installed). No other deps.
  Frontend is plain HTML/CSS/vanilla JS (no build step, no npm). Must work in desktop Chrome.
- Run: `.venv/Scripts/python -m uvicorn backend.app:app --port 8000` from the project root `C:\Users\gooners\Unclone`.

## Layout (file ownership)
```
backend/            <- BACKEND agent owns
  __init__.py
  app.py            FastAPI app, routes, serves ../frontend as static at "/"
  detectif.py       async DetectifAI client (httpx) + mock client
  risk.py           risk engine (pure functions)
  store.py          JSON persistence in data/store.json (customers, assessments)
  events.py         SSE broadcaster
frontend/           <- FRONTEND agent owns
  index.html        Agent console (live call)
  enroll.html       Customer voice enrollment
  phone.html        Customer's phone (trusted channel alerts)
  css/app.css
  js/audio.js       mic capture -> 16 kHz mono PCM ring buffer -> WAV encoder; file upload helper
  js/api.js         fetch wrappers for the endpoints below
  js/console.js, js/enroll.js, js/phone.js
README.md, DEMO.md, pitch/   <- DOCS agent owns
data/               runtime, gitignored
```

## DetectifAI API (base `https://platform.detectif.ai/v1`, header `Authorization: Bearer <key>`)
All model calls are `multipart/form-data` with the audio in field `file`, plus header `Idempotency-Key: <uuid4>`.
- `POST /speakers/enroll` fields: `file`, `speaker_id` (regex `^[A-Za-z0-9_.:-]{1,64}$`), `display_name` (optional).
  Audio 15–60 s, ≥10 s speech. Response: `{request_id, operation_id, object:"speaker.enrollment",
  speaker:{speaker_id, display_name, samples, ...}, quality:{speech_seconds, duration_seconds}, credits:{charged, balance}, latency_ms}`
- `POST /speakers/verify` fields: `file`, `speaker_id`, `detect_deepfake=true`. Audio 3–60 s, ≥2 s speech.
  Response: `{request_id, operation_id, speaker_id, result:{decision:"match"|"no_match", similarity(-1..1), threshold, duration_seconds},
  deepfake: null | {verdict:"real"|"fake"|"not_sure", score(0..1), threshold(0.62), decided_by, segments:[{start,end,score}],
  operation_id, credits_charged, ...} | {error...}, credits:{charged, balance}, latency_ms}`
- `POST /deepfake/detect` field `file`. Audio >4 s and ≤120 s. Response: `{request_id, operation_id,
  result:{verdict, score, threshold, decided_by, segments:[{start,end,score}], duration_seconds, ...}, credits:{charged,balance}, latency_ms}`
- `GET /speakers` -> `{data:[{speaker_id, display_name, samples, created_at}], ...}`
- `GET /credits` -> `{available, reserved, plan, unlimited, price_per_operation}`; `GET /health` -> `{status, inference}`
- `POST /operations/{operation_id}/feedback` JSON `{"correct": bool}` (free).
- Errors: `{error:{type, code, message, param}, request_id, credits?:{available, required}, partial?:{deepfake, credits}}`.
  429 / 503 -> respect `Retry-After`, retry once with the SAME Idempotency-Key. 402 = insufficient credits.

## CallShield backend API (same origin as the frontend)
Every response that involves a DetectifAI result includes `"mode": "live" | "mock"`.
Mode = `mock` if env `CALLSHIELD_MODE=mock` or no API key; else `live`.

1. `GET /api/status` -> `{mode, credits: {available, price_per_operation} | null, health: "ok"|"down"|"unknown", cost_per_check: 100}`
2. `GET /api/customers` -> `{customers:[{customer_id, display_name, phone_last4, enrolled_at, samples}]}`
3. `POST /api/enroll` multipart: `file` (wav/webm), `customer_id`, `display_name`, `phone_last4` (optional)
   -> `{ok, mode, customer:{...as above}, quality:{speech_seconds, duration_seconds}, credits:{charged, balance}|null, request_id}`
4. `POST /api/check` multipart: `file` (WAV clip, 5–20 s), `customer_id` (may be empty = unknown caller -> deepfake-only check),
   `action` (`fund_transfer`|`sim_otp_reset`|`limit_change`|`beneficiary_add`), `amount` (optional number, INR),
   `call_id` (string), `trigger` (`manual`|`keyword`|`upload`), `transcript` (optional, the phrase that triggered it),
   `mock_scenario` (mock mode only: `genuine`|`deepfake`|`imposter`|`uncertain`; default `genuine`)
   -> **Assessment**:
   ```json
   {"check_id":"chk_…","mode":"live","created_at":"ISO8601","call_id":"…","customer_id":"…","customer_name":"…",
    "action":"fund_transfer","action_label":"Fund transfer","amount":50000,"trigger":"keyword","transcript":"…",
    "deepfake":{"verdict":"fake","score":0.81,"threshold":0.62,"decided_by":"second_stage","segments":[{"start":0,"end":4,"score":0.79}],"operation_id":"op_…"} ,
    "speaker":{"decision":"no_match","similarity":0.21,"threshold":0.53,"operation_id":"op_…"},
    "risk":{"score":95,"level":"high","decision":"BLOCK","reasons":["Synthetic voice detected (score 0.81)","Voice does not match enrolled customer (0.21 < 0.53)","High-risk action: Fund transfer ₹50,000"]},
    "alert":{"sent":true,"channel":"CallShield app push (registered device)","message":"…"},
    "credits":{"charged":100,"balance":1900},"request_ids":["req_…"],"latency_ms":412,"audio_seconds":8.0}
   ```
   `deepfake` or `speaker` may be `null` if that check didn't run; on an embedded deepfake error, `deepfake` = null and a reason is added.
   Errors: HTTP 4xx/5xx with `{"error": {"code", "message"}}` (e.g. `insufficient_credits`, `audio_too_short`, `upstream_error`).
   Refuse live checks if balance < 100 (`insufficient_credits`) — check `/v1/credits` (cache 30 s) before spending.
5. `GET /api/assessments?limit=50` -> `{assessments:[Assessment…]}` newest first.
6. `GET /api/events` -> Server-Sent Events. Event names: `assessment` (data = Assessment JSON), `alert`
   (data = `{check_id, customer_id, customer_name, action_label, amount, decision, message, created_at, mode}`),
   `customer_response` (data = `{check_id, response:"me"|"not_me", created_at}`). Send a `: ping` comment every 15 s.
7. `POST /api/alerts/{check_id}/respond` JSON `{"response":"me"|"not_me"}` -> records the customer's answer on the
   assessment, broadcasts `customer_response`; if `not_me` and live mode, send DetectifAI feedback is NOT needed. Returns `{ok:true}`.
8. `POST /api/feedback` JSON `{operation_id, correct}` -> forwards to DetectifAI feedback (free) in live mode; `{ok}`.

## Risk engine (backend/risk.py) — deterministic, explainable
```
score = 0
deepfake.verdict: fake -> +70 ; not_sure -> +30 ; real -> + round(score*20)
speaker.decision: no_match -> +50 ; match with similarity < threshold+0.10 -> +10 (weak match)
speaker missing (unknown caller / no enrollment) -> +20, reason "Caller not enrolled — identity unverified"
action: sim_otp_reset +15 ; fund_transfer +10 (+10 more if amount >= 50,000) ; limit_change +10 ; beneficiary_add +10
clamp 0..100
decision: BLOCK if verdict == fake or score >= 70 ; STEP_UP if score >= 35 or verdict == not_sure ; else APPROVE
level: high (>=70) / medium (>=35) / low
alert.sent = decision in (BLOCK, STEP_UP)
```
Alert message examples: BLOCK -> "CallShield blocked a ₹50,000 fund transfer requested on a call claiming to be you.
If this wasn't you, no action is needed — your money is safe." STEP_UP -> "A call claiming to be you asked for a SIM/OTP reset.
Confirm in the app if this was you."

## Mock client (backend/detectif.py)
Same interface as the live client; returns realistic shapes with `request_id`/`operation_id` prefixed `mock_`, credits null.
Scenarios: genuine (real, score ~0.05–0.15, match ~0.70–0.80), deepfake (fake ~0.80–0.95, similarity ~0.55–0.65 — clones often
still match!), imposter (real ~0.1, no_match ~0.10–0.30), uncertain (not_sure ~0.65, match ~0.58). Adds ~300–700 ms latency.

## UI design language
Dark UI. Tokens: bg `#0f1115`, panel `#171a21`, border `#2a2f3a`, text `#e8eaf0`, muted `#9aa3b2`,
accent (brand lime) `#d4ff2a`, danger `#ff4d3d`, warn `#ffb020`, ok `#2ecc71`. Font: system-ui / Inter; monospace for IDs.
Product name "CallShield" with subtitle "Powered by DetectifAI". Status pill top-right: `LIVE · DetectifAI` (green) or `MOCK MODE` (amber),
plus credits remaining. Must be usable at 1366×768 (projector).
