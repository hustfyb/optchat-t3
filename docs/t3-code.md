# T3 Code

[T3 Code](https://t3.chat) runs Pi as an agent runtime: one Pi process per thread, started as

```
pi --mode rpc --session <that thread's session file> --extension <T3's own extension> …
```

Its only Pi provider settings are **Binary path** and **Launch arguments**, and launch arguments are a
fixed string with no templating. So there is no way for T3 to tell OptChat which thread it just started —
unless OptChat works it out from the session it was given.

This fork adds exactly that, plus the one crash that stood in its way.

## `--optchat-profile auto`

```
Providers → Pi → Launch arguments:  --optchat-profile auto
```

Instead of reading a profile name, OptChat names the profile after the session it is opening:

```
t3-<directory slug>-<first 12 and last 12 characters of the session id>      e.g. t3-tools-01a192272f4563a91f0e44c2
```

- The session id keeps the name stable: T3 reuses the same session file when it resumes a thread, so the
  thread comes back to the same memory, and a session that already carries an `optchat.profile` binding
  keeps it (the binding wins over `auto`).
- Both ends of the id are kept because a UUIDv7 session id starts with its millisecond timestamp: keeping
  only the first 8 characters gave every session started inside the same 65.5 s the same profile, and the
  second of two threads opened together died on the first one's lock. The full 24 characters stay unique
  per session and keep the name, and the lock socket built from it, inside their length limits.
- The profile is created on first use, with the model the session is already running (provider, model and
  thinking level), so a new thread needs no setup.
- A host that starts Pi with `--no-session` has no id to derive from: a headless run stays plain Pi and
  creates no profile. That is how T3 Code runs its provider probe and its one-off text generation, which
  used to leave an empty profile behind on every run. In the TUI, `auto` still refuses loudly.

Explicit names still work exactly as before; `auto` is opt-in.

## The crash `auto` needed fixed

T3 replaces the session under the running extension host, so `session_start` reaches an instance whose
profile is already open. `openProfile` took the lock again, met its own socket, got `ProfileBusyError`,
and — because only the TUI turns that into a menu — took the whole session down. This fork keeps the open
activation when the requested profile is the one already active.

## Install

```sh
pi install git:github.com/hustfyb/optchat-t3
```

Then set the launch arguments above in T3. Nothing else is needed: no wrapper binary, no patched
`node_modules`, no separate profile per thread by hand.

If you installed upstream `pi-optchat` on the same machine, remove it first: both provide the same
extension, and two copies would both try to own the profile.

```sh
pi remove npm:pi-optchat
```

Profiles live in `~/.optchat` as before, so existing memories carry over.

## What this fork changes

| Change | Why |
|---|---|
| `--optchat-profile auto` | one profile per T3 thread without a spawn wrapper |
| the whole session id in the auto name | two threads opened within 65.5 s shared one profile, and the second died on its lock |
| no profile for `--no-session` | T3's provider probe and one-off text generation left an empty profile per run |
| keep the open profile on a repeated `session_start` | T3's session replacement used to crash the thread |
| package name `optchat-t3`, version `…-t3.1` | installs next to upstream without pretending to be it |

Everything else is upstream [pi-optchat](https://github.com/jonaslsaa/pi-optchat) 0.11.0, unchanged.
Tests for both changes run in the same suite (`npm test`).
