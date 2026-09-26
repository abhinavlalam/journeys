# Journeys

A desktop journal over a folder of `.md` files: the tree on the left, the note on
the right, typing saves it. Around that: backlinks, a graph, search, collections,
a calendar, locked notes, git sync and a terminal. Tauri 2 (Rust + system webview)
wrapping Vite + React + TypeScript; the editor is CodeMirror 6.

This file is the design record. Each rule is here because breaking it cost
something once; the one-line reason says what. Read the section for the area you
are changing before you change it.

## Commands

```sh
npm ci            # never `npm install` for a restore
npm run build     # tsc --noEmit && vite build — the real type check
npm test          # vitest
npx tauri dev     # run the app
npx tauri build   # bundle to $CARGO_TARGET_DIR/release/bundle/macos
cd src-tauri && cargo test
```

`~/.zprofile` should export `CARGO_TARGET_DIR="$HOME/.cargo-target"`: the project
may live in a synced folder, and a debug build is ~2.7 GB.

## The map

| Where | What it owns |
| --- | --- |
| `vault.ts` | **The only module that touches the filesystem**, through `VaultFs` (eight calls; `writeBytes` is the one that is not text). Reads decrypt and writes re-encrypt locked notes. |
| `vaultModel.ts` | Pure path and name rules: `fileKind`, `isNote`, `isEncrypted`, `isTextFile`, `noteName`, `knownPath`, `baseName`, `folderNotePath`, `linkLabelSpan`. |
| `useVaultTexts.ts` | The one read of the vault and every cross-note answer as a memo over it. |
| `links.ts` | Parsing, resolving and retargeting links; the note index; backlinks; `collectNotes`. |
| `workspace.ts` / `WorkspaceView.tsx` | Tabs, groups and splits as a pure model / its flat rendering. |
| `NotePane.tsx`, `useNoteBuffer.ts`, `useBuffers.ts` | A note tab, its buffer, and the one door to every open buffer. |
| `EditorHost.tsx` | The editor minus the language: box, gutters, folding, caret, `decorated()`. |
| `MarkdownEditor.tsx`, `JsonEditor.tsx`, `CsvEditor.tsx`, `TextEditor.tsx` | One language each; `TextEditor` is none, for a `.conf`, `.yaml` or `.txt` (as markdown, every `# comment` was a heading). |
| `editorCommands.ts`, `editorComplete.ts`, `editorFold.ts`, `editorPreview.ts` | Keys that write syntax, the `[[` and `/` popups, folding, decorations. |
| `FolderTree.tsx`, `rows.tsx`, `SidebarSection.tsx`, `useDrops.ts` | The left pane; `rows.tsx` is the one row shape everything lists with; `useDrops` is what is dropped onto the tree. |
| `actions.ts`, `actionKinds.ts`, `useCollections.ts`, `tags.ts`, `frontmatter.ts` | `--keyword` collections, their declarations, tags, properties. |
| `calendar.ts`, `ics.ts`, `calendarSync.ts`, `useCalendarSync.ts`, `CalendarView.tsx` | The calendar. |
| `crypto.ts`, `useLocks.ts`, `useAutoLock.ts` | Locked notes: the format and the passphrases held / asking and locking / the clock. |
| `sync.ts`, `useSync.ts`, `src-tauri/src/sync.rs` | Git sync. |
| `terminal.ts`, `TerminalPane.tsx`, `src-tauri/src/terminal.rs` | The terminal. |
| `graph.ts`, `GraphView.tsx` | The graph's model and layout / its view. |
| `settings.ts`, `useSettings.ts`, `SettingsPanel.tsx`, `SettingsFile.tsx` | Settings. |
| `clock.ts` | The app's idea of time: local day stamps, units, relative words. |
| `index.css` + `stylesheet.test.ts` | The sheet, and the rules it is held to. |

## Principles

- **Nothing is stored anywhere but the files.** The exceptions are secrets (the
  sync token in the keychain, passphrases in memory) and `localStorage`'s copy of
  the last applied settings, for the paint before a vault opens.
- **Nothing rewrites bytes nobody touched.** The editor is the file's own text;
  nothing parses and regenerates a note. (v1's WYSIWYG escaped `[[links]]` and
  rewrote lists.)
- **One read of the vault.** `useVaultTexts` reads every text note on vault change
  and on window focus; the index, icons, graph, backlinks, search, collections,
  tags and properties are memos over it. A new cross-note fact is a memo, never a
  second pass. `patch` changes a text without a read (an icon write changes no
  tree). The open note's editor text replaces its row through `liveText`;
  `liveVersion` re-takes it while a derived view is on screen beside the note.
