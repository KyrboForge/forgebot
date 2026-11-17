import { describe, expect, it } from "bun:test";
import createLogger from "@forgebot/logger";
import {
	GitHubAppAuth,
	GitHubClientFactory,
	loadGitHubAppConfig,
} from "./index.ts";

describe.skipIf(process.env.FORGEBOT_GITHUB_SMOKE !== "1")(
	"GitHub App smoke (read-only)",
	() => {
		it("verifies repository access, metadata and review permissions", async () => {
			const config = await loadGitHubAppConfig(process.env);
			if (config.installationId === undefined)
				throw new Error("GITHUB_APP_INSTALLATION_ID is required");
			const repository = process.env.FORGEBOT_SMOKE_REPOSITORY;
			if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
				throw new Error("FORGEBOT_SMOKE_REPOSITORY must be owner/repo");
			const [owner, repo] = repository.split("/");
			if (!owner || !repo)
				throw new Error("FORGEBOT_SMOKE_REPOSITORY must be owner/repo");
			const logger = createLogger({
				level: "info",
				type: "console",
				output: console,
			});
			const auth = new GitHubAppAuth({ config, logger });
			const client = new GitHubClientFactory({ auth, logger }).forInstallation(
				config.installationId,
			);
			await client.verifyRepositoryAccess(owner, repo);
			const metadata = await client.getRepository(owner, repo);
			expect(metadata.fullName.toLowerCase()).toBe(repository.toLowerCase());
			expect(metadata.id).toBeGreaterThan(0);
			const permissions = await client.checkReviewPermissions();
			expect(permissions.missing).toEqual([]);
			expect(permissions.ok).toBe(true);
		});
	},
);
