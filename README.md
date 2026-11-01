# Recruiter AI backend

A chat-based AI recruiting assistant. The recruiter talks to it and it takes a role from job description to hire: JD, job, sourcing, review, outreach, replies, meeting, interview, shortlist, hired, stats.

Stack: Node.js + Express (TypeScript), BullMQ + Redis, MongoDB (Mongoose) and any OpenAI-compatible LLM. The React app lives in the `recruiter-frontend` repo.

## Running it

Keep both repos in the same parent folder:

```
recruiter-backend/
recruiter-frontend/
```

With Docker:

```bash
cd recruiter-backend
cp .env.example .env
docker compose up --build
```

The app is on http://localhost:5173 and the API on http://localhost:4000. The compose file builds the frontend from `../recruiter-frontend`, so that folder name matters.

Without Docker, start MongoDB and Redis yourself, then:

```bash
cp .env.example .env
npm install
npm run dev          # API
npm run dev:worker   # background workers, in a second terminal
```

and run `npm run dev` in the frontend repo.

To try it, click "Use the sample job description" in the chat (it is `seed/sample-jd.txt`), and later upload `seed/sample-candidates.csv` with the paperclip button.

### Running without keys

| Missing | What happens |
|---|---|
| `LLM_API_KEY` | The chat agent says it is disabled. Scoring, drafting and reply classification use simple keyword fallbacks so the rest of the flow still works. |
| `SERPER_API_KEY` | Sourcing returns 5 labelled sample profiles from `seed/mock-search.json`. |
| `SMTP_*` | Emails are recorded as sent but not delivered. |

`.env.example` is set up for Gemini through its OpenAI-compatible endpoint. If you leave `LLM_BASE_URL` out it talks to OpenAI and defaults to `gpt-4o-mini`.

## Architecture

```
React app --REST--> Express API --> MongoDB
    ^                 |   ^
    | SSE             |   '-- Redis pub/sub <-- workers
    '-----------------'
                      | add jobs
                      v
                BullMQ queues (Redis)
     sourcing, scoring, drafting, sending, replies
                      |
                      v
                Worker process --> LLM, Serper, SMTP, MongoDB
```

- The API (`src/server.ts`) serves the REST endpoints, runs the chat agent, handles confirmations and streams events to the browser (`GET /api/events`).
- The worker (`src/worker.ts`) is a separate process with one BullMQ worker per queue. It publishes change events to Redis and the API forwards them over SSE.
- MongoDB holds everything: conversations, jobs, candidates, campaigns, emails, replies, the activity log and LLM usage. The queues only carry ids.

Collections: `Conversation`, `Message` (with cards), `Job`, `Candidate`, `ActivityLog`, `SourcingRun`, `Campaign`, `OutreachMessage` (emails and reply drafts), `Reply`, `PendingAction`, `Meeting`, `LlmUsage`.

## The agent

The agent is a plain tool-calling loop in `src/agent/index.ts`, no framework. For each user message it:

1. builds the prompt from the rules, a fresh summary of the current state read from the database (jobs, counts, campaigns, pending confirmations) and the last 16 messages;
2. calls the model with 15 tools; if it asks for tools they run and the results go back to the model, up to 8 rounds;
3. saves the final answer with any cards the tools produced. The browser gets it over SSE.

Read tools (`list_candidates`, `get_stats`, `get_activity` and so on) run straight away. Everything that writes is a `propose_*` tool: create job, start sourcing, change statuses, create, approve or pause a campaign, switch auto-reply. These do not change anything. They save a `PendingAction` and return a confirmation card, and the change only happens when the recruiter clicks Confirm (`POST /api/actions/:id/confirm`). So the "confirm before any write or send" rule is enforced in code, not by the prompt. Cards can be edited before confirming (job fields, campaign steps, recipients).

The model never picks candidate ids. For "accept the top 5" or "mark Rahim as hired" the tool gets names or a filter, the server resolves them, checks the status rules and lists exactly who will change on the card.

Clicks in the UI (accept and reject buttons, editing a draft, approving a campaign, CSV upload, simulate reply) are the recruiter's own actions, so they run immediately. Chat and UI both call the same service functions. Every status change goes through `changeStatus`, which validates the move and writes the activity log.

## Background jobs

| Queue | What it does |
|---|---|
| `sourcing` | Builds `site:linkedin.com/in` queries from the job, calls Serper, parses the results, removes duplicates by email or profile URL, saves candidates and queues scoring. LinkedIn itself is never scraped. |
| `scoring` | One job per candidate. The LLM returns a 0-100 score, a short reason and matched and missing skills as validated JSON. The candidate's name is not sent to the model. |
| `drafting` | One job per candidate. Writes a personalised email for each step of the campaign. The unsubscribe line is added in code. |
| `sending` | Sends one email over SMTP. Concurrency is 1 so the daily limit cannot be raced. |
| `replies` | Classifies a reply, updates the status, drafts an answer and optionally auto-sends it. |

All queues retry 3 times with exponential backoff. The progress shown in chat ("Found 23, scored 15") is computed from the candidates in the database, so it stays correct across retries and restarts.

Scheduling: when a campaign is approved every email gets a `scheduledFor` date (day 0, 3, 7, ...). A sweeper in the worker runs every 10 seconds and hands due emails of active campaigns to the `sending` queue. Pausing a campaign only changes its status. When an email is about to go out the worker checks again that the campaign is active, the candidate is still in the right status, has not unsubscribed, has not already received this step, and that the daily limit is not reached (if it is, the email moves to tomorrow). A unique key per campaign, candidate and step plus an atomic claim on the message stop anyone getting the same step twice.

