import { describe, expect, it } from "bun:test";
import type { ReviewInput } from "@forgebot/core";
import { createMockLogger } from "@forgebot/testing";
import {
	json,
	mockGitHubFetch,
	privateKey,
	repository,
	tokenResponse,
} from "./github-app-test-helpers.ts";
import {
	DEFAULT_GITHUB_REVIEW_INPUT_LIMITS,
	GitHubAppAuth,
	GitHubClientFactory,
	GitHubReviewError,
	GitHubReviewInputReader,
	type IGitHubReviewInputReader,
	type ReadGitHubReviewInput,
} from "./index.ts";

const input = {
	installationId: 21,
	owner: "owner",
	repo: "repo",
	pullNumber: 7,
} satisfies ReadGitHubReviewInput;
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

const baseSha = "A".repeat(40);
const headSha = "b".repeat(40);
const prUrl = "https://github.com/owner/repo/pull/7";
const prPath = "/repos/owner/repo/pulls/7";
const patch = "@@ -1 +1 @@\n-old\n+new";
const file = { filename: "src/current.ts", status: "modified", patch };

const pull = {
	number: 7,
	state: "open",
	html_url: prUrl,
	changed_files: 1,
	base: { sha: baseSha, ref: "main" },
	head: { sha: headSha, ref: "feature" },
};

function setup({
	initial = pull,
	final = initial,
	files = () => json([file]),
	access = () => json({ total_count: 1, repositories: [repository] }),
}: {
	initial?: Record<string, unknown> | Response;
	final?: Record<string, unknown> | Response;
	files?: (page: number) => Response;
	access?: () => Response;
} = {}) {
	const requests: string[] = [];
	const pages: [page: number, perPage: string | null][] = [];
	let pullReads = 0;
	const logger = createMockLogger();
	const fetch = mockGitHubFetch(({ url, authorization }) => {
		const path = url.pathname;
		requests.push(path);
		if (path.endsWith("/access_tokens"))
			return tokenResponse("installation-token");
		expect(authorization).toBe("token installation-token");
		if (path === "/installation/repositories") return access();
		if (path === prPath) {
			const data = pullReads++ === 0 ? initial : final;
			return data instanceof Response ? data : json(data);
		}
		if (path === `${prPath}/files`) {
			const page = Number(url.searchParams.get("page"));
			pages.push([page, url.searchParams.get("per_page")]);
			return files(page);
		}
		throw new Error("Unexpected GitHub request");
	});
	const auth = new GitHubAppAuth({
		config: { appId: 123, privateKey },
		logger,
		fetch,
	});
	const clientFactory = new GitHubClientFactory({ auth, logger, fetch });
	const client = clientFactory.forInstallation(input.installationId);
	// biome-ignore lint/complexity/useLiteralKeys: Spy on the private Octokit client without widening its public surface.
	const octokit = client["octokit"];
	octokit.paginate = new Proxy(octokit.paginate, {
		apply() {
			throw new Error("Unbounded Octokit pagination called");
		},
	});
	const reader = new GitHubReviewInputReader({ clientFactory });
	return { reader, requests, pages };
}

function listedFiles(count: number, reportedTotal = count) {
	return setup({
		initial: { ...pull, changed_files: reportedTotal },
		files: (page) => {
			const start = (page - 1) * 100;
			return json(
				Array.from(
					{ length: Math.max(0, Math.min(100, count - start)) },
					(_, index) => ({
						filename: `src/file-${start + index}.ts`,
						status: "modified",
					}),
				),
			);
		},
	});
}

