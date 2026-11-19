import type {
	ChangedFile,
	ChangedFileListing,
	ContentAvailability,
	ReviewInput,
} from "@forgebot/core";
import {
	GitHubAppError,
	GitHubPullRequestRequestError,
} from "./github-app.error.ts";
import type { IGitHubClientFactory } from "./github-client-factory.ts";
import type { GitHubInstallationClient } from "./github-installation-client.ts";
import { GitHubReviewError } from "./github-review.error.ts";

export const DEFAULT_GITHUB_REVIEW_INPUT_LIMITS = Object.freeze({
	maxFiles: 300,
	maxPatchBytes: 100_000,
	maxTotalPatchBytes: 1_000_000,
});

export interface ReadGitHubReviewInput {
	readonly installationId: number;
	readonly owner: string;
	readonly repo: string;
	readonly pullNumber: number;
	readonly limits?: {
		readonly maxFiles?: number;
		readonly maxPatchBytes?: number;
		readonly maxTotalPatchBytes?: number;
		readonly includePatches?: boolean;
	};
}

export interface IGitHubReviewInputReader {
	read(input: ReadGitHubReviewInput): Promise<ReviewInput>;
}

const PAGE_SIZE = 100;
const MAX_FILES = 3_000;
const encoder = new TextEncoder();

type Pull = Awaited<
	ReturnType<GitHubInstallationClient["getPullRequestSnapshot"]>
>;
type FilePage = Awaited<
	ReturnType<GitHubInstallationClient["listPullRequestFilesPage"]>
>;
type File = FilePage["files"][number];
type Limits = Required<NonNullable<ReadGitHubReviewInput["limits"]>>;

export class GitHubReviewInputReader implements IGitHubReviewInputReader {
	constructor(
		private readonly options: { readonly clientFactory: IGitHubClientFactory },
	) {}

