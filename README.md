# Motionsalt Compass

A calm, conversational life organizer that lives inside Telegram. You
talk to it in text or voice; it manages your open tasks (pending,
in-progress, or paused), recurring habits, letter-graded priorities,
task time estimates, your running balance, a "set-aside" money bucket
for cash you've earmarked but not spent, and the debts you owe (or
are just holding cash for on someone else's behalf) — all behind the
scenes.

The finance side is deliberately a decision-support tool, not an
expense tracker. When money arrives, Compass looks at your current
balance, your set-aside bucket, and your open debts and gives you one
specific, low-effort suggestion for what to do with it. It knows the
difference between debts that are yours and cash you're only passing
through — it will never tell you to pay someone else's obligation from
your own funds.

Compass also watches your day quietly. When it sees you have a real
free window (no in-progress task, no imminently-scheduled task, and
enough open runway), it may send you a single low-key nudge suggesting
one flexible task that fits the window — sized to your task's own time
estimate, at your own priority order. One nudge per free window, never
scolding.

There are two equally-supported ways to drive Compass:

- **Just talk to it.** Natural-language text or voice notes. The AI
  handles everything: creating tasks, editing them, recording income,
  applying money to debts, moving cash in and out of set-aside, etc.
- **Typed slash commands and buttons.** Every high-frequency read and
  edit is also available as a direct slash command that skips the AI
  entirely (saves quota, faster), and `/menu` opens an inline-keyboard
  interface for Tasks, Finance, and Settings — including a step-by-step
  Add Task wizard, an Edit Task picker, timezone/currency choosers,
  and set-aside moves.

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
and cron triggers get wired up on each deploy.

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

### 5b. Set the webhook

You have two options. Either works; the admin endpoint is preferred
because it keeps `allowed_updates` in sync with what the Worker code
actually handles — no risk of forgetting `callback_query` and
silently breaking the /menu buttons.

**Option A — admin endpoint (recommended).** Once the Worker is
deployed and `TELEGRAM_WEBHOOK_SECRET` is set on it, hit:

```bash
curl -X POST "<WORKER_URL>/admin/set-webhook" \
  -H "X-Admin-Secret: <SECRET>"
```

`<SECRET>` is the same `TELEGRAM_WEBHOOK_SECRET`. You should see
`{"ok":true,"url":"<WORKER_URL>/telegram","allowed_updates":[...]}`.
Safe to re-run any time — e.g. after adding a new update type to the
code, or to recover a deployment whose webhook was originally
registered before `callback_query` support was added (existing
deployments in that state must run this at least once, otherwise
Telegram will keep silently dropping every inline-keyboard button
tap even though the code handles them).

**Option B — raw Telegram API.** Replace `<BOT_TOKEN>`, `<WORKER_URL>`,
and `<SECRET>` below. `<SECRET>` must match `TELEGRAM_WEBHOOK_SECRET`
you set on the Worker.

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<WORKER_URL>/telegram",
    "secret_token": "<SECRET>",
    "allowed_updates": ["message", "edited_message", "callback_query"]
  }'
```

`callback_query` matters — that's how the inline-keyboard buttons in
`/menu` are delivered. Once Telegram has an `allowed_updates` list on
file it stays exactly as set until an explicit `setWebhook` overwrites
it; omitting `callback_query` here silently breaks every /menu button
tap without any error surfacing anywhere.

You should see `{"ok":true,"result":true,...}`.

Sanity check either option:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

`url` should point at your Worker, `pending_update_count` should be 0,
and `allowed_updates` should include `callback_query`.

### 5c. Register the built-in Telegram command menu (one-time, optional but recommended)

Compass ships a small admin endpoint that calls Telegram's
`setMyCommands` for you, so the "/" button in your chat with the bot
shows a proper autocomplete list of every direct command. The list is
defined in `src/handlers/commandMenu.ts` and stays in sync with the
slash-command dispatcher.

Trigger it once (and any time you add or remove a command):

```bash
curl -X POST "<WORKER_URL>/admin/register-commands" \
  -H "X-Admin-Secret: <SECRET>"
