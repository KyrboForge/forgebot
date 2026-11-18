import { describe, expect, it, type Mock } from "bun:test";
import { createMockLogger } from "@forgebot/testing";
import type { GitHubFetch } from "./github-app-auth.ts";
import {
	grantedPermissions,
	json,
	mockGitHubFetch,
	privateKey,
	repository,
	tokenResponse,
} from "./github-app-test-helpers.ts";
import {
	GitHubAppAuth,
	GitHubClientFactory,
	GitHubReviewPublisher,
	type InlineReviewComment,
	type PublishReviewInput,
} from "./index.ts";

const sha = "a".repeat(40);
const nextSha = "b".repeat(40);
const prPath = "/repos/owner/repo/pulls/7";
const reviewUrl = "https://github.com/owner/repo/pull/7#pullrequestreview-27";
const installationToken = "secret-installation-token";
const pat = "github_pat_1234567890abcdef";
const textFile = {
	filename: "src/current.ts",
	status: "modified",
	patch:
		"@@ -10,3 +10,3 @@\n context\n-old\n+new\n another\n@@ -30 +30 @@\n-before\n+after",
};
const inline = {
	path: textFile.filename,
	line: 11,
	side: "RIGHT",
	body: "Keep `value` as-is.",
} as const satisfies InlineReviewComment;
const pr = {
	state: "open",
	head: { sha: sha.toUpperCase() },
	base: { sha: "c".repeat(40), ref: "main" },
};
const review = { id: 27, html_url: reviewUrl, commit_id: sha };
let installationId = 0;

function setup(overrides?: RequestOverride, now?: () => number) {
	const requests: string[] = [];
	const posts: unknown[] = [];
	const postRedirects: RequestInit["redirect"][] = [];
	const logger = createMockLogger();
	const mockFetch = mockGitHubFetch(async (request) => {
		const path = request.url.pathname.toLowerCase();
		requests.push(path);
		const response = await overrides?.(request);
		if (response) return response;
		if (path.endsWith("/access_tokens"))
			return tokenResponse(installationToken);
		if (path === "/installation/repositories")
			return json({ total_count: 1, repositories: [repository] });
		if (path.startsWith("/app/installations/"))
			return json({ permissions: grantedPermissions, suspended_at: null });
		if (path === prPath) return json(pr);
		if (path === `${prPath}/files`) return json([textFile]);
		if (path === `${prPath}/reviews`) {
			const post = posts.at(-1) as { event: string };
			const state = {
				APPROVE: "APPROVED",
				REQUEST_CHANGES: "CHANGES_REQUESTED",
				COMMENT: "COMMENTED",
			}[post.event];
			return json({ ...review, state });
		}
		throw new Error("Unexpected GitHub request");
	});
	const fetch: GitHubFetch = (input, init) => {
		if (
			init?.method === "POST" &&
			new URL(String(input)).pathname.endsWith("/reviews")
		) {
			posts.push(JSON.parse(String(init.body)));
			postRedirects.push(init.redirect);
		}
		return mockFetch(input, init);
	};
	const auth = new GitHubAppAuth({
		config: { appId: 123, privateKey },
		logger,
		fetch,
		now,
	});
	const clientFactory = new GitHubClientFactory({ auth, logger, fetch });
	const publisher = new GitHubReviewPublisher({ clientFactory, logger });
	const input: PublishReviewInput = {
		installationId: ++installationId,
		owner: "owner",
		repo: "repo",
		pullNumber: 7,
		commitSha: sha,
		baseSha: "c".repeat(40),
		verdict: "COMMENT",
		body: "Review summary",
		comments: [],
	};
	return {
		publisher,
		clientFactory,
		input,
		posts,
		postRedirects,
		requests,
		logger,
	};
}

type RequestOverride = (
	request: Parameters<Parameters<typeof mockGitHubFetch>[0]>[0],
) => Response | Promise<Response> | undefined;

