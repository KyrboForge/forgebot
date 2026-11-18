# ChatGPT Plus integration feasibility spike

Issue #40 (parent epic #36). Verification date of the documentation review: **2026-11-18**.

**Verdict: `PARTIALLY_FEASIBLE`** — the ForgeBot side is built and tested; nothing has been run inside a real ChatGPT Plus account yet (see [Phase 4](#4-real-chatgpt-test-results)).

## 1. Official documentation reviewed

| Source | Fetched directly? |
| --- | --- |
| https://developers.openai.com/plugins/quickstart | yes |
| https://developers.openai.com/plugins/build/plugins | yes |
| https://developers.openai.com/plugins/deploy/connect-chatgpt | yes |
| https://developers.openai.com/api/docs/mcp | yes |
| https://developers.openai.com/api/docs/guides/custom-mcp-server | yes |
| https://learn.chatgpt.com/docs/plugins | yes |
| https://learn.chatgpt.com/docs/extend/mcp | yes |
| https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites | **no (HTTP 403)** — search snippets and third-party summaries only |
| https://help.openai.com/en/articles/20001256-plugins-in-chatgpt | **no (HTTP 403)** — same |
| https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites | **no (HTTP 403)** — same |
| https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt | **no (HTTP 403)** — same |

Facts that come only from the four help-center articles are second-hand and must be re-checked in the browser. ChatGPT Sites is a public beta, so these pages can change.

## 2. Tested plan and platform

**None.** No ChatGPT Plus account was used. Every Phase 4 test is `NOT TESTED`.

## 3. Capabilities: documented vs. tested

The eight questions from the spike. "Documented" means stated in the sources above. "Tested" means observed in a real ChatGPT Plus session (none).

| # | Question | Documented | Tested |
| --- | --- | --- | --- |
| 1 | Plus users can use Sites plugins | **Unclear.** Sites is in public beta; plan eligibility must be confirmed in the account. | not tested |
| 2 | MCP read tools | Yes — a Site can host an MCP server whose tools ChatGPT calls. | not tested |
| 3 | Write tools in normal conversation | Yes in general, with manual confirmation driven by MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). OpenAI warns annotations are hints only. Availability on Plus is **unconfirmed**. | not tested |
| 4 | External HTTPS backend | Site code is ordinary server code and can call out; Site secrets are environment variables in Site settings. Egress limits are **unconfirmed**. | not tested |
| 5 | Authentication | Sites handles sign-in between ChatGPT and the MCP server. Plugin auth types: none, OAuth (CIMD/DCR), mixed, API key. | not tested |
| 6 | Write confirmation | ChatGPT asks for manual confirmation on non-read-only tools. Exact UX **unconfirmed**. | not tested |
| 7 | Desktop / web / mobile parity | **Not documented** in the pages we could read. | not tested |
| 8 | Updates need republishing | Yes — republish the Site after changing tools. | not tested |

## 4. Real ChatGPT test results

| Test | Result |
| --- | --- |
| A — tool discovery (`get_forgebot_status`, `create_test_action` listed) | **NOT TESTED** |
| B — read (`get_forgebot_status` returns the expected JSON) | **NOT TESTED** |
| C — authorized write (confirmation prompt, matching request ID, no duplicate side effects) | **NOT TESTED** |
| D — desktop / web / iOS | **NOT TESTED** / **NOT TESTED** / **NOT TESTED** |

Reason: needs the owner's ChatGPT account and interactive confirmation. Manual steps are in [section 6](#6-install-and-manual-verification-steps).

### What *was* tested (automated, no ChatGPT involved)

The plugin's MCP endpoint and the ForgeBot API were run together over real HTTP, and the same cases are covered by `bun test` (22 plugin tests, plus route, service and integration tests in the worker).

| Phase 5 case | Observed |
| --- | --- |
| Read status | 200, exact expected JSON |
| Write | new → 201 `duplicate:false`; same `requestId` + same message → 200 `duplicate:true`, still one record; same `requestId` + different message → 409 `request_id_conflict` |
| Missing / wrong auth on API | 401 |
| Read token used for the write route | 403 |
| Tokens unset on the server | 503 `not_configured` (fails closed) |
| Invalid payload (bad ID, empty/oversized message, non-JSON, body > 4 KB) | 400 / JSON-RPC -32602 |
| Extra argument such as `repository` | rejected locally, **no backend call** |
| Arbitrary GitHub access (`/api/chatgpt/repos/...`, `/reviews`) | 404; the route is never given the GitHub client factory (integration test uses a throwing proxy and still gets 201) |
| Backend down / timeout / malformed response | `isError` tool result with a sanitized message, no leaked detail |
| Inbound plugin token (optional) missing | 401 |

## 5. Authentication and design

```
ChatGPT Plus → Site-hosted MCP plugin (apps/chatgpt-plugin) → ForgeBot API (/api/chatgpt/*) → (nothing else)
```

- **ChatGPT → plugin:** Sites sign-in. Optionally also `FORGEBOT_PLUGIN_TOKEN` (Bearer, constant-time compared) on `POST /mcp`. CORS/Origin are not used as authentication.
- **Plugin → API:** server-side Bearer tokens only. Separate **read** token (`GET /status`) and **write** token (`POST /test-actions`). The write token also satisfies reads; the read token on a write is 403. Tokens live in server environment / Site secrets, never in client code, tool output or the repo.
- **Write safety:** strict schema (`requestId` `^[A-Za-z0-9_-]{8,64}$`, `message` 1–200 chars, no extra keys), idempotent by `requestId`, result is an in-memory simulated record. It **never touches GitHub** and the API route does not receive the GitHub client factory.
- **No generic proxy:** the plugin can call exactly two fixed backend paths.
- **No LLM APIs** are called anywhere.

### Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `FORGEBOT_CHATGPT_READ_TOKEN` | worker + plugin | read token (unset → routes return 503) |
| `FORGEBOT_CHATGPT_WRITE_TOKEN` | worker + plugin | write token (unset → write route 503) |
| `FORGEBOT_API_URL` | plugin | worker base URL; must be `https://` (or `http://localhost` / `127.0.0.1`) |
| `FORGEBOT_PLUGIN_TOKEN` | plugin, optional | extra Bearer check on `POST /mcp` |
| `PORT` | plugin, optional | default 3000 |

Generate tokens with e.g. `openssl rand -hex 32`; use different values for read and write.

## 6. Install and manual verification steps

Run these yourself; the spike could not.

**Prepare the backend**

1. Deploy the worker over HTTPS (or tunnel it, e.g. Cloudflare Tunnel) with `FORGEBOT_CHATGPT_READ_TOKEN` and `FORGEBOT_CHATGPT_WRITE_TOKEN` set.
2. `curl -i https://<worker>/api/chatgpt/status` → expect 401. With `-H "Authorization: Bearer <read token>"` → expect the status JSON.

**Create and publish the Site plugin** (UI wording may differ; Sites is in beta)

3. In ChatGPT (or Codex), ask it to create a Site that hosts an MCP server, giving it `apps/chatgpt-plugin/src/mcp-app.ts` and `src/index.ts` as the source. The server is `POST /mcp`.
4. In the Site settings, add secrets `FORGEBOT_API_URL`, `FORGEBOT_CHATGPT_READ_TOKEN`, `FORGEBOT_CHATGPT_WRITE_TOKEN` (and optionally `FORGEBOT_PLUGIN_TOKEN`).
5. Publish the Site, then install the plugin from the card that appears. Record the plan shown for your account.
6. After any later tool change, **republish**.

**Tests**

7. **A:** new chat, enable the plugin, ask "What ForgeBot tools do you have?" → both tools listed.
8. **B:** "Call get_forgebot_status." → `{"service":"ForgeBot","status":"ok","capabilities":["github_app","review_publisher"]}`.
9. **C:** "Call create_test_action with requestId `spike-0001` and message `hello`." → expect a confirmation prompt; approve; expect `status: recorded`, `requestId: spike-0001`, `duplicate: false`. Repeat the identical request → `duplicate: true`. Then decline the confirmation for a new ID and check that ChatGPT reports no result.
10. **D:** repeat A–C on ChatGPT desktop, web and iOS; record pass / fail / tool not offered per surface.
11. If a step is blocked (plan not eligible, write tools not offered, secrets unsupported), stop and record the blocker. Do not work around it with PATs, token scraping or hidden commands.

## 7. Known blockers and uncertainties

- Plus eligibility for Sites plugins and for write tools is unconfirmed.
- Four help-center articles were not readable (403); some facts are second-hand.
- How a Site-hosted MCP server is authored/deployed from this repo is not documented as a "deploy a repo" flow — the Site is created by prompting ChatGPT/Codex. `apps/chatgpt-plugin` is source to hand over; it may need adapting to the Sites runtime (it is a Bun/Hono app).
- Whether a Site can call an external HTTPS backend, and with which secret mechanism, is unconfirmed.
- Confirmation UX, mobile parity and republish friction are untested.
- The simulated record store is in-memory: it resets on worker restart and is per-process.

## 8. Security considerations

- Annotations are hints, not enforcement: the server authenticates and validates every write regardless of what ChatGPT shows.
- Separate read/write secrets limit blast radius; rotate by changing both the worker and Site secrets.
- Tool output and errors never contain tokens, URLs from env, or backend bodies.
- Before issue #47 adds real GitHub writes, add per-user authorization, an allow-list of repositories/installations, durable idempotency, audit logging and rate limits. The current single shared write token is acceptable only for the harmless sandbox write.
- Prompt injection: tool results flow back to ChatGPT; future tools returning PR content must be treated as untrusted.

## 9. Next implementation steps

1. Owner runs section 6 and fills in section 4.
2. If steps 3–5 succeed, adapt `apps/chatgpt-plugin` to whatever Sites expects (entrypoint, runtime, secret names).
3. Replace the shared tokens with per-user OAuth (Sites sign-in identity → ForgeBot user) before any real write.
4. Persist idempotency records (issue #47 scope decision).
5. Design the real read/publish tools (issues #43–#48 are out of scope here).

## 10. Verdict and recommendation for issue #47

**`PARTIALLY_FEASIBLE`.** The backend contract, auth, idempotency, error handling and plugin protocol layer are implemented and verified; the platform side is documented but unverified.

**Recommendation: conditional GO.** Do a one-hour manual pass of Tests A–C first. Start #47 only if C shows (a) Plus can install the plugin, (b) a write tool is offered, and (c) the confirmation prompt appears. If any of those fails, treat as **NO-GO** and fall back to the smallest supported alternative: read-only plugin tools, with the review text copied by the user into ForgeBot's existing publisher, or a custom MCP connector if Plus allows it.
