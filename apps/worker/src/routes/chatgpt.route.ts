import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { IChatGptTestActionService } from "../services/chatgpt-test-action.service.ts";

export type ChatGptTokens = { readToken?: string; writeToken?: string };

type ChatGptRouteDependencies = {
	chatgptTokens: ChatGptTokens;
	chatgptTestActionService: IChatGptTestActionService;
};

const MAX_BODY_BYTES = 4096;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const BEARER_PATTERN = /^Bearer (\S+)$/;

const digest = (value: string) => createHash("sha256").update(value).digest();
const tokenMatches = (candidate: string, expected: string | undefined) =>
	expected !== undefined &&
	timingSafeEqual(digest(candidate), digest(expected));

function parseTestAction(body: unknown) {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return undefined;
	const { requestId, message, ...rest } = body as Record<string, unknown>;
	if (Object.keys(rest).length > 0) return undefined;
	if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId))
		return undefined;
	if (typeof message !== "string" || message.length < 1 || message.length > 200)
		return undefined;
	return { requestId, message };
}

export default function createChatGptRoute(deps: ChatGptRouteDependencies) {
	const route = new Hono();
	const { readToken, writeToken } = deps.chatgptTokens;

	const error = (
		status: 400 | 401 | 403 | 409 | 503,
		code: string,
		message: string,
	) =>
		new Response(JSON.stringify({ error: { code, message } }), {
			status,
			headers: {
				"content-type": "application/json",
				...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
			},
		});

	// Returns an error Response, or undefined when authorized.
	const authorize = (header: string | undefined, writeOnly: boolean) => {
		if (readToken && readToken === writeToken)
			return error(503, "not_configured", "Endpoint is not configured");
		if (writeOnly ? !writeToken : !readToken && !writeToken)
			return error(503, "not_configured", "Endpoint is not configured");
		const token = header?.match(BEARER_PATTERN)?.[1];
		if (!token) return error(401, "unauthorized", "Missing or invalid token");
		if (tokenMatches(token, writeToken)) return undefined;
		if (!writeOnly && tokenMatches(token, readToken)) return undefined;
		if (writeOnly && tokenMatches(token, readToken))
			return error(403, "forbidden", "Token lacks write access");
		return error(401, "unauthorized", "Missing or invalid token");
	};

	route.get("/status", (c) => {
		const denied = authorize(c.req.header("authorization"), false);
		if (denied) return denied;
		return c.json({
			service: "ForgeBot",
			status: "ok",
			capabilities: ["github_app", "review_publisher"],
		});
	});

	route.post("/test-actions", async (c) => {
		const denied = authorize(c.req.header("authorization"), true);
		if (denied) return denied;

		const raw = await c.req.text();
		if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES)
			return error(400, "invalid_request", "Request body too large");
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return error(400, "invalid_request", "Body must be valid JSON");
		}
		const input = parseTestAction(body);
		if (!input) return error(400, "invalid_request", "Invalid request body");

		const result = deps.chatgptTestActionService.record(
			input.requestId,
			input.message,
		);
		if (result.status === "conflict")
			return error(
				409,
				"request_id_conflict",
				"requestId was already used with a different message",
			);
		const { requestId, recordedAt } = result.record;
		const duplicate = result.status === "duplicate";
		return c.json(
			{ requestId, status: "recorded", duplicate, recordedAt },
			duplicate ? 200 : 201,
		);
	});

	return route;
}
