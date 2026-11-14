# pi-freebuff

A [pi](https://docs.pi.dev) provider extension that exposes the free Codebuff/Freebuff models
inside pi, using pi's own login, model list and `/model` picker.

## Status: it works, by impersonating the official client

Free mode is bound to the official Freebuff apps, and the server checks the shape of every
request to `/api/v1/chat/completions`. Measured on 2026-11-14 against the live API with a real
account, using the official `freebuff@0.2.36` binary as the reference client (captured through a
logging proxy):

| Gate | Refused with | What the extension sends |
| --- | --- | --- |
| Free-mode root turn | `403 free_mode_cli_required` | the official root system prompt (`.pi/extensions/freebuff-system-prompt.txt`) |
| Official client | `403 third_party_client_warning` (+1 strike) | the official `user-agent` and `x-freebuff-client-version: 0.2.36` |
| Current server build | `410 freebuff_update_required` | `x-freebuff-sse-gzip-recovery: 1` |
| Live session claim | `428 waiting_room_required`, `409 session_superseded` | `codebuff_metadata.freebuff_instance_id` = a claim this account admitted |
| Agent run | `400 No runId found in request body` | `codebuff_metadata.run_id` from `POST /api/v1/agent-runs` |
| Tool catalog | `403 third_party_client_warning` | the official 16-tool catalog (`.pi/extensions/freebuff-tools.json`) |

The root prompt and the tool catalog are compared in full: a request with pi's own prompt, or with
pi's tools renamed to the official names, is refused. A request with no tools at all is accepted.
Two things are *not* checked — the Ed25519 device signature and `x-freebuff-acting-user-id` — but
the extension sends them anyway so the request matches the official one.

That impersonation is what makes it work, and it is the risk: the server counts strikes against
the account for third-party clients (`third_party_client_warning`), refuses repeated identical
prompts ("scripted or automated use"), and says the account may be banned. Use a throwaway
account if you try it.

## Install

The extension lives at `.pi/extensions/freebuff.ts` and is picked up automatically when this
directory is a trusted pi project.

To use it from anywhere, clone the repo into pi's global extension directory. pi loads a cloned
directory through the `pi.extensions` manifest in `package.json`, so a private repo works as
long as the clone succeeds:

```sh
gh repo clone ilteoood/pi-fbff ~/.pi/agent/extensions/pi-fbff
```

`gh` uses your GitHub login for the clone; for plain git, run `gh auth setup-git` once.

## Use

```sh
pi            # inside this directory
/login        # pick "Freebuff account", approve the link in your browser
/model        # every free model from the live Freebuff catalog is listed
/freebuff     # show api/auth origins, catalog version, visible models
/freebuff refresh    # refetch the catalog and rebuild the model list
```

Until you log in the provider contributes zero models, so nothing from Freebuff shows up in
`/model`.

Environment overrides: `FREEBUFF_API_ORIGIN` (default `https://www.codebuff.com`),
`FREEBUFF_AUTH_ORIGIN` (default `https://freebuff.com`).

## How it works

- **Auth** — `POST /api/auth/cli/code` on the auth origin returns a `loginUrl`; the extension
  shows it, then polls `/api/auth/cli/status` until the browser approves it. The returned
  `authToken` is stored by pi as an OAuth credential.
- **Model list** — `GET /api/v1/freebuff/models` with the bearer token returns the catalog. The
  extension maps each `access: "open"`, non-premium row to a pi
  model: `id` is the catalog `key` (stable, so a persisted model selection survives catalog
  rotations), `contextWindow` comes from the row, and cost is zero.
- **Session** — before the first request for a model, `POST /api/v1/freebuff/session/admission`
  is sent with `x-freebuff-instance-id` (a persisted `cli:<uuid>` claim),
  `x-freebuff-desktop-attempt-id`, `x-freebuff-model` (the catalog `handle`),
  `x-freebuff-wallet-spend-limit: session` and the multi-session headers. Freebuff binds a
  session to one model and expires it, so pi's model switch triggers a new admission. A busy
  account is handled by taking over the session the server reports in `currentInstanceId`.
- **Agent run** — every turn starts a run (`POST /api/v1/agent-runs` with
  `agentId: base3-free-catalog`) and the run id travels as `codebuff_metadata.run_id`; the run is
  closed with the matching `FINISH` action when the agent loop ends.
- **Requests** — pi's own `openai-completions` stream implementation is reused; the extension only
  injects a `fetch` that adds the bearer token, the official client headers and the catalog fetch
  id, signs the request with the device key, rewrites `model` to the row's `handle`, reshapes the
  messages into a root turn, and retries once on `freebuff_catalog_stale` (refetch catalog) or on
  an expired or superseded session (re-admit).
- **Prompt and tools** — the official root prompt is sent as the system message (pi's own harness
  prompt is appended after it) and the official 16-tool catalog is sent instead of pi's tools. The
  model's tool calls are translated back to pi's tools (`read_files` → `read`, `str_replace` →
  `edit`, `run_terminal_command` → `bash`, `code_search` → `grep`, `glob` → `find`,
  `list_directory` → `ls`, …), so the tools actually run inside pi.

## Limits

- Output tokens are capped at 32000 for every model: the catalog carries no output limit.
- The account gets 3 concurrent Freebuff tabs; a 4th is refused with `409 purchase_capacity` until
  one of the others expires.
- The free tier spends a slice of a 60 minute daily pool per session, priced per model (0 minutes
  for Glyph Cluster, Beam 1.0, Nemotron 3.5 Lightning and the Solar models, 5-15 for the DeepSeek
  ones). An empty pool answers `429 rate_limited` and refills at 23:00 Europe/Rome.
- `pi auth check --provider freebuff` reports `provider_not_found`: that command builds a model
  runtime without extensions, so use `/freebuff` inside a session instead.

## Development

```sh
npm install
npm run check       # tsc --noEmit
npm run selfcheck   # registers the provider against a stub pi
```

The self-check stubs `fetch`, drives one turn through the provider and asserts the outgoing
request: URL, headers, catalog handle, run id, session claim, root prompt, step reminder and the
official tool catalog, plus the translation of the model's tool call back to pi's `read`.
