# pi-read-guard

Refuses to re-read file content that is already in the context window.

## Why

Re-reading the same lines costs fresh (uncached) input tokens and permanently grows the
context, for zero information gain. This extension records which line ranges of which
files have actually landed in the transcript, and blocks reads that would only re-deliver
lines the model can already see.

## The rules

A range counts as "in context" only when those exact lines were delivered:

- The recorded range is the range the read tool actually returned, parsed from its own
  `[Showing lines X-Y of N...]` / `[N more lines in file...]` hint — never guessed from
  the requested `offset`/`limit`.
- A read that delivered nothing (a first line over the byte limit) claims nothing.
- `1-EOF` is only covered by a range that itself reaches EOF. Having lines 1-2000 does
  **not** mean lines 2001+ are in context, so the rest of a file stays readable.
- A file that changed since it was read is forgotten, so "re-read after you edited it"
  always works.
- Compaction drops every record, because the old transcript is gone.

A request that is only partly covered is blocked only when most of it is redundant, and
the block message names the exact sub-ranges to request instead.

## The contract with pi-result-cap

"In context" means "in the transcript the model is looking at". An extension that trims
tool results before the request leaves would break that promise: the model would be told
the lines are already there while they are not, and re-reading them would be refused.

[pi-result-cap](https://github.com/hakergeniusz/pi-result-cap) therefore leaves `read`
results alone. The read tool bounds itself already (2000 lines / 50KB) and tells the
model how to page with `offset`/`limit`, so a trimmed read would only destroy
information.

## Install

```bash
pi install git:github.com/hakergeniusz/pi-read-guard
```

## Test

```bash
bun test read-guard.test.ts
```

MIT licensed.
