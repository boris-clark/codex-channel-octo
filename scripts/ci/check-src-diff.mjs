#!/usr/bin/env node
/**
 * DEV-01 scope proof (R8 §9 exit gate, §10.1): relative to the pinned parent,
 * src/ may change only in the reviewed interface-seam allowlist, plus the
 * reviewed structural entry split (DEV-01 amendment v2.1, Policy 3), which is
 * pinned by change status and exact git blob: any further edit of those files,
 * or any other status, is a violation. Split pins outside src/ are checked the
 * same way.
 *   node scripts/ci/check-src-diff.mjs [base]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC_ALLOWLIST = ['src/seams/clock.ts', 'src/seams/fault-plan.ts'];

/** Structural entry split (Policy 3): path, git diff status and blob after the split. */
export const STRUCTURAL_SPLIT = [
  { status: 'M', path: 'src/__tests__/cli.test.ts', blob: '1b8c6e74ef7291c222cc98416d6e5fb9248fec65' },
  // Reviewed test-stability migration (DEV-01 amendment v2.1-r8, XIN-2207 B-3): the fs.watch reconcile
  // test re-issues its idempotent write until the watcher-driven reconcile is observed, so it is
  // deterministic on asynchronous-watch platforms. Production src/config-watcher.ts is unchanged.
  { status: 'M', path: 'src/__tests__/config-watcher.test.ts', blob: 'b0b8704913aebc1c8aa539cdd5f0a57e170d60cb' },
  { status: 'A', path: 'src/bin.ts', blob: 'af90698bc67f64c299b9d86ac8d4238f8213c34a' },
  { status: 'M', path: 'src/cli.ts', blob: '348560c1574d1a97194f61b5e1203b9f0ba5d009' },
  { status: 'M', path: 'src/index.ts', blob: '6acf68ce7b5d948098b47426f9cbc1b8f508b9c3' },
  { status: 'A', path: 'src/main.ts', blob: 'ca10a2b1fd9b98347ee36ac62087bf05e088cc46' },
  // Reviewed test-stability migration (DEV-01 A-43 remediation C1, SPLIT-ANCHOR-6): FO-03 waits for the
  // RECVACK event (80 ms negative window, 2,000 ms positive wait) instead of a fixed sleep. This path is
  // outside src/, so it is added to the diff scope below; any further edit of it is a violation.
  { status: 'A', path: 'test/integration/fake-octo-transport.test.ts', blob: 'd8f336a5d10cd14ec33464a2f76470a46450bdf3' },
];

/** Diff scope: src/ plus every structural-split pin outside src/. */
const SCOPE = ['src', ...STRUCTURAL_SPLIT.map((s) => s.path).filter((p) => !p.startsWith('src/'))];

/**
 * @param {{ root: string, base: string, changes?: Array<{ status: string, path: string, blob?: string }> }} opts
 * @returns {{ allowlist: string[], split: typeof STRUCTURAL_SPLIT, changes: Array<{ status: string, path: string, blob?: string }>, violations: Array<{ status: string, path: string, blob?: string }> }}
 */
export function checkSrcDiff({ root, base, changes }) {
  let list = changes;
  if (!list) {
    const diff = execFileSync('git', ['-C', root, 'diff', '--name-status', base, '--', ...SCOPE], { encoding: 'utf8' }).trim();
    const untracked = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '--', ...SCOPE], { encoding: 'utf8' }).trim();
    list = [
      ...diff.split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.at(-1) }; }),
      ...untracked.split('\n').filter(Boolean).map((p) => ({ status: 'A', path: p })),
    ];
  }
  const blobOf = (c) => c.blob ?? (changes || c.status === 'D' ? undefined : execFileSync('git', ['-C', root, 'hash-object', '--', c.path], { encoding: 'utf8' }).trim());
  const reviewed = (c) => SRC_ALLOWLIST.includes(c.path)
    || STRUCTURAL_SPLIT.some((s) => s.path === c.path && s.status === c.status && s.blob === blobOf(c));
  return { allowlist: SRC_ALLOWLIST, split: STRUCTURAL_SPLIT, changes: list, violations: list.filter((c) => !reviewed(c)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const base = process.argv[2] ?? JSON.parse(readFileSync(join(root, 'test', 'pins.json'), 'utf8')).A;
  const r = checkSrcDiff({ root, base });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.violations.length ? 1 : 0);
}
