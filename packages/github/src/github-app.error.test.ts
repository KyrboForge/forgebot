import { describe, expect, it } from "bun:test";
import { createMockLogger } from "@forgebot/testing";
import { mapGitHubAppError } from "./github-app.error.ts";
import { GitHubAppAuth } from "./github-app-auth.ts";
import {
	json,
	mockGitHubFetch,
	privateKey,
} from "./github-app-test-helpers.ts";

describe("GitHub error mapping", () => {
	it.each([
		[401, {}, "BAD_CREDENTIALS"],
		[403, {}, "INSUFFICIENT_PERMISSIONS"],
		[404, {}, "INSTALLATION_NOT_FOUND_OR_REVOKED"],
		[403, { "x-ratelimit-remaining": "0" }, "RATE_LIMITED"],
		[403, { "retry-after": "60" }, "RATE_LIMITED"],
		[429, {}, "RATE_LIMITED"],
		[500, {}, "GITHUB_API_ERROR"],
	] as const)("maps token creation status %i safely (%#)", async (status, headers, code) => {
		const logger = createMockLogger();
		const auth = new GitHubAppAuth({
			config: { appId: 1, privateKey },
			logger,
			fetch: mockGitHubFetch(() =>
				json({ message: `secret-token ${privateKey}` }, status, headers),
			),
		});
		try {
			await auth.getInstallationToken(1);
			throw new Error("Expected upstream failure");
		} catch (error) {
			expect(error).toMatchObject({ code, cause: { status } });
			const rendered = Bun.inspect(error);
			for (const secret of [
				"secret-token",
				privateKey,
				"authorization",
				"Bearer",
				"eyJ",
			])
				expect(rendered).not.toContain(secret);
		}
	});

	it("maps suspension separately from insufficient permissions", () => {
		expect(
			mapGitHubAppError(
				{
					status: 403,
					response: {
						data: { message: "This installation has been suspended" },
					},
				},
				"installation",
			).code,
		).toBe("INSTALLATION_NOT_FOUND_OR_REVOKED");
	});

	it("discards sensitive network errors and maps app permission failures", async () => {
		const auth = new GitHubAppAuth({
			config: { appId: 1, privateKey },
			logger: createMockLogger(),
			fetch: mockGitHubFetch(() => {
				throw new Error(`secret-token ${privateKey}`);
			}),
		});
		await expect(auth.getInstallationToken(1)).rejects.toMatchObject({
			code: "GITHUB_API_ERROR",
		});
		expect(mapGitHubAppError({ status: 403 }, "app")).toMatchObject({
			code: "INSUFFICIENT_PERMISSIONS",
			cause: { status: 403 },
		});
		expect(
			mapGitHubAppError(
				{
					status: 403,
					response: { data: { message: "Secondary rate limit" } },
				},
				"repository",
			).code,
		).toBe("RATE_LIMITED");
	});
});
