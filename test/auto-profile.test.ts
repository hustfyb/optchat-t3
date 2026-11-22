import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoProfileName, profilePath } from '../src/profiles.ts';

// `--optchat-profile auto` names one profile per project: the working directory's last 16 characters. Every thread a
// host (T3 Code) opens in that directory resolves to the same name, so they share one memory — the first thread is the
// profile's owner, the rest join it as connected windows (`--optchat-connect auto`, the default). The session id is no
// longer part of the name: a per-thread name would keep the memories apart instead of together.
const tools = '/home/ubuntu/.t3/projects/tools';

test('the name is the project directory, the same for every thread in it', () => {
  assert.equal(autoProfileName(tools), 't3-tools');
  assert.equal(autoProfileName(tools), autoProfileName(tools), 'the same directory always names the same profile');
});

test('different projects name different profiles', () => {
  assert.notEqual(autoProfileName('/home/ubuntu/.t3/projects/tools'), autoProfileName('/home/ubuntu/.t3/projects/web'));
});

test('the name is the last 16 characters of the directory slug', () => {
  assert.equal(autoProfileName('/home/ubuntu/.t3/projects/some-really-long-project-name'), 't3-ong-project-name');
});

test('a name stays inside the profile-name and socket-path limits', () => {
  const name = autoProfileName('/tmp/' + 'a'.repeat(300));
  assert.ok(name && name.length <= 44, `short enough for the 64-character name rule: ${name}`);
  assert.doesNotThrow(() => profilePath(name!), 'the profile directory can be opened');
});

test('a directory with nothing to name falls back to root', () => {
  assert.equal(autoProfileName('/'), 't3-root');
  assert.equal(autoProfileName(''), 't3-root');
});