describe("GitHubReviewInputReader", () => {
	it("returns exactly the Core contract and verifies access and both revisions", async () => {
		const { reader, requests, pages } = setup();
		const expected: Equal<
			IGitHubReviewInputReader["read"],
			(input: ReadGitHubReviewInput) => Promise<ReviewInput>
		> &
			Equal<typeof reader.read, IGitHubReviewInputReader["read"]> = true;
		expect(expected).toBe(true);
		await expect(reader.read(input)).resolves.toEqual({
			repository: {
				provider: "github",
				namespace: "owner",
				name: "repo",
				providerRepositoryId: "10",
			},
			change: { id: "7", url: prUrl },
			base: { id: baseSha, ref: "main" },
			head: { id: headSha, ref: "feature" },
			files: [
				{
					path: "src/current.ts",
					status: "modified",
					patch: { status: "available", text: patch },
				},
			],
			fileListing: { status: "complete" },
		});
		expect(requests).toEqual([
			"/app/installations/21/access_tokens",
			"/installation/repositories",
			prPath,
			`${prPath}/files`,
			prPath,
		]);
		expect(pages).toEqual([[1, "100"]]);
	});

	it("fetches consecutive single pages for more than 100 files", async () => {
		const { reader, pages } = listedFiles(101);
		const result = await reader.read(input);
		expect(result.files).toHaveLength(101);
		expect(result.files.at(-1)?.path).toBe("src/file-100.ts");
		expect(result.fileListing).toEqual({ status: "complete" });
		expect(pages).toEqual([
			[1, "100"],
			[2, "100"],
		]);
	});

	it("uses numbered requests even when a short page claims there is a next page", async () => {
		const { reader, pages } = setup({
			initial: { ...pull, changed_files: 2 },
			files: (page) =>
				page === 1
					? json([file], 200, {
							link: '<https://api.github.com/unexpected?page=9>; rel="next"',
						})
					: json([{ ...file, filename: "src/second.ts" }]),
		});
		const result = await reader.read(input);
		expect(result.files).toHaveLength(2);
		expect(result.fileListing).toEqual({ status: "complete" });
		expect(pages).toEqual([
			[1, "100"],
			[2, "100"],
		]);
	});

	it("marks a listing partial when a next page exists at the file budget", async () => {
		const { reader, pages } = setup({
			files: () =>
				json([file], 200, {
					link: '<https://api.github.com/next>; rel="next"',
				}),
		});
		const result = await reader.read({ ...input, limits: { maxFiles: 1 } });
		expect(result.fileListing).toEqual({
			status: "partial",
			reason: "retrieval_incomplete",
			reportedTotal: 1,
		});
		expect(pages).toEqual([[1, "100"]]);
	});

	it("stops within the last page when the file budget is reached", async () => {
		const { reader, pages } = listedFiles(250);
		const result = await reader.read({ ...input, limits: { maxFiles: 110 } });
		expect(result.files).toHaveLength(110);
		expect(result.fileListing).toEqual({
			status: "partial",
			reason: "retrieval_incomplete",
			reportedTotal: 250,
		});
		expect(pages).toEqual([
			[1, "100"],
			[2, "100"],
		]);
	});

	it("stops early by default and caps larger requests at the GitHub ceiling", async () => {
		expect(DEFAULT_GITHUB_REVIEW_INPUT_LIMITS).toEqual({
			maxFiles: 300,
			maxPatchBytes: 100_000,
			maxTotalPatchBytes: 1_000_000,
		});
		const defaultRead = listedFiles(3_000, 3_001);
		const limited = await defaultRead.reader.read(input);
		expect(limited.files).toHaveLength(300);
		expect(limited.fileListing).toEqual({
			status: "partial",
			reason: "retrieval_incomplete",
			reportedTotal: 3_001,
		});
		expect(defaultRead.pages).toHaveLength(3);

		const { reader, pages } = listedFiles(3_000, 3_001);
		const result = await reader.read({ ...input, limits: { maxFiles: 4_000 } });
		expect(result.files).toHaveLength(3_000);
		expect(result.fileListing).toEqual({
			status: "partial",
			reason: "provider_limit",
			reportedTotal: 3_001,
		});
		expect(pages).toEqual(
			Array.from({ length: 30 }, (_, index) => [index + 1, "100"]),
		);
	});

	it("marks a short retrieval partial and a missing or invalid total unknown", async () => {
		const { reader, pages } = listedFiles(9, 110);
		expect((await reader.read(input)).fileListing).toEqual({
			status: "partial",
			reason: "retrieval_incomplete",
			reportedTotal: 110,
		});
		expect(pages).toEqual([[1, "100"]]);

		for (const changed_files of [undefined, -1, "1"]) {
			const { reader } = setup({ initial: { ...pull, changed_files } });
			expect((await reader.read(input)).fileListing).toEqual({
				status: "unknown",
			});
		}
	});

	it("counts UTF-8 bytes, keeps the budget-crossing file and skips remaining files", async () => {
		const { reader, pages } = setup({
			initial: { ...pull, changed_files: 150 },
			files: () =>
				json([
					{ ...file, patch: "é" },
					{ ...file, filename: "second.ts", patch: "🙂" },
					{ ...file, filename: "third.ts" },
				]),
		});
		const result = await reader.read({
			...input,
			limits: { maxTotalPatchBytes: 5 },
		});
		expect(result.files).toEqual([
			{
				path: file.filename,
				status: "modified",
				patch: { status: "available", text: "é" },
			},
			{ path: "second.ts", status: "modified", patch: { status: "truncated" } },
		]);
		expect(result.fileListing).toEqual({
			status: "partial",
			reason: "retrieval_incomplete",
			reportedTotal: 150,
		});
		expect(pages).toEqual([[1, "100"]]);
	});

	it("stops before another page if the retained patches exactly exhaust the total budget", async () => {
		const { reader, pages } = setup({
			initial: { ...pull, changed_files: 101 },
			files: () =>
				json(
					Array.from({ length: 100 }, (_, index) => ({
						filename: String(index),
						status: "added",
						patch: "é",
					})),
				),
		});
		const result = await reader.read({
			...input,
			limits: { maxTotalPatchBytes: 200 },
		});
		expect(result.files).toHaveLength(100);
		expect(result.fileListing).toEqual({
			status: "partial",
			reason: "retrieval_incomplete",
			reportedTotal: 101,
		});
		expect(pages).toEqual([[1, "100"]]);
	});

	it("keeps a complete listing when the last patch uses the exact byte budget", async () => {
		const { reader } = setup({ files: () => json([{ ...file, patch: "é" }]) });
		expect(
			(
				await reader.read({
					...input,
					limits: { maxTotalPatchBytes: 2, maxFiles: 1 },
				})
			).fileListing,
		).toEqual({ status: "complete" });
	});

	it("preserves statuses, validates previous paths and distinguishes patch availability", async () => {
		const { reader } = setup({
			initial: { ...pull, changed_files: 10 },
			files: () =>
				json([
					{ filename: "added", status: "added", patch: "🙂" },
					{ filename: "modified", status: "modified", patch: "a" },
					{ filename: "removed", status: "removed" },
					{
						filename: "renamed",
						status: "renamed",
						previous_filename: "old-r",
						patch: "",
						additions: 0,
						deletions: 0,
						changes: 0,
					},
					{
						filename: "copied",
						status: "copied",
						previous_filename: "old-c",
						patch: "ab",
					},
					{
						filename: "unknown",
						status: "changed",
						previous_filename: "old-u",
					},
					{
						filename: "bad-rename",
						status: "renamed",
						previous_filename: "../outside",
					},
					{ filename: "bad-copy", status: "copied" },
					{
						filename: "image.png",
						status: "modified",
						patch: "Binary files a/image.png and b/image.png differ\n",
					},
					{
						filename: "empty-unverified",
						status: "modified",
						patch: "",
						additions: 0,
						deletions: 0,
						changes: 0,
					},
				]),
		});
		const result = await reader.read({
			...input,
			limits: { maxPatchBytes: 3 },
		});
		expect(result.files).toEqual([
			{ path: "added", status: "added", patch: { status: "truncated" } },
			{
				path: "modified",
				status: "modified",
				patch: { status: "available", text: "a" },
			},
			{ path: "removed", status: "removed", patch: { status: "unavailable" } },
			{
				path: "renamed",
				status: "renamed",
				previousPath: "old-r",
				patch: { status: "available", text: "" },
			},
			{
				path: "copied",
				status: "copied",
				previousPath: "old-c",
				patch: { status: "available", text: "ab" },
			},
			{
				path: "unknown",
				status: "unknown",
				providerStatus: "changed",
				previousPath: "old-u",
				patch: { status: "unavailable" },
			},
			{
				path: "bad-rename",
				status: "unknown",
				providerStatus: "renamed",
				patch: { status: "unavailable" },
			},
			{
				path: "bad-copy",
				status: "unknown",
				providerStatus: "copied",
				patch: { status: "unavailable" },
			},
			{ path: "image.png", status: "modified", patch: { status: "binary" } },
			{
				path: "empty-unverified",
				status: "modified",
				patch: { status: "unavailable" },
			},
		]);
		expect(result.fileListing).toEqual({ status: "complete" });
	});

	it("omits patch processing when requested", async () => {
		const { reader } = setup();
		expect(
			(await reader.read({ ...input, limits: { includePatches: false } }))
				.files,
		).toEqual([
			{
				path: file.filename,
				status: "modified",
				patch: { status: "not_requested" },
			},
		]);
	});

	it.each([
		{ owner: "https://github.com/owner" },
		{ owner: "owner\n" },
		{ repo: ".." },
		{ repo: "repo%2fother" },
		{ pullNumber: 0 },
		{ pullNumber: 1.5 },
		{ installationId: -1 },
		{ limits: { maxFiles: 0 } },
		{ limits: { maxPatchBytes: Number.POSITIVE_INFINITY } },
		{ limits: { maxTotalPatchBytes: 2.5 } },
	])("rejects invalid input before network calls (%p)", async (invalid) => {
		const { reader, requests } = setup();
		await expect(reader.read({ ...input, ...invalid })).rejects.toMatchObject({
			code: "INVALID_REVIEW_INPUT",
		});
		expect(requests).toEqual([]);
	});

	it.each([
		"base",
		"head",
	] as const)("rejects when the %s SHA changes", async (side) => {
		const { reader } = setup({
			final: { ...pull, [side]: { ...pull[side], sha: "c".repeat(40) } },
		});
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "STALE_REVIEW_SNAPSHOT",
		});
	});

	it.each([
		{ patch: "text", status: "modified" },
		{ filename: "x", status: 123 },
		{ filename: "../outside", status: "modified" },
		{ filename: "x", status: "modified", patch: false },
	])("rejects malformed file entries (%p)", async (entry) => {
		const { reader } = setup({ files: () => json([entry]) });
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "MALFORMED_RESPONSE",
		});
	});

	it("rejects malformed entries in a fetched page beyond the local file budget", async () => {
		const { reader } = setup({
			files: () => json([file, { filename: "missing-status.ts" }]),
		});
		await expect(
			reader.read({ ...input, limits: { maxFiles: 1 } }),
		).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
	});

	it("rejects a malformed file page envelope", async () => {
		const { reader } = setup({ files: () => json({ files: [file] }) });
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "MALFORMED_RESPONSE",
		});
	});

	it("rejects a malformed pull request envelope", async () => {
		const { reader, pages } = setup({ initial: { ...pull, base: null } });
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "MALFORMED_RESPONSE",
		});
		expect(pages).toEqual([]);
	});

	it("rejects ambiguous duplicate files during retrieval", async () => {
		const { reader } = setup({
			initial: { ...pull, changed_files: 101 },
			files: (page) =>
				json(
					Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
						filename: String(index),
						status: "added",
					})),
				),
		});
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "INCOMPLETE_RETRIEVAL",
		});
	});

	it.each([
		401, 403,
	])("maps a non-rate-limit %i to access denied", async (status) => {
		const { reader } = setup({
			access: () => json({ message: "Denied" }, status),
		});
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "REPOSITORY_ACCESS_DENIED",
			cause: { status },
		});
	});

	it("rejects access when the installation does not include the repository", async () => {
		const { reader, requests } = setup({
			access: () => json({ total_count: 0, repositories: [] }),
		});
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "REPOSITORY_ACCESS_DENIED",
		});
		expect(requests).not.toContain(prPath);
	});

	it.each([
		403, 429,
	])("exposes sanitized rate-limit timing for %i", async (status) => {
		const { reader } = setup({
			files: () =>
				json({ message: "Throttled" }, status, {
					"x-ratelimit-remaining": "0",
					"retry-after": "12",
					"x-ratelimit-reset": "1720000000",
				}),
		});
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "RATE_LIMITED",
			cause: { status },
			rateLimit: { retryAfter: 12, reset: 1720000000 },
		});
	});

	it("maps GitHub PR 404 to a typed not-found error", async () => {
		const { reader, pages } = setup({
			initial: json({ message: "Not Found" }, 404),
		});
		const result = reader.read(input);
		await expect(result).rejects.toBeInstanceOf(GitHubReviewError);
		await expect(result).rejects.toMatchObject({
			code: "PULL_REQUEST_NOT_FOUND",
			cause: { status: 404 },
		});
		expect(pages).toEqual([]);
	});

	it("fails the whole read on a later page error without retrying", async () => {
		const { reader, pages, requests } = setup({
			initial: { ...pull, changed_files: 101 },
			files: (page) =>
				page === 1
					? json(
							Array.from({ length: 100 }, (_, index) => ({
								filename: String(index),
								status: "added",
							})),
						)
					: json({ message: "Service Unavailable" }, 503),
		});
		await expect(reader.read(input)).rejects.toMatchObject({
			code: "GITHUB_API_ERROR",
			cause: { status: 503 },
		});
		expect(pages).toEqual([
			[1, "100"],
			[2, "100"],
		]);
		expect(requests.filter((request) => request === prPath)).toHaveLength(1);
	});
});
