import { describe, expect, it, mock } from "bun:test";
import createApp from "../../src/app.ts";
import { ChatGptTestActionService } from "../../src/services/chatgpt-test-action.service.ts";
import { createGitHubClientFactory } from "./github-app.fixture.ts";

describe("/health", () => {
	const app = createApp({
		chatgptTokens: {},
		chatgptTestActionService: new ChatGptTestActionService(),
		gitHubClientFactory: createGitHubClientFactory(),
		gitHubWebhookService: {
			handleWebhook: mock(),
		},
	});
	describe("(GET) /", () => {
		it("should return 200", async () => {
			const response = await app.request("/health");

			expect(response.status).toBe(200);
		});
	});
});
