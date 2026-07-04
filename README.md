# bromine-backend

API consumed by the `bromine-cv-extension` Firefox extension to generate on-demand, AI-tailored CVs — either adapted to a specific job offer or driven by a free-form prompt (e.g. "a CareerChannel pitch oriented toward Tech Lead").

It has three responsibilities:

1. **Generation** — loads the Josiane editorial skill + the current CV source from `carbon-notes`, calls an LLM to produce tailored content, and holds it as an in-memory draft ("session") until the user validates it.
2. **PDF rendering** — spawns `astro dev` inside a `bismuth-blog` checkout with a dev-only env var pointing at the tailored content, and drives Playwright/Chromium to produce a pixel-perfect PDF identical to the real CV pipeline.
3. **Traceability** — on validation, commits the tailored markdown (never the PDF) into `carbon-notes/cv/tailored/<slug>/` for an audit trail of what was generated and sent for which application.

## Stack

- **Node.js ≥ 22.6** — required for `--experimental-strip-types` (direct `.ts` execution, no build step, matching bismuth-blog's own scripts convention).
- **[Hono](https://hono.dev)** — chosen over Fastify/Express for this workload:

  | | Hono | Fastify |
  |---|---|---|
  | Footprint | ~14 KB, zero dependencies | ~500+ KB, plugin ecosystem |
  | RAM idle | ~3 MB | ~30 MB |
  | Validation | Manual / zod | Built-in Ajv (JSON Schema) |
  | Best for | Small APIs, tight memory budgets | Monolithic APIs needing max JSON throughput |

  With only ~8 routes and no database, the real work here is LLM calls and file I/O — Hono's ~30% lower memory footprint matters on a 1 GB LXC where a PDF render already peaks around 450–550 MB.

- **`@anthropic-ai/sdk`** in production, **Claude Code CLI** (subprocess) in development — see below.
- **`playwright`** for headless Chromium PDF rendering (not `@playwright/test` — no need for the test-runner/reporter weight in a production route).
- **`google-auth-library`** for Google OAuth id_token verification (JWKS handled internally, no hand-rolled crypto).

## Environments

Two `.env` files, loaded manually based on `NODE_ENV` (see `src/config.ts` — no `dotenv` dependency):

```
.env.development   # npm run dev  (NODE_ENV unset or "development")
.env.production    # deployed to /etc/bromine.env by the bromine-agent Ansible role
```

Copy `.env.development.example` → `.env.development` and fill in local paths before running `npm run dev`.

### LLM provider: Claude CLI in dev, Anthropic SDK in prod

```
USE_CLAUDE_CLI=true    # dev default — spawns `claude` as a subprocess, reuses your
                       # local Claude Code auth, no separate API key needed.
USE_CLAUDE_CLI=false   # requires ANTHROPIC_API_KEY — used automatically in production
                       # (NODE_ENV=production forces the SDK path regardless of this flag).
```

Both implement the same `ILLMProvider` interface (`src/lib/llm-provider.ts`) — nothing else in the codebase branches on which one is active. One limitation: the Claude CLI provider does not support image attachments (job-offer screenshots) — test that path with `USE_CLAUDE_CLI=false` locally if you need to exercise it before deploying.

### Content repos: local checkout in dev, managed clone in prod

| | Dev | Prod |
|---|---|---|
| carbon-notes | `LOCAL_CARBON_NOTES` (your own checkout) | `/home/bromineuser/repos/carbon-notes` (git clone, SSH deploy key, read+write) |
| bismuth-blog | `LOCAL_BISMUTH_BLOG` (your own checkout) | `/home/bromineuser/repos/bismuth-blog` (git clone, SSH deploy key, read-only) |

**Dev never commits.** `commitTailoredSession()` (`src/lib/git.ts`) is a no-op when `NODE_ENV !== 'production'` — tailored content written during local iteration stays on disk in your own carbon-notes checkout and is never pushed to GitHub. Clean it up manually (`git checkout -- cv/tailored/` or just leave it, it's gitignored-equivalent by convention — see the carbon-notes docs) between test runs if it bothers you.

## Running locally

```bash
npm install
cp .env.development.example .env.development   # then fill in LOCAL_CARBON_NOTES / LOCAL_BISMUTH_BLOG
npm run dev
```

Health check: `curl http://localhost:3000/health`

⚠️ The first `/cv/generate` call will start `astro dev` inside your `LOCAL_BISMUTH_BLOG` checkout to render the PDF, which runs **every** content loader — articles, docs, CV — not just the tailored CV. Make sure `LOCAL_CARBON_NOTES` is also set for that checkout's own `.env` (per bismuth-blog's `docs/content-pipeline.md`), or the loaders will hit the GitHub API instead of your local files and need `CONTENT_TOKEN`.

## Production (VM Bromine, Gallium)

Provisioned via `gallium-homelab` (Terraform `terraform/bromine.tf` + Ansible role `ansible/roles/bromine-agent/`). See `gallium-homelab/docs/bromine.md` for the full infra picture, deploy-key setup, and first-time deployment order.

⚠️ **RAM/disk are sized tight on purpose** (1 GB RAM / 5 GB disk — this backend handles maybe 10 requests/week, not a public service). A PDF render (`astro dev` + Chromium, both spawned fresh per request, never kept warm) peaks around 450–550 MB. If you see OOM kills or the disk filling up (`bismuth-blog`'s `node_modules` + Chromium + the Astro Content Layer cache add up), bump `memory.dedicated` / `disk.size` in `gallium-homelab/terraform/bromine.tf` and re-apply — don't over-provision preemptively for a workload this light.

**Network**: LAN-only, served over HTTPS at `https://bromine.flefevre.fr`. The extension runs in a secure context (WebExtension page), so Firefox force-upgrades any plain-HTTP `fetch()` to HTTPS — the backend *must* be reachable over TLS even on the LAN. Termination is handled by **Caddy** on the same LXC (`:443` → `reverse_proxy 127.0.0.1:3000`); the app itself stays plain HTTP bound to loopback (`BIND_HOST=127.0.0.1`) and never sees the TLS key. The certificate is a real Let's Encrypt cert for `bromine.flefevre.fr`, issued via DNS-01 on the AdGuard LXC and pushed to Caddy over SSH — see `gallium-homelab/docs/bromine.md` for the full TLS + renewal picture. No internet exposure; a Cloudflare Tunnel remains an option later if off-network access is ever needed.

## API

| Route | Auth | Description |
|---|---|---|
| `GET /health` | none | Healthcheck |
| `POST /cv/generate` | Bearer (Google id_token) | Starts (or restarts) a draft generation asynchronously — returns `202` with a `sessionId` immediately |
| `GET /cv/sessions/:id/progress` | Bearer | Polls the phase of an in-flight generation (`calling_llm`, `writing_files`, `rendering_pdf`, `ready`, `error`); once `ready`, includes the copyable sections + PDF URL |
| `POST /cv/sessions/:id/commit` | Bearer | Commits the draft into carbon-notes (no-op in dev) |
| `DELETE /cv/sessions/:id` | Bearer | Discards a draft without committing |
| `GET /cv/sessions/:id/pdf` | Bearer | Downloads the rendered PDF — serves the live draft if `:id` is a sessionId, re-renders (and caches) from `carbon-notes` if it's a committed slug |
| `GET /cv/sessions/:slug` | Bearer | Reloads a previously-committed session (name + copyable sections + PDF URL) for the "historique" dropdown |
| `GET /cv/sessions` | Bearer | Lists previously committed sessions (from `carbon-notes/cv/tailored/`) |

All protected routes expect `Authorization: Bearer <google-id-token>`, verified per-request against Google's JWKS (no backend-issued JWT — id_tokens are short-lived and the extension re-authenticates silently).

## What's not implemented yet

- `POST /form-fill` and `GET /career-channel` (migrating bromine-cv-extension's existing form-filling feature to this backend) — planned, not yet built.
- Daily report email (`scripts/daily-report.sh`, cron-triggered by the Ansible role) — the cron entry exists on the VM; the script itself still needs writing once there's real log volume to report on.
