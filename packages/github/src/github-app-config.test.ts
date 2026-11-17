import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubAppConfigError } from "./github-app.error.ts";
import { loadGitHubAppConfig } from "./github-app-config.ts";

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const ecPrivateKey = generateKeyPairSync("ec", {
	namedCurve: "prime256v1",
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const malformedPrivateKey =
	"-----BEGIN PRIVATE KEY-----\nmalformed-secret-key\n-----END PRIVATE KEY-----";

describe("GitHub App config", () => {
	it("loads numeric IDs and normalizes escaped PEM newlines", async () => {
		expect(
			await loadGitHubAppConfig({
				GITHUB_APP_ID: "123",
				GITHUB_APP_PRIVATE_KEY: privateKey.replaceAll("\n", "\\n"),
				GITHUB_APP_INSTALLATION_ID: "456",
			}),
		).toEqual({ appId: 123, privateKey, installationId: 456 });
	});

	it("loads a PEM file without requiring a default installation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forgebot-key-"));
		try {
			const path = join(directory, "key.pem");
			await Bun.write(path, privateKey);
			expect(
				await loadGitHubAppConfig({
					GITHUB_APP_ID: "123",
					GITHUB_APP_PRIVATE_KEY_PATH: path,
				}),
			).toEqual({ appId: 123, privateKey });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		[
			{},
			[
				"GITHUB_APP_ID",
				"GITHUB_APP_PRIVATE_KEY",
				"GITHUB_APP_PRIVATE_KEY_PATH",
			],
		],
		[
			{
				GITHUB_APP_ID: "secret-app",
				GITHUB_APP_PRIVATE_KEY: "secret-key",
				GITHUB_APP_INSTALLATION_ID: "-1",
			},
			["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"],
		],
		[
			{
				GITHUB_APP_ID: "1",
				GITHUB_APP_PRIVATE_KEY: privateKey,
				GITHUB_APP_PRIVATE_KEY_PATH: "secret-path",
			},
			["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_PATH"],
		],
		[
			{
				GITHUB_APP_ID: "1",
				GITHUB_APP_PRIVATE_KEY_PATH: "/does-not-exist/secret-path",
			},
			["GITHUB_APP_PRIVATE_KEY_PATH"],
		],
		[
			{ GITHUB_APP_ID: "9007199254740992", GITHUB_APP_PRIVATE_KEY: privateKey },
			["GITHUB_APP_ID"],
		],
		[
			{ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: malformedPrivateKey },
			["GITHUB_APP_PRIVATE_KEY"],
		],
		[
			{ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: ecPrivateKey },
			["GITHUB_APP_PRIVATE_KEY"],
		],
	] as const)("rejects missing/invalid configuration without exposing values: %#", async (env, variables) => {
		try {
			await loadGitHubAppConfig(env);
			throw new Error("Expected invalid config");
		} catch (error) {
			expect(error).toBeInstanceOf(GitHubAppConfigError);
			const configError = error as GitHubAppConfigError;
			expect(configError.variables).toEqual(variables);
			expect(configError.code).toBe("INVALID_CONFIG");
			const rendered = Bun.inspect(error);
			for (const secret of [
				privateKey,
				ecPrivateKey,
				"malformed-secret-key",
				"secret-app",
				"secret-key",
				"secret-path",
			]) {
				expect(rendered).not.toContain(secret);
			}
		}
	});
});
