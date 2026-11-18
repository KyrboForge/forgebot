# GitHub App setup

ForgeBot uses a GitHub App and short-lived installation tokens. Authentication and repository clients live in `@forgebot/github`; Core remains provider-agnostic. Worker startup validates the App configuration before loading plugins. No token endpoint is exposed.

## Create the App

1. Open GitHub **Settings → Developer settings → GitHub Apps → New GitHub App** (or the organization's GitHub App settings).
2. Choose a name and homepage URL for your ForgeBot instance. User authorization callbacks are not needed.
3. Disable **Active** under Webhook. A placeholder URL can remain if the form requires one. This authentication layer does not process webhooks.
4. Under **Repository permissions**, grant only:

   | Permission | Access |
   | --- | --- |
   | Contents | Read-only |
   | Pull requests | Read & write |
   | Metadata | Read-only (GitHub default) |

   Leave organization/account permissions unset. No event subscriptions are needed yet.
5. Create the App, note its numeric **App ID**, and generate a private key. Keep the downloaded PEM outside the repository.
6. Under **Install App**, install into the intended account. Select **Only select repositories** and choose the repositories ForgeBot may access. Avoid granting all repositories.
7. Open **Settings → Applications → Installed GitHub Apps → Configure** for the installation. The final numeric segment of `https://github.com/settings/installations/123456` (or the organization installation URL) is the **Installation ID**. It differs from the App ID. An App can have multiple installations; clients and tokens are isolated by Installation ID.

## Environment

Bun loads `.env` automatically. Copy `.env.example` to `.env` and replace the placeholders. `.env` files and `*.pem` are gitignored. Configure exactly one private key source; remove the other variable entirely.

| Variable | Required | Meaning |
| --- | --- | --- |
| `GITHUB_APP_ID` | Yes | Positive numeric App ID |
| `GITHUB_APP_PRIVATE_KEY` | One key source | PEM text, with actual newlines or literal `\n` escaped newlines |
| `GITHUB_APP_PRIVATE_KEY_PATH` | One key source | Path to a readable PEM file; relative paths use the process working directory |
| `GITHUB_APP_INSTALLATION_ID` | For smoke test | Positive numeric default Installation ID; optional for worker startup, whose callers choose an installation explicitly |
| `FORGEBOT_GITHUB_SMOKE` | Opt-in | `1` enables the live read-only smoke test |
| `FORGEBOT_SMOKE_REPOSITORY` | For smoke test | A selected repository in `owner/repo` form |

For local development, prefer a file with owner-only read permissions:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/outside/repo/forgebot.pem
GITHUB_APP_INSTALLATION_ID=789012
FORGEBOT_SMOKE_REPOSITORY=your-owner/your-repo
```

For inline configuration, omit `GITHUB_APP_PRIVATE_KEY_PATH` and set `GITHUB_APP_PRIVATE_KEY` to the full PEM (for example, a single quoted value containing literal `\n` between lines). Never commit PEM text or real credentials to examples. Configuration loading parses the private key and requires RSA; malformed keys and other key types are rejected with errors naming only the key source variable.

## Verify

Offline checks (no GitHub calls; smoke test skipped by default):

```sh
bun install
bun run check
```

With a configured `.env` and selected repository, explicitly opt into live verification:

```sh
bun run test:smoke
# Or provide the repository for this run:
FORGEBOT_SMOKE_REPOSITORY=your-owner/your-repo bun run test:smoke
```

The script sets `FORGEBOT_GITHUB_SMOKE=1`. It creates a short-lived installation token, verifies repository selection and reads minimal metadata from the installation's accessible repositories, then checks the installation's permissions using an App JWT. Repository verification and metadata lookup paginate `GET /installation/repositories` with 100 repositories per page, match `owner/repo` case-insensitively, and stop at the first match. An absent repository returns `REPOSITORY_ACCESS_DENIED`, including public repositories outside the installation's selection. No separate `GET /repos/{owner}/{repo}` request is made. The test does not modify repository content or create comments/reviews. Permission checks require only `metadata:read`, `contents:read`, and `pull_requests:write`; stronger grants satisfy the check but are unnecessary.

Programmatic usage:

```ts
import { GitHubAppAuth, GitHubClientFactory, loadGitHubAppConfig } from "@forgebot/github";

const config = await loadGitHubAppConfig(process.env);
const auth = new GitHubAppAuth({ config, logger }); // Existing ForgeBot Logger
const factory = new GitHubClientFactory({ auth, logger });
const client = factory.forInstallation(installationId);
await client.verifyRepositoryAccess("owner", "repo");
const repository = await client.getRepository("owner", "repo");
const permissions = await client.checkReviewPermissions();
```

Tokens are cached per installation and refreshed below five minutes remaining. Concurrent requests share one token request per installation. A repository API 401 invalidates the cached token only if it matches the token sent by the failed request. A newer cached token or in-flight renewal survives a delayed 401. The error is returned; the next call reuses a valid token or obtains a fresh one. There is no automatic replay of failed API requests.

Set `FORGEBOT_SMOKE_REVIEW_CONFIRM` to the exact pull request target before running the publication smoke test, for example `owner/repo#42`. See the [GitHub PR review publisher guide](./REVIEW_PUBLISHER.md).

## Deployment and security

Inject App credentials through your deployment's secret manager or environment. Alternatively, mount a private key as a read-only secret file and set `GITHUB_APP_PRIVATE_KEY_PATH`. Restrict file and process access; do not bake PEM files into images. Keep the machine clock synchronized for JWT signing.

To rotate a key, generate another key in the GitHub App settings, update the secret/file, restart worker processes to replace the signer and in-memory tokens, verify with the smoke test, then revoke the previous key in GitHub. For a rollback before revocation, restore the previous secret and restart. Revoke compromised keys immediately; uninstall or suspend an installation to remove its access.

Errors have stable `GitHubAppError.code` values: `INVALID_CONFIG`, `INVALID_PRIVATE_KEY`, `BAD_CREDENTIALS`, `INSTALLATION_NOT_FOUND_OR_REVOKED`, `REPOSITORY_ACCESS_DENIED`, `INSUFFICIENT_PERMISSIONS`, `RATE_LIMITED`, and `GITHUB_API_ERROR`. A repository 404 can conceal missing access; confirm that the installation includes the repository. Check App ID/key pairing for app 401s, suspension/revocation for installation 403/404s, and GitHub rate limits for `RATE_LIMITED`.

App authentication and repository access errors discard upstream messages, headers and bodies. Their causes retain only HTTP status. Pull request errors can also retain a sanitized validation or conflict message. Logs contain action names, Installation IDs and expiry timestamps, never private keys, JWTs, tokens or Authorization headers. Do not add request/header dumps or log configuration objects. Installation tokens remain in memory and are never exposed over HTTP.
