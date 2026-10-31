import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { autoProfileName, createProfile, defaults, lastProfile, loadConfig, lockProfile, profilePath, rememberProfile, saveConfig, listProfiles } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

// Short paths: the profile lock socket has a ~103-byte limit on macOS. Windows uses a hashed named pipe, so any directory fits.
const root = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'oc-headless-') : '/tmp/oc-headless-');
const oldHome = process.env.OPTCHAT_HOME;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.OPTCHAT_HOME = join(root, 'home');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  removeDir(root);
});
for (const name of ['work', 'personal']) {
  createProfile(name);
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
}
rememberProfile('personal');

/** A headless Pi (print or RPC) whose model answers "OK to: <prompt>" and records what each call was sent. */
async function headless(mode: 'print' | 'rpc' | 'tui', options: { flag?: string; bound?: string; connect?: string; agent?: string; hold?: Promise<void>; later?: ExtensionFactory;
  /** A host that runs `--no-session`: Pi keeps no file and hands out a throwaway id. */ ephemeral?: boolean; sessionId?: string; cwd?: string } = {}) {
  const dir = options.cwd ?? mkdtempSync(join(root, 's-'));
  const sent: string[] = [], errors: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      sent.push(JSON.stringify(context.messages));
      const last = context.messages.at(-1);
      const prompt = textContent(last && 'content' in last ? last.content : '');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `OK to: ${prompt}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      void ((prompt.includes('slow') ? options.hold : undefined) ?? Promise.resolve()).then(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, ...options.later ? [options.later] : []] });
  await loader.reload();
  const manager = options.ephemeral ? SessionManager.inMemory(dir) : SessionManager.create(dir, join(dir, 'sessions'), options.sessionId ? { id: options.sessionId } : undefined);
  if (options.bound) manager.appendCustomEntry('optchat.profile', { name: options.bound });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: [] });
  if (options.flag) session.extensionRunner.setFlagValue('optchat-profile', options.flag);
  if (options.agent !== undefined) session.extensionRunner.setFlagValue('optchat-agent', options.agent);
  if (options.connect) session.extensionRunner.setFlagValue('optchat-connect', options.connect);
  // RPC hosts have a real UI, but a dialog there can hang the host (pi-acp), so any select fails the test.
  const notes: string[] = [];
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), notify: message => { notes.push(message); },
    select: async () => { throw new Error('a headless session must not ask for a profile'); } };
  await session.bindExtensions({ uiContext, mode, onError: error => { errors.push(error.error); } });
  const ask = async (text: string) => {
    await session.prompt(text);
    const reply = session.state.messages.at(-1);
    return reply?.role === 'assistant' ? textContent(reply.content) : undefined;
  };
  const bindings = () => manager.getEntries().flatMap(e => e.type === 'custom' && e.customType === 'optchat.profile' ? [e.data] : []);
  const close = async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  return { ask, bindings, close, errors, notes, sent, sessionId: manager.getSessionId(), dir };
}

test('a headless run without a binding or --optchat-profile is plain Pi: it answers, and no profile is picked or created', async () => {
  for (const mode of ['print', 'rpc'] as const) {
    const pi = await headless(mode);
    try {
      assert.equal(await pi.ask('Say OK'), 'OK to: Say OK', `${mode}: the prompt reaches the model`);
      assert.deepEqual(pi.errors, []);
      assert.deepEqual(pi.bindings(), [], `${mode}: the session stays unbound`);
      assert.doesNotMatch(pi.sent[0], /You are OptChat/, `${mode}: Pi's own prompt is untouched`);
    } finally { await pi.close(); }
  }
  assert.ok(!existsSync(profilePath('default')), 'no default profile is created');
  assert.equal(lastProfile(), 'personal', 'the last-used profile is unchanged');
});

test('--optchat-profile still opens that profile headlessly', async () => {
  const pi = await headless('print', { flag: 'work' });
  try {
    assert.match(await pi.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/, 'the prompt runs with the OptChat view');
    assert.deepEqual(pi.errors, []);
    assert.deepEqual(pi.bindings(), [{ name: 'work' }]);
    assert.match(pi.sent[0], /You are OptChat/);
  } finally { await pi.close(); }
});

