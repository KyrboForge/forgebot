# GitHub pull request diff reader

`GitHubReviewInputReader` implements `IGitHubReviewInputReader.read(input): Promise<ReviewInput>`. It uses the existing installation client factory from `@forgebot/github`. The installation needs access to the repository and read permission for pull requests. See the [GitHub App setup guide](./GITHUB_APP.md).

## Read a pull request

```ts
import { GitHubReviewInputReader } from "@forgebot/github";

const reader = new GitHubReviewInputReader({ clientFactory });
const review = await reader.read({
  installationId: 123456,
  owner: "example",
  repo: "demo",
  pullNumber: 42,
  limits: { maxFiles: 50 },
});
```

```json
{
  "repository": {
    "provider": "github",
    "namespace": "example",
    "name": "demo",
    "providerRepositoryId": "987654"
  },
  "change": { "id": "42", "url": "https://github.com/example/demo/pull/42" },
  "base": { "id": "0123456789abcdef0123456789abcdef01234567", "ref": "main" },
  "head": { "id": "89abcdef0123456789abcdef0123456789abcdef", "ref": "feature" },
  "files": [
    {
      "path": "src/example.ts",
      "status": "modified",
      "patch": { "status": "available", "text": "@@ -1 +1 @@\n-old\n+new" }
    }
  ],
  "fileListing": { "status": "complete" }
}
```

The reader verifies installation membership using the existing repository lookup and includes the repository ID when available. It reads PR metadata before fetching files and re-reads metadata afterward. A change to either SHA rejects the read with `STALE_REVIEW_SNAPSHOT`. Revision IDs preserve the exact SHAs GitHub returned. Refs are display names from the first read. These checks detect changes visible at the two reads. GitHub's file endpoint accepts a PR number and supplies no revision token for pinning the intermediate requests.

## Limits and completeness

Numeric limits must be positive safe integers. Oversized requests are clamped to these caps. The package exports `DEFAULT_GITHUB_REVIEW_INPUT_LIMITS`.

| Limit | Default | Hard cap |
| --- | ---: | ---: |
| `maxFiles` | 300 | 3,000 |
| `maxPatchBytes` per patch | 100,000 | 100,000 |
| `maxTotalPatchBytes` for retained patches | 1,000,000 | 1,000,000 |

The reader requests consecutive file pages of 100 up to `ceil(maxFiles / 100)`, with a maximum of 30 requests. It uses a next-page link as a hint and constructs each request from the original repository and PR identifiers. It stops before fetching another page when either the file or total patch budget runs out. The existing installation membership lookup uses its own pagination.

- `complete` means the count equals GitHub's `changed_files` and there are no skipped rows or indicated next page.
- `partial` with `provider_limit` means the reader reached GitHub's 3,000-file ceiling and GitHub reported more files.
- Other count mismatches and early stops use `partial` with `retrieval_incomplete`. This reason covers both local budget stops and incomplete upstream listings. Both partial reasons preserve `changed_files` as `reportedTotal`.
- `unknown` means GitHub supplied no usable total.

## Files and patches

The reader preserves GitHub's order and maps `added`, `modified`, `removed`, `renamed`, and `copied` to their matching Core statuses. An unrecognized status maps to `unknown` with the original `providerStatus`. Renames and copies without a valid previous path also map to `unknown` with `providerStatus`. For an unknown status, a valid previous path is preserved when supplied.

| Patch status | Meaning |
| --- | --- |
| `available` | Exact patch text from GitHub, including hunk headers, fits the UTF-8 byte limits. An explicit empty string is accepted for a rename, copy or unchanged file when additions, deletions and changes are all zero. |
| `unavailable` | GitHub omitted the patch or returned an empty string without evidence that it was empty. |
| `binary` | The patch consists of an explicit Git `Binary files … and … differ` marker. The REST response has no dedicated binary flag. An omitted patch remains `unavailable`. |
| `truncated` | The patch exceeded the per-file or remaining total byte limit. The reader omits `partialText`. An oversized individual patch consumes no retained bytes. If a patch crosses the total budget, the reader includes that file with a truncated patch and stops there. |
| `not_requested` | The caller set `limits.includePatches` to `false`. GitHub still returns any patches bundled into its response. |

## Failures

The reader throws `GitHubReviewError`. It returns no files if a request fails and performs no automatic retry.

| Code | Meaning |
| --- | --- |
| `INVALID_REVIEW_INPUT` | Invalid installation ID, repository identifiers, PR number or limits. No GitHub request was made. |
| `REPOSITORY_ACCESS_DENIED` | The repository is outside the installation or GitHub returned a non-rate-limit 401 or 403. |
| `PULL_REQUEST_NOT_FOUND` | A PR endpoint returned 404. |
| `RATE_LIMITED` | GitHub rate-limited the installation. When supplied, `rateLimit.retryAfter` is a delay in seconds and `rateLimit.reset` is a Unix timestamp in seconds. |
| `STALE_REVIEW_SNAPSHOT` | The base or head SHA changed during retrieval. |
| `MALFORMED_RESPONSE` | Required PR metadata, file-page shape or file entries were unusable. |
| `INCOMPLETE_RETRIEVAL` | GitHub repeated a file path, making the retrieved listing ambiguous. |
| `GITHUB_API_ERROR` | Another GitHub API or transport failure. |

## Related contracts

The legacy `RepositoryReader` in `@forgebot/repository` also exposes change metadata and changed files, alongside a whole diff and a ref-based file read. The GitHub reader returns one bounded [Core review input](./REVIEW_INPUT.md) with immutable revision IDs and explicit evidence availability. Issue [#43](https://github.com/Obryko/forgebot/issues/43) will build on those IDs to read targeted `SourceSlice` ranges at the exact base or head SHA with its own read and byte limits.
