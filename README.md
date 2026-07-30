# Motionsalt Compass

A calm, conversational task manager that lives inside Telegram. You
talk to it in text or voice; it manages your open tasks, recurring
habits, and priorities behind the scenes.

Runs entirely on:

- **Cloudflare Workers** (TypeScript) for the runtime
- **Cloudflare D1** for storage
- **Google Gemini** for reasoning + native voice-note understanding
  (Gemini accepts Telegram's OGG/Opus audio directly — no
  transcoding step)
- **GitHub + Cloudflare's GitHub integration** for auto-deploy
- **GitHub Actions** for automated D1 migrations

Everything below can be done from an Android phone via Termux — the
only local tools you need are `git` and `curl`. Wrangler is only used
inside the GitHub Actions runner, never on your phone.

---

## 0. What you'll need

1. A **GitHub** account.
2. A **Cloudflare** account (free tier is enough).
3. A **Telegram** account (to talk to BotFather).
4. One or more **Google Gemini API keys**
   (https://aistudio.google.com/app/apikey). Free-tier keys are fine —
   this project supports pooling multiple keys with automatic fallback.

---

## 1. Push the code to a new GitHub repo

From Termux, inside the unzipped project folder:

```bash
git init
git add .
git commit -m "Initial Motionsalt Compass"
git branch -M main
# create an empty repo on github.com first (e.g. motionsalt-compass),
# then:
git remote add origin https://github.com/<your-username>/motionsalt-compass.git
git push -u origin main
```

---

## 2. Create the D1 database (one-time)

This is the only step that needs Wrangler to run against your
Cloudflare account. Easiest way from a phone: do it inside a **temporary
GitHub Actions run**, or just run it once in the Cloudflare dashboard's
built-in Wrangler console.

### Option A — Cloudflare dashboard (recommended for phone-only workflow)

1. In the Cloudflare dashboard, open **Workers & Pages → D1 → Create
   database**.
2. Name it exactly **`motionsalt_compass`** (underscore, matches
   `wrangler.toml`).
3. Once created, open it. Copy the **Database ID** shown at the top of
   the page.

### Option B — CLI (only if you can run Wrangler locally)

```bash
npx wrangler d1 create motionsalt_compass
```

Copy the `database_id` printed at the end.

### Paste the ID into wrangler.toml

Edit `wrangler.toml`, replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with
the real ID, commit and push:

```bash
git add wrangler.toml
git commit -m "Wire D1 database id"
git push
```

---

## 3. Cloudflare secrets & GitHub secrets

### 3a. Get a Cloudflare API token (for the migrations workflow)

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**.
2. Use the **"Edit Cloudflare Workers"** template. That template
   already includes the `D1: Edit` permission you need.
3. Copy the token value.
4. Also grab your **Account ID** from the right-hand sidebar of any
   Workers page.

### 3b. Add both to GitHub

In your GitHub repo → **Settings → Secrets and variables → Actions →
New repository secret**. Add:

- `CLOUDFLARE_API_TOKEN` — the token from 3a
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID

The `migrate.yml` workflow will now be able to apply D1 migrations on
every push.

### 3c. Add Worker secrets in the Cloudflare dashboard

Later, after the Worker exists (step 4), you'll open the Worker in the
Cloudflare dashboard → **Settings → Variables and Secrets → Add
variable → Encrypt**. Add:

- `TELEGRAM_BOT_TOKEN` — from BotFather (step 5)
- `TELEGRAM_WEBHOOK_SECRET` — any long random string you invent

Do **not** put these in `wrangler.toml`; keep them encrypted.

---

## 4. Connect the repo to Cloudflare Workers (auto-deploy)

1. Cloudflare dashboard → **Workers & Pages → Create → Connect to Git**.
2. Authorise the Cloudflare GitHub app for your account.
3. Pick the `motionsalt-compass` repo.
4. Framework preset: **None**. Build command: leave blank (Wrangler
   handles it). Deploy command: `npx wrangler deploy`.
5. Root directory: leave blank (repo root).
6. Save and deploy.

Every push to `main` will now redeploy the Worker automatically.
Cloudflare will also honour `wrangler.toml`, meaning the D1 binding
and cron trigger get wired up on each deploy.

Once the first deploy finishes, note the Worker's URL — it'll look
like `https://motionsalt-compass.<subdomain>.workers.dev`.

Now go back to step 3c and add the two Telegram secrets to this
Worker.

---

## 5. Create the Telegram bot and set the webhook

### 5a. In Telegram, talk to **@BotFather**:

- `/newbot`
- give it a display name (e.g. "Motionsalt Compass")
- give it a username ending in `bot` (e.g. `motionsalt_compass_bot`)
- BotFather replies with a **bot token** — copy it into the Cloudflare
  Worker secret `TELEGRAM_BOT_TOKEN` (step 3c).

### 5b. Set the webhook (one curl from Termux):

Replace `<BOT_TOKEN>`, `<WORKER_URL>`, and `<SECRET>` below.
`<SECRET>` must match `TELEGRAM_WEBHOOK_SECRET` you set on the Worker.

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<WORKER_URL>/telegram",
    "secret_token": "<SECRET>",
    "allowed_updates": ["message", "edited_message"]
  }'
