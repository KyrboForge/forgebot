import type { GitHubPullRequestErrorCause } from "./github-app.error.ts";

export type GitHubReviewErrorCode =
	| "REPOSITORY_ACCESS_DENIED"
	| "INSUFFICIENT_PERMISSIONS"
	| "PULL_REQUEST_NOT_FOUND"
	| "PULL_REQUEST_CLOSED"
	| "STALE_REVIEW_COMMIT"
	| "INVALID_REVIEW_PAYLOAD"
	| "INVALID_INLINE_COMMENT_LOCATION"
	| "REVIEW_VERDICT_REJECTED"
	| "RATE_LIMITED"
	| "PUBLICATION_OUTCOME_UNKNOWN"
	| "DUPLICATE_SUBMISSION"
	| "GITHUB_API_ERROR";

interface GitHubReviewErrorDetails {
	readonly cause?: GitHubPullRequestErrorCause;
	readonly missing?: readonly string[];
	readonly fields?: readonly string[];
	readonly commentIndex?: number;
	readonly reviewId?: number;
}

export class GitHubReviewError extends Error {
	override readonly name = "GitHubReviewError";
	override readonly cause?: GitHubPullRequestErrorCause;
	readonly missing?: readonly string[];
	readonly fields?: readonly string[];
	readonly commentIndex?: number;
	readonly reviewId?: number;

	constructor(
		readonly code: GitHubReviewErrorCode,
		details: GitHubReviewErrorDetails = {},
	) {
		super(code);
		this.cause = details.cause;
		this.missing = details.missing;
		this.fields = details.fields;
		this.commentIndex = details.commentIndex;
		this.reviewId = details.reviewId;
	}
}
