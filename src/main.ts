// SPDX-License-Identifier: Apache-2.0
// Process entry for the gateway, spawned by the supervisor (cli.ts
// resolveSupervisorPaths().indexEntry) and runnable as `node dist/main.js`.
// It exports nothing and is imported by nothing. It refuses to run unless it is
// the main module of its own process, so loading it into another process (a
// test runner, a tool or a host) can never start the gateway. The importable
// gateway logic lives in ./index.ts and is loaded only after that check.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

/**
 * True only when this module is the entry point of its own process:
 * - it runs on the main thread (a Worker started on this file is refused);
 * - Node's ESM loader marked it as the entry (`import.meta.main`, set by the
 *   loader on Node >= 22.18 and >= 24.2 and never derived from process.argv);
 *   on a runtime that sets the flag, a missing flag means a non-native
 *   evaluator, such as a test runner's module transform, and is refused;
 * - process.argv[1] canonicalizes to this file. On older runtimes this is the
 *   only check, and process.argv is writable by any in-process code, so the
 *   guard is defense in depth against accidental loads, not a proof against
 *   hostile in-process code (the exposure guard covers that statically).
 * A missing or unresolvable argv[1], such as an extensionless launch, is refused.
 */
function isProcessEntry(): boolean {
  if (!isMainThread) return false;
  const flag: unknown = import.meta.main; // undefined on runtimes that predate the flag
  if (typeof flag === 'boolean' ? !flag : runtimeSetsMainFlag()) return false;
  try {
    const entry = process.argv[1];
    return !!entry && realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function runtimeSetsMainFlag(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 2) || (major === 22 && minor >= 18);
}

if (!isProcessEntry()) {
  throw new Error('codex-channel-octo: main.js is a process entry and cannot be loaded as a module');
}

const { main } = await import('./index.js');
main().catch((err) => {
  console.error('[codex-channel-octo] Fatal error:', String(err));
  process.exit(1);
});
