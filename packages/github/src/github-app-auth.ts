import type { Logger } from "@forgebot/logger";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { GitHubAppError, mapGitHubAppError } from "./github-app.error.ts";
import type { GitHubAppConfig } from "./github-app-config.ts";

export type GitHubFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;
export type GitHubInstallationPermissions = Readonly<Record<string, string>>;

export interface GitHubInstallationToken {
	readonly token: string;
	readonly expiresAt: string;
}

export interface IGitHubAppAuth {
	getInstallationToken(
		installationId: number,
	): Promise<GitHubInstallationToken>;
	getInstallationPermissions(
		installationId: number,
	): Promise<GitHubInstallationPermissions>;
	invalidate(installationId: number): void;
}

export interface GitHubAppAuthOptions {
	config: GitHubAppConfig;
	logger: Logger;
	fetch?: GitHubFetch;
	now?: () => number;
}

export class GitHubAppAuth implements IGitHubAppAuth {
	private readonly tokens = new Map<number, GitHubInstallationToken>();
	private readonly inFlight = new Map<
		number,
		Promise<GitHubInstallationToken>
	>();
	private readonly appAuth: ReturnType<typeof createAppAuth>;
	private readonly octokit: Octokit;
	private readonly logger: Logger;
	private readonly now: () => number;

	constructor(options: GitHubAppAuthOptions) {
		this.logger = options.logger;
		this.now = options.now ?? Date.now;
		this.octokit = new Octokit({
			request: { fetch: options.fetch },
			log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		});
		// Use only app JWT signing: auth-app's installation flow shares module-level
		// pending promises across app instances, even with a custom cache/refresh.
		this.appAuth = createAppAuth({
			appId: options.config.appId,
			privateKey: options.config.privateKey,
			request: this.octokit.request,
			log: { warn: () => {} },
		});
	}

	getInstallationToken(
		installationId: number,
	): Promise<GitHubInstallationToken> {
		const cached = this.tokens.get(installationId);
		if (cached && Date.parse(cached.expiresAt) - this.now() >= 5 * 60 * 1000) {
			return Promise.resolve(cached);
		}
		const existing = this.inFlight.get(installationId);
		if (existing) return existing;
		this.tokens.delete(installationId);
		const pending = this.createInstallationToken(installationId)
			.then((token) => {
				if (this.inFlight.get(installationId) === pending) {
					this.tokens.set(installationId, token);
				}
				return token;
			})
			.finally(() => {
				if (this.inFlight.get(installationId) === pending)
					this.inFlight.delete(installationId);
			});
		this.inFlight.set(installationId, pending);
		return pending;
	}

	invalidate(installationId: number): void {
		this.tokens.delete(installationId);
		this.inFlight.delete(installationId);
		this.logger.debug("github.app.token.invalidated", { installationId });
	}

	async getInstallationPermissions(
		installationId: number,
	): Promise<GitHubInstallationPermissions> {
		const jwt = await this.getAppJwt();
		try {
			const { data } = await this.octokit.request(
				"GET /app/installations/{installation_id}",
				{
					installation_id: installationId,
					headers: { authorization: `bearer ${jwt}` },
				},
			);
			if (data.suspended_at)
				throw new GitHubAppError("INSTALLATION_NOT_FOUND_OR_REVOKED");
			return Object.freeze({ ...data.permissions });
		} catch (error) {
			throw mapGitHubAppError(error, "installation");
		}
	}

	private async getAppJwt(): Promise<string> {
		try {
			return (await this.appAuth({ type: "app" })).token;
		} catch {
			throw new GitHubAppError("INVALID_PRIVATE_KEY");
		}
	}

	private async createInstallationToken(
		installationId: number,
	): Promise<GitHubInstallationToken> {
		const jwt = await this.getAppJwt();
		try {
			const { data } = await this.octokit.request(
				"POST /app/installations/{installation_id}/access_tokens",
				{
					installation_id: installationId,
					headers: { authorization: `bearer ${jwt}` },
				},
			);
			if (!data.token || !Number.isFinite(Date.parse(data.expires_at))) {
				throw new GitHubAppError("GITHUB_API_ERROR");
			}
			const token = Object.freeze({
				token: data.token,
				expiresAt: data.expires_at,
			});
			this.logger.debug("github.app.token.created", {
				installationId,
				expiresAt: token.expiresAt,
			});
			return token;
		} catch (error) {
			throw mapGitHubAppError(error, "installation");
		}
	}
}
