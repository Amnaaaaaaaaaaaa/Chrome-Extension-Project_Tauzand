# Backend — Setup & Testing

## 1. Install

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

You'll also need **Chrome** and a matching **chromedriver** on your PATH (Selenium 4.6+
auto-manages this via Selenium Manager in most cases — if `python app.py` fails on driver
setup, install `chromedriver` manually and make sure it's on PATH).

For OCR: install the Tesseract binary itself (the Python package is just a wrapper):
- macOS: `brew install tesseract`
- Ubuntu/Debian: `sudo apt-get install tesseract-ocr`
- Windows: installer from https://github.com/UB-Mannheim/tesseract/wiki, then set
  `TESSERACT_CMD` in `.env` to the install path.

If Tesseract isn't installed, `OCR_ENABLED` code paths degrade gracefully (see
`services/ocr_service.py`) — the DOM/keyword CAPTCHA checks still work without it.

## 2. Supabase (free tier)

1. Create a free project at supabase.com.
2. In the SQL editor, run the two `create table` statements from the top of
   `services/supabase_client.py`.
3. Copy `.env.example` to `.env`, fill in `SUPABASE_URL` and `SUPABASE_KEY`
   (Project Settings → API → `anon` `public` key is fine for this prototype).
4. Insert a test profile row, e.g.:

```sql
insert into profiles (id, full_name, first_name, last_name, email, phone, linkedin_url)
values ('demo-user-1', 'Amna Malik', 'Amna', 'Malik', 'amna@example.com',
        '+92 3259511659', 'https://linkedin.com/in/amnamalik');
```

## 3. Run

```bash
python app.py
```

Server starts at `http://localhost:5000`.

## 4. Try it against the reference platform (Google Forms)

```bash
curl -X POST http://localhost:5000/api/fill-form \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.google.com/forms/d/e/1FAIpQLSf.../viewform",
    "profile_id": "demo-user-1"
  }'
```

A Chrome window opens, navigates to the form, scans + fills recognized fields, and leaves
the window open for you to review and manually submit — this is what you'll screen-record
for the checkpoint video.

## 5. Routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/profile/<id>` | Fetch a candidate profile |
| POST | `/api/profile` | Create/update a profile |
| POST | `/api/fill-form` | Run a fill against `{url, profile_id}` |
| GET | `/api/session/<id>` | Retrieve the result of a past fill run |
| GET | `/api/platforms` | List configured platforms |

## 6. Adding a new platform

Add an entry to `services/platform_configs.py` with the site's selectors — no other file
needs to change. This is the "editable / future-proof" requirement from the brief in
practice.

## 7. Expanded scope routes (radio/checkbox/dropdown, resumes, Mistral)

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/resume/upload` | Save a resume (base64) for a profile; fires the audio alert on success |
| GET | `/api/resume/list/<profile_id>` | List a profile's saved resumes |
| POST | `/api/job-description/analyze` | Extract keywords from a job description via Mistral (Supabase-cached) |
| POST | `/api/resume/best-match` | Pick the best-scoring saved resume for a job description |

**Mistral setup:** create your own free/paid account at mistral.ai (per the SOP's "use your
own personal API/secret keys for testing" rule), grab an API key, and put it in `.env` as
`MISTRAL_API_KEY`. If it's left blank, `mistral_client.py` degrades gracefully — job-description
analysis just returns an empty keyword list (`source: "disabled"`) instead of failing.

**Legal/consent checkboxes are never auto-checked**, by design — see `DESIGN_DOC.md` section 7
for the reasoning. They'll always show up in a fill run's `skipped` list with reason
`requires_manual_review_legal_consent`.
