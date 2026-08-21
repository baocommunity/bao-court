---
name: Feature request
about: Propose a new capability, API, or protocol change
title: '[feature] '
labels: enhancement
assignees: ''
---

## Problem

What gap are you trying to close? Who is affected (hosts, jurors, observers,
downstream settlement)?

## Proposed capability

Describe the capability. If it is a new protocol event/kind, new state
machine, or new public API, sketch the shape:

- Entry points (functions / machine events / event kinds)
- Who produces and who consumes it
- How it binds to the existing session hash / canonical encoding

## Alternative approaches

What else did you consider, and why is this proposal better?

## Compatibility impact

- Does this change existing wire formats or public API signatures?
- Does it require a minor (new capability) or patch (backward-compatible
  fix) bump under the AGENTS.md versioning rules?
- Will consumers need migration steps? (List them if yes.)

## Security / fail-closed notes

Any new input surface must be fail-closed and bounded (see the paper's
production gates). Note where validation should live (machine admission vs
event parser) and any caps/bounds the new surface needs.

## References

Paper sections, FIXES memos, or related issues this builds on.
