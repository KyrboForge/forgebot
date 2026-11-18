import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

export type McpAppOptions = {
	apiUrl: string;
	readToken: string;
	writeToken: string;
	pluginToken?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const statusSchema = {
	type: "object",
	properties: {
		service: { type: "string" },
		status: { type: "string" },
		capabilities: { type: "array", items: { type: "string" } },
	},
	required: ["service", "status", "capabilities"],
};
const confirmationSchema = {
	type: "object",
	properties: {
		requestId: { type: "string" },
		status: { type: "string", enum: ["recorded"] },
		duplicate: { type: "boolean" },
		recordedAt: { type: "string" },
	},
	required: ["requestId", "status", "duplicate", "recordedAt"],
};

const TOOLS = [
	{
		name: "get_forgebot_status",
		description: "Read-only ForgeBot service status and capabilities.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: statusSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			openWorldHint: false,
			idempotentHint: true,
		},
	},
	{
		name: "create_test_action",
		description:
			"Harmless sandbox write: records a test message in ForgeBot. Never touches GitHub. Safe to retry with the same requestId.",
		inputSchema: {
			type: "object",
			properties: {
				requestId: {
					type: "string",
					pattern: REQUEST_ID.source,
					description: "Idempotency key, 8-64 chars of A-Z a-z 0-9 _ -",
				},
				message: { type: "string", minLength: 1, maxLength: 200 },
			},
			required: ["requestId", "message"],
			additionalProperties: false,
		},
		outputSchema: confirmationSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
];

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const sameToken = (a: string, b: string) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

const toolError = (text: string) => ({
	isError: true,
	content: [{ type: "text", text }],
});

class InvalidParams extends Error {}

export function createMcpApp(opts: McpAppOptions) {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 5000;
	const base = opts.apiUrl.replace(/\/+$/, "");

	// Only these two fixed backend paths are ever called; no generic proxy.
	async function backend(
		path: "/api/chatgpt/status" | "/api/chatgpt/test-actions",
		token: string,
		body: unknown,
		valid: (v: Record<string, unknown>) => boolean,
	) {
		try {
			const res = await doFetch(`${base}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const data: unknown = await res.json().catch(() => undefined);
			if (!res.ok) {
				const code =
					isObject(data) &&
					isObject(data.error) &&
					typeof data.error.code === "string"
						? data.error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
						: "";
				return toolError(
					`ForgeBot API request failed (HTTP ${res.status}${code ? `, ${code}` : ""}).`,
				);
			}
			if (!isObject(data) || !valid(data)) {
				return toolError("ForgeBot API returned an unexpected response.");
			}
			return {
				structuredContent: data,
				content: [{ type: "text", text: JSON.stringify(data) }],
			};
		} catch {
			return toolError("ForgeBot API is unreachable or timed out.");
		}
	}

	async function callTool(name: unknown, args: unknown) {
		if (name === "get_forgebot_status") {
			if (
				args !== undefined &&
				!(isObject(args) && Object.keys(args).length === 0)
			) {
				throw new InvalidParams("get_forgebot_status takes no arguments");
			}
			return backend(
				"/api/chatgpt/status",
				opts.readToken,
				undefined,
				(d) =>
					typeof d.service === "string" &&
					typeof d.status === "string" &&
					Array.isArray(d.capabilities) &&
					d.capabilities.every((c) => typeof c === "string"),
			);
		}
		if (name === "create_test_action") {
			if (
				!isObject(args) ||
				Object.keys(args).some((k) => k !== "requestId" && k !== "message") ||
				typeof args.requestId !== "string" ||
				!REQUEST_ID.test(args.requestId) ||
				typeof args.message !== "string" ||
				args.message.length < 1 ||
				args.message.length > 200
			) {
				throw new InvalidParams("invalid arguments for create_test_action");
			}
			const { requestId, message } = args;
			return backend(
				"/api/chatgpt/test-actions",
				opts.writeToken,
				{ requestId, message },
				(d) =>
					d.requestId === requestId &&
					d.status === "recorded" &&
					typeof d.duplicate === "boolean" &&
					typeof d.recordedAt === "string",
			);
		}
		throw new InvalidParams("unknown tool");
	}

	const app = new Hono();
	app.all("/mcp", async (c) => {
		if (c.req.method !== "POST") return c.body(null, 405, { Allow: "POST" });
		// Sites normally handles sign-in between ChatGPT and the MCP server, so this is
		// defense in depth for non-Sites hosting. Origin/CORS are NOT auth.
		if (opts.pluginToken !== undefined) {
			const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
			if (!m?.[1] || !sameToken(m[1], opts.pluginToken)) {
				return c.json({ error: "unauthorized" }, 401);
			}
		}
		const err = (id: unknown, code: number, message: string) =>
			c.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

		let msg: unknown;
		try {
			msg = await c.req.json();
		} catch {
			return err(null, -32700, "Parse error");
		}
		if (!isObject(msg) || typeof msg.method !== "string") {
			return err(null, -32600, "Invalid Request");
		}
		const { id, method, params } = msg;
		const ok = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });

		switch (method) {
			case "initialize":
				return ok({
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "forgebot-chatgpt-plugin", version: "0.1.0" },
				});
			case "notifications/initialized":
				return c.body(null, 202);
			case "ping":
				return ok({});
			case "tools/list":
				return ok({ tools: TOOLS });
			case "tools/call": {
				if (!isObject(params)) return err(id, -32602, "Invalid params");
				try {
					return ok(await callTool(params.name, params.arguments));
				} catch (e) {
					if (e instanceof InvalidParams) return err(id, -32602, e.message);
					return ok(toolError("Internal error."));
				}
			}
			default:
				return err(id, -32601, "Method not found");
		}
	});
	return app;
}
