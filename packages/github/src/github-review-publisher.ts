import type { Logger } from "@forgebot/logger";
import {
	GitHubAppError,
	GitHubPullRequestRequestError,
} from "./github-app.error.ts";
import type { IGitHubClientFactory } from "./github-client-factory.ts";
import type { IGitHubInstallationClient } from "./github-installation-client.ts";
import { GitHubReviewError } from "./github-review.error.ts";
import { parseReviewDiff } from "./github-review-diff.ts";

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
type ReviewSide = "LEFT" | "RIGHT";

export interface InlineReviewComment {
	readonly path: string;
	readonly line: number;
	readonly side: ReviewSide;
	readonly body: string;
	readonly startLine?: number;
	readonly startSide?: ReviewSide;
}

export interface PublishReviewInput {
	readonly installationId: number;
	readonly owner: string;
	readonly repo: string;
	readonly pullNumber: number;
	readonly commitSha: string;
	readonly verdict: ReviewVerdict;
	readonly body: string;
	readonly comments: InlineReviewComment[];
}

export interface PublishedReview {
	readonly reviewId: number;
	readonly url: string;
	readonly commitSha: string;
	readonly verdict: ReviewVerdict;
}

export interface IGitHubReviewPublisher {
	publishReview(input: PublishReviewInput): Promise<PublishedReview>;
}

export interface GitHubReviewPublisherOptions {
	readonly clientFactory: IGitHubClientFactory;
	readonly logger: Logger;
}

const MAX_BODY_LENGTH = 65_536;
const MAX_SUBMISSIONS = 1_000;
const submissions = new Map<string, "unresolved" | PublishedReview>();

export class GitHubReviewPublisher implements IGitHubReviewPublisher {
	constructor(private readonly options: GitHubReviewPublisherOptions) {}

	async publishReview(input: PublishReviewInput): Promise<PublishedReview> {
		try {
			const fields = invalidFields(input);
			if (fields.length)
				throw new GitHubReviewError("INVALID_REVIEW_PAYLOAD", { fields });
			// Snapshot the wire payload before awaiting. The duplicate key, validation
			// and POST must all use the same input even if the caller mutates theirs.
			return await this.submit({
				...input,
				comments: input.comments.map(
					({ path, line, side, body, startLine, startSide }) => ({
						path,
						line,
						side,
						body,
						startLine,
						startSide,
					}),
				),
			});
		} catch (error) {
			const failure = mapReviewError(error);
			this.options.logger.warn("github.review.publication.failed", {
				installationId: positiveInteger(input?.installationId)
					? input.installationId
					: undefined,
				code: failure.code,
			});
			throw failure;
		}
	}

	private async submit(input: PublishReviewInput): Promise<PublishedReview> {
		const {
			installationId,
			owner,
			repo,
			pullNumber,
			commitSha,
			verdict,
			body,
			comments,
		} = input;
		const canonical = JSON.stringify([
			installationId,
			owner.toLowerCase(),
			repo.toLowerCase(),
			pullNumber,
			commitSha,
			verdict,
			body,
			comments.map(({ path, line, side, body, startLine, startSide }) => [
				path,
				line,
				side,
				body,
				startLine,
				startSide,
			]),
		]);
		const key = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
		const existing = submissions.get(key);
		if (existing === "unresolved")
			throw new GitHubReviewError("DUPLICATE_SUBMISSION");
		if (existing) return existing;
		if (submissions.size >= MAX_SUBMISSIONS) evictOldestSuccess();
		submissions.set(key, "unresolved");

		let retainSubmission = false;
		try {
			const client = this.options.clientFactory.forInstallation(installationId);
			await client.verifyRepositoryAccess(owner, repo);
			const permissions = await client.checkReviewPermissions();
			if (!permissions.ok) {
				throw new GitHubReviewError("INSUFFICIENT_PERMISSIONS", {
					missing: permissions.missing,
				});
			}
			const pull = await verifyPullRequest(client, input);
			const files = await client.listPullRequestFiles(owner, repo, pullNumber);
			await verifyPullRequest(client, input, pull.base);
			verifyCommentLocations(files, comments);

			let response: Awaited<
				ReturnType<IGitHubInstallationClient["createReview"]>
			>;
			try {
				response = await client.createReview(owner, repo, pullNumber, {
					commit_id: commitSha,
					event: verdict,
					body,
					comments: comments.map(
						({ path, line, side, body, startLine, startSide }) => ({
							path,
							line,
							side,
							body,
							start_line: startLine,
							start_side: startSide,
						}),
					),
				});
			} catch (error) {
				const failure = mapPublicationError(error, comments.length);
				retainSubmission = failure.code === "PUBLICATION_OUTCOME_UNKNOWN";
				throw failure;
			}
			// GitHub accepted the POST, even when its response is unusable.
			retainSubmission = true;
			if (
				response?.commit_id !== commitSha ||
				reviewVerdict(response.state) !== verdict
			) {
				const id = response?.id;
				throw new GitHubReviewError("PUBLICATION_OUTCOME_UNKNOWN", {
					reviewId: positiveInteger(id) ? id : undefined,
				});
			}
			if (
				!positiveInteger(response.id) ||
				typeof response.html_url !== "string"
			)
				throw new GitHubReviewError("GITHUB_API_ERROR");
			const published = Object.freeze({
				reviewId: response.id,
				url: response.html_url,
				commitSha,
				verdict,
			});
			// Reinsert in publication order, independent of when preflight started.
			submissions.delete(key);
			submissions.set(key, published);
			this.options.logger.info("github.review.published", {
				installationId,
				reviewId: published.reviewId,
				verdict: published.verdict,
				commentCount: comments.length,
			});
			return published;
		} finally {
			if (!retainSubmission) submissions.delete(key);
		}
	}
}