```

`<SECRET>` is the same `TELEGRAM_WEBHOOK_SECRET`. You should see
`{"ok":true,"registered":N,"webhook":{...}}`. This endpoint also
re-syncs the webhook `allowed_updates` list (same job as
`/admin/set-webhook`) so a single post-deploy curl covers both. If
the webhook part fails, the response still returns `ok:true` for the
command-menu refresh and reports the webhook error in
`webhook_error` — hit `/admin/set-webhook` directly to retry.
Aliases (`/add`, `/tz`, `/settings`, etc.) are intentionally not
advertised — Telegram's menu shows one canonical entry per action;
the aliases still work when typed.

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
5. Send: `I just got paid 500` — Compass should record it and, if you
   have any open debts, suggest what to do with the new money.
6. Send: `I owe my landlord 800 by the 5th of every month` — it should
   create a recurring debt with `responsible_party = "user"`. Then try:
   `that 300 is my mom's, I'm just holding it for her` — that one
   should land as `responsible_party = "other"` and Compass should
   NOT suggest paying it from your balance.
7. Try the direct-read commands (no Gemini call, no quota burn):
   `/today`, `/balance`, `/debts`, `/finance`, `/review`,
   `/setbalance 1234.50`, `/timezone Africa/Lagos`.
8. Try `/addtask Draft the report | p=A | dur=90 | when=this afternoon`
   and then `/edittask <id> | status=done`.
9. Send `/menu` and walk through Tasks → Add task (wizard),
   Finance → View balance / Move to set-aside, and
   Settings → Timezone (pick one).
10. Check the D1 console:

    ```sql
    SELECT id, title, status, priority, time_estimate_minutes,
           is_recurring, recurrence_rule
    FROM tasks ORDER BY id DESC LIMIT 10;

    SELECT * FROM user_balance;
    SELECT id, creditor, amount_cents, currency, responsible_party,
           on_behalf_of, due, status, is_recurring, recurrence_rule
    FROM debts ORDER BY id DESC LIMIT 10;
    ```

If any step fails, tail Worker logs from the Cloudflare dashboard
(**Workers → your worker → Logs → Begin log stream**) and re-send a
message.

---

## Schema changes later

1. Add a new SQL file under `migrations/` (e.g. `0003_add_something.sql`).
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

## What Compass can do

### Tasks

- **Priorities as letter grades.** Every task has a priority on a 15-step
  letter scale, A+ (highest) through E- (lowest), with C as the sensible
  default. The scale is honoured by "what should I do now?", the
  free-time nudger, and the flexible-task review list — lower letter =
  higher priority.
- **Time estimates.** Tasks can carry a rough duration in minutes.
  Used by the nudger to fit a suggestion into your actual free window,
  and shown in every task listing as `~45min`.
- **Recurring tasks.** "Add daily Bible study" or "every Monday" style
  phrasing creates a recurring task; Compass will roll fresh instances
  forward on the daily reset cron without pestering you when you miss
  a day.
- **Scheduled ("hard") vs. flexible tasks.** A task with a real
  scheduled time is treated as an appointment. Anything else is
  flexible and shows up in `/review` (a.k.a. `/flex`), ordered by
  priority.
- **Scheduling constraints.** On top of `scheduled_for`, any task can
  carry an optional *constraint* saying when it's eligible at all
  — an inclusive date range, a set of weekdays, a daily time-of-day
  window, or any combination. Each sub-part is independent, and
  independent of any recurrence rule. See the dedicated section
  below.
- **Status.** `pending → in_progress → done` (or `cancelled`).
  Compass sets it in conversation ("I'm done with the groceries") or
  you can flip it via the /menu Edit Task flow, `/edittask <id> | status=done`.

### Finance

- **Running balance.** One row per user. Editable both by talking
  ("I just got paid 500", "I spent 12 on lunch") and by typed
  `/setbalance` / the Finance menu.
- **Set-aside bucket.** A separate slot inside the same balance row
  for cash you've mentally earmarked but haven't spent yet ("set aside
  200 for rent"). Amounts in set-aside are excluded from
  what-to-do-with-new-money suggestions until you move them back.
- **Default currency.** Per-user preference used for a brand-new
  balance row and for any new debt where you didn't say a currency.
  Set it via /menu → Finance → Default currency, or just tell Compass.
- **Debts, yours and others'.** Every debt has a `responsible_party`:
  `user` (your obligation) or `other` (cash you're just holding for
  someone else). Compass never suggests paying an `other` debt from
  your balance, and the underlying tool refuses to as well.
- **Recurring debts.** Rent, subscriptions, tithes, etc. can be
  recorded as recurring; Compass rolls the next instance forward once
  the current one is settled.
- **Confirm-before-execute.** Destructive money actions (delete a
  debt; overwrite the balance to a very different number) require a
  two-step confirm handshake, whether they originate from the AI or
  from the /menu Set balance flow.

---

---

## Task dependencies, parent/subtask relationships, and deadline urgency

### Dependencies (`depends_on_task_id`)

A task can **depend on** another open task. A blocked task:

- Is skipped by the free-time nudger until the dependency is cleared
  (only unblocked tasks are suggested).
- Shows a `⛓ depends=#N` glyph in `/addtask`, `/edittask`, and
  `/alltasks` output so you see the link at a glance.
