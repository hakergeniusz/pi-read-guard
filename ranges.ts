/**
 * Line-range algebra for read-guard. Pure, no I/O, no pi types.
 *
 * A `Range` is 1-indexed and inclusive; `end: Infinity` means "through EOF".
 */

export type Range = { start: number; end: number };

/** Sort, drop empties, and merge overlapping or touching ranges. Infinity-safe. */
export function merge(ranges: Range[]): Range[] {
	const sorted = ranges.filter((r) => r.end >= r.start).sort((a, b) => a.start - b.start);
	const out: Range[] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && (r.start <= last.end + 1 || last.end === Infinity)) {
			last.end = Math.max(last.end, r.end);
		} else {
			out.push({ ...r });
		}
	}
	return out;
}

/** Parts of `want` that no range in `have` covers. */
export function subtract(want: Range, have: Range[]): Range[] {
	const out: Range[] = [];
	let cursor = want.start;
	for (const h of merge(have)) {
		if (h.end < cursor) continue;
		if (h.start > want.end) break;
		if (h.start > cursor) out.push({ start: cursor, end: Math.min(want.end, h.start - 1) });
		if (h.end === Infinity) return out;
		cursor = Math.max(cursor, h.end + 1);
		if (cursor > want.end) return out;
	}
	if (cursor <= want.end) out.push({ start: cursor, end: want.end });
	return out;
}

/** How much of `want` is already covered, as a fraction in [0, 1]. */
export function coveredFractionOf(want: Range, have: Range[]): number {
	const span = want.end === Infinity ? 0 : want.end - want.start + 1;
	if (span === 0) {
		// Unknown-length request (no limit). It is fully covered only if we have
		// a recorded range that extends to Infinity starting at or before
		// want.start — e.g. having 1-2000 does NOT cover 1-EOF (lines 2001+
		// are unknown). Returning 0 here avoids falsely blocking reads for
		// content that isn't actually in context.
		return merge(have).some((h) => h.end === Infinity && h.start <= want.start) ? 1 : 0;
	}
	let covered = 0;
	for (const h of merge(have)) {
		const lo = Math.max(h.start, want.start);
		const hi = h.end === Infinity ? want.end : Math.min(h.end, want.end);
		if (hi >= lo) covered += hi - lo + 1;
	}
	return Math.min(1, covered / span);
}

/** "7", "7-9", "7-EOF". */
export function describeRange(r: Range): string {
	if (r.end === Infinity) return `${r.start}-EOF`;
	return r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`;
}

/**
 * Work out the last line a read actually delivered.
 *
 * - "[Showing lines 1-84 of 300. Use offset=85 to continue.]" -> 84
 *   (the tool's own line/byte cap kicked in)
 * - "[216 more lines in file. Use offset=85 to continue.]" -> the requested
 *   `limit` was reached, so the range ends there
 * - "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: ...]" -> 0: the tool
 *   delivered nothing at all, so no line of that file is in context
 * - no hint -> the request ran to end of file
 */
export function parseRangeEnd(text: string, start: number, limit: number | undefined): number {
	if (/\[\s*Line \d+ is .*exceeds .* limit/.test(text)) return start - 1;
	const showing = /\[\s*Showing lines (\d+)-(\d+) of/.exec(text);
	if (showing) return Number(showing[2]);
	if (limit !== undefined && /\[(\d+) more lines? in file/.test(text)) {
		return start + Math.max(0, Math.floor(limit)) - 1;
	}
	return Infinity;
}
