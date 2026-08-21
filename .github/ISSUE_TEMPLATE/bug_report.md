---
name: Bug report
about: Report a defect in the BAO Court protocol library
title: '[bug] '
labels: bug
assignees: ''
---

## Summary

One or two sentences: what is broken and what did you expect instead.

## Package version

`@bao/court` tag or git ref you are consuming (e.g. `v0.5.4`), or the repo
commit if you are on `main`.

## Reproduction

Minimal, runnable repro. Prefer a small script using the documented tsx
consumption path:

```ts
import { createCourtVoteMachine, reduceCourtVoteMachine } from '@bao/court';
// ...minimal repro...
```

If the bug is in a state machine, include the exact `create*Machine` params
and the event sequence that triggers it, plus the thrown error text.

## Expected behavior

What should happen instead (including the exact error message you expected,
if any).

## Actual behavior

Full error output, including the error class name (`CourtVoteTransitionError`,
`CourtDkgTransitionError`, `CourtSigningTransitionError`, or plain `Error`)
and stack trace.

## Impact

- [ ] Protocol/wire-format issue (could affect other observers' derived state)
- [ ] Fail-closed behavior gap (a malformed input that is NOT rejected)
- [ ] Consumer API/ergonomics issue
- [ ] Performance / resource exhaustion risk
- [ ] Docs / paper inconsistency

## Environment

- Node version:
- Consumed via (git ref / file: dep / vendored copy):
- Runtime (Node / browser / bundler + name):

## Checklist

- [ ] I have searched existing issues for a duplicate
- [ ] I have checked `docs/FIXES-*.md` to confirm this is not an already-documented divergence
