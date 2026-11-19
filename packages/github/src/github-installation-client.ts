import type { Logger } from "@forgebot/logger";
import { Octokit } from "@octokit/rest";
import {
	GitHubAppError,
	mapGitHubAppError,
	mapGitHubPullRequestError,
} from "./github-app.error.ts";
import type {
	GitHubFetch,
	GitHubInstallationPermissions,
	IGitHubAppAuth,
} from "./github-app-auth.ts";

export interface GitHubRepositoryMetadata {
	readonly id: number;
	readonly fullName: string;
	readonly defaultBranch: string;
	readonly private: boolean;
	readonly archived: boolean;
	readonly htmlUrl: string;
}

export interface GitHubReviewPermissions {
	readonly ok: boolean;
	readonly missing: readonly string[];
	readonly granted: GitHubInstallationPermissions;
}

interface GitHubPullRequest {
	readonly state: string;
	readonly head: { readonly sha: string };
	readonly base: { readonly sha: string; readonly ref: string };
}

interface GitHubPullRequestSnapshot {
	readonly number: number;
	readonly htmlUrl: string;
	readonly changedFiles?: number;
	readonly base: { readonly sha: string; readonly ref: string };
	readonly head: { readonly sha: string; readonly ref: string };
}

interface GitHubPullRequestFile {
	readonly filename: string;
	readonly patch?: string;
	readonly status: string;
	readonly previous_filename?: string;
	readonly additions?: number;
	readonly deletions?: number;
	readonly changes?: number;
}

interface CreateGitHubReview {
	readonly commit_id: string;
	readonly event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
	readonly body: string;
	readonly comments: {
		path: string;
		line: number;
		side: "LEFT" | "RIGHT";
		start_line?: number;
		start_side?: "LEFT" | "RIGHT";
		body: string;
	}[];
}

interface GitHubReviewResponse {
	readonly id: number;
	readonly html_url: string;
	readonly commit_id: string | null;
	readonly state: string;
}

export interface IGitHubInstallationClient {
	verifyRepositoryAccess(owner: string, repo: string): Promise<void>;
	getRepository(owner: string, repo: string): Promise<GitHubRepositoryMetadata>;
	checkReviewPermissions(): Promise<GitHubReviewPermissions>;
	getPullRequest(
		owner: string,
		repo: string,
		pullNumber: number,
	): Promise<GitHubPullRequest>;
	listPullRequestFiles(
		owner: string,
		repo: string,
		pullNumber: number,
	): Promise<GitHubPullRequestFile[]>;
	createReview(
		owner: string,
		repo: string,
		pullNumber: number,
		review: CreateGitHubReview,
	): Promise<GitHubReviewResponse>;
}

export interface GitHubInstallationClientOptions {
	installationId: number;
	auth: IGitHubAppAuth;
	logger: Logger;
	fetch?: GitHubFetch;
}

const REQUIRED_REVIEW_PERMISSIONS = {
	metadata: "read",
	contents: "read",
	pull_requests: "write",
} as const;

export class GitHubInstallationClient implements IGitHubInstallationClient {
	private readonly octokit: Octokit;

	constructor(private readonly options: GitHubInstallationClientOptions) {
		this.octokit = new Octokit({
			request: { fetch: options.fetch },
			log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		});
		this.octokit.hook.wrap("request", async (request, endpoint) => {
			const { token } = await options.auth.getInstallationToken(
				options.installationId,
			);
			endpoint.headers.authorization = `token ${token}`;
			try {
				return await request(endpoint);
			} catch (error) {
				if ((error as { status?: number } | null)?.status === 401) {
					options.auth.invalidate(options.installationId, token);
				}
				const path = new URL(endpoint.url, endpoint.baseUrl).pathname;
				if (/^\/repos\/[^/]+\/[^/]+\/pulls\//.test(path)) {
					throw mapGitHubPullRequestError(error);
				}
				throw mapGitHubAppError(error, "repository");
			}
		});
	}

	async verifyRepositoryAccess(owner: string, repo: string): Promise<void> {
		await this.getRepository(owner, repo);
	}

