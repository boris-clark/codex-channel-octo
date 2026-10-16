// SPDX-License-Identifier: Apache-2.0
/**
 * Checked dynamic loader for tooling (goldens generators, downgrade harness).
 *
 * Direct target: imported only when its canonical path is inside one of the pinned outside roots,
 * `.cache/downgrade/<pins.A>/dist/` and `.cache/goldens/`, and outside this repository's `src/`/`dist/`.
 * Containment is decided on filesystem identity (realpathSync.native, (dev,ino) and case-folded path).
 *
 * Provenance (XIN-2207 B-2): a load is refused unless every module under the target's pinned root passes
 * a static pre-scan, performed once per root and cached, that refuses:
 *   - eval / new Function / vm code evaluation;
 *   - node:module register / registerHooks, Module._load, new Module (the two forged-parent and
 *     shortCircuit bypasses rely on these);
 *   - a reflective `.constructor` / `.__proto__` read;
 *   - a write to process.argv;
 *   - any import(), require(), `.require()` or createRequire-result call whose target is not a literal
 *     BARE specifier (so a relative, absolute or `..` target into src/dist cannot be reached).
 * Only literal bare dependency loads (for example `json5`, `@openclaw/fs-safe/secure-temp-root`) are
 * allowed, and they resolve only inside node_modules. After the scan the loader snapshots every file's
 * SHA-256 under the root; before each load it re-verifies the target's digest and refuses if any file was
 * added or changed since the snapshot (fail-closed invalidation).
 *
 * Transitive loads: a synchronous resolution hook (node:module registerHooks) also refuses, defensively,
 * any resolution into `src/`/`dist/` from a module that is not repository-owned.
 *
 * Direct guarantee: no module whose canonical file lies in this checkout's `src/`/`dist/` is loaded, and
 * the loaded pinned-root graph cannot itself load from `src/`/`dist/` or evaluate code. Not covered: code
 * a pinned-root module evaluates WITHOUT the module loader (child process, Worker) — a process entry is
 * still inert there under L1. The exposure guard pins this file by SHA-256.
 */
import * as nodeModule from 'node:module';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const PINS = JSON.parse(readFileSync(join(ROOT, 'test', 'pins.json'), 'utf8'));
const PROTECTED = [join(ROOT, 'src'), join(ROOT, 'dist')];
const CACHE = join(ROOT, '.cache');
const ALLOWED_ROOTS = [join(CACHE, 'downgrade', PINS.A, 'dist'), join(CACHE, 'goldens')];
const ts = createRequire(join(ROOT, 'package.json'))('typescript'); // literal bare specifier

const sha = (b) => createHash('sha256').update(b).digest('hex');
function identity(path) { try { const st = statSync(path); return `${st.dev}:${st.ino}`; } catch { return null; } }
function canonical(path) { try { return realpathSync.native(path); } catch { return null; } }
function within(real, dirs) {
  const ids = new Set(dirs.map(identity).filter(Boolean));
  const names = dirs.map((d) => d.toLowerCase());
  for (let d = real; ; d = dirname(d)) { if (ids.has(identity(d)) || names.includes(d.toLowerCase())) return true; if (dirname(d) === d) return false; }
}
function repositoryOwned(parentURL) {
  if (!parentURL || !parentURL.startsWith('file:')) return false;
  const real = canonical(fileURLToPath(parentURL));
  if (!real) return false;
  return (real === ROOT || real.toLowerCase().startsWith(ROOT.toLowerCase() + sep)) && !within(real, [CACHE]);
}

