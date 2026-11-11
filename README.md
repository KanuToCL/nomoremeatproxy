<p align="center">
  <img src="docs/assets/not-a-meat-proxy.png" width="420" alt="Meme: a man points at his own reflection in a mirror. Caption: You're not a meat proxy. You're an AI assisted senior software engineer.">
</p>

# NOMOREMEATPROXY

Stop being the courier between your OpenAI and Anthropic assistants.

The goal: a coordinator session on one side and a reviewer session on the other find each
other's history, exchange work, spin off their own coding workers, and share one project
repo, on existing ChatGPT and Claude subscriptions with no paid API access.

## Status

Bridge v0 works on the development machine (2026-11-10): `nomeat call` lets one side call the
other, start or continue an exact thread, pick the model and thinking level, and get the reply
back. Calls continue one conversation, with desktop listing limits below. `nomeat find` and
`nomeat read` look up a chat on the other side by title or recent message content; `nomeat
orient` inspects routes without sending. It uses only the vendors' own command lines. Web
chats and fully automatic setup are not supported.

## Install

Version 0.1.0 is on npm. Install the CLI with:

```bash
npm install --global nomoremeatproxy@0.1.0
```

Then `nomeat --help`, `nomeat peers` and `nomeat orient --from astra` are read-only starting
points. For a one-off invocation, use `npx --yes nomoremeatproxy@0.1.0 --help`.
Published on 2026-11-11. An install and a one-off run from the registry were checked on Windows
that day.

This installs only the bridge CLI. **Install Node.js 22.15 or later, Codex CLI and Claude
Code CLI yourself**, then sign in to both vendor CLIs with your supported subscriptions.
The bridge does not install prerequisites, sign you in, configure your assistants, or prove
delivery. Desktop apps are needed to see chats there, with the platform limits below.
Peer names and default models remain fixed; see the usage guide for per-call overrides.

With the npm command on your PATH, use `nomeat` in place of `node bin/nomeat.mjs` in the
source-checkout examples:

```bash
nomeat call --to astra --from fable --effort ultra --message "Review the project plan"
```

## Documents

| File | Contents |
|---|---|
| [docs/usage.md](docs/usage.md) | How to call a peer, results, retries, state |
| [templates/peer-calls.md](templates/peer-calls.md) | Instructions to give both assistants |

Private project records, conversations and development-machine snapshots are not part of
this repository or the npm package.

## Check your machine

From the installed package directory (or source checkout), run the included prerequisite
check. A global install adds `nomeat`, not a separate `doctor` command. This check prints
versions and counts, no paths or content, and sends no messages:

```bash
npm run doctor
```

Built and tested on Windows 11. The app and browser probes are Windows-only for now.

## Known limits

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

## Licence

MIT. See [LICENSE](LICENSE).
