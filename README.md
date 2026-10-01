# Gemini MCP: a second AI reviewer inside Claude

This is a remote [MCP](https://modelcontextprotocol.io) server that lets Claude consult Google's Gemini without you leaving the conversation. Claude briefs Gemini with the context it needs. Gemini then checks the work independently with live Google Search, reading the actual sources (web pages, PDFs, YouTube videos), and reports back with citations. You get a cross-checked answer, plus a note wherever the two models disagree.

```
 You ──► Claude (claude.ai web / desktop / mobile, Claude Code)
            │  "verify these claims", "review my draft", "what does this video say?"
            ▼
   Gemini MCP server (your own Google Cloud Run service, free tier)
            │  Gemini Interactions API + Google Search + URL/YouTube reading
            ▼
         Gemini ──► verdicts, evidence, source links, thread_id for follow-ups
```

Gemini gets context in three ways:

- **Per call:** Claude passes your goal, the relevant details, and what it already found.
- **Thread memory:** every result includes a `thread_id`. When Claude passes it back, Gemini remembers the whole exchange, so Claude can push back on a verdict or ask a follow-up without starting over.
- **Standing context (optional):** a line about you that Gemini should always know, such as "I live in Singapore and use metric units". Set it with `GEMINI_USER_CONTEXT`.

## Before you start: your Gemini subscription vs. the Gemini API

Your **Google AI Plus** ("Gemini Plus") subscription covers the Gemini *app*. It doesn't include API access, and apps like this one can't use your Gemini app chats, memory, or Gems. This server uses a **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey) instead. You can create one with the same Google account in about a minute.

