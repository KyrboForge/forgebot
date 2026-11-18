import { describe, expect, it } from "bun:test";
import createLogger from "@forgebot/logger";
import {
	GitHubAppAuth,
	GitHubClientFactory,
	GitHubReviewPublisher,
	loadGitHubAppConfig,
} from "./index.ts";

it.each([
	"owner/repo",
	"owner/repo#42",
])("rejects smoke confirmation %s before using GitHub credentials", async (confirmation) => {
	await expect(
		publishSmokeReview({
			FORGEBOT_SMOKE_REVIEW_REPOSITORY: "owner/repo",
			FORGEBOT_SMOKE_REVIEW_PULL_NUMBER: "7",
			FORGEBOT_SMOKE_REVIEW_CONFIRM: confirmation,
		}),
	).rejects.toThrow(
		"FORGEBOT_SMOKE_REVIEW_CONFIRM must exactly match owner/repo#pullNumber",
	);
});

describe.skipIf(process.env.FORGEBOT_GITHUB_REVIEW_SMOKE !== "1")(
	"GitHub review publisher smoke",
	() => {
		it("publishes one COMMENT as the installed GitHub App bot", async () => {
			await publishSmokeReview(process.env);
		}, 30_000);
	},
);

async function publishSmokeReview(env: NodeJS.ProcessEnv): Promise<void> {
	const repository = env.FORGEBOT_SMOKE_REVIEW_REPOSITORY;
	const [owner, repo, extra] = (repository ?? "").split("/");
	if (
		!owner ||
		!repo ||
		extra !== undefined ||
		[owner, repo].some(
			(part) => part === "." || part === ".." || /[^\w.-]/.test(part),
		)
	) {
		throw new Error("FORGEBOT_SMOKE_REVIEW_REPOSITORY must be owner/repo");
	}
	const pullNumberValue = env.FORGEBOT_SMOKE_REVIEW_PULL_NUMBER;
	const pullNumber = Number(pullNumberValue);
	if (
		!pullNumberValue ||
		/[^0-9]/.test(pullNumberValue) ||
		!Number.isSafeInteger(pullNumber) ||
		pullNumber <= 0
	) {
		throw new Error(
			"FORGEBOT_SMOKE_REVIEW_PULL_NUMBER must be a positive pull request number",
		);
	}
	if (env.FORGEBOT_SMOKE_REVIEW_CONFIRM !== `${owner}/${repo}#${pullNumber}`) {
		throw new Error(
			"FORGEBOT_SMOKE_REVIEW_CONFIRM must exactly match owner/repo#pullNumber",
		);
	}
	const slug = env.FORGEBOT_SMOKE_APP_SLUG;
	if (slug === "")
		throw new Error("FORGEBOT_SMOKE_APP_SLUG must be non-empty when set");

	const config = await loadGitHubAppConfig(env);
	if (config.installationId === undefined) {
		throw new Error(
			"GITHUB_APP_INSTALLATION_ID is required for the review smoke test",
		);
	}
	const logger = createLogger({
		level: "info",
		type: "console",
		output: console,
	});
	const auth = new GitHubAppAuth({ config, logger });
	const clientFactory = new GitHubClientFactory({ auth, logger });
	const client = clientFactory.forInstallation(config.installationId);
	const { head } = await client.getPullRequest(owner, repo, pullNumber);
	const publisher = new GitHubReviewPublisher({ clientFactory, logger });
	const review = await publisher.publishReview({
		installationId: config.installationId,
		owner,
		repo,
		pullNumber,
		commitSha: head.sha.toLowerCase(),
		verdict: "COMMENT",
		body: "ForgeBot smoke test. This comment verifies GitHub App review publication.",
		comments: [],
	});
	const { user } = await client.getReview(
		owner,
		repo,
		pullNumber,
		review.reviewId,
	);
	expect(user?.type).toBe("Bot");
	expect(user?.login).toEndWith("[bot]");
	if (slug !== undefined) expect(user?.login).toBe(`${slug}[bot]`);
}
