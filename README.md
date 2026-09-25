# Journeys

A desktop journal over a folder of Markdown files. The tree is on the left, the
note is on the right, and typing saves it. Everything the app knows lives in
those files, so the folder opens in any other editor too, and the app never
rewrites bytes you did not touch.

Built with Tauri 2 (Rust and the system webview), React, TypeScript and
CodeMirror 6. It is a personal project, developed and used on macOS.

## What it does

- **Notes and folders.** A folder is a note: `Ideas/` pairs with `Ideas/Ideas.md`,
  so any note can hold notes. `[[wikilinks]]` resolve by name or path, follow a
  note when it is renamed or moved, and read as the note's name.
- **Live preview.** Formatting stays as syntax you can put a caret in: links,
  tasks (Obsidian-style states), headings, lists with hanging indents, tags.
- **Backlinks and a graph.** The end of a note shows where it sits, what is
  inside it and what links to it. The graph pans, zooms, and names as much as
  fits.
- **Daily notes.** ⌘⇧O opens today's page; each day links to the days either side.
- **Collections.** A line carrying `--expense` belongs to the *expense*
  collection. A collection declares one line, such as
  `--expense spent amount::<<>> at merchant::<<>>`, which is the completion you
  type into, the documentation of the shape, and the parser that turns the lines
  back into a table with sums.
- **Tags and properties** are pages built from the notes: every line with
  `#travel`, every note with an `icon:`.
- **Calendar.** Paste a calendar's secret iCal address and its events are written
  into the daily notes as `--event` lines, kept in step as they change, and shown
  as an agenda or a month.
- **Locked notes.** A note can be made encrypted (AES-256-GCM, PBKDF2-SHA256) from
  its first byte. It is left out of search, collections and the graph, and locks
  again by hand or after a few minutes unused.
- **Sync.** The vault syncs to a git remote of your choice (libgit2, in-process):
  commit, pull, push once a minute and when you switch away. Conflicts are kept
  side by side, never guessed at.
- **Terminal.** A tab runs your shell in the vault folder, held by tmux so a
  session survives the window closing.
- **Tabs and panes.** Split the reading pane, drag tabs between panes.
- Images, PDFs, JSON (with a Save for the settings file) and CSV (coloured by
  column) open in the same pane.

## Build

You need Node 22 or later, a Rust toolchain, and the
[Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your platform.
tmux (for example `brew install tmux`) is optional: without it a terminal tab
still works, but its session ends with the window.

```sh
npm ci            # install exactly what the lockfile says
npm test          # the test suite (vitest, jsdom)
npm run build     # type-check and build the web half
npx tauri dev     # run the app
npx tauri build   # bundle it
cd src-tauri && cargo test   # the Rust half: sync and terminal
```

## A vault

Any folder of Markdown. The app keeps its own files in the vault's `.config/`:

| File | What it holds |
| --- | --- |
| `.config/settings.json` | The app's settings for this vault: appearance, typography, shortcuts, calendar feeds, sync interval. |
| `.config/actions/collections.json` | Every collection's declared line, keyed by name. |
| `.config/tmux.conf` | The terminal's tmux settings, written once and then yours. |

Skills for Claude Code live where Claude Code expects them, in
`.claude/skills/<name>/SKILL.md`, and show up in the app's Actions pane.

## Where your data goes

Only into the vault folder, and to a git remote if you set one up. A sync token
is kept in the macOS keychain, never in the vault. A locked note's passphrase is
held in memory for as long as the window is open and never written anywhere.

Note that `.config/settings.json` is an ordinary file in the vault, so a calendar
address saved there travels wherever the vault is synced.

## Layout of the code

- `src/vault.ts`: the only module that touches the filesystem, through one
  `VaultFs` interface.
- `src/useVaultTexts.ts`: one read of the vault, from which the index, backlinks,
  graph, search, collections, tags and properties are all derived.
- `src/workspace.ts`: tabs and panes as a pure model.
- `src/EditorHost.tsx`, `src/MarkdownEditor.tsx`, `src/editor*.ts`: the editor.
- `src-tauri/src/`: the native half: `sync.rs` (git), `terminal.rs` (PTY and
  tmux), `lib.rs` (commands).

`CLAUDE.md` is the design record: why things are the way they are, and the traps
that were found the hard way.

## Licence

MIT. See [LICENSE](LICENSE). Icon geometry is from [Lucide](https://lucide.dev),
under the ISC licence in [LICENSE-lucide](LICENSE-lucide).
