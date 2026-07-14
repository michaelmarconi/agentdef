import { existsSync, mkdirSync, rmSync, cpSync, renameSync } from 'node:fs';
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
function cloneGitRepo(source, targetDir, version) {
    const args = ['clone', '--depth', '1'];
    if (version)
        args.push('--branch', version.replace('^', ''));
    args.push(source, targetDir);
    mkdirSync(join(targetDir, '..'), { recursive: true });
    execFileSync('git', args, { stdio: 'pipe', timeout: 60_000 });
}
function gitOut(args, cwd) {
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
function cloneAndSwap(source, parentDir) {
    const tmpDir = `${parentDir}.tmp-${process.pid}`;
    rmSync(tmpDir, { recursive: true, force: true });
    try {
        cloneGitRepo(source, tmpDir);
        if (!existsSync(join(tmpDir, 'agent.yaml'))) {
            throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid agent definition`);
        }
        rmSync(parentDir, { recursive: true, force: true });
        renameSync(tmpDir, parentDir);
    }
    finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
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
    const warnings = [];
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
function cachedParentIsCurrent(source, parentDir, warnings) {
    let originUrl;
    let localSha;
    try {
        originUrl = gitOut(['config', '--get', 'remote.origin.url'], parentDir);
        localSha = gitOut(['rev-parse', 'HEAD'], parentDir);
    }
    catch {
        return false; // no .git or corrupt cache: re-clone
    }
    if (originUrl !== source)
        return false;
    let remoteSha;
    try {
        // The clone never passes a ref (see cloneGitRepo's unused version param), so
        // HEAD is the one ref to compare. If pinned refs ever land, gate on the ref.
        remoteSha = gitOut(['ls-remote', source, 'HEAD']).split(/\s+/)[0] ?? '';
    }
    catch {
        warnings.push(`warning: could not check ${source} for updates (offline?) — using cached parent @ ${localSha.slice(0, 7)}`);
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
function resolveExtends(agentDir, sourceDir, mode, seen, installed, warnings) {
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
        const keep = mode === 'reuse' ||
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
        if (isLocal)
            rmSync(parentDir, { recursive: true, force: true });
    }
    if (isLocal) {
        mkdirSync(join(parentDir, '..'), { recursive: true });
        cpSync(localPath, parentDir, { recursive: true });
        if (!existsSync(join(parentDir, 'agent.yaml'))) {
            throw new Error(`extends: parent at ${source} has no agent.yaml, not a valid agent definition`);
        }
    }
    else if (isGitSource(source)) {
        cloneAndSwap(source, parentDir);
    }
    else {
        throw new Error(`extends: unknown source type "${source}" (expected a local path or git URL)`);
    }
    installed.push(installed.length === 0 ? 'parent' : `parent^${installed.length + 1}`);
    resolveExtends(parentDir, parentSourceDir, mode, seen, installed, warnings);
}
