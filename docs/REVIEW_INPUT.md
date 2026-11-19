# Review input contracts

Use `ReviewInput` from `@forgebot/core` to describe a change, its base and head revisions, and the files returned by the provider. Use `SourceSlice` to represent a requested range of lines from a file at a specific revision. These are TypeScript contracts only. They perform no network calls.

## Identity and revisions

`repository.provider` holds the stable lowercase provider key, such as `github`, `gitlab`, or `bitbucket`. `namespace` holds the owner, organization, workspace, or group path, including nested groups such as `group/subgroup`. `change.id` is an opaque string scoped to the repository.

Use the immutable commit or revision `id` as the source of truth for `base`, `head`, and `SourceSlice.revision`. The optional `ref` is a mutable branch or ref name for display only. Core performs no SHA-length validation.

## Missing and empty data

Patches and source slices use the same `ContentAvailability` states.

| Status | Meaning | Usable as complete evidence? |
| --- | --- | --- |
| `available` | Verified complete `text`. An empty string means the content was verified to be empty. | Yes |
| `not_requested` | The adapter skipped retrieval. | No |
| `unavailable` | The content was missing upstream. | No |
| `binary` | The content is binary. | No |
| `truncated` | A limit cut the content short. `partialText` may contain the returned portion. | No |

## Changed-file snapshot completeness

Use `fileListing` to describe list completeness. Set `complete` only when the provider establishes that every changed file was returned. Use `partial` with `provider_limit` or `retrieval_incomplete` when some files are known to be missing. `files.length` gives the returned count, and `reportedTotal` holds the provider's total when known. Use `unknown` when completeness cannot be established. Consumers must preserve `unknown` even when the returned list looks complete.

Derive which patches were omitted or incomplete from each returned file's `patch.status`. Only `available` supplies a full patch. A `complete` file listing can still have missing patches.

## Source line numbering

Read the file at `SourceSlice.revision.id`. `startLine` and `endLine` describe the requested range using 1-based, inclusive bounds with `startLine <= endLine`. Split lines on `\n`, retain any trailing `\r` as part of the line text, and omit the final `\n` from `text`. When the file is shorter than the requested range, keep the requested bounds and return `unavailable` or `truncated`. Reserve `available` for the full requested range.

## GitHub adapter mapping

- Convert the PR number to a string for `change.id` and map owner and repo to `repository.namespace` and `repository.name`. Keep the installation ID in the adapter.
- Map `added`, `modified`, `removed`, `renamed`, and `copied` to the matching file status. Use the current path, or the path at base for removals, and supply `previousPath` for renames and copies. Map `changed`, `unchanged`, and any other unrecognized status to `unknown` and preserve the raw value in `providerStatus`.
- Map an absent `patch` field to `unavailable`, or to `binary` when the file is known to be binary. Reserve empty `text` for verified empty patches.
- When GitHub's 3,000-file limit across paginated responses cuts the list short, use `partial` with reason `provider_limit` and include the reported total if known.

## Integration

The [GitHub PR diff reader](./REVIEW_INPUT_READER.md) maps GitHub changed-file retrieval into `ReviewInput` ([#26](https://github.com/Obryko/forgebot/issues/26)). Issue [#43](https://github.com/Obryko/forgebot/issues/43) covers a bounded PR context and file-read service that reads `SourceSlice` at exact immutable revision IDs and enforces byte and read caps. Issues #49–#53 track downstream consumers of these contracts.