```

You should see `{"ok":true,"result":true,...}`.

Sanity check:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

`url` should point at your Worker, `pending_update_count` should be 0.

---

## 6. Add your Gemini API keys to D1

At least one key is required. You can add several — Compass pools
them, uses them LRU, and rotates on quota errors automatically.

### Easiest: the D1 Console in the Cloudflare dashboard

Open **D1 → motionsalt_compass → Console** and paste:

```sql
INSERT INTO api_keys (key_value, daily_quota, is_active)
VALUES ('YOUR_GEMINI_KEY_HERE', 1500, 1);
```

Repeat for each key you have. `daily_quota` is a soft cap Compass
uses to round-robin fairly; set it to whatever your plan actually
allows (1500/day is the free-tier flash daily limit at time of
writing).

### Alternative: from Wrangler (if you have it locally)

```bash
npx wrangler d1 execute motionsalt_compass --remote \
  --command "INSERT INTO api_keys (key_value, daily_quota, is_active) VALUES ('YOUR_KEY', 1500, 1);"
```

---

## 7. Verify end to end

1. In Telegram, open your bot and send `/start`. You should get the
   welcome message within a couple of seconds.
2. Send: `I need to submit the quarterly report by Friday, it's
   important.` — Compass should confirm it created the task.
3. Send: `what should I do now?` — it should recommend the report and
   explain briefly why.
4. Send a **voice note** saying "add daily prayer as a recurring task".
   You should get back a confirmation about a new recurring task.
5. Check the D1 console:

   ```sql
   SELECT id, title, status, priority, is_recurring, recurrence_rule
   FROM tasks ORDER BY id DESC LIMIT 10;
   ```

If any step fails, tail Worker logs from the Cloudflare dashboard
(**Workers → your worker → Logs → Begin log stream**) and re-send a
message.

---

## Schema changes later

1. Add a new SQL file under `migrations/` (e.g. `0002_add_something.sql`).
2. Commit + push. The GitHub Actions `D1 migrations` workflow runs
   automatically and applies it to your remote D1.
3. Cloudflare separately re-deploys the Worker from the same push.

No manual step required.

---

## Local development (optional)

Only useful if you have a laptop. On a phone-only setup you can skip
this entire section — Cloudflare's log stream is enough.

```bash
cp .dev.vars.example .dev.vars   # fill in bot token + webhook secret
npm install
npm run migrate:local
npm run dev
```

Then tunnel with Cloudflare Tunnel / ngrok / etc. and point Telegram's
webhook at the tunnel URL.

---

## Project layout

```
motionsalt-compass/
├── migrations/
│   └── 0001_initial.sql          # tasks, api_keys, conversation_log, users
├── src/
│   ├── index.ts                  # Worker entry (fetch + scheduled)
│   ├── handlers/
│   │   ├── webhook.ts            # Telegram webhook handler
│   │   └── cron.ts               # Daily reset job
│   ├── ai/
│   │   ├── agent.ts              # Tool-calling loop
│   │   ├── gemini.ts             # Gemini REST client + key fallback
│   │   ├── systemPrompt.ts       # Compass's voice + live task snapshot
│   │   ├── tools.ts              # Function-calling tool declarations
│   │   └── toolExecutor.ts       # Tool -> D1 dispatch
│   ├── db/
│   │   ├── tasks.ts
│   │   ├── apiKeys.ts
│   │   ├── conversation.ts
│   │   └── users.ts
│   ├── services/
│   │   └── telegram.ts           # Bot API wrapper
│   ├── utils/
│   │   ├── base64.ts
│   │   ├── logger.ts
│   │   └── time.ts
│   └── types/
│       ├── env.ts
│       ├── task.ts
│       └── telegram.ts
├── .github/workflows/
│   └── migrate.yml               # Auto-applies D1 migrations on push
├── package.json
├── tsconfig.json
├── wrangler.toml
├── .dev.vars.example
└── .gitignore
```

---

## Tone

Compass is deliberately calm. It will not scold you for cancelling a
task, missing a recurring habit for a day, or rescheduling for the
fifth time. When you say "I'm tired", it recommends something lighter
instead of pushing the biggest thing on the list. That behaviour lives
in the system prompt (`src/ai/systemPrompt.ts`) — tweak it there if
you want to shift the voice.
