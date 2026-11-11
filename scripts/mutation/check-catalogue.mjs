// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Catalogue pre-flight: every mutant must be APPLICABLE, exactly once.
 *
 * The runner refuses to start on an ambiguous `find`, but only when it reaches
 * that mutant. This helper answers the question in one second, before a
 * 40-minute sweep: for every entry, does `find` occur exactly once in the named
 * file, and does the mutation actually change the file?
 *
 * Usage:
 *   node scripts/mutation/check-catalogue.mjs            # all mutants
 *   node scripts/mutation/check-catalogue.mjs --only M54,M65
 *   node scripts/mutation/check-catalogue.mjs --cls ladder-bound-sign
 *
 * Exit 0 = every selected mutant applies uniquely; 1 = at least one does not.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS, CLASSES, validateCatalogue } from './mutants.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const only = argValue('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const cls = argValue('--cls', '');

const total = validateCatalogue();
const sources = new Map();
const read = (file) => {
  if (!sources.has(file)) sources.set(file, readFileSync(join(repoRoot, file), 'utf8'));
  return sources.get(file);
};

const selected = MUTANTS.filter((m) => (only.length ? only.includes(m.id) : true))
  .filter((m) => (cls ? m.cls === cls : true));

const failures = [];
for (const mutant of selected) {
  const source = read(mutant.file);
  const occurrences = source.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    failures.push(`${mutant.id} ${mutant.cls}: find occurs ${occurrences}× in ${mutant.file} (need exactly 1)`);
    continue;
  }
  const mutated = source.replace(mutant.find, mutant.replace);
  if (mutated === source) {
    failures.push(`${mutant.id} ${mutant.cls}: mutation is a no-op`);
    continue;
  }
  if (mutant.replace && mutated.split(mutant.replace).length - 1 < 1) {
    failures.push(`${mutant.id} ${mutant.cls}: replacement not present after applied edit`);
  }
}

const byClass = new Map();
for (const mutant of MUTANTS) byClass.set(mutant.cls, (byClass.get(mutant.cls) ?? 0) + 1);

process.stdout.write(
  `${JSON.stringify(
    {
      catalogue: total,
      classes: Object.keys(CLASSES).length,
      selected: selected.length,
      failures,
      byClass: Object.fromEntries([...byClass.entries()].sort()),
    },
    null,
    2,
  )}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
