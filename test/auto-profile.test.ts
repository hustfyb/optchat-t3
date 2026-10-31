import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoProfileName, profilePath } from '../src/profiles.ts';

// `--optchat-profile auto` names one profile per host session. T3 Code opens threads in bursts, and its session ids
// are UUIDv7: the first 12 hex digits are the millisecond timestamp. Naming a profile after only 8 of them gave every
// session started inside one 65.5 s window the same profile, and the second thread died on the first one's lock.
const tools = '/home/ubuntu/.t3/projects/tools';

test('two sessions created in the same 65.5 s window name different profiles', () => {
  const a = autoProfileName(tools, '01a19227-2f21-7c00-8000-000000000001');
  const b = autoProfileName(tools, '01a19227-2f45-7c00-8000-000000000002');
  assert.equal(a, 't3-tools-01a192272f21000000000001', 'the timestamp and the tail of the id both stay');
  assert.notEqual(a, b, 'their first 8 characters match, so the tail is what keeps them apart');
});

test('the same session names the same profile, so a resumed thread returns to its memory', () => {
  const id = '01a19227-2f21-7c00-8000-000000000001';
  assert.equal(autoProfileName(tools, id), autoProfileName(tools, id));
});

test('a name stays inside the profile-name and socket-path limits', () => {
  const name = autoProfileName('/tmp/' + 'a'.repeat(300), '01a19227-2f21-7c00-8000-000000000001');
  assert.ok(name && name.length <= 44, `short enough for the 64-character name rule: ${name}`);
  assert.doesNotThrow(() => profilePath(name!), 'the profile directory can be opened');
  assert.equal(autoProfileName('/tmp/' + 'a'.repeat(300), 'x'.repeat(200))?.split('-').at(-1)?.length, 24,
    'a long custom session id is shortened to its first and last 12 characters');
});

test('a session id too short to be an identity names no profile', () => {
  for (const id of [undefined, '', 'abc', 'a-b-']) assert.equal(autoProfileName(tools, id), undefined);
});

test('a ULID session id works the same way', () => {
  const name = autoProfileName(tools, '01a1921e0d4f3c9a8b7d6e5f4a');
  assert.equal(name, 't3-tools-01a1921e0d4f9a8b7d6e5f4a');
});