describe("GitHubReviewPublisher", () => {
	it("posts an APPROVE with an empty summary", async () => {
		const { publisher, input, posts } = setup();
		await expect(
			publisher.publishReview({ ...input, verdict: "APPROVE", body: "" }),
		).resolves.toEqual({
			reviewId: 27,
			url: reviewUrl,
			commitSha: sha,
			verdict: "APPROVE",
		});
		expect(posts).toEqual([
			{ commit_id: sha, event: "APPROVE", body: "", comments: [] },
		]);
	});

	it("posts one REQUEST_CHANGES review with verbatim summary and inline comments", async () => {
		const { publisher, input, posts, postRedirects, requests } = setup();
		const body = `  Please fix \${value} & "quotes".\n`;
		const multiline = {
			...inline,
			line: 12,
			startLine: 10,
			startSide: "RIGHT" as const,
		};
		await expect(
			publisher.publishReview({
				...input,
				verdict: "REQUEST_CHANGES",
				body,
				comments: [inline, multiline],
			}),
		).resolves.toMatchObject({ verdict: "REQUEST_CHANGES" });
		expect(posts).toEqual([
			{
				commit_id: sha,
				event: "REQUEST_CHANGES",
				body,
				comments: [
					{
						path: textFile.filename,
						line: 11,
						side: "RIGHT",
						body: inline.body,
					},
					{
						path: textFile.filename,
						line: 12,
						side: "RIGHT",
						start_line: 10,
						start_side: "RIGHT",
						body: inline.body,
					},
				],
			},
		]);
		expect(postRedirects).toEqual(["error"]);
		expect(requests).toEqual([
			`/app/installations/${input.installationId}/access_tokens`,
			"/installation/repositories",
			`/app/installations/${input.installationId}`,
			prPath,
			`${prPath}/files`,
			prPath,
			`${prPath}/reviews`,
		]);
	});

	it("posts a summary-only COMMENT", async () => {
		const { publisher, input, posts } = setup();
		await expect(publisher.publishReview(input)).resolves.toMatchObject({
			verdict: "COMMENT",
		});
		expect(posts).toEqual([
			{ commit_id: sha, event: "COMMENT", body: input.body, comments: [] },
		]);
	});

	it.each([
		["commit", { commit_id: nextSha, state: "COMMENTED" }],
		["verdict", { commit_id: sha, state: "CHANGES_REQUESTED" }],
	] as const)("blocks duplicate after GitHub reports the wrong %s", async (_field, mismatch) => {
		const { publisher, input, posts, logger } = setup(({ url }) =>
			url.pathname.endsWith("/reviews")
				? json({ ...review, ...mismatch })
				: undefined,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "PUBLICATION_OUTCOME_UNKNOWN",
			reviewId: 27,
		});
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "DUPLICATE_SUBMISSION",
		});
		expect(posts).toHaveLength(1);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("rejects an unexpected response state and blocks a duplicate POST", async () => {
		const { publisher, input, posts } = setup(({ url }) =>
			url.pathname.endsWith("/reviews")
				? json({ ...review, state: "PENDING" })
				: undefined,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "PUBLICATION_OUTCOME_UNKNOWN",
			reviewId: 27,
		});
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "DUPLICATE_SUBMISSION",
		});
		expect(posts).toHaveLength(1);
	});

	it("rejects a repository outside the installation selection", async () => {
		const { publisher, input, requests, posts } = setup(({ url }) =>
			url.pathname === "/installation/repositories"
				? json({ total_count: 0, repositories: [] })
				: undefined,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "REPOSITORY_ACCESS_DENIED",
		});
		expect(requests).not.toContain(prPath);
		expect(posts).toHaveLength(0);
	});

	it("names the missing review permission", async () => {
		const { publisher, input, requests, posts } = setup(({ url }) =>
			url.pathname.startsWith("/app/installations/") &&
			!url.pathname.endsWith("/access_tokens")
				? json({
						permissions: { ...grantedPermissions, pull_requests: "read" },
						suspended_at: null,
					})
				: undefined,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "INSUFFICIENT_PERMISSIONS",
			missing: ["pull_requests:write"],
		});
		expect(requests).not.toContain(prPath);
		expect(posts).toHaveLength(0);
	});

	it("returns an empty missing list when GitHub denies the permission lookup", async () => {
		const { publisher, input, posts } = setup(({ url }) =>
			url.pathname === `/app/installations/${input.installationId}`
				? json({ message: "Forbidden" }, 403)
				: undefined,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "INSUFFICIENT_PERMISSIONS",
			missing: [],
			cause: { status: 403 },
		});
		expect(posts).toHaveLength(0);
	});

	it.each([
		["PULL_REQUEST_NOT_FOUND", () => json({ message: "Not Found" }, 404)],
		["PULL_REQUEST_CLOSED", () => json({ ...pr, state: "closed" })],
		["STALE_REVIEW_COMMIT", () => json({ ...pr, head: { sha: nextSha } })],
		["GITHUB_API_ERROR", () => json({ message: "Server error" }, 500)],
	] as const)("stops before listing files for %s", async (code, response) => {
		const { publisher, input, posts, requests } = setup(({ url }) =>
			url.pathname === prPath ? response() : undefined,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code,
		});
		expect(requests).not.toContain(`${prPath}/files`);
		expect(posts).toHaveLength(0);
	});

	it("rechecks the PR after listing files and rejects a moved head", async () => {
		let read = false;
		const { publisher, input, posts, requests } = setup(({ url }) => {
			if (url.pathname !== prPath) return;
			if (read) return json({ ...pr, head: { sha: nextSha } });
			read = true;
		});
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "STALE_REVIEW_COMMIT",
		});
		expect(requests.slice(-3)).toEqual([prPath, `${prPath}/files`, prPath]);
		expect(posts).toHaveLength(0);
	});

	it("rejects a LEFT comment when the base changed before publication", async () => {
		const { publisher, input, posts, requests } = setup(({ url }) => {
			if (url.pathname === prPath)
				return json({ ...pr, base: { sha: nextSha, ref: "release" } });
			if (url.pathname === `${prPath}/files`)
				return json([{ ...textFile, patch: "@@ -11 +11 @@\n-other\n+new" }]);
		});

		await expect(
			publisher.publishReview({
				...input,
				comments: [{ ...inline, side: "LEFT" }],
			}),
		).rejects.toMatchObject({ code: "STALE_REVIEW_COMMIT" });
		expect(requests.filter((path) => path === prPath)).toHaveLength(1);
		expect(requests).not.toContain(`${prPath}/files`);
		expect(posts).toHaveLength(0);
	});

	it.each([
		["sha", { ...pr.base, sha: nextSha }],
		["ref", { ...pr.base, ref: "release" }],
	] as const)("rejects a moved base %s with an unchanged head", async (_field, base) => {
		let reads = 0;
		const { publisher, input, posts, requests } = setup(({ url }) =>
			url.pathname === prPath && ++reads === 2
				? json({ ...pr, base })
				: undefined,
		);
		await expect(
			publisher.publishReview({
				...input,
				comments: [{ ...inline, side: "LEFT" }],
			}),
		).rejects.toMatchObject({ code: "STALE_REVIEW_COMMIT" });
		expect(requests.slice(-3)).toEqual([prPath, `${prPath}/files`, prPath]);
		expect(posts).toHaveLength(0);
	});

	it("posts a LEFT-to-RIGHT range in hunk order with decreasing line numbers", async () => {
		const { publisher, input, posts } = setup(({ url }) =>
			url.pathname.endsWith("/files")
				? json([{ ...textFile, patch: "@@ -20 +10 @@\n-old\n+new" }])
				: undefined,
		);
		await publisher.publishReview({
			...input,
			comments: [{ ...inline, line: 10, startLine: 20, startSide: "LEFT" }],
		});
		expect(posts).toEqual([
			{
				commit_id: sha,
				event: "COMMENT",
				body: input.body,
				comments: [
					{
						path: inline.path,
						body: inline.body,
						line: 10,
						side: "RIGHT",
						start_line: 20,
						start_side: "LEFT",
					},
				],
			},
		]);
	});

	it("validates LEFT-side comments on renamed and removed files across file pages", async () => {
		const renamed = {
			filename: "renamed.ts",
			previous_filename: "original.ts",
			status: "renamed",
			patch: "@@ -8 +8 @@\n-before\n+after",
		};
		const removed = {
			filename: "deleted.ts",
			status: "removed",
			patch: "@@ -4,2 +0,0 @@\n-first\n-second",
		};
		const pages: string[] = [];
		const { publisher, input, posts } = setup(({ url }) => {
			if (!url.pathname.endsWith("/files")) return;
			expect(url.searchParams.get("per_page")).toBe("100");
			const page = url.searchParams.get("page") ?? "1";
			pages.push(page);
			return page === "1"
				? json([renamed], 200, {
						link: `<https://api.github.com${prPath}/files?per_page=100&page=2>; rel="next"`,
					})
				: json([removed]);
		});
		await publisher.publishReview({
			...input,
			comments: [
				{ ...inline, path: renamed.filename, side: "LEFT", line: 8 },
				{
					...inline,
					path: removed.filename,
					side: "LEFT",
					line: 5,
					startLine: 4,
					startSide: "LEFT",
				},
			],
		});
		expect(pages).toEqual(["1", "2"]);
		expect(posts).toEqual([
			{
				commit_id: sha,
				event: "COMMENT",
				body: input.body,
				comments: [
					{ body: inline.body, path: renamed.filename, line: 8, side: "LEFT" },
					{
						body: inline.body,
						path: removed.filename,
						line: 5,
						side: "LEFT",
						start_line: 4,
						start_side: "LEFT",
					},
				],
			},
		]);
	});

	it.each([
		["unknown path", { path: "missing.ts" }],
		["old rename path", { path: "old.ts" }],
		["line outside the diff", { line: 22 }],
		["file without patch", { path: "binary.png" }],
		["range between hunks", { line: 30, startLine: 12, startSide: "RIGHT" }],
		[
			"mixed range between hunks",
			{ line: 30, startLine: 11, startSide: "LEFT" },
		],
		["reversed mixed range", { line: 10, startLine: 11, startSide: "LEFT" }],
		[
			"mixed range on one context row",
			{ line: 10, startLine: 10, startSide: "LEFT" },
		],
		[
			"mixed range with start missing on its side",
			{ line: 12, startLine: 9, startSide: "LEFT" },
		],
		[
			"RIGHT side of a deletion",
			{ path: "deleted.ts", line: 11, side: "RIGHT" },
		],
	] as const)("rejects %s with the comment index", async (_name, changes) => {
		const { publisher, input, posts } = setup(({ url }) =>
			url.pathname.endsWith("/files")
				? json([
						{ ...textFile, status: "renamed", previous_filename: "old.ts" },
						{ filename: "binary.png", status: "modified" },
						{
							filename: "deleted.ts",
							status: "removed",
							patch: "@@ -11 +0,0 @@\n-deleted",
						},
					])
				: undefined,
		);
		await expect(
			publisher.publishReview({
				...input,
				comments: [inline, { ...inline, ...changes }],
			}),
		).rejects.toMatchObject({
			code: "INVALID_INLINE_COMMENT_LOCATION",
			commentIndex: 1,
		});
		expect(posts).toHaveLength(0);
	});

	it.each([
		["installationId", { installationId: 0 }],
		["installationId", { installationId: Number.MAX_SAFE_INTEGER + 1 }],
		["installationId", { installationId: 1.5 }],
		["pullNumber", { pullNumber: -1 }],
		["pullNumber", { pullNumber: Number.MAX_SAFE_INTEGER + 1 }],
		["owner", { owner: "" }],
		["owner", { owner: "." }],
		["owner", { owner: "owner\n" }],
		["repo", { repo: ".." }],
		["repo", { repo: "other/repo" }],
		["commitSha", { commitSha: sha.toUpperCase() }],
		["commitSha", { commitSha: sha.slice(1) }],
		["commitSha", { commitSha: "z".repeat(40) }],
		["baseSha", { baseSha: "C".repeat(40) }],
		["baseSha", { baseSha: "c".repeat(39) }],
		["baseSha", { baseSha: undefined }],
		["verdict", { verdict: "PENDING" }],
		["body", { body: 42 }],
		["body", { body: "" }],
		["body", { body: " ", comments: [inline] }],
		["body", { verdict: "REQUEST_CHANGES", body: " \n" }],
		["body", { body: "x".repeat(65537) }],
		["comments", { comments: null }],
		["comments", { comments: Array.from({ length: 51 }, () => inline) }],
		["comments[0]", { comments: [null] }],
	] as const)("validates %s before any network call (%#)", async (field, changes) => {
		const { publisher, input, requests } = setup();
		await expect(
			publisher.publishReview({ ...input, ...changes } as PublishReviewInput),
		).rejects.toMatchObject({
			code: "INVALID_REVIEW_PAYLOAD",
			fields: [field],
		});
		expect(requests).toEqual([]);
	});

	it.each([
		["path", { path: "" }],
		["path", { path: "/absolute.ts" }],
		["path", { path: "src/../outside.ts" }],
		["path", { path: "src/\0file.ts" }],
		["body", { body: "" }],
		["body", { body: "x".repeat(65537) }],
		["line", { line: 0 }],
		["line", { line: 1.5 }],
		["side", { side: "CENTER" }],
		["startSide", { startLine: 10 }],
		["startLine", { startSide: "RIGHT" }],
		["startLine", { startSide: "RIGHT", startLine: 11 }],
		["startLine", { startSide: "RIGHT", startLine: 0 }],
		["startSide", { startSide: "CENTER", startLine: 10 }],
	] as const)("validates inline %s before any network call (%#)", async (field, changes) => {
		const { publisher, input, requests } = setup();
		await expect(
			publisher.publishReview({
				...input,
				comments: [{ ...inline, ...changes }],
			} as PublishReviewInput),
		).rejects.toMatchObject({
			code: "INVALID_REVIEW_PAYLOAD",
			fields: [`comments[0].${field}`],
		});
		expect(requests).toEqual([]);
	});

	it.each([
		["APPROVE", "Can not approve your own pull request"],
		["REQUEST_CHANGES", "Cannot request changes on your own pull request"],
	] as const)("classifies a rejected %s without downgrading the verdict", async (verdict, message) => {
		const { publisher, input, posts } = setup(({ url }) =>
			url.pathname.endsWith("/reviews") ? json({ message }, 422) : undefined,
		);
		await expect(
			publisher.publishReview({ ...input, verdict, body: "approve" }),
		).rejects.toMatchObject({
			code: "REVIEW_VERDICT_REJECTED",
			cause: { status: 422 },
		});
		expect(posts).toEqual([
			{ commit_id: sha, event: verdict, body: "approve", comments: [] },
		]);
	});

	it.each([
		"line",
		"path",
		"side",
		"start_line",
		"start_side",
		"position",
	])("classifies a structured GitHub %s failure without a diagnostic message", async (field) => {
		const { publisher, input } = setup(({ url }) =>
			url.pathname.endsWith("/reviews")
				? json(
						{
							message: "Validation Failed",
							errors: [
								{
									resource: "PullRequestReviewComment",
									code: "invalid",
									field,
								},
							],
						},
						422,
					)
				: undefined,
		);
		await expect(
			publisher.publishReview({ ...input, comments: [inline] }),
		).rejects.toMatchObject({
			code: "INVALID_INLINE_COMMENT_LOCATION",
			cause: { status: 422, field },
			commentIndex: 0,
		});
	});

	it("classifies invalid review comments from a structured GitHub rejection", async () => {
		const { publisher, input } = setup(({ url }) =>
			url.pathname.endsWith("/reviews")
				? json(
						{
							errors: [
								{ resource: "PullRequestReviewComment", code: "invalid" },
							],
						},
						409,
					)
				: undefined,
		);
		await expect(
			publisher.publishReview({ ...input, comments: [inline] }),
		).rejects.toMatchObject({
			code: "INVALID_REVIEW_PAYLOAD",
			fields: ["comments"],
			cause: { status: 409 },
		});
	});

	it("classifies a known GitHub conflict without retaining its diagnostic", async () => {
		const { publisher, input } = setup(({ url }) =>
			url.pathname.endsWith("/reviews")
				? json({ message: "Can not approve your own pull request" }, 409)
				: undefined,
		);
		await expect(
			publisher.publishReview({ ...input, verdict: "APPROVE" }),
		).rejects.toMatchObject({
			code: "REVIEW_VERDICT_REJECTED",
			cause: { status: 409 },
		});
	});

	it("classifies a nested GitHub diff error by location", async () => {
		const { publisher, input, posts } = setup(({ url }) =>
			url.pathname.endsWith("/reviews")
				? json(
						{
							message: "Validation Failed",
							errors: [
								{ message: "comments[1].start_line is outside the diff" },
							],
						},
						422,
					)
				: undefined,
		);
		await expect(
			publisher.publishReview({ ...input, comments: [inline, inline] }),
		).rejects.toMatchObject({
			code: "INVALID_INLINE_COMMENT_LOCATION",
			commentIndex: 1,
		});
		expect(posts).toHaveLength(1);
	});

	it.each([429, 403])("classifies rate limiting (%i)", async (status) => {
		const { publisher, input, posts } = setup(({ url }) =>
			url.pathname.endsWith("/reviews")
				? json(
						{ message: "blocked" },
						status,
						status === 403 ? { "x-ratelimit-remaining": "0" } : undefined,
					)
				: undefined,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "RATE_LIMITED",
			cause: { status },
		});
		expect(posts).toHaveLength(1);
	});

	it.each([
		401, 403, 404, 409,
	])("allows a retry after a definite %i POST failure", async (status) => {
		let fail = true;
		const { publisher, input, requests, posts } = setup(({ url }) => {
			if (url.pathname.endsWith("/reviews") && fail)
				return json({ message: "rejected" }, status);
		});
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "GITHUB_API_ERROR",
			cause: { status },
		});
		expect(posts).toHaveLength(1);
		fail = false;
		await expect(publisher.publishReview(input)).resolves.toMatchObject({
			reviewId: 27,
		});
		expect(posts).toHaveLength(2);
		expect(
			requests.filter((path) => path.endsWith("/access_tokens")),
		).toHaveLength(status === 401 ? 2 : 1);
	});

	it.each([
		[
			"network",
			() => {
				throw new TypeError("network request failed");
			},
		],
		[
			"abort",
			() => {
				throw new DOMException("Request cancelled", "AbortError");
			},
		],
		["502", () => json({ message: "Bad Gateway" }, 502)],
	] as const)("blocks an identical submission after an unknown %s POST outcome", async (_name, response) => {
		const { publisher, input, posts, requests } = setup(({ url }) =>
			url.pathname.endsWith("/reviews") ? response() : undefined,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "PUBLICATION_OUTCOME_UNKNOWN",
		});
		const requestCount = requests.length;
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "DUPLICATE_SUBMISSION",
		});
		expect(requests).toHaveLength(requestCount);
		expect(posts).toHaveLength(1);
	});

	it("releases the duplicate key when token refresh fails before dispatching the POST", async () => {
		let now = Date.now();
		let tokenRequests = 0;
		let pullRequests = 0;
		const { publisher, input, posts } = setup(
			({ url }) => {
				if (url.pathname.endsWith("/access_tokens")) {
					if (++tokenRequests === 2)
						return json({ message: "Bad Gateway" }, 502);
					return tokenResponse(
						installationToken,
						new Date(now + 3_600_000).toISOString(),
					);
				}
				if (url.pathname === prPath && ++pullRequests === 2) now += 3_600_000;
			},
			() => now,
		);
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "GITHUB_API_ERROR",
			cause: { status: 502 },
		});
		expect(posts).toHaveLength(0);
		await expect(publisher.publishReview(input)).resolves.toMatchObject({
			reviewId: 27,
		});
		expect(posts).toHaveLength(1);
	});

	it("releases the duplicate key after a preflight failure and a definite 422", async () => {
		let failGet = true;
		let failPost = true;
		const { publisher, input, posts } = setup(({ url }) => {
			if (url.pathname === prPath && failGet)
				return json({ message: "Server error" }, 500);
			if (url.pathname.endsWith("/reviews") && failPost)
				return json({ message: "Validation Failed" }, 422);
		});
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "GITHUB_API_ERROR",
		});
		expect(posts).toHaveLength(0);
		failGet = false;
		await expect(publisher.publishReview(input)).rejects.toMatchObject({
			code: "INVALID_REVIEW_PAYLOAD",
			fields: [],
		});
		expect(posts).toHaveLength(1);
		failPost = false;
		await expect(publisher.publishReview(input)).resolves.toMatchObject({
			reviewId: 27,
		});
		expect(posts).toHaveLength(2);
	});

	it("rejects a canonical duplicate in flight and returns the cached result afterward", async () => {
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const { publisher, clientFactory, logger, input, posts, requests } = setup(
			({ url }) => {
				if (!url.pathname.endsWith("/reviews")) return;
				started.resolve();
				return response.promise;
			},
		);
		const first = publisher.publishReview({ ...input, comments: [inline] });
		await started.promise;
		const duplicate = {
			...input,
			owner: "OWNER",
			repo: "REPO",
			comments: [
				{
					body: inline.body,
					side: inline.side,
					line: inline.line,
					path: inline.path,
					startLine: undefined,
					startSide: undefined,
				},
			],
		};
		const secondPublisher = new GitHubReviewPublisher({
			clientFactory,
			logger,
		});
		const requestCount = requests.length;
		try {
			await expect(
				secondPublisher.publishReview(duplicate),
			).rejects.toMatchObject({ code: "DUPLICATE_SUBMISSION" });
		} finally {
			response.resolve(json({ ...review, state: "COMMENTED" }));
		}
		const published = await first;
		expect(await secondPublisher.publishReview(duplicate)).toEqual(published);
		expect(requests).toHaveLength(requestCount);
		expect(posts).toHaveLength(1);
	});

	it("discards a 422 diagnostic that echoes JSON-escaped review text and credentials", async () => {
		const body =
			'private-review-body\n"another private line with an invalid path"';
		const diagnostic = "upstream validation marker";
		const { publisher, input, posts, logger } = setup(({ url }) => {
			if (!url.pathname.endsWith("/reviews")) return;
			const submitted = posts.at(-1) as { body: string };
			return json(
				{
					message: `${diagnostic} ${JSON.stringify(submitted.body)} ${installationToken} ${pat} Authorization: bearer naked-credential`,
					errors: [
						{ resource: "PullRequestReview", code: "invalid", field: "body" },
					],
				},
				422,
				{ "x-private-header": "private-header-value" },
			);
		});
		const error = await publisher
			.publishReview({ ...input, body })
			.catch((error: unknown) => error);
		if (!(error instanceof Error)) throw new Error("Expected review error");
		const logs = [logger.debug, logger.info, logger.warn, logger.error].flatMap(
			(log) => (log as Mock<typeof log>).mock.calls,
		);
		for (const output of [
			error.message,
			JSON.stringify(error.cause),
			JSON.stringify(error),
			JSON.stringify(logs),
		]) {
			for (const secret of [
				"private-review-body",
				"another private line",
				diagnostic,
				installationToken,
				pat,
				"private-header-value",
				"naked-credential",
			]) {
				expect(output).not.toContain(secret);
			}
		}
		expect(error).toMatchObject({
			code: "INVALID_REVIEW_PAYLOAD",
			fields: ["body"],
		});
		expect(error.cause).toEqual({ status: 422, field: "body" });
	});

	it("evicts the oldest successes at capacity and keeps in-flight and unknown outcomes", async () => {
		// Isolate the process-wide duplicate map from the other publisher tests.
		const isolatedModule = "./github-review-publisher.ts?capacity";
		const {
			GitHubReviewPublisher: IsolatedPublisher,
		}: typeof import("./github-review-publisher.ts") = await import(
			isolatedModule
		);
		const gate = Promise.withResolvers<void>();
		let outcome: "success" | "unknown" | "pending" = "success";
		const { input, posts, clientFactory, logger } = setup(({ url }) => {
			if (!url.pathname.endsWith("/reviews")) return;
			if (outcome === "unknown") return json({}, 502);
			if (outcome === "pending") return gate.promise.then(() => json({}, 422));
		});
		const publisher = new IsolatedPublisher({ clientFactory, logger });
		const oldest = { ...input, body: "oldest success" };
		const second = { ...input, body: "second success" };
		const unknown = { ...input, body: "unknown outcome" };
		await publisher.publishReview(oldest);
		const cached = await publisher.publishReview(second);
		outcome = "unknown";
		await expect(publisher.publishReview(unknown)).rejects.toMatchObject({
			code: "PUBLICATION_OUTCOME_UNKNOWN",
		});
		outcome = "pending";
		const pendingInput = { ...input, body: "pending 0" };
		const pending = Array.from({ length: 997 }, (_, i) =>
			publisher
				.publishReview({ ...input, body: `pending ${i}` })
				.catch((error: unknown) => error),
		);
		const overflow = { ...input, body: "first overflow" };
		const attempt = (payload: PublishReviewInput) => {
			const result = publisher
				.publishReview(payload)
				.catch((error: unknown) => error);
			pending.push(result);
			return result;
		};
		try {
			attempt(overflow);
			expect(await publisher.publishReview(second)).toBe(cached);
			attempt(oldest);
			const blocked = [
				unknown,
				pendingInput,
				oldest,
				overflow,
				second,
				{ ...input, body: "over capacity" },
			].map(attempt);
			gate.resolve();
			for (const rejection of blocked) {
				expect(await rejection).toMatchObject({ code: "DUPLICATE_SUBMISSION" });
			}
		} finally {
			gate.resolve();
			await Promise.all(pending);
		}
		const bodies = posts.map((post) => (post as { body: string }).body);
		expect(bodies.filter((body) => body === oldest.body)).toHaveLength(2);
		expect(bodies.filter((body) => body === second.body)).toHaveLength(1);
		expect(bodies.filter((body) => body === unknown.body)).toHaveLength(1);
		expect(bodies.filter((body) => body === overflow.body)).toHaveLength(1);
		expect(bodies).not.toContain("over capacity");
	});
});