	async read(input: ReadGitHubReviewInput): Promise<ReviewInput> {
		const limits = readLimits(input);
		const { owner, repo, installationId } = input;
		try {
			const client = this.options.clientFactory.forInstallation(installationId);
			// getRepository verifies installation membership and supplies the repository ID.
			const repository = await client.getRepository(owner, repo);
			const pull = await readPull(client, input);
			const result = await readFiles(client, input, limits, pull.changedFiles);
			const latest = await readPull(client, input);
			if (
				latest.base.sha !== pull.base.sha ||
				latest.head.sha !== pull.head.sha
			) {
				throw new GitHubReviewError("STALE_REVIEW_SNAPSHOT");
			}
			return {
				repository: {
					provider: "github",
					namespace: owner,
					name: repo,
					...(positiveInteger(repository.id)
						? { providerRepositoryId: String(repository.id) }
						: {}),
				},
				change: { id: String(pull.number), url: pull.htmlUrl },
				base: { id: pull.base.sha, ref: pull.base.ref },
				head: { id: pull.head.sha, ref: pull.head.ref },
				...result,
			};
		} catch (error) {
			throw mapReadError(error);
		}
	}
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function readLimits(input: ReadGitHubReviewInput): Limits {
	if (!input || typeof input !== "object") {
		throw new GitHubReviewError("INVALID_REVIEW_INPUT", { fields: ["input"] });
	}
	const { installationId, owner, repo, pullNumber, limits } = input;
	const fields: string[] = [];
	if (!positiveInteger(installationId)) fields.push("installationId");
	if (
		typeof owner !== "string" ||
		!owner.length ||
		owner.length > 39 ||
		/[^a-z0-9_-]/i.test(owner)
	) {
		fields.push("owner");
	}
	if (
		typeof repo !== "string" ||
		!repo.length ||
		repo.length > 100 ||
		/[^a-z0-9_.-]/i.test(repo) ||
		repo === "." ||
		repo === ".."
	) {
		fields.push("repo");
	}
	if (!positiveInteger(pullNumber)) fields.push("pullNumber");
	if (
		limits !== undefined &&
		(!limits || typeof limits !== "object" || Array.isArray(limits))
	) {
		fields.push("limits");
	}
	const {
		maxFiles = DEFAULT_GITHUB_REVIEW_INPUT_LIMITS.maxFiles,
		maxPatchBytes = DEFAULT_GITHUB_REVIEW_INPUT_LIMITS.maxPatchBytes,
		maxTotalPatchBytes = DEFAULT_GITHUB_REVIEW_INPUT_LIMITS.maxTotalPatchBytes,
		includePatches = true,
	} = limits ?? {};
	if (!positiveInteger(maxFiles)) fields.push("limits.maxFiles");
	if (!positiveInteger(maxPatchBytes)) fields.push("limits.maxPatchBytes");
	if (!positiveInteger(maxTotalPatchBytes))
		fields.push("limits.maxTotalPatchBytes");
	if (typeof includePatches !== "boolean") fields.push("limits.includePatches");
	if (fields.length)
		throw new GitHubReviewError("INVALID_REVIEW_INPUT", { fields });
	return {
		maxFiles: Math.min(maxFiles, MAX_FILES),
		maxPatchBytes: Math.min(
			maxPatchBytes,
			DEFAULT_GITHUB_REVIEW_INPUT_LIMITS.maxPatchBytes,
		),
		maxTotalPatchBytes: Math.min(
			maxTotalPatchBytes,
			DEFAULT_GITHUB_REVIEW_INPUT_LIMITS.maxTotalPatchBytes,
		),
		includePatches,
	};
}

async function readPull(
	client: GitHubInstallationClient,
	{ owner, repo, pullNumber }: ReadGitHubReviewInput,
): Promise<Pull> {
	const pull = await client.getPullRequestSnapshot(owner, repo, pullNumber);
	const url = typeof pull.htmlUrl === "string" ? URL.parse(pull.htmlUrl) : null;
	if (
		pull.number !== pullNumber ||
		url?.protocol !== "https:" ||
		url.username ||
		url.password ||
		![pull.base.sha, pull.base.ref, pull.head.sha, pull.head.ref].every(
			nonBlank,
		)
	) {
		throw new GitHubReviewError("MALFORMED_RESPONSE");
	}
	return pull;
}

function nonBlank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

async function readFiles(
	client: GitHubInstallationClient,
	{ owner, repo, pullNumber }: ReadGitHubReviewInput,
	limits: Limits,
	changedFiles: number | undefined,
): Promise<Pick<ReviewInput, "files" | "fileListing">> {
	const reportedTotal =
		changedFiles === 0 || positiveInteger(changedFiles)
			? changedFiles
			: undefined;
	const files: ChangedFile[] = [];
	const paths = new Set<string>();
	const maxPages = Math.ceil(limits.maxFiles / PAGE_SIZE);
	let remainingBytes = limits.maxTotalPatchBytes;
	let moreInListing = false;
	for (let page = 1; page <= maxPages; page++) {
		const response = await client.listPullRequestFilesPage({
			owner,
			repo,
			pullNumber,
			page,
			perPage: PAGE_SIZE,
		});
		const entries = response.files;
		if (!Array.isArray(entries) || entries.length > PAGE_SIZE) {
			throw new GitHubReviewError("MALFORMED_RESPONSE");
		}

		for (const entry of entries) validateFile(entry);

		let consumed = 0;
		for (const entry of entries) {
			if (files.length === limits.maxFiles || remainingBytes === 0) break;
			if (paths.has(entry.filename)) {
				throw new GitHubReviewError("INCOMPLETE_RETRIEVAL");
			}
			const { patch, bytes } = readPatch(entry, limits, remainingBytes);
			files.push(mapFile(entry, patch));
			paths.add(entry.filename);
			remainingBytes -= bytes;
			consumed++;
		}

		moreInListing = consumed < entries.length || response.hasNextPage;
		if (
			files.length === limits.maxFiles ||
			remainingBytes === 0 ||
			(!moreInListing &&
				(entries.length < PAGE_SIZE || files.length === reportedTotal))
		)
			break;
	}

	const fileListing: ChangedFileListing =
		reportedTotal === undefined
			? { status: "unknown" }
			: files.length === reportedTotal && !moreInListing
				? { status: "complete" }
				: {
						status: "partial",
						reason:
							files.length === MAX_FILES && reportedTotal > MAX_FILES
								? "provider_limit"
								: "retrieval_incomplete",
						reportedTotal,
					};
	return { files, fileListing };
}

function validFilePath(path: unknown): path is string {
	return (
		typeof path === "string" &&
		!path.includes("\0") &&
		path.split("/").every((part) => part && part !== "." && part !== "..")
	);
}

function validateFile(file: File): void {
	if (
		!validFilePath(file?.filename) ||
		!nonBlank(file.status) ||
		(file.patch !== undefined && typeof file.patch !== "string")
	) {
		throw new GitHubReviewError("MALFORMED_RESPONSE");
	}
}

function mapFile(file: File, patch: ContentAvailability): ChangedFile {
	const { filename: path, status, previous_filename: previousPath } = file;
	switch (status) {
		case "added":
		case "modified":
		case "removed":
			return { path, status, patch };
		case "renamed":
		case "copied":
			if (validFilePath(previousPath))
				return { path, status, previousPath, patch };
			break;
	}
	return {
		path,
		status: "unknown",
		providerStatus: status,
		patch,
		...(validFilePath(previousPath) ? { previousPath } : {}),
	};
}

function readPatch(
	file: File,
	limits: Limits,
	remainingBytes: number,
): { patch: ContentAvailability; bytes: number } {
	if (!limits.includePatches)
		return { patch: { status: "not_requested" }, bytes: 0 };
	const text = file.patch;
	if (text === undefined || (text === "" && !verifiedEmptyPatch(file))) {
		return { patch: { status: "unavailable" }, bytes: 0 };
	}
	if (/^Binary files [^\r\n]+ and [^\r\n]+ differ\n?$/.test(text)) {
		return { patch: { status: "binary" }, bytes: 0 };
	}
	if (text.length > limits.maxPatchBytes) {
		return { patch: { status: "truncated" }, bytes: 0 };
	}
	const bytes = encoder.encode(text).byteLength;
	if (bytes > limits.maxPatchBytes)
		return { patch: { status: "truncated" }, bytes: 0 };
	if (bytes > remainingBytes)
		return { patch: { status: "truncated" }, bytes: remainingBytes };
	return { patch: { status: "available", text }, bytes };
}

function verifiedEmptyPatch(file: File): boolean {
	return (
		(file.status === "renamed" ||
			file.status === "copied" ||
			file.status === "unchanged") &&
		file.additions === 0 &&
		file.deletions === 0 &&
		file.changes === 0
	);
}

function mapReadError(error: unknown): GitHubReviewError {
	if (error instanceof GitHubReviewError) return error;
	if (!(error instanceof GitHubAppError))
		return new GitHubReviewError("GITHUB_API_ERROR");
	const status = error.cause?.status;
	const cause = status === undefined ? undefined : { status };
	if (error.code === "RATE_LIMITED") {
		return new GitHubReviewError("RATE_LIMITED", {
			cause,
			rateLimit: error.rateLimit,
		});
	}
	if (error instanceof GitHubPullRequestRequestError && status === 404) {
		return new GitHubReviewError("PULL_REQUEST_NOT_FOUND", { cause });
	}
	if (
		error.code === "REPOSITORY_ACCESS_DENIED" ||
		status === 401 ||
		status === 403
	) {
		return new GitHubReviewError("REPOSITORY_ACCESS_DENIED", { cause });
	}
	return new GitHubReviewError("GITHUB_API_ERROR", { cause });
}
