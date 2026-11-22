#!/usr/bin/env node
// Folds the per-thread profiles an older `--optchat-profile auto` left behind into one profile per project.
//
// An older auto named one profile per thread (t3-<dir>-<session id>), so a project's memory was split across many
// profiles. `--optchat-profile auto` now names t3-<dir>, one per project (see docs/t3-code.md). This scans
// ~/.optchat/profiles, works out each profile's project from the working directory of the sessions bound to it (not
// from the name, which cannot be split reliably), and folds the per-thread profiles' logs into the project profile.
//
// Read-only unless --apply. A merge keeps the largest profile's log and summary tree as the prefix and appends the
// other logs after it, de-duplicating by receipt (or by kind+date+text when there is no receipt); the appended tail's
// summaries are dropped and OptChat rebuilds them in the background on the next open, so the bulk of an existing
// tree is reused instead of resummarizing a whole project's history. Every profile it writes is backed up first.
//
//   node scripts/merge-thread-profiles.mjs                 # scan only, print the plan
//   node scripts/merge-thread-profiles.mjs --apply         # merge, backing up first (stop T3 Code / Pi first)
//   node scripts/merge-thread-profiles.mjs --apply --rebind  # also repoint bound sessions at the project profile
//   node scripts/merge-thread-profiles.mjs --apply --prune-empty  # also remove empty per-thread shells
//
// Options:
//   --home <dir>      profiles live in <dir>/profiles (default: $OPTCHAT_HOME or ~/.optchat)
//   --sessions <dir>  Pi sessions to read cwd/bindings from (default: ~/.pi/agent/sessions)
//   --project <name>  only touch this project profile (e.g. t3-fyb)
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';

const NODE = 512;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const HOME = opt('--home', process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
const PROFILES = join(HOME, 'profiles');
const SESSIONS = opt('--sessions', join(homedir(), '.pi', 'agent', 'sessions'));
const ONLY = opt('--project', undefined);
const APPLY = has('--apply'), REBIND = has('--rebind'), PRUNE = has('--prune-empty'), REMOVE = has('--remove-merged');

/** The profile name `--optchat-profile auto` gives the project of an absolute working directory. Mirrors src/profiles.ts. */
function autoProfileName(cwd) {
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-16) || 'root';
  return `t3-${slug}`;
}

const fail = (msg) => { console.error(msg); process.exit(1); };
if (!existsSync(PROFILES)) fail(`No profiles directory at ${PROFILES}`);

// --- 1. Work out the project of each t3 profile from the sessions bound to it. ---------------------------------------
const profileCwds = new Map(); // profile -> Map(cwd -> count)
const bindingsOfSession = []; // { file, profile, cwd }  (one per session that has a binding)
for (const dir of existsSync(SESSIONS) ? readdirSync(SESSIONS) : []) {
  const full = join(SESSIONS, dir);
  if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const file of readdirSync(full).filter(n => n.endsWith('.jsonl'))) {
    const path = join(full, file);
    let cwd, profile;
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value && value.type === 'session' && typeof value.cwd === 'string') cwd = value.cwd;
        if (value && value.customType === 'optchat.profile' && value.data && typeof value.data.name === 'string') profile = value.data.name;
      }
    } catch { continue; }
    if (profile) { bindingsOfSession.push({ file: path, profile, cwd }); }
    if (profile && cwd) {
      const m = profileCwds.get(profile) ?? new Map();
      m.set(cwd, (m.get(cwd) ?? 0) + 1); profileCwds.set(profile, m);
    }
  }
}

/** The project profile a t3 profile belongs to: from the cwd of its bound sessions, else parsed from its name. */
function projectOf(name) {
  const cwds = profileCwds.get(name);
  if (cwds && cwds.size) {
    let best, n = -1; for (const [cwd, count] of cwds) if (count > n) { n = count; best = cwd; }
    return autoProfileName(best);
  }
  // No bound session (an empty shell): fall back to stripping a session-id suffix.
  const m = /^t3-(.+)-\d*[0-9a-f]{8}$/.exec(name) || /^t3-(.+)-\d*[0-9a-f]{20,24}$/.exec(name);
  return m ? `t3-${m[1]}` : name;
}

// --- 2. Read a profile's memory: its entries (with text) and whether it has a tree. -----------------------------------
function memoryDir(dir) {
  const file = join(dir, 'active-memory.json');
  if (!existsSync(file)) return dir;
  try { const name = JSON.parse(readFileSync(file, 'utf8')); if (typeof name === 'string') return join(dir, name); } catch {}
  return dir;
}
const logsIn = (dir) => existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort() : [];
function readRecords(dir) {
  const out = [];
  for (const name of logsIn(dir)) {
    const file = join(dir, name);
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn last line while one is open: skip it */ }
    }
  }
  return out;
}
function readProfile(name) {
  const dir = join(PROFILES, name), mem = memoryDir(dir);
  const entries = readRecords(join(mem, 'main'))
    .filter(e => e && Number.isSafeInteger(e.i) && typeof e.kind === 'string' && typeof e.date === 'string')
    .sort((a, b) => a.i - b.i);
  const treeCount = logsIn(join(mem, 'tree')).reduce((n, f) => n + readFileSync(join(mem, 'tree', f), 'utf8').split('\n').filter(Boolean).length, 0);
  return { name, dir, mem, entries, treeCount };
}
const receiptsOf = (e) => e.receipt;