function evictOldestSuccess(): void {
	for (const [key, submission] of submissions) {
		if (submission !== "unresolved") {
			submissions.delete(key);
			return;
		}
	}
	throw new GitHubReviewError("DUPLICATE_SUBMISSION");
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function validRepositorySegment(value: unknown): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value !== "." &&
		value !== ".." &&
		!/[^\w.-]/.test(value)
	);
}

function validBody(body: unknown, allowEmpty = false): boolean {
	return (
		typeof body === "string" &&
		body.length <= MAX_BODY_LENGTH &&
		(allowEmpty || body.trim().length > 0)
	);
}

function validSide(side: unknown): boolean {
	return side === "LEFT" || side === "RIGHT";
}

function invalidFields(input: PublishReviewInput): string[] {
	if (!input || typeof input !== "object") return ["input"];
	const fields: string[] = [];
	if (!positiveInteger(input.installationId)) fields.push("installationId");
	if (!validRepositorySegment(input.owner)) fields.push("owner");
	if (!validRepositorySegment(input.repo)) fields.push("repo");
	if (!positiveInteger(input.pullNumber)) fields.push("pullNumber");
	if (
		typeof input.commitSha !== "string" ||
		input.commitSha.length !== 40 ||
		/[^0-9a-f]/.test(input.commitSha)
	) {
		fields.push("commitSha");
	}
	if (
		input.verdict !== "APPROVE" &&
		input.verdict !== "REQUEST_CHANGES" &&
		input.verdict !== "COMMENT"
	) {
		fields.push("verdict");
	}
	if (!validBody(input.body, input.verdict === "APPROVE")) fields.push("body");
	if (!Array.isArray(input.comments) || input.comments.length > 50) {
		fields.push("comments");
		return fields;
	}
	for (let index = 0; index < input.comments.length; index++) {
		const comment: InlineReviewComment | undefined = input.comments[index];
		const prefix = `comments[${index}]`;
		if (!comment || typeof comment !== "object") {
			fields.push(prefix);
			continue;
		}
		const { path, line, side, body, startLine, startSide } = comment;
		if (
			typeof path !== "string" ||
			!path.length ||
			path.startsWith("/") ||
			path.includes("\0") ||
			path.split("/").includes("..")
		)
			fields.push(`${prefix}.path`);
		if (!validBody(body)) fields.push(`${prefix}.body`);
		if (!positiveInteger(line)) fields.push(`${prefix}.line`);
		if (!validSide(side)) fields.push(`${prefix}.side`);
		if (startLine !== undefined || startSide !== undefined) {
			if (
				startLine === undefined ||
				!positiveInteger(startLine) ||
				(startSide === side && startLine >= line)
			) {
				fields.push(`${prefix}.startLine`);
			}
			if (!validSide(startSide)) fields.push(`${prefix}.startSide`);
		}
	}
	return fields;
}

