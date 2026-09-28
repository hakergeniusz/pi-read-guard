/**
 * read-guard — refuse to re-read file content that is already in context.
 *
 * Re-reading the same lines costs fresh (uncached) input tokens and permanently
 * grows the context, for zero information gain. This extension records which
 * line ranges of which files have actually landed in the transcript, and blocks
 * a `read` call whose requested range is already covered.
 *
 * Correctness rules, so this never blocks a read that would have told the model
 * something new:
 * - A range only counts as covered if the file is byte-identical to when it was
 *   read. Any edit/write/bash change to the file drops its record immediately,
 *   so "re-read after you edited it" always works.
 * - A partially covered request is only blocked when most of it is redundant;
 *   the block message names the exact uncovered sub-ranges to request instead.
 * - Compaction discards the old transcript, so all records are dropped then.
 * - The record is the *actual* returned range, parsed from the read tool's own
 *   "[Showing lines X-Y of N...]" hint rather than guessed from the arguments.
 *
 * Block messages are deliberately terse: they are themselves fresh tokens, and
 * the model only needs the path, the lines, and what to do instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { type Range, coveredFractionOf, describeRange, merge, parseRangeEnd, subtract } from "./ranges.ts";

/** What we know about one file's in-context content. */
type FileRecord = {
	/** Merged, sorted, non-overlapping ranges already in the transcript. */
	ranges: Range[];
	/** mtime+size at the moment those ranges were read; a mismatch invalidates. */
	mtimeMs: number;
	size: number;
	/** How many times the model has been blocked here, to damp repeat attempts. */
	blocked: number;
};

/** Block once at least this fraction of the request is already in context. */
const BLOCK_WHEN_COVERED_AT_LEAST = 0.6;

/** Bound the registry so a long session cannot grow it without limit. */
const MAX_TRACKED_FILES = 500;

const registry = new Map<string, FileRecord>();

export default function readGuard(pi: ExtensionAPI) {
	// The transcript is empty at session start: nothing is in context yet.
	pi.on("session_start", () => registry.clear());
	// Compaction summarizes the old transcript away, so those lines are gone.
	pi.on("session_compact", () => registry.clear());

	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		if (event.toolName !== "read") return;
		const { path: rawPath, offset, limit } = event.input as { path?: string; offset?: number; limit?: number };
		if (!rawPath) return;

		const abs = path.resolve(ctx.cwd, rawPath);
		const rec = registry.get(abs);
		if (!rec || rec.ranges.length === 0) return;

		// The file changed since we recorded it: everything we know may be stale.
		const stat = statOrNull(abs);
		if (!stat || stat.mtimeMs !== rec.mtimeMs || stat.size !== rec.size) {
			registry.delete(abs);
			return;
		}

		const start = Math.max(1, Math.floor(offset ?? 1));
		const requested: Range = {
			start,
			end: limit === undefined ? Infinity : start + Math.max(0, Math.floor(limit)) - 1,
		};
		if (requested.end < requested.start) return;

		const missing = subtract(requested, rec.ranges);
		const covered = coveredFractionOf(requested, rec.ranges);
		if (covered < BLOCK_WHEN_COVERED_AT_LEAST) return;

		rec.blocked++;
		const hint =
			missing.length === 0
				? "Already in context (read earlier this session, file unchanged since)."
				: `${Math.round(covered * 100)}% already in context. Request only: ${missing.map(describeRange).join(", ")}.`;
		const again = rec.blocked > 1 ? ` Blocked ${rec.blocked}x now - stop re-reading this file.` : "";
		return {
			block: true,
			reason: `read-guard: ${rawPath} lines ${describeRange(requested)}. ${hint}${again} Use the copy already in context.`,
		};
	});

	pi.on("tool_result", (event: ToolResultEvent, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const { path: rawPath, offset, limit } = event.input as { path?: string; offset?: number; limit?: number };
		if (!rawPath) return;

		const abs = path.resolve(ctx.cwd, rawPath);
		const stat = statOrNull(abs);
		if (!stat) return;

		// Images and other non-text payloads have no line semantics to track.
		if (event.content.some((c) => c.type !== "text")) return;
		const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		if (!text) return;

		const start = Math.max(1, Math.floor(offset ?? 1));
		addRange(abs, { start, end: parseRangeEnd(text, start, limit) }, stat.mtimeMs, stat.size);
	});
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

function addRange(file: string, range: Range, mtimeMs: number, size: number) {
	if (range.start <= 1 && range.end === Infinity) {
		// Whole file: supersedes anything else we knew about it.
		registry.set(file, { ranges: [{ start: 1, end: Infinity }], mtimeMs, size, blocked: 0 });
		return;
	}
	let rec = registry.get(file);
	if (!rec || rec.mtimeMs !== mtimeMs || rec.size !== size) {
		rec = { ranges: [], mtimeMs, size, blocked: 0 };
		registry.set(file, rec);
	}
	rec.ranges = merge([...rec.ranges, range]);

	if (registry.size > MAX_TRACKED_FILES) {
		// Drop the least recently inserted; Map preserves insertion order.
		const oldest = registry.keys().next();
		if (!oldest.done) registry.delete(oldest.value);
	}
}

function statOrNull(file: string): fs.Stats | null {
	try {
		return fs.statSync(file);
	} catch {
		return null;
	}
}