- The AI sees `depends_on=#N` in its context each turn so it can
  reason about blocking chains.

**Set a dependency:**

```
/addtask Write intro | depends=3
/addbatch
Draft outline | depends=5
---
/edittask 12 | depends=5
/edittask 12 | depends=clear
```

Aliases: `dep=`, `depends_on=`, `blocked_by=`, `after=`

Via the button menu: **Tasks → ⛓ Dependencies / Parents → Set dependency**

### Parent / subtask (`parent_task_id`)

A task can be a **subtask** of another. Compass enforces:

- A parent task **cannot be marked done** while any subtask is still
  open (`pending`, `in_progress`, or `paused`). A clear error message
  names the blocking subtask ids.
- The nudger skips the parent and nudges the subtask instead (make
  progress on the work, not the wrapper).
- Subtasks show a `↳ subtask-of #N` glyph; parent tasks show their
  children indented in `renderTaskList` output.

**Add a subtask:**

```
/subtask 5 Write intro section
/subtask 5 Write intro section | p=B | dur=30
/addtask Write intro | parent=5
/edittask 12 | parent=5
/edittask 12 | parent=clear
```

Aliases: `sub_of=`, `subof=`, `subtask_of=`

Via the button menu: **Tasks → ⛓ Dependencies / Parents → Set parent (subtask)**

### Deadline-aware urgency

`src/utils/urgency.ts` classifies any task that has a hard
`scheduled_for` date or a constraint date-range into urgency buckets:

| Bucket     | Meaning                    | Score boost |
|------------|----------------------------|-------------|
| `overdue`  | Deadline already passed    | +200        |
| `imminent` | < 24 h away                | +100        |
| `today`    | Due today                  | +60         |
| `soon`     | < 3 days                   | +30         |
| `this_week`| < 7 days                   | +10         |
| `far`      | ≥ 7 days or no deadline    | 0           |

These boosts layer on top of priority + age + fit scoring in the nudger
so an imminent task surfaces above an otherwise-equal long-runway task.
The AI receives a compact urgency label (e.g. `urgency=⏳ today`) in
its per-task context every turn. Stored priority is **never modified**
by the urgency system — it is a display and scoring overlay only.


## Scheduling constraints

Every task can carry an optional **scheduling constraint** on top of
its `scheduled_for` field. Where `scheduled_for` says *"this happens
at 19:00 on Friday"*, a constraint says *"this task is only eligible
at all inside this window"* — morning workouts (`time:06:00-08:00`),
a project you only want to touch weekdays (`days:mon,tue,wed,thu,fri`),
a single-month push (`dates:2026-08-01..2026-08-31`), or any
combination. The free-time nudger honours it: a task whose constraint
isn't currently satisfied is skipped for the current window without
being dropped from your list.

The field has three independent sub-parts, and every write path
(AI tools, `/schedule`, `/edittask | constraint=`, the /menu Edit
Task → Constraint picker) funnels through the same validator, so the
shape is the same everywhere:

