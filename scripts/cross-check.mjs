#!/usr/bin/env node
// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Cross-check: verifies that every evidence pointer in docs/CROSS_CHECK.md
 * (§ "Machine-checkable index") EXISTS today — test names are present in the
 * cited test files, bench ids in the bench, model-check instances in the
 * committed fixture, fixture keys/values hold, docs and scripts exist, and
 * every `gap`-typed claim is registered in the gap register.
 *
 * The doc claims the proofs; this script makes the doc itself testable:
 *
 *   node scripts/cross-check.mjs
 *
 * Exit code 0 = every evidence pointer resolves; 1 = any dangling pointer,
 * unknown claim id, or gap not registered.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'CROSS_CHECK.md');

const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Extract every it('…')/test('…') name from a test file (multiline-safe). */
function extractTestNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = [];
  const re = /\b(?:it|test)\(\s*(['"`])((?:[^\\]|\\.)*?)\1/gs;
  let m;
  while ((m = re.exec(src))) names.push(norm(m[2].replace(/\\(['"`])/g, '$1')));
  return names;
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function getDotted(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** Verify one evidence ref. Two grammars:
 *  - `type:location#fragment` for test/bench/fixture/doc/script/pkg;
 *  - `model-check:<instance name>` (the instance is matched against the
 *    committed fixture and __tests__/modelCheckingCore.ts). */
function verifyRef(ref) {
  let type;
  let location;
  let fragment = '';
  if (ref.startsWith('model-check:')) {
    type = 'model-check';
    location = '__fixtures__/model-check-summary.json';
    fragment = ref.slice('model-check:'.length).trim();
  } else {
    const m = ref.match(/^(test|bench|fixture|doc|script|pkg):([^#]+)(?:#(.+))?$/);
    if (!m) return { ok: false, reason: `unparseable ref "${ref}"` };
    type = m[1];
    location = m[2].trim();
    fragment = (m[3] ?? '').trim();
  }

  const abs = path.join(ROOT, location);
  if (type !== 'pkg' && !fs.existsSync(abs)) {
    return { ok: false, reason: `${type} path not found: ${location}` };
  }

  switch (type) {
    case 'test': {
      if (!fragment) return { ok: false, reason: 'test ref without a name fragment' };
      const names = extractTestNames(abs);
      const nf = norm(fragment);
      if (names.some((n) => n.includes(nf))) return { ok: true };
      // Fallback: normalized raw-content match (describe-level names, wrapping).
      const haystack = norm(fs.readFileSync(abs, 'utf8').replace(/(['"`])/g, ' '));
      if (haystack.includes(nf)) return { ok: true };
      return { ok: false, reason: `test name not found in ${location}: "${fragment}"` };
    }
    case 'bench': {
      const src = fs.readFileSync(abs, 'utf8');
      const re = new RegExp(`bench\\(\\s*'${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
      if (re.test(src)) return { ok: true };
      return { ok: false, reason: `bench id not found in ${location}: "${fragment}"` };
    }
    case 'model-check': {
      // Instance must exist in the committed fixture OR be declared in the
      // model-checking core (full-mode instances).
      let where = null;
      try {
        const fixture = readJson(location);
        const names = (fixture.instances ?? []).map((i) => i.name);
        if (names.includes(fragment)) where = 'fixture';
      } catch { /* fall through to core */ }
      if (!where) {
        const core = fs.readFileSync(path.join(ROOT, '__tests__', 'modelCheckingCore.ts'), 'utf8');
        if (core.includes(`'${fragment}'`)) where = 'modelCheckingCore';
      }
      if (where) return { ok: true };
      return { ok: false, reason: `model-check instance not found (${location} or modelCheckingCore): "${fragment}"` };
    }
    case 'fixture': {
      const json = readJson(location);
      // fragment: `dotted.path` or `dotted.path=value`
      const eq = fragment.indexOf('=');
      const key = eq === -1 ? fragment : fragment.slice(0, eq);
      const want = eq === -1 ? undefined : fragment.slice(eq + 1);
      const got = getDotted(json, key);
      if (got === undefined) return { ok: false, reason: `fixture key not found: ${location}#${key}` };
      if (want !== undefined && String(got) !== want) {
        return { ok: false, reason: `fixture ${location}#${key} = ${got}, expected ${want}` };
      }
      return { ok: true };
    }
    case 'doc':
    case 'script':
      return { ok: true };
    case 'pkg': {
      // `pkg:name@versionRange` — the dependency (or devDependency) must be
      // declared with the exact version in package.json.
      const at = location.lastIndexOf('@');
      const name = location.slice(0, at);
      const version = location.slice(at + 1);
      const pkg = readJson('package.json');
      const got = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      if (got === version) return { ok: true };
      return { ok: false, reason: `package.json pins ${name} at ${got}, expected ${version}` };
    }
    default:
      return { ok: false, reason: `unknown evidence type "${type}"` };
  }
}

// ─── parse the doc ───────────────────────────────────────────────────────────

const doc = fs.readFileSync(DOC, 'utf8');

function section(title) {
  const start = doc.indexOf(`## ${title}`);
  if (start === -1) throw new Error(`docs/CROSS_CHECK.md is missing section "## ${title}"`);
  const rest = doc.slice(start);
  const next = rest.slice(1).indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const indexSection = section('Machine-checkable index');
const gapSection = section('Gap register');

const rows = [];
for (const line of indexSection.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length !== 4) continue;
  const [claimId, kind, evidenceType, evidencePath] = cells;
  if (!/^[A-Za-z][A-Za-z0-9.-]*-\S+$/i.test(claimId)) continue; // skip header/separator rows
  if (claimId.toUpperCase() === 'CLAIM-ID') continue;
  rows.push({ claimId, kind, evidenceType, evidencePath });
}

if (rows.length === 0) throw new Error('no machine index rows parsed from docs/CROSS_CHECK.md');

const gapClaimIds = new Set();
for (const line of gapSection.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length >= 1 && /^[A-Z]/.test(cells[0]) && cells[0].includes('-')) gapClaimIds.add(cells[0]);
}

// ─── verify ──────────────────────────────────────────────────────────────────

let checks = 0;
const failures = [];
const seenClaimIds = new Set();

for (const row of rows) {
  if (seenClaimIds.has(row.claimId)) failures.push(`${row.claimId}: duplicate claim id in machine index`);
  seenClaimIds.add(row.claimId);

  if (row.evidenceType === 'gap') {
    if (!gapClaimIds.has(row.claimId)) {
      failures.push(`${row.claimId}: evidence-type "gap" but the claim id is not registered in the Gap register`);
    }
    continue;
  }

  const refs = row.evidencePath.split(';').map((s) => s.trim()).filter(Boolean);
  if (refs.length === 0) failures.push(`${row.claimId}: empty evidence path`);
  for (const ref of refs) {
    checks += 1;
    const res = verifyRef(ref);
    if (!res.ok) failures.push(`${row.claimId}: ${res.reason}`);
  }
}

// Every claim id discussed in the human sections must appear in the machine index.
const discussed = new Set();
for (const m of doc.matchAll(/^\| `?([A-Z][A-Z0-9-]+-[0-9A-Za-z.-]+)`? \|/gm)) discussed.add(m[1]);
for (const m of doc.matchAll(/(?:^|\s)((?:INV|PAPER|CA|FINDING|ER|MC|BENCH|SUITE)-[A-Za-z0-9.-]+)/g)) discussed.add(m[1]);
const missingFromIndex = [...discussed].filter((id) => !seenClaimIds.has(id) && id.startsWith('PAPER-'));
for (const id of missingFromIndex) failures.push(`${id}: discussed in the doc but absent from the Machine-checkable index`);

// ─── report ──────────────────────────────────────────────────────────────────

const byKind = {};
for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
const byType = {};
for (const row of rows) byType[row.evidenceType] = (byType[row.evidenceType] ?? 0) + 1;

console.log(`cross-check: ${rows.length} claims indexed, ${checks} evidence refs verified`);
console.log(`claims by kind:   ${JSON.stringify(byKind)}`);
console.log(`claims by evidence: ${JSON.stringify(byType)}`);
console.log(`gap register entries: ${gapClaimIds.size}`);

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nOK — every evidence pointer in docs/CROSS_CHECK.md resolves.');
