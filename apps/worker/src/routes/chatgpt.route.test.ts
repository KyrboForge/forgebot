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

	it("rejects an oversized streamed body without reading it all", async () => {
		const service = new ChatGptTestActionService();
		const limited = createChatGptRoute({
			chatgptTokens: { writeToken: "w-token" },
			chatgptTestActionService: service,
		});
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(1024));
			},
		});
		const res = await limited.fetch(
			new Request("http://localhost/test-actions", {
				method: "POST",
				headers: {
					authorization: "Bearer w-token",
					"content-type": "application/json",
				},
				body: stream,
				duplex: "half",
			} as RequestInit),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"invalid_request",
		);
		expect(pulls).toBeLessThan(10);
	});

	it("rejects an oversized Content-Length up front", async () => {
		const res = await route.request("/test-actions", {
			method: "POST",
			headers: { authorization: "Bearer w-token", "content-length": "5000" },
			body: "{}",
		});
		expect(res.status).toBe(400);
	});

	it("denies both routes with 503 when read and write tokens are equal", async () => {
		const same = createChatGptRoute({
			chatgptTokens: { readToken: "same", writeToken: "same" },
			chatgptTestActionService: new ChatGptTestActionService(),
		});
		const headers = { authorization: "Bearer same" };
		expect((await same.request("/status", { headers })).status).toBe(503);
		expect(
			(await same.request("/test-actions", { method: "POST", headers })).status,
		).toBe(503);
	});
});
