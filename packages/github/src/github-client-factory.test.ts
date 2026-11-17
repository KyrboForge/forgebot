import { describe, expect, it } from "bun:test";
import { createMockLogger } from "@forgebot/testing";
import { GitHubAppAuth } from "./github-app-auth.ts";
import {
	grantedPermissions,
	json,
	mockGitHubFetch,
	privateKey,
	repository,
	tokenResponse,
} from "./github-app-test-helpers.ts";
import { GitHubClientFactory } from "./github-client-factory.ts";

function setup(
	handler: Parameters<typeof mockGitHubFetch>[0],
	now?: () => number,
) {
	const fetch = mockGitHubFetch(handler);
	const logger = createMockLogger();
	const auth = new GitHubAppAuth({
		config: { appId: 123, privateKey },
		logger,
		fetch,
		now,
	});
	return { auth, factory: new GitHubClientFactory({ auth, logger, fetch }) };
}

describe("GitHub installation clients", () => {
	it("provides minimal repository metadata and verifies access using the installation token", async () => {
		const authorizations: (string | null)[] = [];
		const { factory } = setup((request) => {
			if (request.url.pathname.endsWith("/access_tokens"))
				return tokenResponse("secret-installation-1");
			authorizations.push(request.authorization);
			return json(repository);
		});
		const client = factory.forInstallation(1);
		await expect(
			client.verifyRepositoryAccess("owner", "repo"),
		).resolves.toBeUndefined();
		expect(await client.getRepository("owner", "repo")).toEqual({
			id: 10,
			fullName: "owner/repo",
			defaultBranch: "main",
			private: true,
			archived: false,
			htmlUrl: "https://github.com/owner/repo",
		});
		expect(authorizations).toEqual([
			"token secret-installation-1",
			"token secret-installation-1",
		]);
	});

	it("keeps clients, tokens and 401 invalidation scoped to an installation", async () => {
		const counts = new Map<string, number>();
		const seen: (string | null)[] = [];
		let deny = false;
		const { factory } = setup((request) => {
			if (request.url.pathname.endsWith("/access_tokens")) {
				const id = request.url.pathname.split("/")[3] ?? "";
				counts.set(id, (counts.get(id) ?? 0) + 1);
				return tokenResponse(`secret-${id}-${counts.get(id)}`);
			}
			seen.push(request.authorization);
			if (deny && request.authorization === "token secret-1-1")
				return json({ message: "bad credentials secret-1-1" }, 401);
			return json(repository);
		});
		const one = factory.forInstallation(1);
		const two = factory.forInstallation(2);
		expect(factory.forInstallation(1)).toBe(one);
		expect(one).not.toBe(two);
		await Promise.all([
			one.getRepository("owner", "repo"),
			two.getRepository("owner", "repo"),
		]);
		deny = true;
		await expect(one.getRepository("owner", "repo")).rejects.toMatchObject({
			code: "BAD_CREDENTIALS",
		});
		await two.getRepository("owner", "repo");
		await one.getRepository("owner", "repo");
		expect(counts.get("1")).toBe(2);
		expect(counts.get("2")).toBe(1);
		expect(seen).toEqual([
			"token secret-1-1",
			"token secret-2-1",
			"token secret-1-1",
			"token secret-2-1",
			"token secret-1-2",
		]);
	});

	it("automatically renews tokens on the same client", async () => {
		let now = Date.now();
		let calls = 0;
		const seen: (string | null)[] = [];
		const { factory } = setup(
			(request) => {
				if (request.url.pathname.endsWith("/access_tokens"))
					return tokenResponse(
						`secret-${++calls}`,
						new Date(now + 3_600_000).toISOString(),
					);
				seen.push(request.authorization);
				return json(repository);
			},
			() => now,
		);
		const client = factory.forInstallation(1);
		await client.getRepository("owner", "repo");
		now += 3_300_001;
		await client.getRepository("owner", "repo");
		expect(seen).toEqual(["token secret-1", "token secret-2"]);
	});

	it.each([
		403, 404,
	])("maps repository access denial (%i) without leaking upstream secrets", async (status) => {
		const { factory } = setup((request) =>
			request.url.pathname.endsWith("/access_tokens")
				? tokenResponse("secret-token")
				: json({ message: `secret-token ${privateKey}` }, status),
		);
		try {
			await factory.forInstallation(1).verifyRepositoryAccess("owner", "repo");
			throw new Error("Expected access denial");
		} catch (error) {
			expect(error).toMatchObject({
				code: "REPOSITORY_ACCESS_DENIED",
				cause: { status },
			});
			expect(Bun.inspect(error)).not.toContain("secret-token");
			expect(Bun.inspect(error)).not.toContain(privateKey);
			expect(JSON.stringify(error)).not.toContain("authorization");
		}
	});

	it.each([
		[{ metadata: "read", contents: "read" }, ["pull_requests:write"]],
		[
			{ metadata: "read", contents: "read", pull_requests: "read" },
			["pull_requests:write"],
		],
		[{}, ["metadata:read", "contents:read", "pull_requests:write"]],
		[grantedPermissions, []],
		[
			{
				metadata: "read",
				contents: "write",
				pull_requests: "write",
				issues: "read",
			},
			[],
		],
	] as const)("checks only the three least-privilege review permissions (%#)", async (granted, missing) => {
		const requests: string[] = [];
		const { factory } = setup((request) => {
			requests.push(request.url.pathname);
			expect(request.authorization).toStartWith("bearer ");
			return json({ permissions: granted, suspended_at: null });
		});
		expect(await factory.forInstallation(1).checkReviewPermissions()).toEqual({
			ok: missing.length === 0,
			missing,
			granted,
		});
		expect(requests).toEqual(["/app/installations/1"]);
	});

	it("rejects suspended installations while checking permissions", async () => {
		const { factory } = setup(() =>
			json({
				permissions: grantedPermissions,
				suspended_at: new Date().toISOString(),
			}),
		);
		await expect(
			factory.forInstallation(1).checkReviewPermissions(),
		).rejects.toMatchObject({ code: "INSTALLATION_NOT_FOUND_OR_REVOKED" });
	});
});
