type DiffSide = "LEFT" | "RIGHT";
type ReviewDiffHunk = Readonly<Record<DiffSide, ReadonlyMap<number, number>>>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseReviewDiff(patch: string): ReviewDiffHunk[] {
	const hunks: ReviewDiffHunk[] = [];
	let lines: Record<DiffSide, Map<number, number>> | undefined;
	let rowIndex = 0;
	let oldLine = 0;
	let newLine = 0;
	let oldEnd = 0;
	let newEnd = 0;

	for (const row of patch.split("\n")) {
		const header = HUNK_HEADER.exec(row);
		if (header) {
			if (lines && oldLine === oldEnd && newLine === newEnd) hunks.push(lines);
			oldLine = Number(header[1]);
			newLine = Number(header[3]);
			oldEnd = oldLine + Number(header[2] ?? 1);
			newEnd = newLine + Number(header[4] ?? 1);
			lines = { LEFT: new Map(), RIGHT: new Map() };
			rowIndex = 0;
			continue;
		}
		if (!lines || row === "" || row.startsWith("\\ No newline")) continue;
		switch (row[0]) {
			case " ":
				lines.LEFT.set(oldLine++, rowIndex);
				lines.RIGHT.set(newLine++, rowIndex);
				break;
			case "-":
				lines.LEFT.set(oldLine++, rowIndex);
				break;
			case "+":
				lines.RIGHT.set(newLine++, rowIndex);
				break;
			default:
				lines = undefined;
		}
		rowIndex++;
	}
	if (lines && oldLine === oldEnd && newLine === newEnd) hunks.push(lines);
	return hunks;
}