// --- 3. Group t3 profiles by project. --------------------------------------------------------------------------------
const groups = new Map();
for (const name of readdirSync(PROFILES)) {
  if (!name.startsWith('t3-')) continue;
  const dir = join(PROFILES, name);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
  const project = projectOf(name);
  if (ONLY && project !== ONLY && name !== ONLY) continue;
  const g = groups.get(project) ?? { project, profiles: [], cwd: undefined };
  g.profiles.push(name);
  const viaSession = [...(profileCwds.get(name)?.keys() ?? [])][0];
  g.cwd ??= viaSession;
  groups.set(project, g);
}

// --- 4. Plan each project. -------------------------------------------------------------------------------------------
const plans = [];
for (const { project, profiles, cwd } of [...groups.values()]) {
  const loaded = profiles.map(readProfile);
  const real = loaded.filter(p => p.entries.length > 0);
  const empty = loaded.filter(p => p.entries.length === 0);
  const existingTarget = loaded.find(p => p.name === project);
  if (!real.length) {
    // Nothing to merge. Empty shells are prunable; a lone empty target is left as it is.
    if (empty.length && project !== undefined) plans.push({ project, empty, merge: false });
    continue;
  }
  // Base: the existing project profile if it has memory, else the largest per-thread profile (keeps its summary tree).
  const base = existingTarget && existingTarget.entries.length ? existingTarget
    : real.reduce((a, b) => (b.entries.length > a.entries.length ? b : a));
  const others = real.filter(p => p !== base).sort((a, b) => a.entries[0].date.localeCompare(b.entries[0].date));
    plans.push({ project, base, others, empty, merge: true, targetExists: !!existingTarget, cwd });
}

// --- 5. Report. ------------------------------------------------------------------------------------------------------
function projectLabel(plan) {
  return plan.cwd ?? '(from profile names)';
}
let changes = 0;
for (const plan of plans) {
  if (!plan.merge) {
    if (plan.empty.length) { console.log(`\n${plan.project}: ${plan.empty.length} empty profile(s), no memory — prune with --prune-empty`); changes += plan.empty.length; }
    continue;
  }
  const { project, base, others, empty } = plan;
  let total = base.entries.length;
  const seenReceipt = new Set(base.entries.map(receiptsOf).filter(Boolean));
  const seenContent = new Set(base.entries.filter(e => !receiptsOf(e)).map(e => `${e.kind}\u0000${e.date}\u0000${e.text}`));
  const per = others.map(o => {
    let add = 0;
    for (const e of o.entries) {
      const r = receiptsOf(e);
      if (r ? seenReceipt.has(r) : seenContent.has(`${e.kind}\u0000${e.date}\u0000${e.text}`)) continue;
      if (r) seenReceipt.add(r); else seenContent.add(`${e.kind}\u0000${e.date}\u0000${e.text}`);
      add++;
    }
    total += add;
    return { source: o, add, total: o.entries.length };
  });
  console.log(`\n${project}  ←  ${projectLabel(plan)}`);
  console.log(`  base   ${base.name}  (${base.entries.length} messages, ${base.treeCount} summaries kept)`);
  for (const { source, add, total: n } of per) console.log(`  + ${source.name}  (${add} of ${n} new${add < n ? ', rest duplicate' : ''})`);
  if (!per.length) console.log('  (no per-thread profiles to fold in)');
  if (empty.length) console.log(`  - ${empty.length} empty shell(s)${PRUNE ? ' (pruned)' : ' (use --prune-empty)'}`);
  if (REMOVE && (per.length || base.name !== project)) console.log(`  - fold-in source(s) archived after merge (--remove-merged)`);
  console.log(`  → ${total} messages in ${project}${plan.targetExists ? '' : ' (created)'}`);
  changes++;
}

if (!changes) { console.log('Nothing to merge: every t3 project already has a single profile.'); process.exit(0); }
if (!APPLY) { console.log('\nScan only. Re-run with --apply to merge (stop T3 Code / Pi first).'); process.exit(0); }