- **`dates:YYYY-MM-DD..YYYY-MM-DD`** — inclusive date range in your
  timezone. Either side may be `-` or omitted for an open-ended range
  (`dates:2026-08-01..` = "from August 1st onwards";
  `dates:..2026-08-15` = "until the 15th").
- **`days:mon,wed,fri`** — comma-separated lowercase 3-letter
  weekday codes. Any non-empty subset of `mon,tue,wed,thu,fri,sat,sun`.
- **`time:HH:MM-HH:MM`** — daily wall-clock window in your timezone,
  inclusive at the start and exclusive at the end. Wraparound is OK
  (`time:22:00-02:00` means "22:00 today through 02:00 tomorrow").

Any subset of the three is legal, and an absent sub-part imposes no
restriction. A task with no constraint at all is always eligible —
the default state for every task written before this feature landed.

### Mini-syntax

Inside `/schedule` and inside the `constraint=` tag on `/addtask` /
`/edittask`, sub-parts are separated by `;` or `|`. Whitespace is
tolerated everywhere and sub-keys are case-insensitive:

```
days:mon,wed,fri; time:07:00-08:00
dates:2026-08-01..2026-08-15; days:mon,tue,wed,thu,fri
time:22:00-02:00
```

### `/schedule` command

```
/schedule 12 days:mon,wed,fri; time:07:00-08:00
/schedule 12 dates:2026-08-01..2026-08-15
/schedule 12 clear      # remove the whole constraint
/schedule 12            # show the current one
```

`/constraint` is an alias for the exact same command. Editing routes
through the same `editTask` helper the AI's `edit_task` tool, the
`/edittask` command, and the /menu Edit Task flow all call — no
forked write path.

### `constraint=` tag on /addtask and /edittask

```
/addtask Morning stretch | constraint=days:mon,tue,wed,thu,fri; time:06:00-06:30
/edittask 12 | constraint=dates:2026-08-01..2026-08-31
/edittask 12 | constraint=      # bare = with no value clears it
```

`window=` and `c=` are shorter aliases for the `constraint=` key.

### Button path (/menu → Tasks → Edit task → Constraint)

For users who'd rather not type the mini-syntax, `/menu → Tasks →
Edit task →` pick the task `→ Constraint` opens a small sub-menu
with one button per sub-part:

- **📅 Date range** — prompts for a free-text value in the same
  `YYYY-MM-DD..YYYY-MM-DD` syntax (with `-` and open-ended forms
  supported). Sending `-` clears just the date range.
- **🗓 Days of week** — opens a 7-day toggle grid seeded with the
  current selection; tap each day to flip it and tap ✅ Save when
  done. Saving an empty selection clears just the days.
- **⏰ Time window** — prompts for a free-text `HH:MM-HH:MM`. Sending
  `-` clears just the time window.
- **🧹 Clear constraint** — one-tap wipe of the whole field
  (equivalent to `/schedule <id> clear`).

Each sub-part commits on its own and lands you back on the parts
menu with a refreshed header showing the new state, so you can tweak
one piece at a time without walking the whole flow. Tap ✅ Done to
close.

### Knowing what time it is

Compass is told the real current time on every single turn, so it never
has to guess at the clock or ask you what day it is.

- **Injected, not looked up.** The exact local date, weekday and
  `HH:MM` ride along inside the same per-turn context block that
  already carries your open tasks, balance and debts
  (`src/ai/systemPrompt.ts`) — there is deliberately no
  `get_current_time` tool the model could forget to call. It has the
  reading before it starts reasoning.
- **In your timezone.** The reading is taken in your own IANA zone,
  with the correct UTC offset for that instant, so DST and half-hour
  zones (`Asia/Kolkata`, `Australia/Adelaide`) come out right. The
  model also gets a machine-readable `2026-07-31T22:42+03:00`
  timestamp to anchor relative phrasing — "in two hours", "tonight",
  "tomorrow at 9" all resolve against it, which is what lets a vague
  request become a concretely-scheduled task the nudger can reason
  about.
- **One instant per turn.** The timestamp is stamped once when your
  message arrives and reused everywhere in that turn, so the date and
  the clock can never disagree across a midnight boundary.
- **Honest when it's guessing.** If you've never set a timezone,
  Compass is told the zone is the Worker's `DEFAULT_TIMEZONE` standing
  in rather than your real one, and will say so once (and point you at
  `/timezone`) instead of confidently reporting the wrong hour.
- **Verifiable.** `/time` shows you exactly the reading Compass is
  working from, without spending any Gemini quota — so if an answer
  looks time-confused, you can tell straight away whether the clock or
  the model was at fault.

### Free-time nudging

A separate, higher-frequency cron scans each user's day. When you're
in a genuine free window (no in-progress task, no imminently-scheduled
task, enough runway to actually finish something), Compass picks the
single flexible task that best fits the window — by priority and by
whether its time estimate is smaller than the window — and sends one
low-key suggestion. One nudge per free window; no double-tapping the
same window.

Window length is measured against your own wall clock: a task
scheduled for a bare `19:00` means 19:00 *where you are*, not 19:00
UTC, so the runway Compass thinks you have matches the runway you
actually have.

### Two ways to drive it: talk, or type / tap

Everything above is reachable both by natural language ("mark #12 done",
"move 100 to set-aside", "change my timezone to Africa/Lagos") and by
the direct commands and menus below. Direct commands never call the AI
and never burn Gemini quota.

---

## Direct slash commands

### Tasks

- `/today` — today's tasks (includes paused tasks so you can still see
  them on the list, prefixed with ⏸).
- `/alltasks` — every open task, today + non-today combined. `/all`
  is an alias.
- `/addtask <title> [| p=A] [| dur=45] [| when=tonight] [| note=...]` —
  add a single task. `/add` is an alias.
- `/addbatch` — add several tasks at once, one task per line, same
  syntax as `/addtask` (bullet-list prefixes like `-` or `•` are
  stripped, `#` starts a comment). `/batch` is an alias.
