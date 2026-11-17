/**
 * Types for `scripts/check-live-site.mjs`, which is plain ESM run by `node` (no
 * build step) and therefore ships no declarations of its own. Only the two
 * exports the test suite uses are described; keep this file in step with the
 * module's exported surface.
 */

/** [file in this repo, path on the host] — the paths the live check compares. */
export declare const FILES: ReadonlyArray<readonly [file: string, path: string]>;

/** Does the content type the host returned match what that path must be served as? */
export declare function expectType(path: string, contentType: string): boolean;
