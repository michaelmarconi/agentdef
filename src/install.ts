import { existsSync, mkdirSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAgentManifest } from './loader.js';
import { knowledgeDirName } from './knowledge.js';
import { AGENTDEF_DIR } from './paths.js';

function isGitSource(source: string): boolean {
  return (
    source.endsWith('.git') ||
    source.includes('github.com') ||
    source.includes('gitlab.com') ||
    source.includes('bitbucket.org')
  );
}

// Paths agentdef reads out of a parent for every consumer: skills/ and agents/
// (mirror.ts, skills.ts) plus that level's knowledge dir, which is renameable per
// level via `knowledge: { dir: }` and so cannot be a constant. An `include:` can
// only add to this set, never remove from it. memory/ is deliberately absent:
// doc.ts reads memory/MEMORY.md from the local repo only, never from a parent.
const ESSENTIAL_PATHS = ['skills', 'agents'];

function essentialPathsFor(targetDir: string): string[] {
  return [...new Set([...ESSENTIAL_PATHS, knowledgeDirName(targetDir)])];
}

// `git clone --sparse` exists from 2.25 but was broken for URLs until 2.26 (it
// chdir'd into the URL instead of the clone dir), and cloneGitRepo is only ever
// reached for URLs. Rather than raise agentdef's floor to 2.26 for everyone, an
// older git falls back to the plain clone it has always done: the parent's whole
// tree, exactly as before. Only `include:` stops working there, and it says so.
let sparseSupport: boolean | undefined;
function gitSupportsSparseClone(): boolean {
  if (sparseSupport !== undefined) return sparseSupport;
  try {
    const m = gitOut(['--version']).match(/(\d+)\.(\d+)/);
    sparseSupport = m ? Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 26) : false;
  } catch {
    sparseSupport = false;
  }
  return sparseSupport;
}

// Returns whether the clone is sparse-capable, i.e. whether a selection can be
// applied afterwards. `--filter=blob:none --sparse` fetches the commit and tree
// objects but defers blobs; the implicit sparse-checkout the clone runs then
// pulls exactly the root files, so agent.yaml is on disk when this returns and
// the include list can be read before any subdirectory is fetched.
function cloneGitRepo(source: string, targetDir: string, version?: string): boolean {
  const sparse = gitSupportsSparseClone();
  const args = ['clone', '--depth', '1'];
  if (sparse) args.push('--filter=blob:none', '--sparse');
  if (version) args.push('--branch', version.replace('^', ''));
  args.push(source, targetDir);
  mkdirSync(join(targetDir, '..'), { recursive: true });
  execFileSync('git', args, { stdio: 'pipe', timeout: 60_000 });
  return sparse;
}

