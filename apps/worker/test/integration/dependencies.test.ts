import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GitHubAppConfigError } from "@forgebot/github";
import createDependencies from "../../src/dependencies.ts";
import { privateKey } from "./github-app.fixture.ts";

const variables = [
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_APP_PRIVATE_KEY_PATH",
	"GITHUB_APP_INSTALLATION_ID",
] as const;
let saved: (string | undefined)[];

beforeEach(() => {
	saved = variables.map((name) => process.env[name]);
	for (const name of variables) delete process.env[name];
});
afterEach(() => {
	variables.forEach((name, index) => {
		const value = saved[index];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	});
});

describe("worker GitHub App startup", () => {
	it("fails fast when GitHub App configuration is missing", async () => {
		await expect(createDependencies()).rejects.toBeInstanceOf(
			GitHubAppConfigError,
		);
	});

	it("builds installation clients from validated config without network requests", async () => {
		process.env.GITHUB_APP_ID = "123";
		process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
		const dependencies = await createDependencies();
		expect(dependencies.gitHubClientFactory.forInstallation(456)).toBe(
			dependencies.gitHubClientFactory.forInstallation(456),
		);
	});
});
