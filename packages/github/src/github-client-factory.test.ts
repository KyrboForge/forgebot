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
	it("provides minimal metadata and verifies access from the installation repository list", async () => {
		const authorizations: (string | null)[] = [];
		const { factory } = setup((request) => {
			if (request.url.pathname.endsWith("/access_tokens"))
				return tokenResponse("secret-installation-1");
			expect(request.method).toBe("GET");
			expect(request.url.pathname).toBe("/installation/repositories");
			expect(request.url.searchParams.get("per_page")).toBe("100");
			authorizations.push(request.authorization);
			return json({ total_count: 1, repositories: [repository] });
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

	it("denies an unselected public repository even when repos.get would succeed", async () => {
		const paths: string[] = [];
		const { factory } = setup((request) => {
			if (request.url.pathname.endsWith("/access_tokens"))
				return tokenResponse("secret-token");
			paths.push(request.url.pathname);
			if (request.url.pathname === "/repos/owner/repo")
				return json({ ...repository, private: false });
			return json({ total_count: 0, repositories: [] });
		});
		const client = factory.forInstallation(1);
		await expect(
			client.verifyRepositoryAccess("owner", "repo"),
		).rejects.toMatchObject({
			code: "REPOSITORY_ACCESS_DENIED",
		});
		await expect(client.getRepository("owner", "repo")).rejects.toMatchObject({
			code: "REPOSITORY_ACCESS_DENIED",
		});
		expect(paths).toEqual([
			"/installation/repositories",
			"/installation/repositories",
		]);
	});

	it("follows Link pagination to find a repository on page two", async () => {
		const pages: string[] = [];
		const { factory } = setup((request) => {
			if (request.url.pathname.endsWith("/access_tokens"))
				return tokenResponse("secret-token");
			expect(request.url.pathname).toBe("/installation/repositories");
			expect(request.url.searchParams.get("per_page")).toBe("100");
			expect(request.authorization).toBe("token secret-token");
			const page = request.url.searchParams.get("page") ?? "1";
			pages.push(page);
			if (page === "1")
				return json(
					{
						total_count: 101,
						repositories: Array.from({ length: 100 }, (_, id) => ({
							...repository,
							id,
							full_name: `owner/other-${id}`,
						})),
					},
					200,
					{
						link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
					},
				);
			return json({ total_count: 101, repositories: [repository] });
		});
		expect(
			await factory.forInstallation(1).getRepository("owner", "repo"),
		).toMatchObject({ id: 10, fullName: "owner/repo" });
		expect(pages).toEqual(["1", "2"]);
	});

	it("matches repository names case-insensitively and stops before the next page", async () => {
		let calls = 0;
		const { factory } = setup((request) => {
			if (request.url.pathname.endsWith("/access_tokens"))
				return tokenResponse("secret-token");
			calls++;
			expect(request.url.searchParams.has("page")).toBe(false);
			return json({ total_count: 2, repositories: [repository] }, 200, {
				link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
			});
		});
		expect(
			await factory.forInstallation(1).getRepository("OWNER", "Repo"),
		).toMatchObject({ fullName: "owner/repo" });
		expect(calls).toBe(1);
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
			return json({ total_count: 1, repositories: [repository] });
		});
		const one = factory.forInstallation(1);
		const two = factory.forInstallation(2);
		expect(factory.forInstallation(1)).toBe(one);
		expect(one).not.toBe(two);
		await one.getRepository("owner", "repo");
		await two.getRepository("owner", "repo");
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
				return json({ total_count: 1, repositories: [repository] });
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
		"cached",
		"in-flight",
	] as const)("preserves the %s renewal after a delayed 401 for the previous token", async (state) => {
		let now = Date.now();
		let tokenCalls = 0;
		let delayRequest = false;
		const rejectedResponse = Promise.withResolvers<Response>();
		const requestStarted = Promise.withResolvers<void>();
		const renewalResponse = Promise.withResolvers<Response>();
		const renewalStarted = Promise.withResolvers<void>();
		const seen: (string | null)[] = [];
		const { auth, factory } = setup(
			(request) => {
				if (request.url.pathname.endsWith("/access_tokens")) {
					tokenCalls++;
					if (tokenCalls === 2) {
						renewalStarted.resolve();
						return renewalResponse.promise;
					}
					return tokenResponse(
						`secret-${tokenCalls}`,
						new Date(now + 3_600_000).toISOString(),
					);
				}
				seen.push(request.authorization);
				if (delayRequest && request.authorization === "token secret-1") {
					requestStarted.resolve();
					return rejectedResponse.promise;
				}
				return json({ total_count: 1, repositories: [repository] });
			},
			() => now,
		);
		const client = factory.forInstallation(1);
		await client.getRepository("owner", "repo");
		delayRequest = true;
		const rejected = client.getRepository("owner", "repo");
		await requestStarted.promise;
		now += 3_300_001;
		const renewal = auth.getInstallationToken(1);
		await renewalStarted.promise;
		if (state === "cached") {
			renewalResponse.resolve(
				tokenResponse("secret-2", new Date(now + 3_600_000).toISOString()),
			);
			await renewal;
		}
		rejectedResponse.resolve(json({ message: "bad credentials" }, 401));
		await expect(rejected).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
		const surviving = auth.getInstallationToken(1);
		if (state === "in-flight") {
			expect(surviving).toBe(renewal);
			renewalResponse.resolve(
				tokenResponse("secret-2", new Date(now + 3_600_000).toISOString()),
			);
		}
		expect((await surviving).token).toBe("secret-2");
		await client.getRepository("owner", "repo");
		expect(tokenCalls).toBe(2);
		expect(seen).toEqual([
			"token secret-1",
			"token secret-1",
			"token secret-2",
		]);
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