// ---- static pre-scan of a pinned-root module -------------------------------------------------------
const isBareLiteral = (s) => typeof s === 'string' && s.length > 0 && !s.startsWith('.') && !s.startsWith('/') && !s.includes('..') && !s.startsWith('file:') && !/^[a-zA-Z]:[\\/]/.test(s);
const lit = (a) => (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null);
function scanModule(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const requireAliases = new Set();
  const collectAlias = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      let e = n.initializer; while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
      const txt = e.getText(sf);
      if (/createRequire\s*\(/.test(txt) && ts.isCallExpression(e) && /createRequire$/.test(e.expression.getText(sf).split('(')[0])) requireAliases.add(n.name.text);
    }
    ts.forEachChild(n, collectAlias);
  };
  collectAlias(sf);
  const bad = [];
  const isCreateRequireCall = (callee) => { const t = callee.getText(sf); return /(^|\.)createRequire$/.test(t); };
  const v = (n) => {
    if (ts.isPropertyAccessExpression(n) && (n.name.text === 'constructor' || n.name.text === '__proto__')) bad.push('reflective ' + n.name.text);
    if (ts.isElementAccessExpression(n)) { const k = lit(n.argumentExpression); if (k === 'constructor' || k === '__proto__') bad.push('reflective ' + k); }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Function') bad.push('new Function');
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const cText = callee.getText(sf);
      if (ts.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function')) bad.push(callee.text);
      if (/(^|\.)(runInThisContext|runInNewContext|runInContext|compileFunction)$/.test(cText)) bad.push('vm ' + cText.slice(-24));
      if (/(^|\.)registerHooks$/.test(cText) || /^register$/.test(cText) || /(^|\.)(module|Module|nodeModule)\.register$/.test(cText) || /(^|\.)_load$/.test(cText)) bad.push('loader ' + cText.slice(-24));
      // createRequire must bind to this module's own URL; a string-literal (forged repo parent) is refused
      if (isCreateRequireCall(callee)) { const a0 = n.arguments?.[0]; const t = a0 ? a0.getText(sf) : ''; if (!/^(import\.meta\.url|__filename)$/.test(t)) bad.push('createRequire forged parent ' + t.slice(0, 30)); }
      // dynamic module loads with a NON-LITERAL target are refused; literal targets are left to the
      // resolution hook, which refuses any resolution reaching this checkout's src/ or dist/.
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireId = ts.isIdentifier(callee) && (callee.text === 'require' || requireAliases.has(callee.text));
      const isDotRequire = ts.isPropertyAccessExpression(callee) && callee.name.text === 'require' && /^(module|Module|nodeModule)$/.test(callee.expression.getText(sf));
      const isCRResult = ts.isCallExpression(callee) && isCreateRequireCall(callee.expression);
      if (isImport || isRequireId || isDotRequire || isCRResult) { const a0 = n.arguments?.[0]; if (lit(a0) === null) bad.push(`non-literal load ${cText.slice(-20)}(${a0 ? a0.getText(sf).slice(0, 20) : ''})`); }
    }
    if (ts.isNewExpression(n) && /(^|\.)Module$/.test(n.expression.getText(sf))) bad.push('new Module');
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && /process\.argv/.test(n.left.getText(sf))) bad.push('process.argv write');
    ts.forEachChild(n, v);
  };
  v(sf);
  return bad;
}

const CODE_EXT = /\.(mjs|cjs|js|mts|cts|ts)$/;
function verifyRoot(realRoot) {
  // Re-walk and re-scan on every load (not cached): a module added to the pinned root after an earlier
  // clean load is scanned too, so a later-planted wrapper cannot ride a prior snapshot.
  const digests = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || !CODE_EXT.test(e.name)) continue;
      const bad = scanModule(p);
      if (bad.length) throw new Error(`refusing to load from pinned root: ${p} contains a refused construct: ${bad[0]}`);
      digests.set(p, sha(readFileSync(p)));
    }
  };
  walk(realRoot);
  return digests;
}

let hooked = false;
function installHook() {
  if (hooked) return;
  if (typeof nodeModule.registerHooks !== 'function') throw new Error('refusing to load: this runtime has no module.registerHooks, so transitive loads cannot be checked');
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith('file:') && !repositoryOwned(context.parentURL)) {
        const real = canonical(fileURLToPath(result.url));
        if (real && within(real, PROTECTED)) throw new Error(`refusing to resolve ${specifier} from ${context.parentURL ?? '<no parent>'}: it resolves inside the repository source or build tree`);
      }
      return result;
    },
  });
  hooked = true;
}

export function loadOutsideSource(path) {
  installHook();
  const real = realpathSync.native(path);
  if (within(dirname(real), PROTECTED)) throw new Error(`refusing to load ${path}: it resolves inside the repository source or build tree`);
  const roots = ALLOWED_ROOTS.map(canonical).filter((r) => r && !within(r, PROTECTED) && within(r, [CACHE]));
  const realRoot = roots.find((r) => within(dirname(real), [r]));
  if (!realRoot) throw new Error(`refusing to load ${path}: it is not inside a pinned outside root`);
  const digests = verifyRoot(realRoot);
  const now = sha(readFileSync(real));
  if (!digests.has(real) || digests.get(real) !== now) throw new Error(`refusing to load ${path}: it was added or changed since the pinned root was verified`);
  return import(pathToFileURL(real).href);
}