test('in an RPC host (Pi Web), /optchat profile <name> as the first message binds that session in place', async () => {
  // No commandContextActions are bound, so ctx.newSession() throws, as Pi Web's does.
  const pi = await headless('rpc');
  try {
    await pi.ask('/optchat profile work');
    assert.deepEqual(pi.bindings(), [{ name: 'work' }]);
    assert.match(await pi.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/, 'the next prompt runs with the OptChat view');
    assert.match(pi.sent[0], /You are OptChat/);
    await pi.ask('/optchat profile personal');
    assert.deepEqual(pi.bindings(), [{ name: 'work' }], 'a session with messages keeps its profile');
    assert.match(pi.notes.at(-1) ?? '', /^Run \/optchat profile personal as the first message of a new session/);
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});

test('in an RPC host, /optchat profile <name> that cannot open saves no binding and blocks prompts instead of running without memory', async () => {
  const unlock = await lockProfile(profilePath('work'), 'work · PID 1 · elsewhere');
  try {
    for (const [why, name, error] of [['typo', 'wrok', /does not exist/], ['busy', 'work', /Profile already running/]] as const) {
      const pi = await headless('rpc');
      try {
        await pi.ask(`/optchat profile ${name}`);
        assert.match(pi.notes.at(-1) ?? '', error, `${why}: the command says why`);
        assert.equal(await pi.ask('Say OK'), undefined, `${why}: the prompt is not answered`);
        assert.equal(pi.sent.length, 0, `${why}: nothing reaches the model`);
        assert.deepEqual(pi.bindings(), [], `${why}: no binding is saved`);
      } finally { await pi.close(); }
    }
  } finally { await unlock(); }
});

test('the model gets the system prompt Pi has now, with sections extensions loaded after OptChat add (Pi\'s built-in MCP)', async () => {
  const later: ExtensionFactory = pi => { pi.on('before_agent_start', event => { event.systemPromptOptions.sections.x = 'SECTION-FROM-LATER-EXTENSION'; }); };
  const pi = await headless('print', { flag: 'work', later });
  try {
    await pi.ask('Say OK');
    assert.match(pi.sent[0], /You are OptChat/);
    assert.match(pi.sent[0], /SECTION-FROM-LATER-EXTENSION/);
  } finally { await pi.close(); }
});

test('a requested profile that cannot open fails visibly and does not run without memory', async () => {
  const unlock = await lockProfile(profilePath('work'), 'work · PID 1 · elsewhere');
  try {
    // `auto` would join the busy owner; this one has no windows socket, so the join fails too, with a failing exit code.
    for (const [why, options] of [['typo', { flag: 'wrok' }], ['busy', { bound: 'work', connect: 'off' }], ['busy, nothing to join', { bound: 'work' }],
      ['deleted', { bound: 'gone' }], ['join without a session', { flag: 'personal', connect: 'join' }], ['join with an invalid name', { flag: 'Work', connect: 'join' }]] as const) {
      process.exitCode = undefined;
      const pi = await headless('print', options);
      try {
        assert.equal(pi.errors.length, 1, `${why}: Pi reports the error (stderr in print mode)`);
        assert.equal(await pi.ask('Say OK'), undefined, `${why}: the prompt is not answered without memory`);
        assert.equal(pi.sent.length, 0);
        assert.equal(process.exitCode, why.includes('join') ? 1 : undefined, `${why}: exit code`);
      } finally { await pi.close(); }
    }
  } finally { process.exitCode = undefined; await unlock(); }
});

test('a second pi -p on a profile a headless run owns fails up front, instead of joining and dying when the owner exits', async () => {
  let release = () => {};
  const owner = await headless('print', { flag: 'work', hold: new Promise<void>(resolve => { release = resolve; }) });
  const stderr: string[] = [], write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; };
  process.exitCode = undefined;
  try {
    const second = await headless('print', { flag: 'work' });
    try {
      // The joined task would run in the owner and wait there, so the owner exits mid-task, as `pi -p` does once its own prompt is answered.
      const answer = second.ask('slow joined task');
      let answered = false; void answer.finally(() => { answered = true; });
      while (!answered && !owner.sent.some(s => s.includes('slow joined task'))) await new Promise(resolve => setTimeout(resolve, 10));
      const closed = owner.close(); release(); await closed;
      assert.equal(await answer, undefined);
      assert.doesNotMatch(stderr.join(''), /Connection to the original Pi window was lost/);
      assert.equal(second.errors.length, 1, 'the second run reports the busy profile when it starts');
      assert.match(second.errors[0], /does not accept connections/);
      assert.equal(process.exitCode, 1);
      assert.ok(!owner.sent.some(s => s.includes('slow joined task')), 'nothing of the second run reached the owner');
    } finally { await second.close(); }
  } finally { process.stderr.write = write; process.exitCode = undefined; release(); await owner.close(); }
});