- **Anything derived from disk needs a trigger for writes the app did not make.**
  "On our own writes" feels complete and is not: an agent in the terminal writes
  too. Focus is the trigger.
- **A folder is a note.** `Ideas/` pairs with `Ideas/Ideas.md`, written on the
  first keystroke (`openNoteExists`), never on browse. A nested note is *known*
  as its folder (`knownPath`), and a note with children is a state a note gets
  into, not a kind: the `+`, a dropped file and a dropped note all convert it
  through `convertNote`.
- **A file is not necessarily a note.** `fileKind` is the only place a file's kind
  is decided. `isNote` (`.md` and not encrypted) gates every piece of note
  machinery — frontmatter, `path:`, link rewriting, the icon picker, the `+`.
  `isTextFile` gates the corpus. A non-note keeps its extension in the tree and
  opens in a `file` tab with no buffer, because a buffer over a PDF is a file the
  first keystroke corrupts.
- **The note carries what the app knows about it**: `icon:` and `path:` in its
  frontmatter. `path:` is `knownPath`, rewritten by a move, a rename, a create and
  a conversion. What a new note is given is one funnel, `endowNote`: its `path:`
  and the icon of its folder's own note, read from disk. Today's page takes the
  icon and not the `path:`, and only on the day it is made.
- **A setting that measures layout is in the app's own units** (steps, `em`, the
  leading), never pixels beside values derived from the type.
- **Judge a feature by whether it is the right design**, not by how often it is
  used; a feature used daily may still be built the wrong way.

## Notes, buffers and moves

- **Read the note before switching what is open**, or the editor holds the old
  text and the next keystroke saves it into the new file (`app.test.tsx`).
- **A field renames the note it was opened for, or nothing.** Blur is not under a
  field's control; `ViewerHeader` keeps the name it opened with and abandons a
  commit whose note changed underneath it.
- **A write the app makes to an open note reaches its buffer** (`reread`), and
  declines while a save is queued: pending typing outranks a property.
- **A queued save follows a move** with the buffer's note and `loadedPath`.
  `followFolder` takes the move map, not a prefix: a folder rename changes its own
  note's basename, and a prefix swap names a file that does not exist.
- **Links follow a rename by resolution, not by text.** `retargetLinks` takes the
  index and paths as they were; a link is rewritten because it resolves to the
  moved note, and its form (bare name, path, alias, anchor) survives.
  `retargetVaultLinks` is the loop; it skips non-notes and notes not on disk, and
  reports only notes that exist and still could not be read.
- **A case-only rename is not a collision** (`moveUnlessTaken`): macOS says the
  destination exists.
- **`mutate` hands `after` the tree the operation produced**; read the folder back
  out of it (`folderAt`), since a renamed folder's children carry old paths.
- A path link's head is a name too (`underNamedNote`): `[[Query Layer/DML]]` makes
  the child beside the note named `Query Layer`, not a new root folder.

## Locked notes

- `.enc` (and v1's `.enc.md`) is AES-256-GCM over PBKDF2-SHA256, self-describing,
  its iteration count capped rather than trusted. The seam is `vault.ts`: above it
  the buffer and editor see plain text.
- A read of a locked note throws `LockedFileError`; `openNote`, the funnel every
  row, hit, backlink and link goes through, asks for the passphrase under the
  note's own row. Passphrases live in `crypto.ts` memory for the window; a vault
  change locks everything; a move carries the unlock.
- **Its owner's alone, unlocked or not.** The vault read skips it (no search,
  collections, tags, properties, backlinks or calendar), the graph drops it after
  the walk, and `isNote` refuses it, so nothing writes into it. An icon picked for
  a `.enc.md` once wrote plain text over its ciphertext.
- **Locked from the moment it is made, or never.** A plain note synced once stays
  readable in git and Drive history, so there is no Lock on an existing note. The
  lock beside the Notes `+` is the one way in: name, then the passphrase twice, in
  **one `<input>`** whose `type` changes (a remounted field loses the keyboard and
  a create gives up on blur). `createLockedNote` writes ciphertext first.
