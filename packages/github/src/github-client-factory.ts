import type { Logger } from "@forgebot/logger";
import type { GitHubFetch, IGitHubAppAuth } from "./github-app-auth.ts";
import { GitHubInstallationClient } from "./github-installation-client.ts";

export interface IGitHubClientFactory {
	forInstallation(installationId: number): GitHubInstallationClient;
}

export interface GitHubClientFactoryOptions {
	auth: IGitHubAppAuth;
	logger: Logger;
	fetch?: GitHubFetch;
}

export class GitHubClientFactory implements IGitHubClientFactory {
	private readonly clients = new Map<number, GitHubInstallationClient>();

	constructor(private readonly options: GitHubClientFactoryOptions) {}

	forInstallation(installationId: number): GitHubInstallationClient {
		let client = this.clients.get(installationId);
		if (!client) {
			client = new GitHubInstallationClient({
				...this.options,
				installationId,
			});
			this.clients.set(installationId, client);
		}
		return client;
	}
}
