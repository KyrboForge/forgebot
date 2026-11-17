import { generateKeyPairSync } from "node:crypto";
import { GitHubAppAuth, GitHubClientFactory } from "@forgebot/github";
import { createMockLogger } from "@forgebot/testing";

export const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export function createGitHubClientFactory() {
	const logger = createMockLogger();
	const auth = new GitHubAppAuth({ config: { appId: 1, privateKey }, logger });
	return new GitHubClientFactory({ auth, logger });
}
