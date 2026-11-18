import { describe, expect, it } from "bun:test";
import { ChatGptTestActionService } from "../services/chatgpt-test-action.service.ts";
import createChatGptRoute from "./chatgpt.route.ts";

describe("chatgpt route", () => {
	const route = createChatGptRoute({
		chatgptTokens: { readToken: "r-token", writeToken: "w-token" },
		chatgptTestActionService: new ChatGptTestActionService(),
	});

	it("authorizes status with the read token only as bearer", async () => {
		expect(
			(
				await route.request("/status", {
					headers: { authorization: "Bearer r-token" },
				})
			).status,
		).toBe(200);
		expect(
			(
				await route.request("/status", {
					headers: { authorization: "r-token" },
				})
			).status,
		).toBe(401);
	});

	it("denies writes with the read token", async () => {
		const res = await route.request("/test-actions", {
			method: "POST",
			headers: { authorization: "Bearer r-token" },
			body: "{}",
		});
		expect(res.status).toBe(403);
	});
});
