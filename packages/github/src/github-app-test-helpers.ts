import { generateKeyPairSync } from "node:crypto";
import type { GitHubFetch } from "./github-app-auth.ts";

export const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export const grantedPermissions = {
	metadata: "read",
	contents: "read",
	pull_requests: "write",
};
export const repository = {
	id: 10,
	full_name: "owner/repo",
	default_branch: "main",
	private: true,
	archived: false,
	html_url: "https://github.com/owner/repo",
};

export interface RecordedRequest {
	url: URL;
	method: string;
	authorization: string | null;
}

export function mockGitHubFetch(
	handler: (request: RecordedRequest) => Response | Promise<Response>,
): GitHubFetch {
	return async (input, init) => {
		const original = input instanceof Request ? input : undefined;
		const url = new URL(original?.url ?? String(input));
		const response = await handler({
			url,
			method: init?.method ?? original?.method ?? "GET",
			authorization: new Headers(init?.headers ?? original?.headers).get(
				"authorization",
			),
		});
		// Fetch responses include their final URL, which Octokit pagination uses.
		if (!response.url)
			Object.defineProperty(response, "url", { value: url.toString() });
		return response;
	};
}

export function json(
	data: unknown,
	status = 200,
	headers?: Record<string, string>,
): Response {
	return Response.json(data, { status, headers });
}

export function tokenResponse(
	token: string,
	expiresAt = new Date(Date.now() + 3_600_000).toISOString(),
) {
	return json(
		{
			token,
			expires_at: expiresAt,
			permissions: grantedPermissions,
			repository_selection: "selected",
		},
		201,
	);
}
