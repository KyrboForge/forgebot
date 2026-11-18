import { expect, test } from "bun:test";
import type {
	ChangedFile,
	ContentAvailability,
	RepositoryIdentity,
	ReviewInput,
	SourceSlice,
} from "./index.ts";

const emptyPatch = {
	status: "available",
	text: "",
} satisfies ContentAvailability;
const missingPatch = { status: "unavailable" } satisfies ContentAvailability;

const githubReview = {
	repository: {
		provider: "github",
		namespace: "example",
		name: "demo",
		providerRepositoryId: "123",
	},
	change: { id: "42", url: "https://github.com/example/demo/pull/42" },
	base: { id: "0123456789abcdef0123456789abcdef01234567", ref: "main" },
	head: { id: "89abcdef0123456789abcdef0123456789abcdef", ref: "feature" },
	files: [
		{
			path: "src/review.ts",
			status: "modified",
			patch: { status: "available", text: "@@ -1 +1 @@\n-old\n+new" },
		},
		{ path: "empty.txt", status: "added", patch: emptyPatch },
		{ path: "old.txt", status: "removed", patch: missingPatch },
		{
			path: "guide.md",
			status: "renamed",
			previousPath: "intro.md",
			patch: { status: "not_requested" },
		},
		{
			path: "backup.png",
			status: "copied",
			previousPath: "logo.png",
			patch: { status: "binary" },
		},
		{
			path: "notes.md",
			status: "unknown",
			providerStatus: "changed",
			patch: { status: "truncated", partialText: "@@ -1 +1 @@" },
		},
	],
	fileListing: {
		status: "partial",
		reason: "provider_limit",
		reportedTotal: 3001,
	},
} satisfies ReviewInput;

test("keeps changed-file listing and patch completeness independent", () => {
	expect(githubReview.fileListing.reportedTotal).toBeGreaterThan(
		githubReview.files.length,
	);
	expect(githubReview.files.map(({ patch }) => patch.status)).toEqual([
		"available",
		"available",
		"unavailable",
		"not_requested",
		"binary",
		"truncated",
	]);
	expect(emptyPatch.text).toBe("");
	expect(missingPatch).not.toHaveProperty("text");
});

test("pins source slices to a revision ID even when a ref is present", () => {
	const slice = {
		repository: githubReview.repository,
		revision: githubReview.head,
		path: "src/review.ts",
		startLine: 2,
		endLine: 3,
		content: { status: "available", text: "first\r\nsecond\r" },
	} satisfies SourceSlice;

	expect(githubReview.base.id).not.toBe(githubReview.head.id);
	expect(githubReview.base.id).not.toBe(githubReview.base.ref);
	expect(slice.revision.id).toBe(githubReview.head.id);
	expect(slice.revision.id).not.toBe(slice.revision.ref);
});

test("accepts provider-specific namespaces and opaque change and revision IDs", () => {
	const gitlabReview = {
		repository: {
			provider: "gitlab",
			namespace: "group/subgroup",
			name: "demo",
		},
		change: { id: "7" },
		base: { id: "base-v2" },
		head: { id: "head-v2" },
		files: [],
		fileListing: { status: "unknown" },
	} satisfies ReviewInput;
	const bitbucketReview = {
		repository: { provider: "bitbucket", namespace: "workspace", name: "demo" },
		change: { id: "101" },
		base: { id: "abc123def456" },
		head: { id: "def456abc123" },
		files: [],
		fileListing: { status: "complete" },
	} satisfies ReviewInput;

	expect(gitlabReview.repository.namespace).toBe("group/subgroup");
	expect(gitlabReview.change.id).toBe("7");
	expect(gitlabReview.head).toEqual({ id: "head-v2" });
	expect(gitlabReview.fileListing.status).toBe("unknown");
	expect(bitbucketReview.repository.namespace).toBe("workspace");
	expect(bitbucketReview.change.id).toBe("101");
});

// Type-only assertions checked by `bun run typecheck`.
function _checkContractTypes(input: ReviewInput): void {
	const _otherProvider: RepositoryIdentity = {
		...input.repository,
		provider: "forgejo",
	};
	const file = { path: "src/review.ts", patch: missingPatch };
	// @ts-expect-error Renames require a previous path.
	const _renamed: ChangedFile = { ...file, status: "renamed" };
	// @ts-expect-error Unknown changes require the raw provider status.
	const _unknown: ChangedFile = { ...file, status: "unknown" };
	// @ts-expect-error Added files cannot have a previous path.
	const _added: ChangedFile = {
		...file,
		status: "added",
		previousPath: "old.ts",
	};
	// @ts-expect-error Available content requires text.
	const _available: ContentAvailability = { status: "available" };
	const _notRequested: ContentAvailability = {
		status: "not_requested",
		// @ts-expect-error Unrequested content cannot contain text.
		text: "unrequested",
	};
	const _truncated: ContentAvailability = {
		status: "truncated",
		// @ts-expect-error Truncated content uses partialText.
		text: "incomplete",
	};
	// @ts-expect-error Revision IDs are readonly.
	input.head.id = "different";
	// @ts-expect-error The file array is readonly.
	input.files.push();
}
