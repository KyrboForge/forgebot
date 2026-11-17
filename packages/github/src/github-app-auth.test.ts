import { describe, expect, it } from "bun:test";
import { createMockLogger } from "@forgebot/testing";
import { GitHubAppError } from "./github-app.error.ts";
import { GitHubAppAuth } from "./github-app-auth.ts";
import {
	json,
	mockGitHubFetch,
	privateKey,
	tokenResponse,
} from "./github-app-test-helpers.ts";

function setup(
	handler: Parameters<typeof mockGitHubFetch>[0],
	now?: () => number,
) {
	const logger = createMockLogger();
	return {
		logger,
		auth: new GitHubAppAuth({
			config: { appId: 123, privateKey },
			logger,
			fetch: mockGitHubFetch(handler),
			now,
		}),
	};
}

describe("GitHub App auth", () => {
	it("signs an app JWT and reuses an installation token", async () => {
		let calls = 0;
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		const { auth } = setup((request) => {
			calls++;
			expect(request.method).toBe("POST");
			expect(request.url.pathname).toBe("/app/installations/456/access_tokens");
			const jwt = request.authorization?.slice("bearer ".length) ?? "";
			expect(request.authorization).toStartWith("bearer ");
			expect(
				JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString())
					.iss,
			).toBe(123);
			return tokenResponse("installation-secret", expiresAt);
		});
		expect(await auth.getInstallationToken(456)).toEqual({
			token: "installation-secret",
			expiresAt,
		});
		expect(await auth.getInstallationToken(456)).toEqual({
			token: "installation-secret",
			expiresAt,
		});
		expect(calls).toBe(1);
	});

	it("refreshes below five minutes remaining, bypassing Octokit's cache", async () => {
		let now = Date.now();
		let calls = 0;
		const { auth } = setup(
			() =>
				tokenResponse(
					`secret-${++calls}`,
					new Date(now + 3_600_000).toISOString(),
				),
			() => now,
		);
		expect((await auth.getInstallationToken(1)).token).toBe("secret-1");
		now += 3_300_000;
		expect((await auth.getInstallationToken(1)).token).toBe("secret-1");
		now++;
		expect((await auth.getInstallationToken(1)).token).toBe("secret-2");
		expect(calls).toBe(2);
	});

	it("single-flights concurrent callers and retries after failures", async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { auth } = setup(async () => {
			calls++;
			await barrier;
			if (calls === 1) return json({ message: "revoked" }, 404);
			return tokenResponse("recovered");
		});
		const pending = Array.from({ length: 10 }, () =>
			auth.getInstallationToken(1),
		);
		release?.();
		const results = await Promise.allSettled(pending);
		expect(
			results.every(
				(result) =>
					result.status === "rejected" &&
					result.reason.code === "INSTALLATION_NOT_FOUND_OR_REVOKED",
			),
		).toBe(true);
		expect(calls).toBe(1);
		const recovered = await Promise.all(
			Array.from({ length: 10 }, () => auth.getInstallationToken(1)),
		);
		expect(recovered.every(({ token }) => token === "recovered")).toBe(true);
		expect(calls).toBe(2);
	});

	it("keeps different installations and different auth instances isolated", async () => {
		const counts = new Map<string, number>();
		const { auth } = setup((request) => {
			const path = request.url.pathname;
			counts.set(path, (counts.get(path) ?? 0) + 1);
			return path.includes("/1/")
				? json({ message: "revoked" }, 404)
				: tokenResponse("second-installation");
		});
		await expect(auth.getInstallationToken(1)).rejects.toMatchObject({
			code: "INSTALLATION_NOT_FOUND_OR_REVOKED",
		});
		expect((await auth.getInstallationToken(2)).token).toBe(
			"second-installation",
		);
		auth.invalidate(1);
		expect((await auth.getInstallationToken(2)).token).toBe(
			"second-installation",
		);
		expect(counts.get("/app/installations/2/access_tokens")).toBe(1);
		const a = setup(() => tokenResponse("app-a")).auth;
		const b = setup(() => tokenResponse("app-b")).auth;
		expect(
			(
				await Promise.all([
					a.getInstallationToken(7),
					b.getInstallationToken(7),
				])
			).map(({ token }) => token),
		).toEqual(["app-a", "app-b"]);
	});

	it("does not repopulate the cache with an invalidated in-flight request", async () => {
		let release: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const { auth } = setup(async () => {
			const call = ++calls;
			if (call === 1) await barrier;
			return tokenResponse(`token-${call}`);
		});
		const pending = auth.getInstallationToken(1);
		auth.invalidate(1);
		const fresh = auth.getInstallationToken(1);
		release?.();
		await pending;
		expect((await fresh).token).toBe("token-2");
		expect((await auth.getInstallationToken(1)).token).toBe("token-2");
	});

	it("detects a malformed private key during signing without leaking it", async () => {
		const key =
			"-----BEGIN PRIVATE KEY-----\nmalformed-secret-key\n-----END PRIVATE KEY-----";
		const auth = new GitHubAppAuth({
			config: { appId: 1, privateKey: key },
			logger: createMockLogger(),
			fetch: mockGitHubFetch(() => {
				throw new Error("Network should not be used");
			}),
		});
		try {
			await auth.getInstallationToken(1);
			throw new Error("Expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(GitHubAppError);
			expect(error).toMatchObject({ code: "INVALID_PRIVATE_KEY" });
			expect(Bun.inspect(error)).not.toContain("malformed-secret-key");
		}
	});

	it("logs only installation IDs, expiry and actions, never credentials", async () => {
		const { auth, logger } = setup(() => tokenResponse("unique-secret-token"));
		await auth.getInstallationToken(1);
		auth.invalidate(1);
		for (const method of [
			logger.debug,
			logger.info,
			logger.warn,
			logger.error,
		]) {
			const calls = (method as ReturnType<typeof import("bun:test").mock>).mock
				.calls;
			const rendered = JSON.stringify(calls);
			expect(rendered).not.toContain("unique-secret-token");
			expect(rendered).not.toContain(privateKey.split("\n")[1] ?? privateKey);
			for (const [, context] of calls) {
				expect(
					Object.keys(context ?? {}).every((key) =>
						["installationId", "expiresAt"].includes(key),
					),
				).toBe(true);
			}
		}
	});
});
