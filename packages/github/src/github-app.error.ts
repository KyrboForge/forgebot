export type GitHubAppErrorCode =
	| "INVALID_CONFIG"
	| "INVALID_PRIVATE_KEY"
	| "BAD_CREDENTIALS"
	| "INSTALLATION_NOT_FOUND_OR_REVOKED"
	| "REPOSITORY_ACCESS_DENIED"
	| "INSUFFICIENT_PERMISSIONS"
	| "RATE_LIMITED"
	| "GITHUB_API_ERROR";

export type GitHubRateLimit = Readonly<{
	retryAfter?: number;
	reset?: number;
}>;

export class GitHubAppError extends Error {
	declare readonly rateLimit?: GitHubRateLimit;
	override readonly name: string = "GitHubAppError";

	constructor(
		readonly code: GitHubAppErrorCode,
		// Only sanitized metadata is retained, never the upstream RequestError.
		override readonly cause?: Readonly<{ status: number }>,
		rateLimit?: GitHubRateLimit,
	) {
		super(code);
		if (rateLimit) this.rateLimit = rateLimit;
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

export type GitHubApiOperation =
	| "app"
	| "installation"
	| "repository"
	| "pullRequest";

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
	} else if (operation !== "pullRequest" && status === 403) {
		code = "INSUFFICIENT_PERMISSIONS";
	}
	return new GitHubAppError(
		code,
		status === undefined ? undefined : { status },
		code === "RATE_LIMITED" ? readRateLimit(headers) : undefined,
	);
}

function readRateLimit(
	headers: Record<string, string> | undefined,
): GitHubRateLimit | undefined {
	const retryAfter = numericHeader(headers?.["retry-after"]);
	const reset = numericHeader(headers?.["x-ratelimit-reset"]);
	if (retryAfter === undefined && reset === undefined) return undefined;
	return {
		...(retryAfter === undefined ? {} : { retryAfter }),
		...(reset === undefined ? {} : { reset }),
	};
}

