import { describe, expect, test } from "bun:test";
import { createMcpApp } from "./mcp-app.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-only loose JSON
type Rpc = any;
type Call = { url: string; init: RequestInit };
const auth = (c: Call | undefined) =>
	((c as Call).init.headers as Record<string, string>).Authorization;
const OK_STATUS = {
	service: "ForgeBot",
	status: "ok",
	capabilities: ["github_app", "review_publisher"],
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

function setup(
	respond: (call: Call) => Response | Promise<Response> = () => json(OK_STATUS),
	opts: { pluginToken?: string; timeoutMs?: number } = {},
) {
	const calls: Call[] = [];
	const app = createMcpApp({
		apiUrl: "https://api.example.test",
		readToken: "READ",
		writeToken: "WRITE",
		fetch: ((url: string, init: RequestInit) => {
			const call = { url, init };
			calls.push(call);
			return Promise.resolve(respond(call));
		}) as unknown as typeof fetch,
		...opts,
	});
	const rpc = async (body: unknown, headers: Record<string, string> = {}) =>
		app.request("/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	const call = async (name: string, args: unknown) => {
		const res = await rpc({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		});
		return (await res.json()) as Rpc;
	};
	return { app, calls, rpc, call };
}

const REQ = { requestId: "req-12345678", message: "hello" };
const CONFIRM = {
	requestId: "req-12345678",
	status: "recorded",
	duplicate: false,
	recordedAt: "2026-11-18T00:00:00.000Z",
};

describe("protocol", () => {
	test("initialize", async () => {
		const { rpc } = setup();
		const body: Rpc = await (
			await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
		).json();
		expect(body.result.protocolVersion).toBe("2025-06-18");
		expect(body.result.capabilities).toEqual({ tools: {} });
		expect(body.result.serverInfo.name).toBeString();
	});

	test("notifications/initialized -> 202 no body", async () => {
		const { rpc } = setup();
		const res = await rpc({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(res.status).toBe(202);
		expect(await res.text()).toBe("");
	});

	test("ping", async () => {
		const { rpc } = setup();
		const body: Rpc = await (
			await rpc({ jsonrpc: "2.0", id: 2, method: "ping" })
		).json();
		expect(body.result).toEqual({});
	});

	test("tools/list shapes", async () => {
		const { rpc } = setup();
		const body: Rpc = await (
			await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })
		).json();
		const tools = body.result.tools;
		expect(tools.map((t: { name: string }) => t.name)).toEqual([
			"get_forgebot_status",
			"create_test_action",
		]);
		expect(tools[0].inputSchema).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		});
		expect(tools[0].annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			openWorldHint: false,
			idempotentHint: true,
		});
		expect(tools[0].outputSchema).toBeObject();
		expect(tools[1].inputSchema.required.sort()).toEqual([
			"message",
			"requestId",
		]);
		expect(tools[1].inputSchema.additionalProperties).toBe(false);
		expect(Object.keys(tools[1].inputSchema.properties).sort()).toEqual([
			"message",
			"requestId",
		]);
		expect(tools[1].annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(tools[1].outputSchema).toBeObject();
		expect(tools[1].description).toContain("GitHub");
	});

	test("unknown method -> -32601", async () => {
		const { rpc } = setup();
		const body: Rpc = await (
			await rpc({ jsonrpc: "2.0", id: 1, method: "nope" })
		).json();
		expect(body.error.code).toBe(-32601);
	});

	test("invalid JSON -> -32700", async () => {
		const { rpc } = setup();
		const body: Rpc = await (await rpc("{nope")).json();
		expect(body.error.code).toBe(-32700);
	});

	test("unknown tool / bad params -> -32602", async () => {
		const { call, rpc } = setup();
		expect((await call("nope", {})).error.code).toBe(-32602);
		const body: Rpc = await (
			await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: 5 })
		).json();
		expect(body.error.code).toBe(-32602);
	});

	test("GET /mcp -> 405", async () => {
		const { app } = setup();
		expect((await app.request("/mcp")).status).toBe(405);
	});
});

describe("inbound auth", () => {
	const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
	test("missing/invalid -> 401, valid ok", async () => {
		const { rpc } = setup(undefined, { pluginToken: "secret" });
		expect((await rpc(ping)).status).toBe(401);
		expect((await rpc(ping, { authorization: "Bearer wrong" })).status).toBe(
			401,
		);
		expect((await rpc(ping, { authorization: "Bearer secrets" })).status).toBe(
			401,
		);
		expect((await rpc(ping, { authorization: "Bearer secret" })).status).toBe(
			200,
		);
	});
});