	async getRepository(
		owner: string,
		repo: string,
	): Promise<GitHubRepositoryMetadata> {
		const target = `${owner}/${repo}`.toLowerCase();
		for await (const response of this.octokit.paginate.iterator(
			this.octokit.rest.apps.listReposAccessibleToInstallation,
			{ per_page: 100 },
		)) {
			for (const item of response.data) {
				if (item.full_name.toLowerCase() === target) {
					this.options.logger.debug("github.repository.accessed", {
						installationId: this.options.installationId,
					});
					return {
						id: item.id,
						fullName: item.full_name,
						defaultBranch: item.default_branch,
						private: item.private,
						archived: item.archived,
						htmlUrl: item.html_url,
					};
				}
			}
		}
		throw new GitHubAppError("REPOSITORY_ACCESS_DENIED");
	}

	async checkReviewPermissions(): Promise<GitHubReviewPermissions> {
		const granted = await this.options.auth.getInstallationPermissions(
			this.options.installationId,
		);
		const missing = Object.entries(REQUIRED_REVIEW_PERMISSIONS)
			.filter(([name, required]) => {
				const actual = granted[name];
				return (
					actual !== "admin" &&
					actual !== "write" &&
					!(required === "read" && actual === "read")
				);
			})
			.map(([name, required]) => `${name}:${required}`);
		this.options.logger.debug("github.installation.permissions.checked", {
			installationId: this.options.installationId,
		});
		return { ok: missing.length === 0, missing, granted };
	}

	async getPullRequest(
		owner: string,
		repo: string,
		pullNumber: number,
	): Promise<GitHubPullRequest> {
		const { data } = await this.requestPullRequest(owner, repo, pullNumber);
		return {
			state: data.state,
			head: { sha: data.head.sha },
			base: { sha: data.base.sha, ref: data.base.ref },
		};
	}

	async getPullRequestSnapshot(
		owner: string,
		repo: string,
		pullNumber: number,
	): Promise<GitHubPullRequestSnapshot> {
		const { data } = await this.requestPullRequest(owner, repo, pullNumber);
		return {
			number: data?.number,
			htmlUrl: data?.html_url,
			changedFiles: data?.changed_files,
			base: { sha: data?.base?.sha, ref: data?.base?.ref },
			head: { sha: data?.head?.sha, ref: data?.head?.ref },
		};
	}

	private requestPullRequest(owner: string, repo: string, pullNumber: number) {
		return this.octokit.rest.pulls.get({
			owner,
			repo,
			pull_number: pullNumber,
		});
	}

	async listPullRequestFilesPage({
		owner,
		repo,
		pullNumber,
		page,
		perPage,
	}: {
		owner: string;
		repo: string;
		pullNumber: number;
		page: number;
		perPage: number;
	}): Promise<{
		files: readonly GitHubPullRequestFile[];
		hasNextPage: boolean;
	}> {
		const response = await this.octokit.rest.pulls.listFiles({
			owner,
			repo,
			pull_number: pullNumber,
			page,
			per_page: perPage,
		});
		return {
			files: response.data,
			hasNextPage: /<[^>]+>;\s*rel="next"/.test(response.headers.link ?? ""),
		};
	}

	listPullRequestFiles(
		owner: string,
		repo: string,
		pullNumber: number,
	): Promise<GitHubPullRequestFile[]> {
		return this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
			owner,
			repo,
			pull_number: pullNumber,
			per_page: 100,
		});
	}

	async createReview(
		owner: string,
		repo: string,
		pullNumber: number,
		review: CreateGitHubReview,
	): Promise<GitHubReviewResponse> {
		const { data } = await this.octokit.rest.pulls.createReview({
			...review,
			owner,
			repo,
			pull_number: pullNumber,
			// A 307 or 308 redirect could replay the POST.
			request: { redirect: "error" },
		});
		return data;
	}

	async getReview(
		owner: string,
		repo: string,
		pullNumber: number,
		reviewId: number,
	): Promise<{ user: { type: string; login: string } | null }> {
		const { data } = await this.octokit.rest.pulls.getReview({
			owner,
			repo,
			pull_number: pullNumber,
			review_id: reviewId,
		});
		return {
			user: data.user && { type: data.user.type, login: data.user.login },
		};
	}
}
