/** Identifies a repository across providers without carrying adapter credentials. */
export type RepositoryIdentity = {
	/** Stable lowercase provider key, such as `github`, `gitlab`, or `bitbucket`. */
	readonly provider: string;
	/** Owner, organization, workspace, or group path, including nested groups. */
	readonly namespace: string;
	readonly name: string;
	readonly providerRepositoryId?: string;
};

/** Identifies a change within its repository using an opaque provider ID. */
export type ChangeIdentity = {
	readonly id: string;
	readonly url?: string;
};

/** Pins an immutable revision by ID. The ReviewInput field names carry the base and head roles. */
export type RevisionReference = {
	readonly id: string;
	/** Optional mutable ref for display only. */
	readonly ref?: string;
};

/** Reports whether a patch or source slice is usable as complete evidence. Only `available` is complete. */
export type ContentAvailability =
	| { readonly status: "available"; readonly text: string }
	| { readonly status: "not_requested" }
	| { readonly status: "unavailable" }
	| { readonly status: "binary" }
	| { readonly status: "truncated"; readonly partialText?: string };

/** Preserves file history and patch availability without guessing unrecognized provider statuses. */
export type ChangedFile = {
	/** Current path, or the last path at the base revision for a removed file. */
	readonly path: string;
	readonly patch: ContentAvailability;
} & (
	| {
			readonly status: "added" | "modified" | "removed";
			readonly previousPath?: never;
	  }
	| {
			readonly status: "renamed" | "copied";
			readonly previousPath: string;
	  }
	| {
			readonly status: "unknown";
			readonly providerStatus: string;
			readonly previousPath?: string;
	  }
);

/** Records what the provider established about file-list completeness independently of patch availability. */
export type ChangedFileListing =
	| { readonly status: "complete" }
	| {
			readonly status: "partial";
			readonly reason: "provider_limit" | "retrieval_incomplete";
			readonly reportedTotal?: number;
	  }
	| { readonly status: "unknown" };

/** Describes a change at pinned base and head revisions. `repository.provider` is the sole provider identity. */
export type ReviewInput = {
	readonly repository: RepositoryIdentity;
	readonly change: ChangeIdentity;
	readonly base: RevisionReference;
	readonly head: RevisionReference;
	readonly files: readonly ChangedFile[];
	readonly fileListing: ChangedFileListing;
};

/**
 * Captures source at `revision.id` for a requested 1-based range, inclusive at both ends,
 * with `startLine <= endLine`. Split on `\n`, preserve any trailing `\r` in line text,
 * and omit the final `\n` from `text`. If the file is shorter than the requested range,
 * report `unavailable` or `truncated` and retain the requested bounds.
 */
export type SourceSlice = {
	readonly repository: RepositoryIdentity;
	readonly revision: RevisionReference;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly content: ContentAvailability;
};