// An `include:` entry becomes a git argv element, so it is checked before it can
// become one. The `--` end-of-options token below already stops an option-shaped
// entry from being parsed as a flag (without it, `--no-cone` silently turns cone
// mode off and drops agent.yaml/SOUL.md/RULES.md from the checkout), but it does
// nothing about the rest: git rejects wildcards, absolute paths and `..` with a
// bare exit 128, and an entry carrying a newline passes git's own checks and
// writes raw extra lines into .git/info/sparse-checkout.
//
// This is a blocklist, unlike the allowlist init.ts applies to knowledge.dir,
// because that value is interpolated into a shell case pattern while this one is
// argv: the risky shapes are enumerable here, and an allowlist would reject
// legitimate non-ASCII directory names.
//
// It matters more than a normal input check because the mistake is invisible to
// the person who can fix it: a parent never applies its own `include:`, so a bad
// entry only ever fails on the consumers, in an unattended git hook.
export function parseIncludeList(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${where}: "include" must be a list of paths, got ${typeof value}`);
  }
  return value.map((entry, i) => {
    const at = `${where}: include[${i}]`;
    if (typeof entry !== 'string') {
      throw new Error(`${at} must be a string, got ${entry === null ? 'null' : typeof entry}`);
    }
    const path = entry.trim();
    const reason =
      path === ''
        ? 'is empty'
        : /^[-/!~]/.test(path)
          ? 'must not start with "-", "/", "!" or "~"'
          : /[*?[\]\\]/.test(path)
            ? 'must be a directory, not a wildcard pattern'
            : /[\u0000-\u001f]/.test(path)
              ? 'must not contain control characters or newlines'
              : path.split('/').includes('..')
                ? 'must not contain a ".." segment'
                : '';
    if (reason) throw new Error(`${at} ${JSON.stringify(entry)} ${reason}`);
    return path;
  });
}

// Applies the parent's own `include:` to the still-sparse clone:
//   absent  -> sparse-checkout disable, i.e. the full tree, byte-identical to
//              the plain clone agentdef has always done
//   present -> essentials + the declared paths, and nothing else is ever fetched
//   []      -> essentials only
// Cone mode always materialises every file at the repository root, so agent.yaml,
// SOUL.md and RULES.md arrive regardless and `include:` only ever names
// subdirectories. A listed path that does not exist is a silent no-op in cone
// mode, which validate() warns about in the repo that declared it.
function applySparseSelection(targetDir: string, source: string): void {
  const manifest = loadAgentManifest(targetDir) as { include?: unknown };
  const include = parseIncludeList(manifest.include, `extends: ${source}: agent.yaml`);
  const args = include
    ? ['sparse-checkout', 'set', '--', ...essentialPathsFor(targetDir), ...include]
    : ['sparse-checkout', 'disable'];
  execFileSync('git', ['-C', targetDir, ...args], { stdio: 'pipe', timeout: 60_000 });
}

function gitOut(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    ...(cwd ? { cwd } : {}),
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 15_000,
  }).trim();
}

// Clone into a sibling temp dir, verify, then swap. Failure-safe where a plain
// rm-then-clone is not: a network drop mid-clone leaves the previous
// materialization intact instead of destroying it.
//
// applySparseSelection belongs INSIDE this window, on tmpDir. On a partial clone
// it is a second network operation (it backfills the deferred blobs), and at
// --depth 1 it carries most of the bytes, so it is the likelier of the two to
// fail. Run after the swap it would leave a root-files-only cache behind, with
// the right origin URL and the right HEAD SHA — exactly and only what
// cachedParentIsCurrent() gates on — so every later sync would certify it as
// healthy while every inherited skill, agent and knowledge doc stayed missing.
// Here a failure throws with the previous cache untouched, and sparse state
// survives the rename (it lives in .git/info, which carries no absolute paths).
function cloneAndSwap(source: string, parentDir: string, warnings: string[]): void {
  const tmpDir = `${parentDir}.tmp-${process.pid}`;
  rmSync(tmpDir, { recursive: true, force: true });
  try {
    const sparse = cloneGitRepo(source, tmpDir);
    if (!existsSync(join(tmpDir, 'agent.yaml'))) {
      throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid agent definition`);
    }
    if (sparse) {
      applySparseSelection(tmpDir, source);
    } else if (parseIncludeList((loadAgentManifest(tmpDir) as { include?: unknown }).include, `extends: ${source}: agent.yaml`)) {
      // Too old a git to filter, but the parent asked to be trimmed. The clone
      // is complete and correct, so this is a warning and not a failure.
      warnings.push(
        `warning: ${source} declares include: but git ${gitOut(['--version']).replace('git version ', '')} cannot do a partial clone (needs 2.26+) — fetched the full tree instead`,
      );
    }
    rmSync(parentDir, { recursive: true, force: true });
    renameSync(tmpDir, parentDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// How install treats an already-materialized git parent:
//   reuse   — keep it, only fill in missing deeper ancestors (CLI `install`)
//   refresh — re-clone only when the remote HEAD moved (sync's default; the
//             SHA gate keeps routine syncs offline-safe and clone-free)
//   force   — unconditionally re-clone (`install --force`, `sync --force`)
// Local-path parents are always re-copied under refresh/force: uncommitted
// local edits carry no SHA to gate on, and the copy is cheap.
export type InstallMode = 'reuse' | 'refresh' | 'force';

export interface InstallResult {
  installed: string[];
  warnings: string[];
}

// Resolve `extends:` by materializing the parent agent into .agentdef/parent,
// from a local path or a git URL — then recurse into that parent's own extends,
// so a whole ancestry (e.g. noord -> we-site -> texte) resolves in a single pass.
// Each ancestor lands one level deeper (.agentdef/parent/.agentdef/parent/...);
// the adapters walk that chain with nearer ancestors winning on collision (see
// sources.ts and merge.ts), so a local skill still overrides every inherited one.
// (Dependencies[] are not used by noord; add when a repo needs them.)
export function install(dir: string, opts: { mode?: InstallMode } = {}): InstallResult {
  const installed: string[] = [];
  const warnings: string[] = [];
  const root = resolve(dir);
  // Seed with the root's own identity so a chain that points back to it (directly
  // or transitively) is caught before any copy, not after a self-copy crash.
  resolveExtends(root, root, opts.mode ?? 'reuse', new Set([root]), installed, warnings);
  return { installed, warnings };
}

// Whether the materialized git parent can be kept as-is under `refresh`: same
// origin URL (an edited extends: must re-clone) and the remote HEAD unchanged.
// Network failure keeps the cache with a loud warning rather than aborting:
// the cache is a previously-validated materialization and sync runs from git
// hooks on every pull, so it must survive being offline. Real definition errors
// (bad agent.yaml, cycles, missing parent manifest) still fail loudly below.
function cachedParentIsCurrent(source: string, parentDir: string, warnings: string[]): boolean {
  let originUrl: string;
  let localSha: string;
  try {
    originUrl = gitOut(['config', '--get', 'remote.origin.url'], parentDir);
    localSha = gitOut(['rev-parse', 'HEAD'], parentDir);
  } catch {
    return false; // no .git or corrupt cache: re-clone
  }
  if (originUrl !== source) return false;
  let remoteSha: string;
  try {
    // The clone never passes a ref (see cloneGitRepo's unused version param), so
    // HEAD is the one ref to compare. If pinned refs ever land, gate on the ref.
    remoteSha = gitOut(['ls-remote', source, 'HEAD']).split(/\s+/)[0] ?? '';
  } catch {
    warnings.push(
      `warning: could not check ${source} for updates (offline?) — using cached parent @ ${localSha.slice(0, 7)}`,
    );
    return true;
  }
  return remoteSha !== '' && remoteSha === localSha;
}

// One link in the chain: materialize this agent's parent, then recurse into the
// parent so its own extends resolves too. `sourceDir` is where this agent
// originally lives (for the root, agentDir itself): a materialized copy under
// .agentdef/parent must resolve its relative `extends:` against the original
// location, not the copy, or every second-level local parent goes missing.
// `seen` holds the identities already in the chain (the root, plus every source
// pulled in), so a repo that (transitively) extends itself fails loudly here
// instead of cloning forever.
function resolveExtends(
  agentDir: string,
  sourceDir: string,
  mode: InstallMode,
  seen: Set<string>,
  installed: string[],
  warnings: string[],
): void {
  const manifest = loadAgentManifest(agentDir);
  if (!manifest.extends) return;

  const source = manifest.extends;
  const localPath = resolve(sourceDir, source);
  const isLocal = existsSync(localPath);
  const key = isLocal ? localPath : source;
  if (seen.has(key)) {
    throw new Error(`extends: cycle detected — "${source}" already appears in the chain`);
  }
  seen.add(key);

  const parentDir = join(agentDir, AGENTDEF_DIR, 'parent');
  // A git-cloned parent has no original location on this machine, so the clone
  // itself is the best base for resolving whatever it extends.
  const parentSourceDir = isLocal ? localPath : parentDir;

  if (existsSync(parentDir)) {
    const keep =
      mode === 'reuse' ||
      (mode === 'refresh' &&
        !isLocal &&
        isGitSource(source) &&
        cachedParentIsCurrent(source, parentDir, warnings));
    if (keep) {
      // Already materialized and current enough; resolve its chain so any deeper
      // ancestor still missing (or stale) gets handled, then stop.
      resolveExtends(parentDir, parentSourceDir, mode, seen, installed, warnings);
      return;
    }
    if (isLocal) rmSync(parentDir, { recursive: true, force: true });
  }

  if (isLocal) {
    mkdirSync(join(parentDir, '..'), { recursive: true });
    cpSync(localPath, parentDir, { recursive: true });
    if (!existsSync(join(parentDir, 'agent.yaml'))) {
      throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid agent definition`);
    }
  } else if (isGitSource(source)) {
    cloneAndSwap(source, parentDir, warnings);
  } else {
    throw new Error(`extends: unknown source type "${source}" (expected a local path or git URL)`);
  }

  installed.push(installed.length === 0 ? 'parent' : `parent^${installed.length + 1}`);

  resolveExtends(parentDir, parentSourceDir, mode, seen, installed, warnings);
}
