# GitHub pull request review publisher

Use `GitHubReviewPublisher` from `@forgebot/github` to publish one submitted review against a specific pull request head. The installation must include the target repository. Follow the [GitHub App setup guide](./GITHUB_APP.md) to configure the app.

| GitHub App repository permission | Access |
| --- | --- |
| Pull requests | Read & write |
| Contents | Read |
| Metadata | Read |

## Publish a review

```ts
import {
	GitHubAppAuth,
	GitHubClientFactory,
	GitHubReviewPublisher,
	loadGitHubAppConfig,
	type PublishReviewInput,
} from "@forgebot/github";

const config = await loadGitHubAppConfig(process.env);
const auth = new GitHubAppAuth({ config, logger }); // Existing ForgeBot Logger
const clientFactory = new GitHubClientFactory({ auth, logger });
const publisher = new GitHubReviewPublisher({ clientFactory, logger });

const summary = {
	installationId: 123456,
	owner: "example",
	repo: "demo",
	pullNumber: 42,
	commitSha: "0123456789abcdef0123456789abcdef01234567",
	baseSha: "89abcdef0123456789abcdef0123456789abcdef",
	verdict: "COMMENT",
	body: "The implementation matches the migration plan.",
	comments: [],
} satisfies PublishReviewInput;

const published = await publisher.publishReview(summary);
// published contains reviewId, url, commitSha and verdict from GitHub.
```

Replace the example IDs and SHAs with the installation, pull request number, and head and base commits you actually reviewed. Both `commitSha` and `baseSha` are required and must contain exactly 40 lowercase hexadecimal characters. The publisher checks that the PR is open and that its head and base SHAs match the reviewed ones before loading the diff. It reads the PR again after fetching the files and requires the head SHA, base SHA, and base branch to match the first read. The base affects diff anchors, including those on the left side. The POST carries the exact reviewed SHA.

| Verdict | GitHub review state | Summary |
| --- | --- | --- |
| `APPROVE` | `APPROVED` | May be empty |
| `REQUEST_CHANGES` | `CHANGES_REQUESTED` | Must contain non-whitespace text |
| `COMMENT` | `COMMENTED` | Must contain non-whitespace text even with inline comments |

The summary and each comment body can contain up to 65,536 characters. Each inline comment needs a non-blank body, and a review can include up to 50 inline comments. Markdown and whitespace in valid bodies are sent verbatim.

### Inline and multiline examples

```ts
const withInline: PublishReviewInput = {
	...summary,
	comments: [{
		path: "src/cache.ts",
		line: 38,
		side: "RIGHT",
		body: "Could this branch preserve the existing TTL?",
	}],
};

const changesRequested: PublishReviewInput = {
	...summary,
	verdict: "REQUEST_CHANGES",
	body: "Please preserve the TTL before merging.",
	comments: [{
		path: "src/cache.ts",
		startLine: 35,
		startSide: "RIGHT",
		line: 38,
		side: "RIGHT",
		body: "Keep the initial expiry timestamp across this update.",
	}],
};
```

- Use the changed file's exact `filename` from GitHub. For renames, use the new filename on either side. For deletions, a patch can support comments on `LEFT`. A missing patch, such as for a binary or oversized file, prevents inline comments.
- Use the actual file line number and specify a side. `RIGHT` uses new-file numbering for additions and context. `LEFT` uses old-file numbering for removals and context. GitHub receives `line` and `side` without a legacy `position` offset.
- For a range, supply both `startLine` and `startSide`. Each endpoint uses its own side and file line number. Both endpoints must be in the same hunk, with the start on a diff row strictly before the end. The sides may differ, such as a `LEFT` start on a removed row and a `RIGHT` end on an added row. A location outside the returned patch is rejected at its original comment index.

## Errors

`GitHubReviewError.code` identifies the failure. An optional `cause` contains the HTTP status and may include a field name from a fixed allowlist for a 409 or 422 response. Error messages and publication logs use ForgeBot error codes.