function numericHeader(value: string | undefined): number | undefined {
	if (!value || /[^0-9]/.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : undefined;
}

const INLINE_FIELDS = [
	"line",
	"path",
	"side",
	"start_line",
	"start_side",
	"position",
] as const;
const PAYLOAD_FIELDS = [
	["body", "body", /\bbody\b/i],
	["comments", "comments", /\bcomments\b/i],
	["event", "verdict", /\b(?:event|verdict)\b/i],
	["commit_id", "commitSha", /\bcommit_id\b/i],
] as const;

type PullRequestField =
	| (typeof INLINE_FIELDS)[number]
	| (typeof PAYLOAD_FIELDS)[number][0];

export type GitHubPullRequestErrorCause = Readonly<{
	status: number;
	field?: PullRequestField;
}>;

type PullRequestRejection =
	| { code: "REVIEW_VERDICT_REJECTED"; field?: undefined }
	| {
			code: "INVALID_INLINE_COMMENT_LOCATION";
			field?: (typeof INLINE_FIELDS)[number];
			commentIndex?: number;
	  }
	| {
			code: "INVALID_REVIEW_PAYLOAD";
			field?: (typeof PAYLOAD_FIELDS)[number][0];
			fields: readonly string[];
	  };

export class GitHubPullRequestRequestError extends GitHubAppError {
	constructor(
		code: GitHubAppErrorCode,
		override readonly cause?: GitHubPullRequestErrorCause,
		readonly rejection?: PullRequestRejection,
		rateLimit?: GitHubRateLimit,
	) {
		super(code, cause, rateLimit);
	}
}

export function mapGitHubPullRequestError(
	error: unknown,
): GitHubPullRequestRequestError {
	const upstream = error as {
		response?: { data?: { message?: unknown; errors?: unknown } };
	} | null;
	// Octokit may assign a synthetic 500 to errors without an HTTP response.
	const mapped = mapGitHubAppError(
		upstream?.response ? error : undefined,
		"pullRequest",
	);
	const status = mapped.cause?.status;
	if (status === undefined)
		return new GitHubPullRequestRequestError(mapped.code);
	const rejection =
		status === 422 || status === 409
			? classifyPullRequestRejection(status, upstream?.response?.data)
			: undefined;
	const field = rejection?.field;
	return new GitHubPullRequestRequestError(
		mapped.code,
		field === undefined ? { status } : { status, field },
		rejection,
		mapped.rateLimit,
	);
}

const OWN_REVIEW_MESSAGE =
	/\b(?:can\s*not|can't)\s+(?:approve|request changes (?:on|for))\s+(?:your|their) own pull request\b/i;
// Location diagnostics: "<subject> <problem>" or "<problem> <subject>".
const LOCATION_SUBJECT =
	"(?:lines?|path|diff(?: hunk)?|position|side|start_line|start_side)";
const LOCATION_MESSAGES = [
	new RegExp(
		String.raw`\b${LOCATION_SUBJECT}\s+is (?:outside|invalid|not|missing)`,
		"i",
	),
	new RegExp(
		String.raw`\b${LOCATION_SUBJECT}\s+could(?: not|n't) be resolved`,
		"i",
	),
	new RegExp(String.raw`\b${LOCATION_SUBJECT}\s+can(?:not|'t) be`, "i"),
	new RegExp(String.raw`\b${LOCATION_SUBJECT}\s+(?:must|does not)\b`, "i"),
	new RegExp(String.raw`\b(?:invalid|missing)\s+${LOCATION_SUBJECT}\b`, "i"),
];

type RejectionData = { message?: unknown; errors?: unknown } | undefined;

function collectDiagnostics(data: RejectionData): {
	messages: string[];
	structuredFields: Set<unknown>;
} {
	const messages: string[] = [];
	const structuredFields = new Set<unknown>();
	if (typeof data?.message === "string") messages.push(data.message);
	if (!Array.isArray(data?.errors)) return { messages, structuredFields };
	for (const detail of data.errors as unknown[]) {
		if (typeof detail === "string") {
			messages.push(detail);
		} else if (detail && typeof detail === "object") {
			collectDetail(
				detail as Record<string, unknown>,
				messages,
				structuredFields,
			);
		}
	}
	return { messages, structuredFields };
}

function collectDetail(
	{ field, message, resource, code }: Record<string, unknown>,
	messages: string[],
	structuredFields: Set<unknown>,
): void {
	structuredFields.add(field);
	if (
		field === undefined &&
		resource === "PullRequestReviewComment" &&
		(code === "invalid" || code === "missing_field")
	) {
		structuredFields.add("comments");
	}
	if (typeof message === "string") messages.push(message);
}

function classifyPullRequestRejection(
	status: number,
	data: RejectionData,
): PullRequestRejection | undefined {
	const { messages, structuredFields } = collectDiagnostics(data);

	// Classify the original diagnostics. Only fixed codes, fields and numeric
	// indices can leave this function.
	if (messages.some((message) => OWN_REVIEW_MESSAGE.test(message))) {
		return { code: "REVIEW_VERDICT_REJECTED" };
	}

	const inlineField = INLINE_FIELDS.find((field) =>
		structuredFields.has(field),
	);
	const structuredPayloadFields = PAYLOAD_FIELDS.filter(([field]) =>
		structuredFields.has(field),
	);
	const locationMessage = messages.find((message) =>
		LOCATION_MESSAGES.some((pattern) => pattern.test(message)),
	);
	if (inlineField || (!structuredPayloadFields.length && locationMessage)) {
		const index = Number(
			/\bcomments\[(\d+)\]/i.exec(locationMessage ?? "")?.[1],
		);
		return {
			code: "INVALID_INLINE_COMMENT_LOCATION",
			field: inlineField,
			commentIndex: Number.isSafeInteger(index) ? index : undefined,
		};
	}

	const fields = structuredPayloadFields.length
		? structuredPayloadFields
		: PAYLOAD_FIELDS.filter(([, , pattern]) =>
				messages.some((message) => pattern.test(message)),
			);
	if (status === 422 || fields.length) {
		return {
			code: "INVALID_REVIEW_PAYLOAD",
			field: fields[0]?.[0],
			fields: fields.map(([, field]) => field),
		};
	}
}
