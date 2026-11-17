export type GitHubAppErrorCode =
	| "INVALID_CONFIG"
	| "INVALID_PRIVATE_KEY"
	| "BAD_CREDENTIALS"
	| "INSTALLATION_NOT_FOUND_OR_REVOKED"
	| "REPOSITORY_ACCESS_DENIED"
	| "INSUFFICIENT_PERMISSIONS"
	| "RATE_LIMITED"
	| "GITHUB_API_ERROR";

export class GitHubAppError extends Error {
	override readonly name: string = "GitHubAppError";

	constructor(
		readonly code: GitHubAppErrorCode,
		// Only sanitized metadata is retained, never the upstream RequestError.
		override readonly cause?: Readonly<{ status: number }>,
	) {
		super(code);
	}
}

export type GitHubAppConfigVariable =
	| "GITHUB_APP_ID"
	| "GITHUB_APP_PRIVATE_KEY"
	| "GITHUB_APP_PRIVATE_KEY_PATH"
	| "GITHUB_APP_INSTALLATION_ID";

export class GitHubAppConfigError extends GitHubAppError {
	override readonly name = "GitHubAppConfigError";

	constructor(readonly variables: readonly GitHubAppConfigVariable[]) {
		super("INVALID_CONFIG");
		this.message = `Invalid GitHub App configuration: ${variables.join(", ")}`;
	}
}

export type GitHubApiOperation = "app" | "installation" | "repository";

export function mapGitHubAppError(
	error: unknown,
	operation: GitHubApiOperation,
): GitHubAppError {
	if (error instanceof GitHubAppError) return error;
	const upstream = error as {
		status?: number;
		response?: {
			headers?: Record<string, string>;
			data?: { message?: string };
		};
	} | null;
	const status =
		typeof upstream?.status === "number" ? upstream.status : undefined;
	const headers = upstream?.response?.headers;
	const message = upstream?.response?.data?.message ?? "";
	let code: GitHubAppErrorCode = "GITHUB_API_ERROR";
	if (
		status === 429 ||
		(status === 403 &&
			(headers?.["x-ratelimit-remaining"] === "0" ||
				headers?.["retry-after"] !== undefined ||
				/rate limit|abuse detection/i.test(message)))
	) {
		code = "RATE_LIMITED";
	} else if (status === 401) {
		code = "BAD_CREDENTIALS";
	} else if (
		operation === "installation" &&
		(status === 404 || (status === 403 && /suspend|revok/i.test(message)))
	) {
		code = "INSTALLATION_NOT_FOUND_OR_REVOKED";
	} else if (operation === "repository" && (status === 404 || status === 403)) {
		code = "REPOSITORY_ACCESS_DENIED";
	} else if (status === 403) {
		code = "INSUFFICIENT_PERMISSIONS";
	}
	return new GitHubAppError(
		code,
		status === undefined ? undefined : { status },
	);
}