| | Free API tier (no billing) | Paid API tier (billing enabled on the key) |
|---|---|---|
| Cost | $0 | Pay per use. A typical check costs about $0.01–0.03 (see [Costs](#costs)) |
| Web search (Google Search grounding) | **Gemini 2.5 Flash only.** Gemini 3.x models can't use search on the free tier | Newest models: Gemini 3.8 Flash, and Gemini 3.1 Pro for `depth: "deep"` |
| Reading URLs, PDFs, YouTube; reasoning without search | Gemini 3.8 Flash | Gemini 3.8 Flash and 3.1 Pro |
| Privacy | Google may use prompts and answers to improve its products, and human reviewers may read them | Not used to improve Google's products |
| Rate limits | Low daily limits | Much higher |
| Thread memory (`thread_id`) | Kept for 1 day | Kept for 55 days by default |

The server works with either tier. Set `GEMINI_TIER` to match your key. If you set `paid` but the key turns out to be free tier, the server notices and falls back automatically. Don't send sensitive personal data through a free-tier key.

> If your plan is actually **Google AI Pro** or **Ultra**, it includes monthly Google Cloud credits through the Google Developer Program ($10/month on Pro). These can pay for the paid API tier and for Cloud Run.

## What Claude gets

| Tool | What it does |
|---|---|
| `gemini_verify_claims` | Fact-checks a list of claims with Google Search. Opens the URLs Claude cited to check that they really say what Claude claims. Returns a verdict per claim (✅ supported, 🟡 partly, ❌ contradicted, ⚖️ disputed, ❔ unverified) with evidence, corrections, and sources. |
| `gemini_web_search` | Independent research on a question. Returns a sourced answer with inline citations and the exact Google searches Gemini ran, which is useful for cross-checking Claude's own web search. |
| `gemini_analyze_urls` | Gemini reads specific pages, PDFs, images, or **public YouTube videos** (which Claude can't watch) and answers a question about them. It quotes the content, gives timestamps, says which URLs it couldn't open (paywalls, errors), and rates each source's credibility. |
| `gemini_second_opinion` | A critical review of a draft answer, plan, calculation, or code: verdict, prioritized issues with fixes, and what holds up. |
| `gemini_ask` | Talk to Gemini directly, or continue any earlier exchange with its `thread_id`. |
| `gemini_deep_research_start` / `_result` | *Optional, paid tier only, about $1–7 per run.* Gemini Deep Research writes a long, cited report over 5–20 minutes. Turn it on with `ENABLE_DEEP_RESEARCH=true`. |

Every tool accepts `depth` (`quick`, `standard`, or `deep`), `context`, and `thread_id`. The server also provides three prompt templates in Claude's **+** menu: *Fact-check the last answer with Gemini*, *Get Gemini's critique of the last answer*, and *Research a question with Claude and Gemini independently*.

## Setup (about 15 minutes, one time)

### 1. Get a Gemini API key

1. Open [Google AI Studio → API keys](https://aistudio.google.com/apikey) and sign in with your Google account.
2. Click **Create API key** and copy it.
3. Optional: to use the paid tier, set up billing for the key's project in AI Studio. You can also start free and switch later.

### 2. Deploy the server to Google Cloud Run

Cloud Run hosts the server in Google's cloud, so it works from any device with nothing running on your computer. Personal use normally stays inside Cloud Run's free tier, but Google requires a billing account (a card) on the Cloud project.

1. Open **[Google Cloud Shell](https://shell.cloud.google.com)**, a terminal in your browser with everything preinstalled. Use the same Google account.
2. Decide which Google Cloud project hosts the server. It needs billing [linked](https://console.cloud.google.com/billing/linkedaccount):
   - **The `gen-lang-client-…` project** that AI Studio created for your key is simplest. Turning billing on there also moves your Gemini key to the **paid** tier.
   - **Another project** (or a [new one](https://console.cloud.google.com/projectcreate)) keeps the Gemini key on the **free** tier, because billing only goes on the hosting project.
3. Paste this into Cloud Shell:

   ```bash
   git clone https://github.com/weixuanng/gemini_mcp.git
   cd gemini_mcp
   git checkout claude/mcp-gemini-integration-cww1kx   # skip this line once the branch is merged into main
   ./deploy/cloudrun.sh
   ```

4. The script asks three things:
   - **Which project:** type its number from the list. Don't paste your API key here.
   - **Your Gemini API key:** paste it when asked. New keys start with `AQ.`. Nothing appears while you paste; that's normal. Press Enter afterwards.
   - **Paid tier?:** answer `y` if billing is on for the key's project, otherwise `N`.

   If you already cloned the repo, run `git pull` first to get the latest script.

After 3–5 minutes the script prints two things:

- **Connector URL**, for example `https://gemini-mcp-123456789.us-central1.run.app/mcp`
- **Access key**, a long random password. Save it in your password manager.

The Gemini key and the access key are stored in Google Secret Manager, not in the code. To add a sentence about yourself, run the script with `GEMINI_USER_CONTEXT="I live in Singapore, train for marathons, prefer metric units" ./deploy/cloudrun.sh`.

### 3. Connect it to Claude

1. Go to [claude.ai/customize/connectors](https://claude.ai/customize/connectors), click **+**, then **Add custom connector**.
2. Enter **Name** `Gemini` and **URL** = the Connector URL from step 2 (it ends in `/mcp`). Click **Add**.
3. Click **Connect**. A page titled **Connect to Gemini MCP** opens. Paste your access key and click **Approve**.

That's it. The connector works in Claude on the web, desktop, and mobile, and in Claude Code on the web. Enable it in a chat from **+ → Connectors**.

**Claude Code CLI** (optional): `claude mcp add --transport http gemini <Connector URL> --header "Authorization: Bearer <access key>"`. Leave out `--header` to sign in through the browser instead.

### 4. Try it

- "Fact-check your last answer with Gemini."
- "Before you answer, have Gemini verify the statistics you're using."
- "Ask Gemini to independently research X, then compare its answer with yours."
- "Have Gemini watch this YouTube video and tell me whether it supports claim Y."
- "Get Gemini's second opinion on this plan, then fix whatever you both agree is wrong."

To have Claude double-check things automatically, add this to your Claude **profile preferences** or a **Project's instructions**:

> For important factual answers (numbers, health, money, legal, recent events), verify the key claims with the Gemini connector (`gemini_verify_claims`) before answering. Tell me where you and Gemini disagree.

## Costs

- **Cloud Run, Cloud Build, Artifact Registry, Secret Manager:** personal use normally fits in Google Cloud's free tiers, which works out to $0 or a few cents. The server scales to zero when idle. Each redeploy stores a new container image, so it's worth adding an Artifact Registry [cleanup policy](https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy) and a [budget alert](https://console.cloud.google.com/billing/budgets).
- **Gemini API, free tier:** $0.
- **Gemini API, paid tier** (prices on [Google's pricing page](https://ai.google.dev/gemini-api/docs/pricing), checked October 2026): Gemini 3.8 Flash costs $0.75 / $3.75 per million input/output tokens through 31 Dec 2026, then $1.50 / $7.50. Gemini 3.1 Pro costs $2 / $12. Google Search grounding includes 5,000 free searches a month, then $14 per 1,000. A typical fact-check is about $0.01–0.03, a `deep` check on 3.1 Pro about $0.05–0.20, and a Deep Research run about $1–7.
- **Safety cap:** the server allows at most 300 Gemini calls per day (`DAILY_CALL_LIMIT`). You can also set a spend cap on the key in AI Studio.

## Privacy, security and terms

- **Who can use it:** only someone holding your access key. Claude gets in through OAuth: you type the key once on the approval page, and Claude receives tokens that refresh automatically. The approval page only sends codes back to Claude (`claude.ai`) or to apps on your own computer (localhost). After 10 wrong attempts, that IP address is locked out for 15 minutes.
- **No database:** OAuth tokens are signed with a key derived from your access key. Rotating the access key (`ROTATE_ACCESS_KEY=1 ./deploy/cloudrun.sh`) immediately logs out every client.
- **What leaves the server:** only the text Claude sends in each tool call goes to Google's Gemini API. Interactions are stored by Google for thread memory (1 day free, 55 days paid; see [Interactions API retention](https://ai.google.dev/gemini-api/docs/interactions)). Set `GEMINI_STORE=false` to turn that off, which also disables `thread_id`. Logs record tool names, timings and token counts, never your prompts.
- **Google's grounding terms:** Google requires that grounded results be shown with their "Search Suggestions" and restricts how they're stored or reused ([Gemini API terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search)). Every result includes the Google searches Gemini ran as links. This project is meant for personal use, so read the terms if you plan anything more.
- **Treat Gemini as a second opinion, not an oracle.** It can be wrong too. Claude is told to weigh evidence rather than defer, and to tell you when they disagree.

## Configuration

Set these as Cloud Run environment variables (Cloud Console → Cloud Run → `gemini-mcp` → **Edit & deploy new revision** → **Variables & secrets**), or pass them to `./deploy/cloudrun.sh`.

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | (required) | Gemini API key, stored in Secret Manager by the deploy script |
| `MCP_ACCESS_KEY` | (required for HTTP) | The access key used for the approval page and Bearer auth. At least 24 characters |
| `GEMINI_TIER` | `free` | `free` or `paid` (see the table above) |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model for quick and standard work |
| `GEMINI_DEEP_MODEL` | `gemini-3.1-pro-preview` (paid), else `GEMINI_MODEL` | Model for `depth: "deep"` |
| `GEMINI_FREE_SEARCH_MODEL` | `gemini-2.5-flash` | Model used for web search on the free tier |
| `GEMINI_USER_CONTEXT` | (empty) | Standing context about you, added to every Gemini request |
| `GEMINI_STORE` | `true` | Store interactions so `thread_id` follow-ups work |
| `GEMINI_TIMEOUT_MS` | `200000` | Time budget per call. Claude's apps cut tool calls off at 240 s |
| `ENABLE_DEEP_RESEARCH` | `false` | Adds the paid Deep Research tools |
| `DAILY_CALL_LIMIT` | `300` | Max Gemini calls per day per instance (`0` = unlimited) |
| `MAX_OUTPUT_CHARS` | `60000` | Truncate longer results (Claude Code's default limit is about 25k tokens) |
| `AUTH_MODE` | `oauth` | `oauth` (Claude apps and Bearer key), `bearer` (Bearer key only), or `none` (local testing only) |
| `PUBLIC_URL` | (derived) | Fix the external URL, e.g. behind a custom domain |
| `OAUTH_EXTRA_REDIRECT_URIS` | (empty) | Extra allowed OAuth callbacks, comma-separated, e.g. for other MCP clients |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS` | `3600` / `7776000` | OAuth token lifetimes (1 hour / 90 days) |

## Maintenance

- **Update** after pulling new code: `git pull && ./deploy/cloudrun.sh`. Your keys and settings are kept.
- **Show the access key:** `gcloud secrets versions access latest --secret=gemini-mcp-access-key`
- **Replace the Gemini API key:** `UPDATE_GEMINI_KEY=1 ./deploy/cloudrun.sh`
- **Rotate the access key:** `ROTATE_ACCESS_KEY=1 ./deploy/cloudrun.sh`, then click **Connect** again in Claude.
- **Logs:** `gcloud run services logs read gemini-mcp --region us-central1 --limit 50`
- **Remove everything:** `gcloud run services delete gemini-mcp --region us-central1`, then delete the two secrets and the `cloud-run-source-deploy` Artifact Registry repository. Also remove the connector in Claude.

## Running locally (Claude Desktop / Claude Code, no cloud)

Requires Node.js 20.19 or newer.

```bash
npm ci && npm run build
claude mcp add gemini --env GEMINI_API_KEY=your-key -- node /path/to/gemini_mcp/dist/index.js --stdio
```

For Claude Desktop, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gemini": {
      "command": "node",
      "args": ["/path/to/gemini_mcp/dist/index.js", "--stdio"],
      "env": { "GEMINI_API_KEY": "your-key", "GEMINI_TIER": "free" }
    }
  }
}
```

To run the HTTP server locally: `GEMINI_API_KEY=… MCP_ACCESS_KEY=$(openssl rand -base64 32) npm run dev`, then use `http://localhost:8080/mcp`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Claude says "Couldn't reach the MCP server" | Check the URL ends in `/mcp` and opens in a browser (the home page shows the exact URL). Run `curl https://…/healthz`. |
| The approval page says the access key is wrong | Show it with `gcloud secrets versions access latest --secret=gemini-mcp-access-key` and paste it without spaces. |
| "Gemini rate limit or quota reached" | The free tier has low daily limits. Wait, or enable billing on the key and redeploy with `GEMINI_TIER=paid`. |
| "API key … invalid" | Run `UPDATE_GEMINI_KEY=1 ./deploy/cloudrun.sh` with a fresh key from AI Studio. |
| Deploy fails with a permission or build error | Make sure billing is linked and you're a project Owner, then re-run the script (it's safe to repeat). |
| The deploy warns that setting the IAM policy failed | Your organization blocks public services. Use a personal project, or redeploy with `--no-invoker-iam-check`. |
| A `thread_id` stopped working | Threads expire (1 day on free, 55 on paid). Start a new call with context. |
| Answers are cut off in Claude Code | Raise `MAX_MCP_OUTPUT_TOKENS` in Claude Code, or lower `MAX_OUTPUT_CHARS` on the server. |

## Development

```bash
npm ci
npm run check     # typecheck + tests (a mock Gemini API, real MCP SDK client, full OAuth flow)
npm run build
```

The code is TypeScript on Node 22: [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) v1 with stateless Streamable HTTP, a thin client for the [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions), and Express. Start reading at `src/server.ts` (tools and instructions), `src/prompts.ts` (what Gemini is told), `src/gemini/` (API client, model fallback, citations), and `src/http/` (OAuth and transport).