- `/edittask <id> [| field=value | ...]` — edit an existing task. Fields:
  `title`, `priority` (A+..E-), `dur` (minutes), `when`, `note`,
  `status` (`pending|in_progress|paused|done|cancelled`),
  `constraint` (see `/schedule` below — same mini-syntax; `window=`
  and `c=` are shorter aliases; a bare `constraint=` with no value
  clears the field). `/edit` is an alias.
- `/schedule <id> [dates:YYYY-MM-DD..YYYY-MM-DD] [days:mon,wed,fri] [time:HH:MM-HH:MM]` —
  set a scheduling window on a task. `/schedule <id> clear` removes
  it; bare `/schedule <id>` shows the current one. Sub-keys are
  independent — any subset is legal. `/constraint` is an alias.
- `/deletetask [id]` — delete a task by id (asks to confirm via the
  same pending_confirmations gate the AI uses). Without an id, opens
  the same picker the menu Delete Task button uses. `/del` is an alias.
- `/starttask <id>` — mark a task as active right now
  (status=`in_progress`). `/begin` is an alias.
- `/finishtask <id>` — mark a task as done yourself. `/done` is an
  alias.
- `/pause <id>` — park a task without dropping it. A paused task
  stays visible in every listing (today / all / review / menu pickers),
  but is skipped by the free-time nudger and is NOT counted as
  "what's active now". Use `/resume <id>` to unpause.
- `/resume <id>` — unpause a task; it goes back to `pending` and is
  eligible for free-time nudges again.
- `/review` — list your flexible (unscheduled) open tasks, highest
  priority first. `/flex` and `/flexible` are aliases.

### Finance

- `/balance` — current balance.
- `/debts` — open debts (marks any you're just holding for someone
  else).
- `/finance` — balance + debts summary, split into "you owe" vs.
  "holding for others".
- `/setbalance <amount> [currency]` — overwrite the balance directly.
  If you typed the command yourself, Compass assumes you meant it and
  skips the AI's large-overwrite confirmation gate.

### Settings

- `/time` — the current date, weekday and time in your timezone,
  exactly as Compass sees it each turn, plus the zone and its UTC
  offset. Warns you when the zone is only the server default. `/now`
  is an alias.
