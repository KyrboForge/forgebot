import { expect, it } from "bun:test";
import { parseReviewDiff } from "./github-review-diff.ts";

it("tracks old and new numbering independently across hunk boundaries", () => {
	const patch = [
		"@@ -8,4 +10,5 @@ function example()",
		" context",
		"-previous",
		"+current",
		"+extra",
		" another",
		" final",
		"\\ No newline at end of file",
		"@@ -20 +23 @@",
		"-before",
		"+after",
	].join("\n");
	expect(parseReviewDiff(patch)).toEqual([
		{
			LEFT: new Map([
				[8, 0],
				[9, 1],
				[10, 4],
				[11, 5],
			]),
			RIGHT: new Map([
				[10, 0],
				[11, 2],
				[12, 3],
				[13, 4],
				[14, 5],
			]),
		},
		{ LEFT: new Map([[20, 0]]), RIGHT: new Map([[23, 1]]) },
	]);
});

it("handles zero-count sides and empty added or removed lines", () => {
	expect(parseReviewDiff("@@ -0,0 +1,2 @@\n+\n+new")).toEqual([
		{
			LEFT: new Map(),
			RIGHT: new Map([
				[1, 0],
				[2, 1],
			]),
		},
	]);
	expect(parseReviewDiff("@@ -1,2 +0,0 @@\n-old\n-")).toEqual([
		{
			LEFT: new Map([
				[1, 0],
				[2, 1],
			]),
			RIGHT: new Map(),
		},
	]);
});

it("ignores missing or incomplete hunks without extending a hunk past its declared range", () => {
	expect(parseReviewDiff("Binary files differ")).toEqual([]);
	expect(parseReviewDiff("@@ -1,2 +1,2 @@\n-first\n+first")).toEqual([]);
	expect(parseReviewDiff("@@ -1 +1 @@\n-old\n+new\n+unaccounted")).toEqual([]);
});