Replies: a reply (there is no real inbox, use `POST /simulate-reply` or the button in the UI) moves the candidate to Replied right away and cancels their follow-ups. A worker then classifies it as Interested, Not interested, Question, Wants a meeting or Unsubscribe, updates the status and drafts an answer that waits for approval. Unsubscribe is also matched by keywords in code, so it works even if the model misses it, and it applies to that email address across all jobs.

Meetings: the reply draft for an interested candidate contains a link to the built-in slot picker (`/book/:token`) or your `CALENDLY_URL`. When the candidate picks a slot they move to Meeting booked.

Auto-reply is off by default and set per job. A reply goes out without approval only if it is an "interested" or "wants a meeting" reply, confidence is at least 0.8, there is no injection flag, the draft says nothing about money, offers or promises, it still contains the booking link and the candidate has not been auto-answered before (`src/lib/autoReply.ts`).

## Statuses

`Sourced -> Accepted / Rejected -> Contacted -> Replied -> Interested / Not interested -> Meeting booked -> Interviewed -> Shortlisted -> Hired / Rejected`, plus `Unsubscribed` at any point after Contacted. The allowed moves are in `src/lib/status.ts` and skipping a stage is rejected. Each change is logged with who made it (recruiter in the UI, recruiter in chat, candidate, AI or system).

## Prompt injection

Profile text, CSV notes and candidate replies are treated as untrusted:

1. `src/lib/sanitize.ts` strips hidden characters, neutralises fake tags, truncates and flags phrases that look like instructions. Flagged candidates and replies get a warning in the UI.
2. Untrusted text is always wrapped in `<untrusted_*>` tags and the system prompts say to treat it as data.
3. Scoring, classification and drafting are plain text-in, JSON-out calls with no tools, so an injected instruction has nothing to call.
4. Outputs are validated with zod: scores are clamped, labels come from a fixed list.
5. Writes from the chat agent need a click, and flagged text blocks auto-reply. The sample CSV has one row with a planted injection to show this.

## Why this LLM and agent setup

- LLM: any OpenAI-compatible API. I used Gemini (`gemini-3.1-flash-lite`) because it is cheap and supports tool calling and JSON output. Changing `LLM_BASE_URL` and `LLM_MODEL` is enough to switch to OpenAI, OpenRouter and others.
- Agent: my own loop instead of LangGraph or the Vercel AI SDK. The loop is short, there are 15 tools and one hard rule about confirmation. A framework would hide exactly the parts I care about, what goes to the model and how confirmation is enforced. The cost is that I get no token streaming and no graph persistence for free.
- Background work (scoring, drafting) uses the same small model with short structured prompts, since it runs once per candidate. Tokens and cost are saved per call in `LlmUsage` and shown per job.

## Done, mocked, skipped

Done: all the core requirements: chat UI with cards, tool-using agent, confirmation before every write or send, BullMQ jobs with retries for sourcing, scoring, drafting and sending, live progress over SSE, CSV upload, simulated replies with classification and drafts, status changes from chat and UI with an activity log, a dashboard with funnel, reply rate, interested rate, meetings and hires, and persistence across refresh. Of the optional items: real SMTP sending, auto-reply with safety rules, cost tracking per job, pause and resume, an AI summary per job and prompt injection protection.

Mocked:
- Web search without a Serper key returns sample profiles.
- Email without SMTP settings is recorded as sent but not delivered.
- Replies come from `POST /simulate-reply`, not an inbox. The slot picker stands in for Calendly.

Skipped:
- Login and multi-user support. It is a single-user tool and every browser sees all events. It needs auth and rate limiting before going on the internet.
- Reading a real inbox (IMAP or Gmail webhooks).
- Streaming the answer token by token. The chat shows a working status and then the full answer.
- LinkedIn scraping. Web results only give a title and snippet and no email, so scores for these candidates are shallow. For outreach, upload a CSV with emails or click "add email" on the candidate row.

## Trade-offs

- Confirmation cards make the recruiter click more, but the AI can never send or change anything on its own.
- The database is the scheduler, not one delayed BullMQ job per email. Pause, resume and "stop on reply" become simple status changes, and the price is up to 10 seconds of delay.
- Cards store ids and load their own data, so they are always current after a refresh, at the cost of one request per card.
- The agent remembers the last 16 messages plus the state summary instead of replaying every tool call. That is cheaper and predictable, but it only knows what is in the summary and the visible chat.
- The daily limit is per campaign per calendar day and the sending queue has concurrency 1. Fine for one recruiter, it would need rework at scale.
- `OUTREACH_DAY_MS` shrinks a "day" so follow-ups can be shown in a demo within minutes.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/conversations`, `GET /api/conversations/:id/messages`, `POST /api/conversations/:id/messages` | chat |
| `GET /api/events` | SSE stream |
| `GET /api/actions/:id`, `POST /api/actions/:id/confirm`, `POST /api/actions/:id/cancel` | confirmation cards |
| `GET /api/jobs`, `/api/jobs/:id/stats`, `/summary`, `/candidates`, `/activity`, `/replies` | job data |
| `POST /api/jobs/:id/candidates/csv` | CSV upload |
| `PATCH /api/candidates/:id/status` | move a candidate |
| `PATCH /api/candidates/:id/email` | set or fix a candidate's email, body `{ email }` |
| `GET /api/campaigns/:id`, `POST /api/campaigns/:id/approve`, `/pause`, `/resume`, `PATCH /api/outreach/:id` | campaigns and drafts |
| `POST /simulate-reply` (also `/api/simulate-reply`) | simulate a reply, body `{ candidateId, text }` |
| `POST /api/replies/:draftId/approve`, `/discard` | reply drafts |

## Tests

```bash
npm test
npm run typecheck
```