| Code | Meaning |
| --- | --- |
| `REPOSITORY_ACCESS_DENIED` | The installation lacks access to the target repository. |
| `INSUFFICIENT_PERMISSIONS` | The permission check failed. `missing` lists the missing grants, or is empty if GitHub denied the permission lookup. |
| `PULL_REQUEST_NOT_FOUND` | GitHub returned 404 when fetching the pull request. |
| `PULL_REQUEST_CLOSED` | The pull request is no longer open. |
| `STALE_REVIEW_COMMIT` | The supplied head SHA differs from the PR head, the supplied base SHA differs from the PR base, or the base SHA or branch changed while files were being fetched. Review the updated diff before submitting. |
| `INVALID_REVIEW_PAYLOAD` | Local validation or GitHub rejected the input. `fields` lists identifiable field names and can be empty for a generic GitHub response. |
| `INVALID_INLINE_COMMENT_LOCATION` | An inline comment location failed diff validation. `commentIndex` is zero-based and may be absent when GitHub does not identify a specific comment. |
| `REVIEW_VERDICT_REJECTED` | GitHub rejected the verdict, for example when an app tries to approve or request changes on its own PR. |
| `RATE_LIMITED` | GitHub returned a rate-limit response. |
| `PUBLICATION_OUTCOME_UNKNOWN` | The POST lost its HTTP response, returned 5xx, or reported a different commit or verdict. GitHub may already have created the review. When available, the numeric `reviewId` identifies it. |
| `DUPLICATE_SUBMISSION` | An identical submission is in flight or unresolved, or the duplicate map is full with no successful entry to evict. |
| `GITHUB_API_ERROR` | Another GitHub or authentication failure, or an unexpected review response. |

### Duplicate submissions and uncertain outcomes

The publisher never automatically retries or changes a verdict. It makes one review POST containing the summary and all inline comments. Definite failures clear the duplicate key, so a caller can try again when appropriate. Identical in-flight or unresolved submissions fail with `DUPLICATE_SUBMISSION`. Identical successful submissions return the cached result without contacting GitHub. Identity includes the installation, case-insensitive repository, PR number, commit, verdict, summary, and ordered inline comments.

On `PUBLICATION_OUTCOME_UNKNOWN`, inspect the review by `reviewId` if available, or list the PR's reviews with authenticated `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`. Compare the installation bot, commit, review state, and content before deciding what to do. Never automatically retry an uncertain POST. An accepted POST with an unexpected response also retains its duplicate key and requires reconciliation.

Publisher instances in each process share an in-memory duplicate map capped at 1,000 entries. At capacity, a new submission evicts the oldest cached success. In-flight and unresolved entries are protected from eviction. If all entries are protected, new submissions fail with `DUPLICATE_SUBMISSION` until a slot becomes available. An evicted success can be submitted again. Workers and restarts have separate state. Persistent idempotency is tracked in [issue #46](https://github.com/Obryko/forgebot/issues/46).

## Tests

Run the offline mocked GitHub tests with `bun test packages/github`. The live smoke test is skipped by default.

For a live run, configure an App ID, one private key source, and `GITHUB_APP_INSTALLATION_ID` as described in the [GitHub App setup guide](./GITHUB_APP.md). Use a dedicated test repository and open pull request. Each enabled run publishes a visible, labelled `COMMENT` review with no inline comments, then reads the review to verify its App bot author. The script uses an installation token.

| Variable | Value |
| --- | --- |
| `FORGEBOT_GITHUB_REVIEW_SMOKE` | `1`, set by `bun run test:smoke:review` |
| `FORGEBOT_SMOKE_REVIEW_REPOSITORY` | Explicit target `owner/repo` |
| `FORGEBOT_SMOKE_REVIEW_PULL_NUMBER` | Positive pull request number |
| `FORGEBOT_SMOKE_REVIEW_CONFIRM` | The exact target as `owner/repo#pullNumber` |
| `FORGEBOT_SMOKE_APP_SLUG` | Optional expected App slug, checked as `<slug>[bot]` |

```sh
FORGEBOT_SMOKE_REVIEW_REPOSITORY=example/forgebot-test \
FORGEBOT_SMOKE_REVIEW_PULL_NUMBER=42 \
FORGEBOT_SMOKE_REVIEW_CONFIRM='example/forgebot-test#42' \
bun run test:smoke:review
```
