import { describe, expect, it, mock } from "bun:test";
import createApp from "../../src/app.ts";
import {
	ChatGptTestActionService,
	type IChatGptTestActionService,
} from "../../src/services/chatgpt-test-action.service.ts";

const READ = "read-token-value";
const WRITE = "write-token-value";
const throwingFactory = new Proxy(
	{},
	{
		get() {
			throw new Error("GitHub client factory must not be used");
		},
	},
) as never;

function setup(
	tokens: { readToken?: string; writeToken?: string } = {
		readToken: READ,
		writeToken: WRITE,
	},
	service: IChatGptTestActionService = new ChatGptTestActionService(),
) {
	const app = createApp({
		chatgptTokens: tokens,
		chatgptTestActionService: service,
		gitHubClientFactory: throwingFactory,
		gitHubWebhookService: { handleWebhook: mock() },
	});
	const get = (token?: string, scheme = "Bearer") =>
		app.request("/api/chatgpt/status", {
			headers: token ? { authorization: `${scheme} ${token}` } : {},
		});
	const post = (body: unknown, token: string | null = WRITE) =>
		app.request("/api/chatgpt/test-actions", {
			method: "POST",
			headers: token ? { authorization: `Bearer ${token}` } : {},
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	return { get, post };
}

const valid = { requestId: "request-0001", message: "hello" };

describe("GET /api/chatgpt/status", () => {
	it("returns ok for read and write tokens", async () => {
		const { get } = setup();
		for (const token of [READ, WRITE]) {
			const res = await get(token);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				service: "ForgeBot",
				status: "ok",
				capabilities: ["github_app", "review_publisher"],
			});
		}
	});

	it("rejects missing, wrong and malformed credentials with 401", async () => {
		const { get } = setup();
		for (const res of [
			await get(),
			await get("nope"),
			await get(READ, "Basic"),
		]) {
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe("Bearer");
			expect(await res.json()).toMatchObject({
				error: { code: "unauthorized" },
			});
		}
	});

	it("fails closed with 503 when no token is configured", async () => {
		const res = await setup({}).get("anything");
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			error: { code: "not_configured" },
		});
	});
});

describe("POST /api/chatgpt/test-actions", () => {
	it("rejects the read token with 403 and no credentials with 401", async () => {
		const { post } = setup();
		expect((await post(valid, READ)).status).toBe(403);
		expect((await post(valid, null)).status).toBe(401);
		expect((await post(valid, "wrong")).status).toBe(401);
	});

	it("returns 503 and records nothing when the write token is unset", async () => {
		const service = { record: mock() };
		const res = await setup({ readToken: READ }, service).post(valid, READ);
		expect(res.status).toBe(503);
		expect(service.record).not.toHaveBeenCalled();
	});

	it("returns 503 and records nothing when read and write tokens are equal", async () => {
		const service = { record: mock() };
		const res = await setup(
			{ readToken: READ, writeToken: READ },
			service,
		).post(valid, READ);
		expect(res.status).toBe(503);
		expect(service.record).not.toHaveBeenCalled();
	});

	it("rejects invalid payloads with 400 and never echoes input", async () => {
		const service = { record: mock() };
		const { post } = setup(undefined, service);
		const bodies = [
			"not json",
			{},
			{ requestId: "short", message: "hi" },
			{ requestId: "request-0001", message: "" },
			{ requestId: "request-0001", message: "x".repeat(201) },
			{ ...valid, repository: "o/r" },
			{ ...valid, token: "secret-leak" },
			[],
			JSON.stringify({ ...valid, message: "x".repeat(5000) }),
		];
		for (const body of bodies) {
			const res = await post(body);
			expect(res.status).toBe(400);
			const text = await res.text();
			expect(JSON.parse(text)).toMatchObject({
				error: { code: "invalid_request" },
			});
			expect(text).not.toContain("secret-leak");
		}
		expect(service.record).not.toHaveBeenCalled();
	});

	it("records once, dedupes identical retries and conflicts on changed message", async () => {
		const service = new ChatGptTestActionService();
		const record = mock(service.record.bind(service));
		const { post } = setup(undefined, { record });

		const first = await post(valid);
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as { recordedAt: string };
		expect(firstBody).toMatchObject({
			requestId: valid.requestId,
			status: "recorded",
			duplicate: false,
		});
		expect(new Date(firstBody.recordedAt).toISOString()).toBe(
			firstBody.recordedAt,
		);

		const again = await post(valid);
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ ...firstBody, duplicate: true });

		const conflict = await post({ ...valid, message: "different" });
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			error: { code: "request_id_conflict" },
		});
	});
});