- **It locks again** by hand (the header's Lock) or unused for `lockMinutes`
  (`useAutoLock`): used means input while it is the note in front, measured
  against the clock so a machine that slept finds it locked. `lockNotes` in
  `useLocks` is the one funnel: flush typing (sealed), close tabs, drop `liveText`, then `lock`,
  which also clears the derived-key cache.

## The workspace

- `workspace.ts` is pure and tested alone. **A note is open in one place**;
  opening it anywhere goes to its tab. A split makes an empty, focused group.
- **A buffer per note tab**, owned by `NotePane` through `useNoteBuffer` and
  registered with `useBuffers`, the one door every vault operation reaches every
  open note through. Inactive tabs stay mounted; the editor mounts once, over the
  bytes (never over `''` then re-keyed).
- **The DOM is flat.** `WorkspaceView` measures the tree into boxes and renders
  every viewer keyed by id over its group's box. Nested, a split re-parented the
  subtree and killed a terminal's shell. An inactive terminal is hidden, not
  unmounted.
- Tabs drag onto tabs, strip ends, or a pane's outer quarter (`DROP_EDGE`) to
  split. The drag carries `group:index` under one MIME type.
- A tab is square, fills the strip, and meets the page with no line; the focused
  pane's active tab has a two-pixel `--mark` rule on top.

## The left pane

- **Three sections** — Notes, Actions, Applications — each a `GroupRow` heading
  whose controls sit in its `folder-actions`. One scrollport, `.sidebar-body`;
  headings are sticky with `--bg-sidebar`. Section open state is a key in
  `useFolderOpenState`'s set, seeded open; `setAll` touches only the paths given.
- **A folder is open because it is in one set.** Opening a note writes its
  ancestors into it (`reveal`); nothing derives openness from the selection.
- **One row shape everywhere** (`rows.tsx`: `NoteRow`, `RowIcon`, `GroupRow`,
  `NameField`, `stepIn`, `guideAt`, `GatheredNotes`, `Section`); `rowShape.test.tsx` compares
  the boxes in the tree, the Actions pane and a note's footer.
- **One field at a time, and leaving it means what the caller says**: a rename
  commits on blur, a create or search abandons. Buttons that open a field
  `preventDefault` on mousedown; `asking` declines a repeat of the same question.
  Two trees draw one tree (`where`), and only the one asked draws the field.
- **Picking is not opening**: ⌘-click and ⇧-click build a set (`picking.ts`, range
  in drawn order via `visibleFiles`); a plain click opens. A picked set takes a
  ground; the open row is coloured, not filled.
- **Drags start on the primary button only** (`usePrimaryDrag`; WebKit starts one
  on right-press). A drop target's wash clears on the window's `dragend`/`drop`.
- `dragDropEnabled` stays **false**: with it on, every HTML5 drag inside the app
  dies. The window swallows stray file drops, or the webview navigates to the
  file. A dropped file is copied, never over an existing one.
- The `+` on a row appears through `visibility`, not animated opacity.

## The editor

- **`EditorHost` is the editor minus the language**, and every file type mounts
  it: typography is not per file type. `decorated(compute)` redraws when the
  syntax tree changes too, or a long note's end never renders.
- **Presses are `mousedown`** for links, keywords, tags and checkboxes: the pressed
  span is replaced before release, so no `click` ever fires. Position from
  `posAtDOM` on the pressed node.
- **`markdown({ addKeymap: false })`**: its keymap is `Prec.high` and outranks
  anything passed; the one array in `MarkdownEditor` is the whole precedence.
  Tab: snippet field → list item (markdown's content-column rule, at most three
  past it) → block (a line heading a deeper run) → one indent width. Enter keeps a
  line's own indent (`continueIndent`). **Test keys through the real keymap**; a
  command tested by direct call is a binding nobody tested.
- **Hanging indent is a length** on `.cm-md-hang`: a list item by
  `(level + 1) × --indent-step`, indented prose by its spaces × `--space-w`. A
  marker's box is one step wide, the gap inside it; the inherited `text-indent`
  is load-bearing (resetting it pushes `10.` off the grid).
- **The prose inset is on `.cm-line`**, where CodeMirror's selection geometry reads
  it; on `.cm-content` the drawn selection spanned the pane.
- **The caret is CodeMirror's**: `drawSelection` writes its geometry inline.
  Measure what it wrote before adding to `.cm-cursor`.
- **Specificity**: `.cm-line`'s `padding` shorthand is (0,3,0), so a rule setting
  one side must out-specify it; CodeMirror's base theme injects after the sheet,
  so gutter and selection rules carry `.cm-editor` and three classes.
- The gutter is a fixed `--gutter-w`; numbers `flex: 1`, right-aligned, tabular.
  The fold marker's span is `display: flex`, or it is a line tall and the arrow
  sits low. Line numbers stay on every file type.
- **Every link reads as its name** (`linkLabelSpan`): the alias, else the last
  name of the path; `|!n` shows n names, `|!` all. Syntax hides while the caret is
  elsewhere. Bare URLs and emails are links. External targets go to `open_url`,
  which checks the scheme in Rust.
- **One mark per line.** A mark inside a sentence changes colour and nothing else
  — not size, weight, family or line. The clock is `--text-dim` and tabular; a
  keyword and a link take `--mark`, underlined only under the pointer.
- Tasks are a scan of the line (Obsidian's states, any single character); the
  checkbox replaces the bullet and is always drawn. Done text is `--text-dim`, not
  struck (`~~` is its own syntax).
- `/` opens where `--` does (line start or after a space) and offers blocks only
  where a block can begin. `[`/`<` over a selection make a link/slot. Backspace
  inside a fresh `[[]]` takes all four characters.
- JSON and CSV are coloured by scans, not grammars (`jsonPreview`, `csvPreview`).
  `.config/settings.json` is the one file with a Save; everything else autosaves.
- A note opens focused with the caret below its frontmatter.

## Collections, tags and properties

- **`--keyword` anywhere in a line** after start or whitespace; `proseLines` masks
  code first, with `maskCode` — the one rule for what is code, which the links read
  too (two rules disagreed about fences in lists and fences in fences). macOS turns `--` into `—`, so `DASHES` reads `--`, `—` and `–`, and
  what the app writes is always `--`.
- **A collection's declaration is its schema**: one line in
  `.config/actions/collections.json` (`structure` is the authority; `fields` is
  re-derived on every read, for agents reading the file). A file it cannot parse
  is never overwritten.
- **Slots**: `label::<<default>>`. `<<`/`>>` because a single `<x>` is a markdown
  autolink; `>>` ends a value, so values may hold anything. `::` decides a label
  (`:` is prose). Snippet fields are numbered, or same-named slots fill together.
  Brackets and labels hide when the caret is elsewhere; values stay; the keyword
  never hides.
- **`collectionSyntax` is the one rule for which spans are the app's**, read by
  the editor and by every page quoting a line. `readFields` is partial and never
  complains; `fillFields` is its inverse and drops empty `|` parts.
- **Collections, tags and properties are pages, not files** (`dir: null`, `views`).
  An empty file named after a thing is not the thing. `gatherLines` is the one
  rule for an entry and the run nested under it. Skills are
  `.claude/skills/<name>/SKILL.md`, made valid; Config is `.config`.
- A tag is `#` + a word with a letter, after start or whitespace, outside code, and
  folded to lower case (the only folded name). A property keeps the first spelling
  met.
- `CollectionTable` is read-only (a cell edit is a write through a partial parse),
  leads with the note, adds `when`, sums numeric columns, and resizes columns
  (`useColumnWidths`: auto until the first drag, then fixed).
- **No second `--keyword` inside a structure**: every line would join a phantom
  collection.

## The calendar

- Feeds are secret iCal addresses (`calendarFeeds: {name, url}[]`). `ics.ts` parses
  (TZID via `Intl`, RRULE, EXDATE, RECURRENCE-ID, first VALARM); `recurrences`
  serves feeds and typed `repeats::` alike.
- **One source of truth**: sync writes `--event` lines into daily notes and the
  view reads every `--event` line back. Synced lines carry no `repeats::`.
  Dedupe is day + clock + title (`eventKey`).
- **Sync takes back only what is wholly the calendar's**: its `source::` names a
  feed, the feed no longer has it, nothing is nested under it, and it is exactly
  its fields (`untouched`). An empty name is never a source.
- `useCalendarSync` runs on vault open, on a new feed, every `calendarMinutes`
  and on a stale focus. `declarationNow` reads the file at that moment: the
  pane's copy may not be read yet, and "not read" is not "not declared".
- The fetch is `curl` in Rust, off the main thread, scheme-checked.
- Nothing about the week is assumed (`firstWeekday` from `Intl.Locale`).

## Sync

- **git through libgit2 (`git2`)**, not the binary, because Android has none.
  Every command is `spawn_blocking` via `blocking`. The token is in the keychain
  (`/usr/bin/security`, keyed by remote), never in the vault.
- **The identity is the repository's local config only**; the machine's global
  one may be someone's work account.
- A pull: nothing here → take theirs; no merge base → refused; fast-forward →
  checkout; else merge, each conflict kept as this side plus `name (other).md`.
  Checkouts are `safe()`; libgit2's `Conflict` means wait a round. Push only when
  ahead and not behind.
- **A round deleting over half the tracked files is refused** unless Sync now is
  pressed.
- `useSync`: flush, commit, pull, push — on vault open, every `syncSeconds`
  (through a `latest` ref, or each render restarts the timer), on focus and on
  blur. A commit that found changes re-walks the tree. `sync_status` cannot fail,
  so an error there is the bridge missing, and the sync says nothing.

## The terminal

- `portable-pty`, `$SHELL -i -l` in the vault (a Dock-launched app has no PATH),
  `TERM=xterm-256color`. **tmux holds the session**, because the app owns the PTY
  master and its death kills every child.
- tmux by absolute path, on a **private socket per vault** (`socket_for`, FNV-1a
  of the path), `new-session -A` with `terminalName`'s lowest free `journeys-<n>`.
  `end_orphans` ends servers whose sessions' folders are gone. Closing a tab
  detaches; End session kills. `spawn_terminal` says whether it persisted.
- `.config/tmux.conf` is written once, then the user's: `status off`, `mouse off`
  (the wheel stays xterm's), `prefix None` with `C-b` unbound (readline's back).
- `link_memory` makes `<vault>/.claude/memory` Claude Code's project memory, so it
  moves and syncs with the vault.
- xterm is themed from computed tokens; `monoFace` finds a family the canvas and
  the DOM agree on; the size is `0.92 × prose` with the leading stated. xterm 6
  scrolls `.xterm-scrollable-element`, whose slider needs theme colours; the fit
  wraps an unpadded `.terminal-screen` and reruns on `document.fonts.ready`.

## Android

- **Toolchain, all from Homebrew**: `openjdk@17` and the `android-commandlinetools`
  cask, whose `sdkmanager` installs the platform, build-tools, NDK and emulator into
  `/opt/homebrew/share/android-commandlinetools`; `rustup target add` the four
  Android targets. `~/.zprofile` sets `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`, and a
  `RANLIB_<target>` per target pointing at the NDK's `llvm-ranlib`, because the NDK
  ships no `<target>-ranlib` and the OpenSSL git builds asks for it by that name.
- Build with `npx tauri android build --debug --apk --target aarch64`; Gradle calls
  back through the npm `tauri` script, and `run()` carries
  `#[cfg_attr(mobile, tauri::mobile_entry_point)]`. The emulator (`journeys`, a
  Pixel 8 on Android 36) runs headless; `adb exec-out screencap -p` is how to look.
- **git's OpenSSL is built from source there and has no file access** (`no-stdio`,
  which openssl-src needs on Android), so no certificate file or folder can be
  pointed at: `trust_system_certificates` parses the phone's own certificates in
  memory and adds each with `GIT_OPT_ADD_SSL_X509_CERT`. It is not fatal — a
  failure at startup used to be the app not opening at all.
- **The token** is `secrets.rs`: the keychain on macOS, and on Android
  `SecretsPlugin.kt` in the app's own sources, sealing it with a Keystore key into
  the app's private files. Written here rather than taken from a plugin, because
  it is the one credential the app holds.
- **What Android cannot do is left out, not faked** (`platform.ts`): no folder to
  pick (the vault is cloned into the app's storage), no shell, no Finder.

## The graph

- `GraphView` owns a view transform; the layout stays in world space. The wheel
  zooms about the pointer (a native, non-passive listener); background drags pan;
  the fit is automatic once, then a button.
- **Labels are placed by collision, not zoom** (`decluttered`), most-connected
  first, the open note first of all. Edges recede; a hovered node's own edges come
  back. Dragging pins after the step; a moved press is not a click.
- `graphHides` and encrypted notes are dropped after the walk, so a link into one
  is not a hollow "missing" node. `settle(graph, from)` is the one loop.

## Settings and the sheet

- `.config/settings.json` dresses the vault; each value parses on its own and
  falls back to its default; an unparsable file is left untouched.
  `readConfigFile`/`writeConfigFile` take a file name — do not add a second pair.
- **A vault's calendars and hidden folders are its own** (`portable`): not carried
  into a new vault, not kept in `localStorage`, and not handed out until that
  vault's file is read. Carried, a secret feed reached another vault's remote, and
  the render that switched vaults synced the old calendar into the new one.
- `stylesheet.test.ts` holds the sheet to its rules; run it after any CSS change:
  - every colour a token or a mix of one; one duration, `--motion`; weights are
    `--fw-*` tokens; gaps from the allowed set; radii `--radius`/`--radius-sm`;
    `z-index` a named layer;
  - no px `width`, `height` or `font-size` (glyphs read `--glyph`/`--glyph-sm`);
  - **one family on a screen** — a second family came back three times and was
    asked away three times;
  - a control sized in `em` states `font-size: inherit` **and**
    `line-height: inherit` (form controls inherit neither); a `--control` box on
    an element that shrinks its em divides by `--glyph-num`.
- `--mark` is the one accent tone, chrome and prose alike. Glyphs state only their
  grid (`GRID_10/16/24`); `--icon-weight` turns into the stroke.
- `--indent-step` is the one measured value (`applySettings`), because a note's
  indent is spaces in a proportional face.

## What will bite

- **A successful build is not a running one.** Quit before rebuilding; `open` on a
  running app only focuses it. Compare the process start time with the binary's
  mtime.
- **Google Drive replays old versions over edits.** Edit, type-check and commit as
  one command, then check `git show HEAD:<file>`. A synced `node_modules` is
  unusable: `npm ci`.
- **Never name a `.tsx` like a `.ts` but for case.** macOS keeps one; `tsc` then
  silently skips the other (hence `SettingsPanel.tsx`, `WorkspaceView.tsx`).
- **A `**` capability scope does not reach a dot folder** (`requireLiteralLeadingDot`).
  Every `fs:` permission names `**/.config`, `**/.config/**`, `**/.claude`,
  `**/.claude/**`; `capability.test.ts` insists. A new `VaultFs` call needs its
  own permission.
- **A failure that reports itself as success** is this project's most repeated
  bug: a swallowed scope refusal, an unwritten file called "already there", a
  fallback shell reported as persistent. No `.catch` that turns a refusal into an
  empty answer.
- **There and unreadable is not absent** (a Drive placeholder offline). Every
  write that starts from "not there yet" checks `exists` and lets the read throw:
  taken for absent, a note's body became its `path:` block, and `settings.json` and
  `collections.json` were written over with defaults.
- **A native crate can link Homebrew.** After adding one, run `otool -L` on the
  bundled binary: everything should be under `/System` or `/usr/lib`. OpenSSL is
  static (`src-tauri/.cargo/config.toml`).
- **Tests**: a `waitFor` callback must throw to retry (put an `expect` in it); the
  async budget is one setting in `src/__tests__/setup.ts`; a wall-clock guard needs
  a runner timeout looser than itself.
- **jsdom lays nothing out.** Measure layout in headless Chrome: dump a component's
  markup into a page with `index.css`, write `getBoundingClientRect()` into a
  `<pre>`, and run
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --virtual-time-budget=2000 --dump-dom file://…`.

## How to work here

- **Build and launch the app after every change**; a headless check cannot see a
  render bug.
- **Measure, don't reason.** When code and layout both look right and the bug
  persists, instrument the running app (a listener writing events into a file in
  the vault) before the third theory.
- **Ask what is on screen before building what you know how to build.** Several
  reports were fixed as the wrong problem first.
- **Check that a new test fails with the fix reverted.**
- **Don't remove what the owner did not mention** to fix what they did.
- **A function alive only by its tests is dead code.**
- Removed on purpose, so they are not rebuilt: vault-declared kinds
  (`kinds.json`), default properties stamped into new notes, the `runs:` registry,
  the old `calendar` action kind, `fitToBox`, line numbers off notes, a serif
  display family.
- **Still open**: at `--fw-prose` 600, `####` and below stop reading as headings;
  folders are not pickable.

## Preferences

Write the fewest lines that meet the goal. A comment earns its place by recording
a trap someone would otherwise reintroduce, not by restating the code.

**Nothing from the owner's vault goes into this repository** — no person, place,
employer, project, account, card, merchant, currency or note name, in code,
comments, tests or docs — because the code is public. Fixtures are fictional
(Mira Vance, Northwind, Harbour Bistro, Lakeside Terminal). After adding a test
from a real report, grep the tree for the vault's note names.

The history before publication is kept beside this folder, never in the public
repository: `journeys-v1-2026-09-02.bundle` (v1, a deliberate restart) with
`journeys-v1-browsable` checked out from it, and
`journeys-v2-history-2026-09-25.bundle` (this app's 416 commits before the fresh
start, which carry the real names the published tree was scrubbed of).
`git clone <bundle>` reads either.
