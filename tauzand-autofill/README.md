# Tauzand Auto-Apply — Execution Checkpoint

This repo is the working prototype for the "Backend Form Auto-Fill Validation" checkpoint.
It demonstrates the core mechanism (not the polished product): a Flask backend that reads a
candidate profile from Supabase, drives a real Chrome session with Selenium, detects form
fields, fills them, and pauses with an audio alert whenever it hits something that needs a
human (login wall, CAPTCHA, "I'm not a robot" check).

## What's in here

```
tauzand-autofill/
├── backend/                  Flask app (the thing that does the work)
│   ├── app.py                 REST routes
│   ├── config.py               All tunables in one place (no hardcoded values buried in logic)
│   ├── requirements.txt
│   ├── services/
│   │   ├── supabase_client.py  Profile storage (Supabase, free tier)
│   │   ├── platform_configs.py Per-platform selectors/config (this is how you add a
│   │   │                       new site without touching form_filler.py)
│   │   ├── form_filler.py      Selenium-driven field detection + fill engine
│   │   ├── captcha_detector.py Heuristics + OCR hook to detect (never solve) CAPTCHAs
│   │   ├── ocr_service.py      Hardcoded Tesseract OCR wrapper
│   │   └── audio_alert.py      Cross-platform beep for "come intervene" moments
│   └── README.md               Backend-specific setup instructions
├── frontend/                  Next.js + TS + Tailwind (bare, no polish per brief)
│   ├── app/
│   └── lib/api.ts              Talks to the Flask REST routes
└── DESIGN_DOC.md              Architecture notes + edge case log — paste this into the
                                shared Google Doc the client asked for
```

## What I could and couldn't do here

I can write and hand you working, tested-as-far-as-possible code. I can't do the following
for you, since they need your accounts/credentials or a real screen to record:

- **Create the Supabase project / get real API keys.** `supabase_client.py` is wired to real
  Supabase Python SDK calls — you just need to sign up (free tier), create a `profiles` table,
  and drop the URL + anon key into a `.env` file (see `backend/README.md`).
- **Record and upload the video demo to Google Drive.** Once you run this locally against
  a Google Form (the easiest, most reliable reference target — no anti-bot walls), you can
  screen-record the flow described in `DESIGN_DOC.md`'s "Demo Script" section.
- **Create the shared Google Doc.** `DESIGN_DOC.md` is written so you can paste it directly in.

## Quick start

```bash
# Backend
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in SUPABASE_URL / SUPABASE_KEY
python app.py           # runs on http://localhost:5000

# Frontend
cd ../frontend
npm install
npm run dev              # runs on http://localhost:3000
```

## SOP compliance notes (Tauzand internal dev standards)

- **Data access (SOP §5):** the frontend defaults to the hardcoded sample JSON in
  `frontend/data/sampleData.json`, not the live backend — there's a checkbox on the page
  to switch to live mode, which you'd only do for the mentor-approved emergency case the
  SOP describes.
- **Naming/comments (SOP §3.2–3.4):** variables use full descriptive names with inline
  same-line comments explaining purpose; the one dict used for optimization
  (`FIELD_LABEL_HINTS` in `form_filler.py`, and the in-memory session store in `app.py`)
  has a TC/SC comment directly above it.
- **Edge cases (SOP §3.5):** `form_filler.py` and `app.py` each end with an "Edge Cases
  Handled" comment block; `DESIGN_DOC.md` has the fuller table for the video/doc.
- **Color palette (SOP §4.2):** `frontend/tailwind.config.ts` restricts to Sapphire Veil
  (blue, primary actions/confident results) and Imperial Topaz (amber, attention/skipped
  states) plus neutral grays and `rose` instead of pure red.
- **Env vars (SOP §3.7):** backend reads everything through `config.py` from `.env`;
  frontend reads the API base from `NEXT_PUBLIC_API_BASE` — see `.env.example` /
  `.env.local.example`. No secrets are hardcoded anywhere in the repo.
- **AI disclosure (SOP §2):** this repo was scaffolded with AI assistance and then needs
  your own read-through before any PR — the SOP requires you understand every function
  before submitting, not just that it runs.

## Reference platform used for the demo

Per the brief's suggestion of Workday / Ashley / Google Forms, this prototype targets
**Google Forms** as the primary, reliably-testable reference target, since Workday and most
ATS platforms sit behind auth walls and bot-detection that would make a first checkpoint demo
flaky through no fault of the code. The `platform_configs.py` module is written so Workday and
others are a config addition, not a rewrite — see `DESIGN_DOC.md` for how that extends.
