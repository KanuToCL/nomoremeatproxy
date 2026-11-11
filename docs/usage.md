# Using `nomeat`

One command that lets an assistant on one side call an assistant on the other, and look up
chats on the other side.

Examples below use a source checkout. With the npm package installed and on your PATH,
replace `node bin/nomeat.mjs` with `nomeat`. Run `npm run doctor` from the installed package
directory or source checkout; it is not a separate command added to your PATH.

## Requirements

- Node.js 22.15 or later.
- Codex CLI and Claude Code CLI installed and signed in with your subscriptions.
- Windows or macOS for listing sessions in the Claude app; the calls themselves do not need
  it. On macOS the opener runs under `script`, which gives it the terminal it needs. On
  Linux the vendor offers no opener, so a bridge conversation shows in Claude Desktop only
  when a chat there is listening (`listen --once`, see below); this was confirmed on Linux.
- On macOS, keep the project and the state folder outside Documents, Desktop and Downloads.
  The first time the Codex app touches a project in one of them, the system asks for access to
  that folder, and no installer can grant it ahead.

Run `npm run doctor` to check. It reports what is installed and whether both command lines
are signed in with the subscription, and calls nothing. A sign-in through an API key or a
third party shows as a `warning`: calls would use paid API credentials. A model can need a newer command line than the bridge does:
`claude-fable-5-2` (the peer `fable`) is refused with "API Error 400" before Claude CLI
2.1.290, so an older version shows as a `warning` that names that model. The row
`state-folder` says whether the state folder (see [State](#state)) exists or can be created,
and can be written; when it cannot, the row is `missing` and names `NOMEAT_STATE_DIR`.
`doctor` exits 1 when a required row is `missing`, and 0 otherwise. The desktop apps,
browsers and WSL are checked on Windows only; elsewhere those rows are `unknown` and say that
they are not checked on this platform. The host line names the distribution and its version
where `/etc/os-release` exists, as on Linux.

`npm run doctor -- --live` also makes one real, read-only, one-word call to `astra` and one to
`fable` through `nomeat call`, each in a new thread, from the caller `doctor-check`. For each
side it reports whether the command line was found, whether the call answered (which shows
that sign-in and the model work) and what `app.opened` said (Claude only). It exits 1 when a
side fails, including a Claude chat whose `app.opened` is `false`. A side is called only when its
command line and its subscription sign-in are both `found`, once, with a request id of its own
and no retry. After 11 minutes its call and every process it started are ended, and the result
is uncertain; if ending them does not succeed, the detail says so. The details use fixed wording, never the vendor's output. The live part is
printed, never written with `--write`.

## Calling a peer

### First use: orient without sending

```bash
node bin/nomeat.mjs orient --from astra --cwd <target-project>
```

`--cwd` is the project whose routes you want, **not necessarily the bridge installation**.
Without it, the current directory is resolved to an absolute lexical path; symlinks are not
canonicalized. The report shows the state location, an advisory filesystem access check,
standing/fallback destinations, incoming and outgoing routes involving `--from`, and Claude
listener registrations. Custom caller names remain valid; known peers are shown first, at
most 20 routes, with `routesOmitted` for any remainder. With no `--from`, existing project
routes are shown. Peer names identify configured roles, not proof of the model running.

Orientation creates no folders, write probes, daemons or messages. An access check can pass
while a sandbox still refuses a write. Listener registration includes fresh heartbeats and
held `listen --once` claims; it does not prove that the chat will receive or answer a call.
Codex callers do not run `listen`; a receiving Claude Desktop chat does, in that exact chat.

```bash
node bin/nomeat.mjs call --to astra --from fable --effort ultra --message "Review the project plan"
```

Long or multi-line messages go in on stdin:

```bash
node bin/nomeat.mjs call --to fable --from astra < question.md
```

| Peer | Side | Default model | Default thinking level |
|---|---|---|---|
| `astra` | Codex | `gpt-6-astra` | `ultra` |
| `sol` | Codex | `gpt-6.1-sol` | `ultra` |
| `fable` | Claude | `claude-fable-5-2` | none (the vendor's own) |
| `opus` | Claude | `claude-opus-5-5` | `high` |

The defaults apply when a call starts a new thread. A message into a Codex thread that already
exists, the standing one or one named with `--thread`, keeps that thread's own model and level;
only `--model` or `--effort`, when given, replace them. A Claude session is the one difference:
a continued session is still given the peer's model and level, since it has no stored setting
the command line would fall back to.

- `--from` names the caller and is required. The peer sees it in a one-line header, so it can
  tell a peer's message from your own. The header is plain text, not proof of who sent it.
- `--effort` replaces the peer's default thinking level and is passed through as given. Codex
  accepts `low` to `ultra`; Claude accepts `low` to `max`. The result says which level was
  applied (`effort`); a queued or attended delivery applies none, and then the result lists
  `effort` under `notApplied` if you gave `--effort`.
- `--model` overrides the peer's model. A queued or attended delivery runs with the chat's own
  model, and the result lists `model` under `notApplied` if you gave `--model`.
- `--write` lets the peer edit files in the project. The default is read-only: a Codex peer
  runs in a read-only sandbox, and a Claude peer gets only its reading tools (Read, Grep,
  Glob), which also makes each call much cheaper. A Claude peer that has to run a command or
  search the web needs `--write`. The result says which access the call ran with (`access`).
  A `--write` call that would go through the Codex app's queue is refused unless the bridge
  created that thread with write access (see below).

- `--no-wait` hands the message over and returns at once with `"state": "sent"`. Use it when
  the peer's work will take long, or when the peer is going to call you back: a caller that is
  still waiting cannot be reached. It works for Codex peers, into a thread the Codex app has
  open, and needs `--thread` or an earlier call to that peer. `--new --no-wait` is refused by
  design, before anything is sent: call once with waiting to create the chat, then send with
  `--thread <id> --no-wait`. Where the Codex command line
  offers `codex queue --resume`, the bridge uses it to ask Codex to load the chat and run the
  message; if that fails the message stays queued and the result carries Codex's `warning`
  (only lines that mention resuming).

  A queued message runs only when something has the chat loaded: the Codex app, for a chat it
  is running, or Codex's own background daemon. So where it uses `--resume`, the bridge first
  checks that the daemon runs and starts it if not (`codex app-server daemon start`, with a
  time limit). The daemon keeps running afterwards; `codex app-server daemon stop` stops it.
  Where Codex's daemon package is not installed yet, that first start makes Codex install it
  without asking: about 370 MB on a Mac. The bridge does this by itself, by the owner's choice.
  If it cannot be started, the message is still queued once, and the `warning` says it may
  not run until the chat is opened in the Codex app.

### Which thread a call lands in

- If a Claude chat is **listening** for that peer name in this project (see below), the call
  goes to that chat, and the chat itself answers.
- Otherwise a call **continues the standing thread** between the same caller and peer in the
  same project folder. The first call starts it.
- `--new` starts a side thread. Later calls still continue the standing one.
- `--thread <id>` sends into that exact thread, including one you started yourself in the
  app. The standing thread stays as it is.
- Neither of those two becomes the standing thread by itself, not even as the first call of
  a route. The next ordinary call continues the standing thread, or starts it.
- `--standing`, added to a call, makes that call's thread the standing one from now on.
- `nomeat standing --to <peer> --from <caller>` shows the standing thread of a route, and
  with `--thread <id>` names one without sending anything.
- A binding change reports the old and new named/fallback destinations, exactly which calls
  are affected, a restoration command and argv, and `routing configured; delivery not tested`.
  It affects only default calls for that exact project/caller/peer when a Claude listener does
  not take precedence. Explicit `--thread`, `--new`, other routes and chat settings stay as
  they were. Restoration uses `--thread <previous>` or `--clear` if the route was unnamed.
  It pins the exact state location in `restore.environment.NOMEAT_STATE_DIR`; apply that
  environment together with executable/argv. The display command carries it automatically
  and restores the prior shell environment afterward on Windows.
  `--clear` appends an event restoring unnamed fallback behavior; no history is deleted and
  repeated clears leave the same routing behavior. Restoration is a new change, not a rollback
  of intervening calls or settings. The display command targets PowerShell on Windows and a
  POSIX shell elsewhere; executable/args plus environment need no shell interpretation.
  If clearing leaves neither a standing nor an answered fallback thread, `stateDir` and
  `stateNote` retain the state-folder guidance alongside the routing `note`. A read-only
  `standing` lookup that finds nothing keeps that guidance in its existing `note` field.
- A Claude chat that answers from its own app, because it is listening or has answered a
  call that way, cannot be the standing thread. The standing thread is continued without
  the app, and that would start a second copy of a live chat. `nomeat standing` fails for
  such a chat, and a call with `--thread <that chat> --standing` is refused before anything
  is sent.
- A route used before standing threads existed keeps continuing its last answered thread,
  and that thread becomes the standing one at the next ordinary call. Calls made with
  `--new` or `--thread` after the upgrade do not count for this. Name the right one first
  if it is not.
- New threads get a title such as `astra to fable [shop]: Review the plan`, where `shop` is
  the last folder of the project path. New Claude sessions are
  listed in the Claude app automatically on Windows and macOS (`--no-open` skips that); on
  Linux the vendor offers no way to do that. A new Codex thread works at once and
  `nomeat find --side codex` lists it. Once its turn has ended, the bridge opens it by its
  link, `codex://threads/<id>`, so that the running Codex app lists it (`--no-open` skips
  that too): with `cmd.exe /c start "" <link>` on Windows, `open <link>` on macOS and
  `xdg-open <link>` on Linux. Opening the link switches the Codex app's main area to the new
  chat, seen on Linux: if you are in another chat there, you are moved out of it. Whether the
  window is raised or takes keyboard focus was not checked. Only a thread the call created is
  opened, never one it continued; a call sent with `--no-wait` or through the app's queue
  never creates one. The call returns, and the link is opened, only once the bridge's own
  Codex server has ended, since while it runs it holds the thread; it waits up to 5 seconds,
  and if the server is still running then, the link is opened anyway and `warning` and
  `app.reason` say so.

  What was seen. Windows: the bridge's opener ran twice, before it waited for its server, and
  both chats showed in the app on their own, the second during an update of the app; a third run, with the wait for the bridge's own server in place, showed its chat too. Opened
  by hand, the link made the app list a chat twice, once after a delay that was not timed and
  once within seconds; with the app closed, it started the app, which came up on that new
  chat, seen once. macOS and Linux: only the same commands run by hand, on older code without
  the opener, once each. `open` exited 0 and the chat was listed in under 3 seconds by the
  owner's estimate; `xdg-open` exited 0 in 0.02 seconds and one second later the chat was
  open, first in Recents. Not tested: the link while the app is minimized, or closed on macOS
  and Linux; for a chat whose turn is still running; from a shell without a desktop session,
  or from inside Codex's sandbox. Where it does not work, the app shows the chat later: see
  the [detailed platform observations](#detailed-platform-observations).

### A thread that is open in the Codex app

Codex allows one writer per thread. When the app holds the thread, the message goes through
Codex's queue and the app runs the turn itself. The result then says `"delivery": "queued"`,
and the thread's own model and settings apply instead of `--model` and `--effort`.

`--write` cannot raise a queued thread's access. Such a call is refused before anything is
queued, unless the bridge created the thread with `--write`. Send without `--write` if the
chat already has write access in the app, or start a thread with `--new --write`.

### Calls into the Claude chat you are sitting in

A Claude chat that is running in the desktop app cannot safely be resumed from outside: that
would start a second copy of it. A chat can listen for calls instead:

```bash
node bin/nomeat.mjs listen --as fable --thread <this chat's session id>
```

The Claude assistant runs this as a background monitor in its own chat. While it runs:

- A call to `fable` in this project that names no thread arrives in that chat as one JSON
  line, with `requestId`, `from`, `hop`, `maxHops`, `file`, `instruction` and `message`. The
  `instruction` names the sender and the request id, and tells the chat to quote the whole
  message and its sender in the chat before anything else, reading `file` first if the
  message is cut off, then to write its answer and send that same answer back with
  `node bin/nomeat.mjs reply --request-id <id> --message "..."`. Every request line carries
  it, so this does not depend on the chat remembering the rule.
- The Claude app shows that line as a background notice, not as a chat bubble. The owner
  sees the peer's words only because the chat prints them. A long notice is cut short at the
  end, so `message` comes last and `instruction` before it; `file` holds the whole request.
  In the other direction nothing changes: a message into a Codex chat arrives as a message of
  that thread, and the Codex app shows it as one.
- The caller waits for that answer and gets `"delivery": "attended"`. `--model`, `--effort`
  and `--write` do not apply: the chat answers as it is.
- A request retried under the same id is not printed again. Once its answer is there, the
  retry gets it. While the chat holds it unanswered, a resend with `--force` is refused at
  once, whether a chat is listening or not, with a note saying so; if it is still needed,
  send it as a new call, without `--request-id`.
- `--thread` and `--new` still go where they say, without involving the listening chat.
- If the listening chat is itself waiting for an answer from the caller, the call runs
  headless in the standing chat instead, because the listening chat could not answer.
- When nobody is listening (the monitor ended or the app closed), calls go back to the
  standing chat within about 20 seconds.

The app limits a monitor to 30 minutes, so listening has to be started again to continue.

Optionally, add `--once` (it needs `--thread`) and run the listener as a plain background
command instead of a monitor. It works the same, but exits with code 0 after the first round
in which it printed something: one request (or several that arrived together), or a Remote
Control notice. The chat is notified when the command ends, so it pays a turn only when
something arrived, not every 30 minutes.

- When the command ends, start it again first, then answer. Calls that arrive in between wait
  in the inbox and the next start delivers them.
- After a `--once` exit the chat still counts as listening for 5 minutes, and only a start
  with the same `--thread` can take over. Started later than that, calls in the gap go to the
  standing chat, as when nobody is listening. A chat that stops after a `--once` exit keeps
  callers waiting for those 5 minutes before they fall back.

Only one chat can listen for a peer name in a project. A second chat is refused with exit
code 1 and a message naming the chat that is listening. The same chat, identified by
`--thread`, can restart at once; a different chat can take over about 20 seconds after the
first stops. Listening uses a database module built into Node, which prints a one-line
"experimental" warning on stderr.

### Following up on a message sent without waiting

```bash
node bin/nomeat.mjs check --request-id <id>
```

Says whether the peer has not started on the message (`waiting`), is working on it
(`running`) or has finished (`answered`, with its reply). Nothing is sent again. The reply is
the turn's final answer, as for a call that waits; the status lines Codex marks as interim are
left out.

A `waiting` message says only what can be seen. Under a minute after sending, the note says how
many seconds ago it was sent and that the peer has not started on it yet. After that, with
`"idle": true` the chat's newest turn is finished, so nothing is running there and the message has not been
picked up: open the chat in the Codex app, or send it again as a new call that waits (the
queued copy may then run as well). Otherwise the cause is unknown. Without
`--request-id` it checks every message of this project sent with `--no-wait` in the last 24
hours. Whoever sends without waiting is the one who follows up.

`check` reports the turn that the request started. A later turn in the same chat, such as the
owner's answer to a question card, is not part of it; `read` shows it.

Open observation, from a Mac: two messages sent with `--no-wait` into a thread the Codex app
held stayed `waiting` until that thread was loaded in the app the next day. The cause was not
examined.

### Reaching a bridge chat from another device

Newly imported Claude chats start with Remote Control **off**. To enable them automatically,
once per installation, start a named, attended Claude Desktop listener and opt in:

```sh
node bin/nomeat.mjs remote-control enable --as fable --thread <coordinator-id> --cwd <coordinator-project>
```

From then on, a new chat opened by `nomeat call` is queued, including chats in other folders.
The primary reply does not wait. The bound Desktop chat gets a notice, uses its native
`set_remote_control` tool, and checks `get_session` for **on and active** before reporting
success. A target gets at most three notices, five minutes apart; if unanswered, it becomes
`unavailable` rather than waking the coordinator indefinitely. Only the new session ID
crosses projects, not its path or conversation. An offline
coordinator leaves durable pending work; restart its listener with the same project, peer,
and chat ID to pick it up. Restart any listener running pre-feature code once after upgrading.

Use `remote-control status --target <chat-id>` to see pending, blocked, or last verified
active (not a live connection check). If platform approval is required, approve in Desktop
and use `remote-control retry --target <chat-id>`. An opening failure, inactive host, or a
chat not yet visible in Desktop is not a successful verification.

Use `call --no-remote-control` to skip one new chat or `remote-control disable` to turn off
the default and cancel pending work. Neither changes already-enabled chats or revokes a native
Desktop action already in flight. Existing or
resumed chats, attended conversations, and `--no-open` calls are not enrolled. This enables
the Desktop session; it does **not** make later headless turns sync to a phone.

## Looking up a chat on the other side

```bash
node bin/nomeat.mjs find --side codex --search "Vercel"
```

```bash
node bin/nomeat.mjs read --side codex --thread <id> --turns 2
```

```bash
node bin/nomeat.mjs find --side claude --text "token expired"
```

- `--search` matches **titles** (a thread without a title is matched on the first line of
  its first message). The result states what was searched in `matchedOn` and `scope`, and
  `more` says whether further matches exist beyond `--limit`.
- `--text` searches inside messages: a chat matches when one message of the person or the
  assistant contains all the words, in any order, ignoring case. Tool output, commands and
  attachments are not searched. Each result adds `match`: who said it (`by`: `user` or
  `assistant`), when (`at`, if the store has it) and a one-line `excerpt` around the match.
  Only the most recent chats are looked through: 200 session files on the Claude side, 20
  threads on the Codex side, where listing the threads is slow. With `--project` on the Codex
  side, up to 20 of the project's threads are read from the newest the app lists (at most
  100). `scope` says how many were listed and looked through, and whether older ones were
  left out. With `--search` as well, both must match. An empty `--text` is a usage error.
- `--project` keeps only the chats whose folder is this project (or `--cwd`). Use it to find
  a chat whose title does not mention the project, with or without `--search`. On the Codex
  side it looks through the newest threads the app returns in one request (at most 100);
  `scope` says how many. It goes by the folder the app recorded for the chat: a Codex chat started in the app outside any project sits in a
  folder the app made for it and is not found this way, even if it works on the project.
  `find --side codex --text <a word typed into it>` does find it. `nomeat standing` shows
  which thread a route uses, whatever its folder.
- `read` now defaults to compact user/assistant text, newest 2 **visible conversation turns**
  in chronological order, with turn indices, `startedAt` when available and nullable `status`.
  The newest Codex turn in the saved thread snapshot reports an ambiguous `interrupted`
  status as `interrupted, or still running`, just like the raw view; older interrupted turns
  stay `interrupted`. Status is retained on every fragment, and Claude status is null.
  Hidden-only notification or compaction turns do not crowd out recent conversation. `--tools` adds
  described tool/command/file events and Claude tool results; private reasoning stays hidden.
  Structured Claude compaction, meta/sidechain and task/peer notification records are excluded,
  along with complete legacy `/compact`/compaction-output envelopes. Ordinary prose mentioning
  those terms is not filtered. Incoming bridge task/peer notification envelopes are
  intentionally counted and hidden: the listening assistant's visible request quotation,
  required by each notification's show rule, stays readable. Use `--raw` to inspect the
  original control notification. Unknown vendor formats may still appear.
- `--budget` bounds the **entire minified JSON plus its newline**, in UTF-8 bytes (default
  16000, minimum 2048). If even metadata or one scalar cannot fit, reading fails rather than
  exceeding the budget. `--max-chars` limits a text fragment to 4000 UTF-16 code units by
  default; a supplementary Unicode scalar needs two units even with `--max-chars 1`.
- Feed `nextCursor` back as `--cursor` with the same side, thread and `--tools` view to finish
  the current window, including inside a long message. Once `nextCursor` is null,
  `olderCursor` navigates to the preceding visible-turn window. Each window is chronological;
  windows are visited newest to oldest. Both null means there is no more visible material.
  `--turns` is ignored for a cursor; budget and fragment size can change. Cursors are
  thread/view-scoped snapshots: edits invalidate the selected window, while appended turns
  are counted as `newerTurns` outside it. Restart without a cursor to see new material.
  Cursor schema v2 preserves whole-thread status context across fragments and older windows;
  restart reads made with pre-review v1 cursors rather than reusing them.
- `omitted` separately counts items/text units outside the window, filtered items by reason,
  text before/after the current page and split items. A partially displayed item counts in
  both its page and the corresponding before/after item count; text-unit counts do not
  overlap. Text units mean UTF-16 units of displayable descriptions, not raw transcript bytes;
  private/unsupported blocks are counted without inspecting or exposing their text.
- **Migration:** consumers of the former CLI result should add `--raw`. It preserves the old
  tool-inclusive `turns` shape, raw-turn selection and per-item `--max-chars` clipping. It
  cannot use compact `--budget`, `--cursor` or `--tools`. Exported legacy history readers,
  content search and the independent call/check history consumers keep their old behavior.
- `--side codex` covers the threads the Codex app lists. `--side claude` covers the Claude
  Code session files on this machine, and accepts ids with the app's `local_` prefix.
- Web chats on chatgpt.com and claude.ai are not covered.

## Result of a call

One JSON object on stdout:

| Field | Meaning |
|---|---|
| `state` | `answered`, `sent` (with `--no-wait`), `duplicate`, `uncertain` or `refused` |
| `threadId` | The thread on the peer's side |
| `continued` | Whether an existing thread was continued |
| `requestId` | Reuse it on a retry |
| `reply` | The peer's answer, when `answered`. From a Codex peer, the turn's final answer: the status lines Codex marks as interim are left out, and where it marks none, the last message is the answer |
| `delivery` | `direct` or `queued` for Codex peers; `headless` for a Claude run; `attended` when a listening Claude chat answered |
| `access` | `read-only` or `write`: what the call set, or else, for a Codex thread, the access the bridge created it with (a queued call, or a resumed one without `--write`). Absent when unknown |
| `effort` | The thinking level applied. Absent for queued and attended deliveries, or when none was set |
| `app` | For a new Claude chat: `opened` is `true` when the opener that lists it in the Claude app exited with code 0 within 20 seconds, and `false` with a `reason` otherwise (it did not start, exited with another code, or ran out of time; the reason then says whether a stop signal was sent or it could not be stopped). On macOS that exit code is the opener's own. On Windows it only shows that the opener's console window was launched, not that the chat was listed. Where the vendor offers no opener, as on Linux, nothing is attempted: `opened` is `false` and `supported` is `false`, a field present only in that case. For a new Codex chat: `opened` is `true` when the program that opens its link exited with code 0 within 10 seconds. That shows only that the system took the link, not that the app listed the chat. Otherwise `opened` is `false` with a `reason`, also for a thread id that is not a UUID, which is never put into a link. `supported` is `false` only where there is no opener: on a platform other than Windows, macOS and Linux, or when the opener program, such as `xdg-open`, is not installed. When the bridge's own Codex server had not ended within 5 seconds, the link is opened anyway and `reason` says so, ahead of the opener's own reason if there is one. A failure to open never fails the call |
| `notApplied` | `model` and/or `effort`, when you gave them on the command line and a queued or attended delivery ran the turn with the chat's own settings. The message was still delivered. Absent when nothing was dropped |
| `recovered` | Present when a retry found the answer already in the thread |
| `warning` | What Codex warned about a queued message, such as a chat it could not load. For a direct Codex call: that the bridge's own Codex server had not exited 5 seconds after it was told to stop, so it may still hold the thread; the answer stands. Absent when there was nothing |
| `note` | What to do, when nothing was sent |

Exit codes: `0` done, `1` failed, `2` usage error, `3` not sent.

## What calls cost

```bash
node bin/nomeat.mjs stats --since 2026-11-10T00:00:00Z
```

Summarises the answered calls of this project by caller, peer and way of delivery: how many,
the median size of message and reply in characters, the median time to answer, and token use.

- Token figures exist only where the vendor reports them to the bridge: `direct` Codex calls
  and `headless` Claude calls. They cover the peer that answered, not the caller.
- `total` is everything the model processed for the call, the fixed load of instructions and
  tool definitions included. That load can dwarf the message; private development-machine
  measurements are not part of this distribution.

## Retries and limits

- Retry with the same `--request-id`. An answered request is never sent again.
- After a failure that may have delivered the message, a retry first looks in the thread. If
  the answer is there it is returned (`recovered`); otherwise the state is `uncertain`. Resend
  with `--force` only after checking that the message is absent. Recovery works for Codex
  peers and for a listening Claude chat that answered late; for a headless Claude run use
  `read` to check.
- `--hop` counts positions in one exchange and `--max-hops` bounds it (default 4). Past the
  limit the call is refused and the question goes to the owner.
- A Claude call that no listening chat takes runs the Claude command line, which needs the
  network and a writable folder for its sessions (`projects` under `CLAUDE_CONFIG_DIR`, or
  under `.claude` in your home folder). Before starting it the bridge checks both: it creates
  and removes an empty folder there, and only if that works looks up the host the command
  line talks to with the system's own resolver, in a short child process that is ended after
  3 seconds. That costs one such process, about 0.1 seconds, per headless Claude call. The
  lookup is skipped for an address or `localhost` in `ANTHROPIC_BASE_URL`, and when `HTTPS_PROXY`,
  `HTTP_PROXY` or `ALL_PROXY` is set, because behind a proxy it can fail while the call works. When a check
  fails, the call fails at once with exit code 1, nothing is sent, and a retry is not
  `uncertain`. Inside Codex's sandbox on Linux and macOS both fail: run the call outside the
  sandbox, or have a Claude chat listen (see above) so that the call is delivered to it.

## State

The state folder is `.nomoremeatproxy` in your home folder on Windows, or
`$XDG_STATE_HOME/nomoremeatproxy` elsewhere. `NOMEAT_STATE_DIR` overrides it. It must be one
folder that both assistants see. A side that uses another folder sees none of the other's
calls, without an error: when `standing` finds no thread, or `check` no such request, the result
names the folder it read in `stateDir` and says that both sides must use the same one. On Windows it is deliberately not under `AppData`: each
Store app gets a private copy of that folder, so the two desktop apps would each keep their
own state and calls from one side would never continue a chat.

When the state folder refuses a write for lack of permission, or does not exist and cannot be
created, the command fails with an error that names `NOMEAT_STATE_DIR`, not with the system's
own message. The same holds for a command that only reads the state, such as `standing`,
`check` or `stats`: a folder that does not exist and cannot be created is reported, not taken
for an empty first run. A folder that does not exist yet but can be created reads as empty,
and a read does not create it. A call writes its
first ledger entry before anything is sent: when that write is refused, nothing was sent, and
the error ends with "nothing was sent". A
write refused later, such as the one that records the answer, comes after the peer was
contacted, so the message may have been delivered and the work done; check the thread with
`read` before sending again. Inside Codex's sandbox the default folder cannot be written; there,
set `NOMEAT_STATE_DIR` to a folder the sandbox can write, and the same on the other side.

- `ledger.jsonl` holds ids, states, project folders, message hashes, the sizes of message and
  reply and the vendor's token figures, never message text.
- `inbox/` is the mailbox for listening chats. It holds a message and its answer only until
  the caller has collected the answer; leftovers are removed after a day.

## Detailed platform observations

**New chats can be late in the Codex app's list.** A chat the bridge creates on the Codex side
works at once: the message is delivered, the answer comes back, and `nomeat find --side codex`
lists it. The Codex app itself may not show the chat in its list until the app re-reads it.

The bridge now opens each new Codex chat by its link, `codex://threads/<id>`, once the call's
turn has ended and the bridge's own Codex server has stopped (`--no-open` skips that). Opening
the link switches the app's main area to that chat, seen on Linux: if you are in another chat
there, you are moved out of it. Whether the window is raised or takes keyboard focus was not
checked.

- Windows: the bridge's opener ran twice, before it waited for its own server to stop, and
  both chats showed in the app on their own, the second during an update of the app; a third run, with the wait for the bridge's own server in place, showed its chat too. Opened by
  hand, the link made the app show and list a chat twice: once after a delay that was not
  timed, once within seconds. With the app closed, a link opened by hand started the app, which
  came up on that new chat; seen once.
- macOS and Linux: only the same commands run by hand, on older code without the opener, once
  each. On macOS the chat was listed in under 3 seconds; on Linux it was open one second later,
  first in Recents. The bridge's opener itself has run only on Windows.

Not tested: the link while the app is minimized, or closed on macOS and Linux; for a chat whose
turn is still running; from a shell without a desktop session, or from inside Codex's sandbox.
Where it does not work, the chat appears as before:

- Linux: it appears after you start any new chat in the Codex app.
- macOS: it appears after you quit and reopen the Codex app.
- Windows: it appears after you quit and reopen the Codex app. A folder the app does not know
  is not added to its Projects; the chat shows under Recents.

Messages and answers are not lost while the chat is missing from the list. This is observed
behaviour: the cause is not proven.

**A question card in such a chat can be lost.** Seen on a Mac, and on Windows in three runs.
On the Mac, the assistant in a bridge chat the
Codex app did not list yet asked the owner with its question card. The card tool answered that
it was accepted, the owner saw nothing, the card was still missing once the chat was listed,
and the bridge reported the call as answered. Seen twice; in the same chat once listed, a card
was shown. On Windows, a card raised in a follow-up message, in a chat that was already up in
the app after its link was opened, was shown; cards raised before the chat was up were lost. On
macOS and Linux, in the runs where the link was opened by hand, a follow-up sent with
`--no-wait` that asked for a card showed it, and the owner's yes arrived; a card raised before
the link was sent was not tested there. The bridge now tells the assistant in a Codex chat it made to
put a question for the owner in its answer instead.

**On Linux a bridge chat cannot be listed in the Claude app.** The vendor's opener works on
macOS and Windows only. A bridge conversation shows in the Claude app on Linux when a chat
there is listening.
