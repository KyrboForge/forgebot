import { createPrivateKey } from "node:crypto";
import {
	GitHubAppConfigError,
	type GitHubAppConfigVariable,
} from "./github-app.error.ts";

export interface GitHubAppConfig {
	readonly appId: number;
	readonly privateKey: string;
	readonly installationId?: number;
}

function parseId(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const id = Number(value);
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export async function loadGitHubAppConfig(
	env: Readonly<Record<string, string | undefined>>,
): Promise<GitHubAppConfig> {
	const invalid: GitHubAppConfigVariable[] = [];
	const appId = parseId(env.GITHUB_APP_ID);
	if (appId === undefined) invalid.push("GITHUB_APP_ID");
	const inline = env.GITHUB_APP_PRIVATE_KEY;
	const path = env.GITHUB_APP_PRIVATE_KEY_PATH;
	let privateKey = "";
	if ((inline !== undefined) === (path !== undefined)) {
		invalid.push("GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_PATH");
	} else {
		const keyVariable: GitHubAppConfigVariable =
			path !== undefined
				? "GITHUB_APP_PRIVATE_KEY_PATH"
				: "GITHUB_APP_PRIVATE_KEY";
		try {
			privateKey = (
				path !== undefined ? await Bun.file(path).text() : (inline ?? "")
			).replaceAll(String.raw`\n`, "\n");
		} catch {
			// File errors can contain sensitive paths; report only the variable name.
		}
		try {
			const keyObject = createPrivateKey(privateKey);
			if (keyObject.asymmetricKeyType !== "rsa") {
				invalid.push(keyVariable);
			}
		} catch {
			invalid.push(keyVariable);
		}
	}
	const installationId = parseId(env.GITHUB_APP_INSTALLATION_ID);
	if (
		env.GITHUB_APP_INSTALLATION_ID !== undefined &&
		installationId === undefined
	) {
		invalid.push("GITHUB_APP_INSTALLATION_ID");
	}
	if (invalid.length || appId === undefined)
		throw new GitHubAppConfigError(invalid);
	return {
		appId,
		privateKey,
		...(installationId === undefined ? {} : { installationId }),
	};
}