describe("get_forgebot_status", () => {
	test("success uses read token and fixed path", async () => {
		const { call, calls } = setup();
		const body = await call("get_forgebot_status", {});
		expect(body.result.isError).toBeUndefined();
		expect(body.result.structuredContent).toEqual(OK_STATUS);
		expect(JSON.parse(body.result.content[0].text)).toEqual(OK_STATUS);
		expect(calls[0]?.url).toBe("https://api.example.test/api/chatgpt/status");
		expect(auth(calls[0])).toBe("Bearer READ");
	});

	test("rejects arguments", async () => {
		const { call, calls } = setup();
		expect((await call("get_forgebot_status", { x: 1 })).error.code).toBe(
			-32602,
		);
		expect(calls).toHaveLength(0);
	});

	test("backend 401 -> isError without leaking", async () => {
		const { call } = setup(() =>
			json({ error: { code: "unauthorized", message: "READ" } }, 401),
		);
		const body = await call("get_forgebot_status", {});
		expect(body.result.isError).toBe(true);
		expect(JSON.stringify(body)).not.toContain("READ");
	});

	test("malformed shape -> isError", async () => {
		const { call } = setup(() => json({ hi: 1 }));
		expect((await call("get_forgebot_status", {})).result.isError).toBe(true);
	});
});

describe("create_test_action", () => {
	test("success uses write token and POSTs body", async () => {
		const { call, calls } = setup(() => json(CONFIRM, 201));
		const body = await call("create_test_action", REQ);
		expect(body.result.isError).toBeUndefined();
		expect(body.result.structuredContent).toEqual(CONFIRM);
		expect(calls[0]?.url).toBe(
			"https://api.example.test/api/chatgpt/test-actions",
		);
		expect(calls[0]?.init.method).toBe("POST");
		expect(auth(calls[0])).toBe("Bearer WRITE");
		expect(JSON.parse(calls[0]?.init.body as string)).toEqual(REQ);
	});

	test("rejects extra keys without calling fetch", async () => {
		const { call, calls } = setup();
		const body = await call("create_test_action", {
			...REQ,
			repository: "o/r",
		});
		expect(body.error.code).toBe(-32602);
		expect(calls).toHaveLength(0);
	});

	test("rejects invalid requestId/message", async () => {
		const { call, calls } = setup();
		for (const args of [
			{ requestId: "short", message: "x" },
			{ requestId: "bad id!bad id!", message: "x" },
			{ requestId: "a".repeat(65), message: "x" },
			{ requestId: "req-12345678", message: "" },
			{ requestId: "req-12345678", message: "x".repeat(201) },
			{ requestId: "req-12345678" },
			{ requestId: 12345678, message: "x" },
		]) {
			expect((await call("create_test_action", args)).error.code).toBe(-32602);
		}
		expect(calls).toHaveLength(0);
	});

	test("duplicate surfaced", async () => {
		const dup = { ...CONFIRM, duplicate: true };
		const { call } = setup(() => json(dup, 200));
		expect(
			(await call("create_test_action", REQ)).result.structuredContent,
		).toEqual(dup);
	});

	test("409 surfaced as isError", async () => {
		const { call } = setup(() =>
			json({ error: { code: "request_id_conflict", message: "x" } }, 409),
		);
		const body = await call("create_test_action", REQ);
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toContain("request_id_conflict");
	});

	test("mismatched requestId in response -> isError", async () => {
		const { call } = setup(() =>
			json({ ...CONFIRM, requestId: "other-1234" }, 201),
		);
		expect((await call("create_test_action", REQ)).result.isError).toBe(true);
	});

	test("fetch rejects -> isError, no leak", async () => {
		const { call } = setup(() => {
			throw new Error("boom secret-stack");
		});
		const body = await call("create_test_action", REQ);
		expect(body.result.isError).toBe(true);
		expect(JSON.stringify(body)).not.toContain("secret-stack");
	});

	test("timeout -> isError", async () => {
		const app = createMcpApp({
			apiUrl: "https://api.example.test",
			readToken: "R",
			writeToken: "W",
			timeoutMs: 20,
			fetch: ((_u: string, init: RequestInit) =>
				new Promise((_, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				})) as unknown as typeof fetch,
		});
		const res = await app.request("/mcp", {
			method: "POST",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create_test_action", arguments: REQ },
			}),
		});
		const body: Rpc = await res.json();
		expect(body.result.isError).toBe(true);
	});

	test("non-JSON backend body -> isError", async () => {
		const { call } = setup(() => new Response("<html>", { status: 201 }));
		expect((await call("create_test_action", REQ)).result.isError).toBe(true);
	});
});
