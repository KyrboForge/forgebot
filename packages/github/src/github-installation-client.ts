import type { Logger } from "@forgebot/logger";
import { Octokit } from "@octokit/rest";
import { mapGitHubAppError } from "./github-app.error.ts";
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

export interface IGitHubInstallationClient {
	verifyRepositoryAccess(owner: string, repo: string): Promise<void>;
	getRepository(owner: string, repo: string): Promise<GitHubRepositoryMetadata>;
	checkReviewPermissions(): Promise<GitHubReviewPermissions>;
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
					options.auth.invalidate(options.installationId);
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
		const { data } = await this.octokit.rest.repos.get({ owner, repo });
		this.options.logger.debug("github.repository.accessed", {
			installationId: this.options.installationId,
		});
		return {
			id: data.id,
			fullName: data.full_name,
			defaultBranch: data.default_branch,
			private: data.private,
			archived: data.archived,
			htmlUrl: data.html_url,
		};
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
}
