import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAgentManifest } from './loader.js';
import { AGENTDEF_DIR } from './paths.js';
function isGitSource(source) {
    return (source.endsWith('.git') ||
        source.includes('github.com') ||
        source.includes('gitlab.com') ||
        source.includes('bitbucket.org'));
}
// Paths agentdef itself reads and merges for every consumer (see sources.ts,
// merge.ts). These are an operational invariant, not user config — a parent's
// `include:` can only add to this list, never omit from it.
const ESSENTIAL_PATHS = ['skills', 'agents'];
// A `--filter=blob:none --sparse` clone fetches commit/tree objects and root
// file blobs eagerly, but defers subdirectory blobs until a sparse-checkout
// pattern requests them — so agent.yaml is always readable immediately after
// this returns, before any decision about which subdirectories to fetch.
function cloneGitRepo(source, targetDir, version) {
    const args = ['clone', '--depth', '1', '--filter=blob:none', '--sparse'];
    if (version)
        args.push('--branch', version.replace('^', ''));
    args.push(source, targetDir);
    mkdirSync(join(targetDir, '..'), { recursive: true });
    execFileSync('git', args, { stdio: 'pipe', timeout: 60_000 });
}
// Applies the parent's declared `include:` whitelist to an already-cloned,
// still-sparse working tree:
//   - no `include` key       -> `sparse-checkout disable`: full tree, lazily
//                                fetching everything else. Content-identical
//                                to a plain (non-sparse) full clone.
//   - `include` present      -> fetch only ESSENTIAL_PATHS + the listed paths
//                                (cone mode always keeps root files regardless
//                                of this list, so agent.yaml/SOUL.md/RULES.md
//                                need not be named). Everything else (docs/,
//                                tests/, handovers/, ...) is never fetched.
//   - `include: []`          -> essentials only (the `set` branch with an
//                                empty extra list — still "present").
// Non-existent listed paths are harmless no-ops under cone mode.
function applySparseSelection(targetDir) {
    const manifest = loadAgentManifest(targetDir);
    // `manifest.include` is typed `string[] | undefined`, but the YAML behind it
    // is unchecked at runtime: a bare `include:` key yields null, and a scalar
    // (`include: foo`) yields a string. A string is truthy AND spreadable, so
    // without this guard it would silently expand into one path per character.
    // Null/absent is the least-surprising "full clone" for a bare key; an empty
    // list stays essentials-only ([] is truthy, so it takes the `set` branch).
    const include = manifest.include;
    if (include !== undefined && include !== null && !Array.isArray(include)) {
        throw new Error(`include: must be a list of paths, got ${typeof include}`);
    }
    if (!include) {
        execFileSync('git', ['-C', targetDir, 'sparse-checkout', 'disable'], {
            stdio: 'pipe',
            timeout: 60_000,
        });
        return;
    }
    // The literal `--` end-of-options token stops git from parsing an include
    // entry that looks like a flag (e.g. `--no-cone`, `--stdin`) as an option,
    // which would silently switch off cone mode and break the root-file guarantee.
    execFileSync('git', ['-C', targetDir, 'sparse-checkout', 'set', '--', ...ESSENTIAL_PATHS, ...include], { stdio: 'pipe', timeout: 60_000 });
}
// Resolve `extends:` by materializing the parent agent into .agentdef/parent,
// from a local path or a git URL — then recurse into that parent's own extends,
// so a whole ancestry (e.g. noord -> we-site -> texte) resolves in a single pass.
// Each ancestor lands one level deeper (.agentdef/parent/.agentdef/parent/...);
// the adapters walk that chain with nearer ancestors winning on collision (see
// sources.ts and merge.ts), so a local skill still overrides every inherited one.
// (Dependencies[] are not used by noord; add when a repo needs them.)
export function install(dir, opts = {}) {
    const installed = [];
    const root = resolve(dir);
    // Seed with the root's own identity so a chain that points back to it (directly
    // or transitively) is caught before any copy, not after a self-copy crash.
    resolveExtends(root, root, Boolean(opts.force), new Set([root]), installed);
    return { installed };
}
// One link in the chain: materialize this agent's parent, then recurse into the
// parent so its own extends resolves too. `sourceDir` is where this agent
// originally lives (for the root, agentDir itself): a materialized copy under
// .agentdef/parent must resolve its relative `extends:` against the original
// location, not the copy, or every second-level local parent goes missing.
// `seen` holds the identities already in the chain (the root, plus every source
// pulled in), so a repo that (transitively) extends itself fails loudly here
// instead of cloning forever.
function resolveExtends(agentDir, sourceDir, force, seen, installed) {
    const manifest = loadAgentManifest(agentDir);
    if (!manifest.extends)
        return;
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
        if (!force) {
            // Already materialized by a prior run; resolve its chain so any deeper
            // ancestor still missing gets filled in, then stop.
            resolveExtends(parentDir, parentSourceDir, force, seen, installed);
            return;
        }
        rmSync(parentDir, { recursive: true, force: true });
    }
    if (isLocal) {
        // A local path is a plain filesystem copy, not a git clone — there is no
        // partial-fetch to gate, so `include:` does not apply here. The parent's
        // full tree is already on disk with no extra fetch cost.
        mkdirSync(join(parentDir, '..'), { recursive: true });
        cpSync(localPath, parentDir, { recursive: true });
    }
    else if (isGitSource(source)) {
        cloneGitRepo(source, parentDir);
    }
    else {
        throw new Error(`extends: unknown source type "${source}" (expected a local path or git URL)`);
    }
    if (!existsSync(join(parentDir, 'agent.yaml'))) {
        throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid agent definition`);
    }
    if (!isLocal) {
        applySparseSelection(parentDir);
    }
    installed.push(installed.length === 0 ? 'parent' : `parent^${installed.length + 1}`);
    resolveExtends(parentDir, parentSourceDir, force, seen, installed);
}