test('--optchat-agent refuses headless mode without opening a profile or answering locally', async () => {
  for (const mode of ['print', 'rpc'] as const) {
    process.exitCode = undefined;
    const pi = await headless(mode, { flag: 'work', agent: '8ab62e89' });
    try {
      assert.equal(pi.errors.length, 1);
      assert.match(pi.errors[0], /requires interactive Pi/);
      assert.equal(await pi.ask('Do not run this locally'), undefined);
      assert.equal(pi.sent.length, 0);
      assert.deepEqual(pi.bindings(), []);
      assert.equal(process.exitCode, 1);
    } finally { await pi.close(); process.exitCode = undefined; }
  }
});

test('--optchat-profile auto names the profile after the session and creates it from the session model', async () => {
  const pi = await headless('rpc', { flag: 'auto' });
  try {
    assert.match(await pi.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/, 'the prompt runs with the OptChat view');
    const [binding, ...rest] = pi.bindings();
    assert.equal(rest.length, 0, 'one binding');
    const id = pi.sessionId.replace(/[^a-z0-9]/gi, '').toLowerCase();
    assert.equal(String((binding as { name?: string } | undefined)?.name), `t3-${basename(pi.dir).toLowerCase()}-${id.slice(0, 12)}${id.slice(-12)}`,
      'the name is the directory slug plus both ends of the session id, so two sessions never share one');
    const name = (binding as { name: string }).name, dir = profilePath(name);
    assert.ok(existsSync(join(dir, 'AGENTS.md')), 'the profile is complete, so /optchat instructions works');
    const config = loadConfig(dir);
    assert.deepEqual({ provider: config.compactor.provider, model: config.compactor.model }, { provider: 'fixture', model: 'fixture' },
      'the compactor runs the model the session already uses');
    assert.deepEqual({ provider: config.subagent.provider, model: config.subagent.model }, { provider: 'fixture', model: 'fixture' });
    assert.equal(config.compactor.thinking, config.subagent.thinking, 'thinking follows the session');
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});

test('--optchat-profile auto gives two sessions whose ids share their first 8 characters different profiles', async () => {
  // T3 Code opens threads in bursts. UUIDv7 ids started inside one 65.5 s window share their first 8 characters,
  // so the shortened name gave them one profile, and the second session died on the first one's lock.
  const first = await headless('rpc', { flag: 'auto', sessionId: '01a19227-2f21-7c00-8000-000000000001' });
  const second = await headless('rpc', { flag: 'auto', sessionId: '01a19227-2f45-7c00-8000-000000000002' });
  try {
    assert.match(await first.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/, 'the first session runs with its own memory');
    assert.match(await second.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/, 'the second session runs with its own memory too');
    assert.deepEqual(first.errors, [], 'the first session was not taken down');
    assert.deepEqual(second.errors, [], 'the second session did not meet the first one\'s lock');
    const names = [first, second].map(pi => (pi.bindings()[0] as { name?: string } | undefined)?.name);
    assert.ok(names[0] && names[1], 'both sessions saved a binding');
    assert.notEqual(names[0], names[1], 'the two sessions name different profiles');
    for (const name of names) assert.ok(existsSync(join(profilePath(String(name)), 'AGENTS.md')), `${name} exists`);
  } finally { await first.close(); await second.close(); }
});

test('--optchat-profile auto with --no-session creates no profile and runs as plain Pi', async () => {
  // T3 Code starts its provider probe and one-off text generation with --no-session; a profile named after the
  // throwaway session id can never be resumed, so it was only an empty directory left behind on every run.
  const before = listProfiles();
  for (const mode of ['print', 'rpc'] as const) {
    const pi = await headless(mode, { flag: 'auto', ephemeral: true });
    try {
      assert.equal(await pi.ask('Say OK'), 'OK to: Say OK', `${mode}: the prompt is answered without OptChat memory`);
      assert.deepEqual(pi.errors, [], `${mode}: nothing failed`);
      assert.deepEqual(pi.bindings(), [], `${mode}: a session with no file is not bound`);
      assert.doesNotMatch(pi.sent[0] ?? '', /You are OptChat/, `${mode}: Pi's own prompt is untouched`);
    } finally { await pi.close(); }
  }
  assert.deepEqual(listProfiles(), before, 'no profile was created for the throwaway session');
});

test('a profile another host creates during startup surfaces as its lock owner, not as EEXIST', async () => {
  const dir = mkdtempSync(join(root, 'race-')), id = '01a19227-2f21-7c00-8000-000000000001';
  const name = autoProfileName(dir, id)!, target = profilePath(name);
  createProfile(name);
  const unlock = await lockProfile(target, `${name} · PID 1 · elsewhere`);
  const original = fs.existsSync, seen = { n: 0 };
  // The first two checks are startup's guard and createProfile's own: both see no directory, as they would while two
  // hosts race. Afterwards the directory is visible, as it is once the other host's mkdir has returned.
  mock.method(fs, 'existsSync', (path: fs.PathLike) => String(path) === target && seen.n++ < 2 ? false : original(path));
  syncBuiltinESMExports();
  const pi = await headless('rpc', { flag: 'auto', sessionId: id, cwd: dir });
  try {
    assert.equal(pi.errors.length, 1, 'the session start fails once');
    assert.match(String(pi.errors[0]), /Profile already running: .*PID 1/, 'the message names the host that holds the profile');
    assert.doesNotMatch(String(pi.errors[0]), /EEXIST/, 'a raced mkdir is not reported as a filesystem error');
    assert.deepEqual(loadConfig(target).compactor, defaults.compactor, 'the other host keeps the config it wrote');
  } finally {
    await pi.close(); mock.restoreAll(); syncBuiltinESMExports(); await unlock(); removeDir(target); removeDir(dir);
  }
});

test('--optchat-profile auto still refuses a --no-session session in the TUI, and opens nothing', async () => {
  const before = listProfiles();
  const pi = await headless('tui', { flag: 'auto', ephemeral: true });
  try {
    assert.deepEqual(pi.errors, [], 'the refusal is shown to the person, not thrown out of the handler');
    assert.match(pi.notes.at(-1) ?? '', /--optchat-profile auto needs a session: this host started Pi with --no-session/,
      'the person is told why their flag did nothing');
    assert.deepEqual(pi.bindings(), [], 'nothing is bound');
    assert.deepEqual(listProfiles(), before, 'no profile is created');
  } finally { await pi.close(); }
});

test('--optchat-profile auto leaves a session that is already bound to its own profile alone', async () => {
  const pi = await headless('rpc', { flag: 'auto', bound: 'work' });
  try {
    await pi.ask('Say OK');
    assert.deepEqual(pi.bindings(), [{ name: 'work' }], 'the saved binding wins over auto');
    assert.ok(!existsSync(profilePath('auto')), 'auto is not treated as a profile name');
  } finally { await pi.close(); }
});