// --- 6. Apply. ------------------------------------------------------------------------------------------------------
const locked = (name) => new Promise(resolve => {
  const sock = join(PROFILES, name, 'lock.sock');
  if (!existsSync(sock)) return resolve(false);
  const s = createConnection(sock); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false));
});
const backupRoot = join(HOME, 'backups', `merge-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(backupRoot, { recursive: true });
const backup = (name) => { const to = join(backupRoot, name); cpSync(join(PROFILES, name), to, { recursive: true }); return to; };
const rmdirs = join(backupRoot, 'removed');

// Refuse to write anything if any profile this run touches is open: a live profile would not see our edits, and a
// half-applied run is worse than none. Checked for every plan before the first write.
const involvedAll = [...new Set(plans.filter(p => p.merge).flatMap(p => [p.base.name, p.project, ...p.others.map(o => o.name)]))]
  .filter(n => existsSync(join(PROFILES, n)));
const busy = [];
for (const n of involvedAll) if (await locked(n)) busy.push(n);
if (busy.length) fail(`These profiles are open (lock.sock accepts connections): ${busy.join(', ')}\nStop T3 Code / Pi, then re-run.`);

for (const plan of plans) {
  if (!plan.merge) continue;
  const { project, base, others, empty } = plan;
  const involved = [base.name, project, ...others.map(o => o.name)].filter((n, i, a) => a.indexOf(n) === i && existsSync(join(PROFILES, n)));

  for (const n of involved) { backup(n); }
  console.log(`\n${project}: backed up to ${backupRoot}`);

  // Build the merged log: base entries unchanged (their tree stays valid), then each source's new entries renumbered.
  const targetDir = join(PROFILES, project);
  const baseMem = memoryDir(join(PROFILES, base.name));
  const isBaseTarget = base.name === project;

  if (!isBaseTarget) {
    // Copy the base profile in wholesale (config, AGENTS, images, main, tree) to seed the target.
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(join(PROFILES, base.name), targetDir, { recursive: true, filter: (src) => !src.endsWith('lock.sock') && !src.endsWith('windows.sock') });
  }
  const mem = memoryDir(targetDir);
  // The base's main and tree stay as they are; appended entries go to one file of their own.
  const appendFile = join(mem, 'main', `zz-merged-${Date.now()}.jsonl`);
  mkdirSync(join(mem, 'main'), { recursive: true });

  const seenReceipt = new Set(base.entries.map(receiptsOf).filter(Boolean));
  const seenContent = new Set(base.entries.filter(e => !receiptsOf(e)).map(e => `${e.kind}\u0000${e.date}\u0000${e.text}`));
  let next = base.entries.length;
  const lines = [];
  for (const o of others) {
    for (const e of o.entries) {
      const r = receiptsOf(e);
      const key = `${e.kind}\u0000${e.date}\u0000${e.text}`;
      if (r ? seenReceipt.has(r) : seenContent.has(key)) continue;
      if (r) seenReceipt.add(r); else seenContent.add(key);
      const { i, ...rest } = e;              // renumber: the log must stay contiguous
      lines.push(JSON.stringify({ i: next++, ...rest }));
    }
    // The source's own tree does not line up after this offset; drop it (OptChat rebuilds those in the background).
    // Its images are still referenced by message text, so copy any the target lacks.
    const srcImages = join(o.dir, 'images');
    if (existsSync(srcImages)) {
      const dst = join(targetDir, 'images'); mkdirSync(dst, { recursive: true });
      for (const img of readdirSync(srcImages)) if (!existsSync(join(dst, img))) cpSync(join(srcImages, img), join(dst, img));
    }
  }
  if (lines.length) writeFileSync(appendFile, lines.join('\n') + '\n');
  // A stale view would point at parts of the old log; drop it and let OptChat rebuild it (local, no model calls).
  rmSync(join(mem, 'view.json'), { force: true });

  // Repoint the sessions bound to the old per-thread profiles at the merged project profile.
  if (REBIND) {
    const sources = new Set(others.map(o => o.name));
    if (base.name !== project) sources.add(base.name);
    for (const b of bindingsOfSession) {
      if (!sources.has(b.profile)) continue;
      // The plugin reads the last binding, so appending one to the project profile rebinds without rewriting history.
      const line = JSON.stringify({ type: 'custom', customType: 'optchat.profile', data: { name: project }, id: `rebind-${Date.now()}` });
      writeFileSync(b.file, line + '\n', { flag: 'a' });
    }
    console.log(`  rebound ${[...sources].join(', ')} → ${project}`);
  }

  if (PRUNE) {
    mkdirSync(rmdirs, { recursive: true });
    for (const e of empty) {
      cpSync(join(PROFILES, e.name), join(rmdirs, e.name), { recursive: true });
      rmSync(join(PROFILES, e.name), { recursive: true, force: true });
    }
    if (empty.length) console.log(`  pruned ${empty.length} empty shell(s) → ${rmdirs}`);
  }
  console.log(`  merged into ${project}: ${next} messages`);

  // Archive the folded-in profiles (a copy-source base and every appended source) so one project keeps one profile.
  // Never the profile that is itself the target. Done as a move into the backup tree, so it is reversible.
  if (REMOVE) {
    mkdirSync(rmdirs, { recursive: true });
    const gone = [];
    for (const n of [base.name, ...others.map(o => o.name)]) {
      if (n === project) continue;
      const from = join(PROFILES, n);
      if (!existsSync(from)) continue;
      cpSync(from, join(rmdirs, n), { recursive: true });
      rmSync(from, { recursive: true, force: true });
      gone.push(n);
    }
    if (gone.length) console.log(`  archived ${gone.length} folded-in profile(s) → ${rmdirs}`);
  }
}

console.log(`\nDone. Backups: ${backupRoot}`);
console.log('Restart T3 Code / Pi. The merged projects rebuild their appended summaries in the background on first open.');