- `/timezone <IANA tz>` — set your own timezone, e.g.
  `/timezone America/New_York`, `/timezone Africa/Lagos`. Used for
  daily rollovers and any "today" logic. Rejects anything that isn't
  a real IANA identifier; falls back to the Worker's
  `DEFAULT_TIMEZONE` for users who've never set one. `/tz` is an alias.
  Sending `/timezone` with no argument shows the current value — and
  the resulting wall-clock time, so a wrong zone is obvious at a
  glance. Setting a new one echoes the same check.

### Meta

- `/start` — welcome message.
- `/help` — a grouped list of every direct command, plus a pointer to
  `/menu`.
- `/menu` — open the button-driven interface (see below). `/settings`
  is an alias for the same entry point.

The canonical list registered with Telegram's built-in command menu
(the "/" autocomplete) lives in `src/handlers/commandMenu.ts` and is
pushed via the one-shot `/admin/register-commands` endpoint from step 5c.

---

## Button-driven menu (/menu)

`/menu` (or `/settings`) opens an inline-keyboard menu:

- **📋 Tasks**
  - 📅 Today — today's tasks (paused tasks visible here, prefixed ⏸)
  - 🗂️ All tasks — every open task, today + non-today combined (also
    via `/alltasks`)
  - 🔀 Flexible (by priority) — same list as `/review`
  - ➕ Add task — step-by-step wizard: title → priority band (A..E) →
    fine-tune (`+`, plain, `-`) → rough duration → confirm
  - ✏️ Edit task — pick from a list of open tasks, then pick the field
    to edit (Title, Priority, Duration, When, **Constraint**, Status).
    The Status picker includes **Paused** alongside Pending /
    In progress / Done / Cancelled. The Constraint picker is a small
    sub-menu of its own (see the Scheduling constraints section)
    that lets you edit the three sub-parts independently: a date
    range, a days-of-week set (as a tap-to-toggle grid), and a daily
    time-of-day window — plus a one-tap Clear.
  - ▶️ Start · ✅ Finish — one-tap direct status changes: pick a task,
    it goes to `in_progress` or `done`. Same helper the AI, `/starttask`,
    and `/finishtask` use.
  - ⏸️ Pause · ▶️ Resume — one-tap park and unpark. The Pause picker
    only lists pausable tasks (pending or in-progress); the Resume
    picker only lists paused tasks. Same helper the AI, `/pause`, and
    `/resume` use.
  - 🗑️ Delete task — pick from a list, then confirm.
- **💰 Finance**
  - 💵 View balance (shows set-aside too when non-zero)
  - 📒 View debts
  - ➕ Add to balance / ✍️ Set balance (large overwrites go through the
    same confirm gate the AI does)
  - ➡️ Move to set-aside / ⬅️ Take from set-aside
  - 💱 Default currency — pick from common codes or type your own
- **⚙️ Settings**
  - 🕒 Timezone — pick from common IANA zones or type your own. The
    picker shows your current zone *and* what time that makes it for
    you right now, so a mis-picked zone is caught immediately.

Every button-driven action routes through the same D1 helpers the
typed commands and AI tools use — no forked logic. Anywhere the menu
asks you for free text (a task title, an IANA identifier, a cash
amount), any `/`-command breaks you out cleanly.

---

## Project layout

