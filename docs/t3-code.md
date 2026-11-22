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

Instead of reading a profile name, OptChat names the profile after the project it is opening:

```
t3-<directory slug>      e.g. t3-tools, t3-fyb
```

- One profile per project: every thread T3 opens in that directory resolves to the same name, so they share
  one memory. The first thread is the profile's owner; a later thread that starts while it runs joins it as a
  **connected window** (its agent runs in its own process but reads this memory, `--optchat-connect auto`),
  instead of dying on the owner's lock. When no thread has it open, the next one starts a fresh owner.
- The name is stable, so a resumed thread returns to its memory. A session that already carries an
  `optchat.profile` binding keeps it (the binding wins over `auto`), so profiles made by an older per-thread
  `auto` keep their memory until you merge them.
- The profile is created on first use, with the model the session is already running (provider, model and
  thinking level), so a new thread needs no setup.
- A host that starts Pi with `--no-session` has no working session to name: a headless run stays plain Pi and
  creates no profile. That is how T3 Code runs its provider probe and its one-off text generation, which
  used to leave an empty profile behind on every run. In the TUI, `auto` still refuses loudly.

Explicit names still work exactly as before; `auto` is opt-in.

## Merging old per-thread memories

Earlier versions of this fork named one profile per thread (`t3-<slug>-<session id>`), so a project's memory
was split across many profiles. After upgrading, new threads use the shared `t3-<slug>`; the old ones keep
their own until merged. `scripts/merge-thread-profiles.mjs` scans `~/.optchat/profiles`, groups the per-thread
profiles by project (the slug before the session id), and folds their logs into the project profile's own
memory, renumbering and de-duplicating and rebuilding the summary tree, with a `--dry-run` preview and a
backup before it writes.

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
| `--optchat-profile auto` | one profile per T3 project without a spawn wrapper |
| the project directory as the auto name | every thread in a project shares one memory; a second thread joins as a connected window instead of dying on the first one's lock |
| `scripts/merge-thread-profiles.mjs` | folds the old per-thread profiles' memories into their project profile |
| no profile for `--no-session` | T3's provider probe and one-off text generation left an empty profile per run |
| keep the open profile on a repeated `session_start` | T3's session replacement used to crash the thread |
| package name `optchat-t3`, version `…-t3.1` | installs next to upstream without pretending to be it |

Everything else is upstream [pi-optchat](https://github.com/jonaslsaa/pi-optchat) 0.12.4, unchanged, except that a profile this process already has open is kept by name alone: T3 replaces the session under the extension it keeps running, and `--optchat-connect` decides what a busy profile does (T3 leaves it at `auto`, so a second thread in the same process becomes a connected window instead of failing).
Tests for this fork's changes run in the same suite (`npm test`).
