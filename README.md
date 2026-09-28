# pi-read-guard

Refuses to re-read file content that is already in the context window.

## Why

Re-reading the same lines costs fresh (uncached) input tokens and permanently grows the
context, for zero information gain. This extension records which line ranges of which
files have actually landed in the transcript, and blocks reads that would only re-deliver
lines the model can already see.

## Install

```bash
pi install git:github.com/hakergeniusz/pi-read-guard
```

MIT licensed.
