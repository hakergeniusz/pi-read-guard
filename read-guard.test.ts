/**
 * read-guard tests: `bun test`
 *
 * The contract that matters: a range is only "in context" when those exact
 * lines were delivered. A read that returned the first X lines of a file must
 * never make the rest of the file unreadable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import readGuard from "./index.ts";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "read-guard-"));

type Handlers = Record<string, Array<(event: any, ctx: any) => any>>;

function load() {
	const handlers: Handlers = {};
	readGuard({
		on: (event: string, handler: any) => {
			(handlers[event] ??= []).push(handler);
		},
	} as any);
	return {
		emit(event: string, payload: any, ctx: any) {
			for (const h of handlers[event] ?? []) {
				const result = h(payload, ctx);
				if (result) return result;
			}
			return undefined;
		},
	};
}

function makeFile(name: string, lines: number): string {
	const file = path.join(CWD, name);
	fs.writeFileSync(file, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
	return file;
}

/** The text pi's read tool returns for `offset`/`limit`, hint included. */
function readText(file: string, offset: number, limit: number | undefined, totalLines: number): string {
	const all = fs.readFileSync(file, "utf8").split("\n");
	const start = offset - 1;
	const end = limit === undefined ? all.length : Math.min(start + limit, all.length);
	const body = all.slice(start, end).join("\n");
	if (limit !== undefined && start + limit < all.length) {
		return `${body}\n\n[${all.length - (start + limit)} more lines in file. Use offset=${end + 1} to continue.]`;
	}
	return body;
}

function doRead(h: ReturnType<typeof load>, file: string, offset?: number, limit?: number) {
	const input: Record<string, unknown> = { path: file };
	if (offset !== undefined) input.offset = offset;
	if (limit !== undefined) input.limit = limit;
	const blocked = h.emit("tool_call", { toolName: "read", input }, { cwd: CWD });
	if (blocked) return { blocked: true, reason: blocked.reason as string };
	const total = fs.readFileSync(file, "utf8").split("\n").length;
	const text = readText(file, offset ?? 1, limit, total);
	h.emit("tool_result", { toolName: "read", input, content: [{ type: "text", text }], isError: false }, { cwd: CWD });
	return { blocked: false, reason: "" };
}

afterEach(() => {
	// Each test starts with a fresh registry.
	for (const f of fs.readdirSync(CWD)) fs.unlinkSync(path.join(CWD, f));
});

describe("read-guard", () => {
	test("blocks a re-read of the same lines", () => {
		const h = load();
		const file = makeFile("a.txt", 500);
		expect(doRead(h, file, 1, 100).blocked).toBe(false);
		const again = doRead(h, file, 1, 100);
		expect(again.blocked).toBe(true);
		expect(again.reason).toContain("already in context");
	});

	test("allows reading the next chunk", () => {
		const h = load();
		const file = makeFile("b.txt", 500);
		expect(doRead(h, file, 1, 100).blocked).toBe(false);
		expect(doRead(h, file, 101, 100).blocked).toBe(false);
	});

	test("allows reading the rest of the file after a partial read", () => {
		const h = load();
		const file = makeFile("c.txt", 500);
		expect(doRead(h, file, 1, 100).blocked).toBe(false);
		// 1-EOF is NOT covered by 1-100: lines 101+ were never delivered.
		const rest = doRead(h, file, 1);
		expect(rest.blocked).toBe(false);
	});

	test("blocks 1-EOF once the whole file was read", () => {
		const h = load();
		const file = makeFile("d.txt", 500);
		expect(doRead(h, file, 1).blocked).toBe(false);
		const again = doRead(h, file, 1);
		expect(again.blocked).toBe(true);
	});

	test("names the uncovered sub-ranges when it blocks", () => {
		const h = load();
		const file = makeFile("e.txt", 500);
		doRead(h, file, 1, 100);
		doRead(h, file, 101, 50);
		const blocked = doRead(h, file, 1, 200);
		expect(blocked.blocked).toBe(true);
		expect(blocked.reason).toContain("151-200");
	});

	test("allows a read that only partly overlaps", () => {
		const h = load();
		const file = makeFile("f.txt", 500);
		doRead(h, file, 1, 100);
		expect(doRead(h, file, 1, 200).blocked).toBe(false);
	});

	test("claims nothing when the read delivered nothing", () => {
		const h = load();
		const file = makeFile("g.txt", 2);
		fs.writeFileSync(file, "x".repeat(60 * 1024) + "\n");
		const input = { path: file };
		h.emit(
			"tool_result",
			{
				toolName: "read",
				input,
				content: [{ type: "text", text: "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' g.txt | head -c 50.0KB]" }],
				isError: false,
			},
			{ cwd: CWD }
		);
		expect(doRead(h, file, 1, 1).blocked).toBe(false);
	});

	test("forgets a file that changed since the read", () => {
		const h = load();
		const file = makeFile("h.txt", 500);
		doRead(h, file, 1, 100);
		fs.writeFileSync(file, "changed\n");
		expect(doRead(h, file, 1, 100).blocked).toBe(false);
	});

	test("ignores other tools", () => {
		const h = load();
		const file = makeFile("i.txt", 10);
		h.emit("tool_call", { toolName: "bash", input: { command: "cat i.txt" } }, { cwd: CWD });
		expect(h.emit("tool_call", { toolName: "read", input: { path: file } }, { cwd: CWD })).toBeUndefined();
	});
});