```
motionsalt-compass/
├── migrations/
│   ├── 0001_initial.sql          # tasks, api_keys, conversation_log, users
│   └── 0002_finance.sql          # user_balance (incl. set_aside), debts,
│                                   pending_confirmations, pending_flows,
│                                   nudge state
├── src/
│   ├── index.ts                  # Worker entry (fetch + scheduled +
│                                   /admin/register-commands)
│   ├── handlers/
│   │   ├── webhook.ts            # Telegram webhook: slash dispatch +
│   │                               callback_query routing
│   │   ├── buttons.ts            # Inline-keyboard callback handlers +
│   │                               multi-step flow state
│   │   ├── menuUi.ts             # Keyboard builders + callback_data
│   │                               encoding
│   │   ├── directTasks.ts        # /addtask, /addbatch, /edittask,
│   │                               /review parsers and executors
│   │   ├── commandMenu.ts        # BOT_COMMANDS list for setMyCommands
│   │   ├── cron.ts               # Daily reset job
│   │   └── nudgeCron.ts          # Duration-aware free-time nudger
│   ├── ai/
│   │   ├── agent.ts              # Tool-calling loop
│   │   ├── gemini.ts             # Gemini REST client + key fallback
│   │   ├── systemPrompt.ts       # Compass's voice + live task snapshot
│   │   ├── tools.ts              # Function-calling tool declarations
│   │   └── toolExecutor.ts       # Tool -> D1 dispatch
│   ├── db/
│   │   ├── tasks.ts
│   │   ├── balance.ts
│   │   ├── debts.ts
│   │   ├── confirmations.ts
│   │   ├── flows.ts              # pending_flows for menu-driven wizards
│   │   ├── nudge.ts
│   │   ├── apiKeys.ts
│   │   ├── conversation.ts
│   │   └── users.ts
│   ├── services/
│   │   └── telegram.ts           # Bot API wrapper (incl. setMyCommands,
│   │                               editMessageText, answerCallbackQuery)
│   ├── utils/
│   │   ├── base64.ts
│   │   ├── logger.ts
│   │   ├── money.ts              # cent-integer parse + format
│   │   ├── priority.ts           # letter-grade scale
│   │   ├── freeWindow.ts         # free-window detector
│   │   ├── nudgeScoring.ts       # flexible-task scorer for the nudger
│   │   └── time.ts               # local date / wall clock / UTC offset;
│   │                             #   localNow() is the per-turn reading
│   │                             #   handed to the AI and to /time
│   └── types/
│       ├── env.ts
│       ├── task.ts
│       ├── shared.ts
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
instead of pushing the biggest thing on the list. The free-time nudger
inherits the same restraint: at most one suggestion per genuinely free
window, sized to fit, and never a follow-up if you ignore it. That
behaviour lives in the system prompt (`src/ai/systemPrompt.ts`) and
the nudge scorer (`src/utils/nudgeScoring.ts`) — tweak it there if you
want to shift the voice.

---

## Finance model (quick reference)

**Storage.** All amounts live in D1 as INTEGER minor units (cents) to
avoid floating-point drift. The runtime converts to/from decimal
strings at the edges (`src/utils/money.ts`).

**Balance + set-aside.** One row per user in `user_balance` holds both
the main balance and the set-aside bucket (`set_aside_cents`). Money
in set-aside still belongs to the user — it's just excluded from
"what should I do with this new money?" suggestions until moved back.
Editable both via the AI (`record_income`, `record_spend`,
`adjust_balance`, `set_balance`, `move_to_set_aside`,
`move_from_set_aside`) and directly via `/setbalance` or the Finance
menu. All paths converge on the same row.

**Default currency.** Stored on the `users` row. Applied to a
first-time balance row and to any new debt that didn't specify a
currency. Change it via /menu → Finance → Default currency, or by
telling Compass.

**Debts.** Everything owed lives in `debts`. The key field is
`responsible_party`:

- `'user'` — the user's own obligation. Compass may suggest paying
  it from the balance and will decrement the balance when told to.
- `'other'` — someone else's obligation the user is just holding
  cash for (e.g. "this 300 is my mom's"). Compass will never suggest
  paying it from the user's balance, and the `apply_payment_to_debt`
  tool hard-refuses `from_balance=true` for such debts.

Debts can also be recurring (rent, subscriptions), with the same
`recurrence_rule` mechanism as recurring tasks.

**Confirm-before-execute.** Destructive financial actions require a
two-step handshake via `pending_confirmations`:

- `delete_debt` — always requires a confirm token.
- `set_balance` — only when the new number is very different from
  the current one (>=50% change AND >=100 units). Small corrections
  are frictionless. The /menu Set balance flow uses the exact same
  gate and reuses the same token type.

Non-destructive actions (recording income, applying money to a debt,
adjusting an amount, adding a new debt, cancelling a debt, moving
cash in/out of set-aside) do not need confirmation.
