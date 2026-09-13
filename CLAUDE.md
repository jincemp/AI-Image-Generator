# Claude Code instructions

## Session log

Every session ends by writing a log entry, including sessions that changed no
source file. A session that only investigated, reviewed, or answered still
writes its entry and pushes it.

Write to `logs/sessions/YYYY-MM-DD-<slug>.md` with this shape:

```text
date: <ISO 8601>
agent: <role, or "unassigned">
task: <one line — what you were asked>
outcome: shipped | investigated | blocked | abandoned
files_changed: <count; 0 is valid>

## What I found
## What I changed
## What I did not do, and why
## What the next session should know
```

Push the entry on your branch and open a pull request, even for a zero-change
session. A session that ends without a log entry leaves no record it happened.
