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
t3-<directory slug>-<first 8 characters of the session id>      e.g. t3-fairlead-01a185d0
```

- The session id keeps the name stable: T3 reuses the same session file when it resumes a thread, so the
  thread comes back to the same memory, and a session that already carries an `optchat.profile` binding
  keeps it (the binding wins over `auto`).
- The profile is created on first use, with the model the session is already running (provider, model and
  thinking level), so a new thread needs no setup.
- A host that starts Pi with `--no-session` has no id to derive from, and `auto` refuses loudly instead of
  guessing.

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
| keep the open profile on a repeated `session_start` | T3's session replacement used to crash the thread |
| package name `optchat-t3`, version `…-t3.1` | installs next to upstream without pretending to be it |

Everything else is upstream [pi-optchat](https://github.com/jonaslsaa/pi-optchat) 0.11.0, unchanged.
Tests for both changes run in the same suite (`npm test`).