async function verifyPullRequest(
	client: IGitHubInstallationClient,
	{ owner, repo, pullNumber, commitSha }: PublishReviewInput,
	previousBase?: { readonly sha: string; readonly ref: string },
) {
	const pull = await client
		.getPullRequest(owner, repo, pullNumber)
		.catch((error: unknown) => {
			if (
				error instanceof GitHubPullRequestRequestError &&
				error.cause?.status === 404
			) {
				throw new GitHubReviewError("PULL_REQUEST_NOT_FOUND", {
					cause: { status: 404 },
				});
			}
			throw error;
		});
	if (!previousBase && pull.state !== "open")
		throw new GitHubReviewError("PULL_REQUEST_CLOSED");
	if (
		pull.head.sha.toLowerCase() !== commitSha ||
		(previousBase &&
			(pull.base.sha !== previousBase.sha ||
				pull.base.ref !== previousBase.ref))
	)
		throw new GitHubReviewError("STALE_REVIEW_COMMIT");
	if (pull.state !== "open") throw new GitHubReviewError("PULL_REQUEST_CLOSED");
	return pull;
}

function verifyCommentLocations(
	files: Awaited<ReturnType<IGitHubInstallationClient["listPullRequestFiles"]>>,
	comments: readonly InlineReviewComment[],
): void {
	if (comments.length === 0) return;
	const patches = new Map(files.map((file) => [file.filename, file.patch]));
	const byPath = new Map<string, ReturnType<typeof parseReviewDiff>>();
	for (const [
		commentIndex,
		{ path, line, side, startLine, startSide },
	] of comments.entries()) {
		let hunks = byPath.get(path);
		if (!hunks) {
			const patch = patches.get(path);
			hunks = patch ? parseReviewDiff(patch) : [];
			byPath.set(path, hunks);
		}
		if (
			!hunks.some((hunk) => {
				const end = hunk[side].get(line);
				if (end === undefined) return false;
				if (startLine === undefined) return true;
				const start = startSide && hunk[startSide].get(startLine);
				return start !== undefined && start < end;
			})
		) {
			throw new GitHubReviewError("INVALID_INLINE_COMMENT_LOCATION", {
				commentIndex,
			});
		}
	}
}

function reviewVerdict(state: string): ReviewVerdict | undefined {
	switch (state) {
		case "APPROVED":
			return "APPROVE";
		case "CHANGES_REQUESTED":
			return "REQUEST_CHANGES";
		case "COMMENTED":
			return "COMMENT";
	}
}

function mapReviewError(error: unknown): GitHubReviewError {
	if (error instanceof GitHubReviewError) return error;
	if (!(error instanceof GitHubAppError))
		return new GitHubReviewError("GITHUB_API_ERROR");
	const cause =
		error instanceof GitHubPullRequestRequestError
			? error.cause
			: error.cause && { status: error.cause.status };
	switch (error.code) {
		case "INSUFFICIENT_PERMISSIONS":
			return new GitHubReviewError(error.code, { cause, missing: [] });
		case "REPOSITORY_ACCESS_DENIED":
		case "RATE_LIMITED":
			return new GitHubReviewError(error.code, { cause });
		default:
			return new GitHubReviewError("GITHUB_API_ERROR", { cause });
	}
}

function mapPublicationError(
	error: unknown,
	commentCount: number,
): GitHubReviewError {
	if (!(error instanceof GitHubAppError))
		return new GitHubReviewError("PUBLICATION_OUTCOME_UNKNOWN");
	if (!(error instanceof GitHubPullRequestRequestError))
		return mapReviewError(error);
	const cause = error.cause;
	if (!cause || cause.status >= 500)
		return new GitHubReviewError("PUBLICATION_OUTCOME_UNKNOWN", { cause });
	const { rejection } = error;
	if (!rejection) return mapReviewError(error);
	switch (rejection.code) {
		case "REVIEW_VERDICT_REJECTED":
			return new GitHubReviewError(rejection.code, { cause });
		case "INVALID_INLINE_COMMENT_LOCATION": {
			const index = rejection.commentIndex;
			const commentIndex =
				index !== undefined && index < commentCount
					? index
					: commentCount === 1
						? 0
						: undefined;
			return new GitHubReviewError(rejection.code, { cause, commentIndex });
		}
		case "INVALID_REVIEW_PAYLOAD":
			return new GitHubReviewError(rejection.code, {
				cause,
				fields: rejection.fields,
			});
	}
}
