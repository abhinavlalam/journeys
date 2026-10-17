# Journeys

A desktop journal over a folder of `.md` files: the tree on the left, the note on
the right, typing saves it. Around that: backlinks, a graph, search, tags,
a calendar, locked notes, git sync and a terminal. Tauri 2 (Rust + system webview)
wrapping Vite + React + TypeScript; the editor is CodeMirror 6.

This file is the design record. Each rule is here because breaking it cost
something once; the one-line reason says what. Read the section for the area you
are changing before you change it.

## Commands

```sh
npm ci            # in ~/.cargo-target/journeys, never here (see below)
npm run build     # tsc --noEmit && vite build — the real type check
npm test          # vitest
npx tauri dev     # run the app
npx tauri build   # bundle to $CARGO_TARGET_DIR/release/bundle/macos
B="$CARGO_TARGET_DIR/release/bundle/macos/Journeys.app"
test -d "$B" && rm -rf /Applications/Journeys.app && mv "$B" /Applications/
                  # moved, not copied: Raycast and Spotlight find only what is in Applications;
                  # and only once there is a build, or a failed one left no app at all
cd src-tauri && cargo test
```

`~/.zprofile` should export `CARGO_TARGET_DIR="$HOME/.cargo-target"`: the project
may live in a synced folder, and a debug build is ~2.7 GB. For the same reason
**`node_modules` is a symlink to `~/.cargo-target/journeys/node_modules`**: Drive's
stream mode made most of it online-only, and tests then timed out starting their
workers. To restore it, copy `package.json` and `package-lock.json` there and run
`npm ci` in that folder; `npm ci` here would replace the link with a real folder.

## The map

| Where | What it owns |
| --- | --- |
| `vault.ts` | **The only module that touches the filesystem**, through `VaultFs` (ten calls; `readBytes` and `writeBytes` are the ones that are not text, `stat` the one that reads no contents). Reads decrypt and writes re-encrypt locked notes. |
| `vaultModel.ts` | Pure path and name rules: `fileKind`, `isNote`, `isEncrypted`, `isTextFile`, `noteName`, `knownPath`, `baseName`, `folderNotePath`, `fileAt`, `isWithin` and `movedWith` (a path in a folder, and where it goes when the folder moves), `linkLabelSpan`. |
| `useVaultTexts.ts` | The one read of the vault and every cross-note answer as a memo over it. |
| `links.ts` | Parsing, resolving and retargeting links; the note index; backlinks; `collectNotes`. |
| `workspace.ts` / `WorkspaceView.tsx` | Tabs, groups and splits as a pure model / its flat rendering. |
| `NotePane.tsx`, `useNoteBuffer.ts`, `useBuffers.ts` | A note tab, its buffer, and the one door to every open buffer. |
| `FileView.tsx` | A file the pane shows rather than edits: an image, a PDF, a Word document's pages (`WordPages`). |
| `WordEditor.tsx`, `wordFonts.ts` | A Word document edited in place, and the faces Word's documents are drawn in. |
| `EditorHost.tsx` | The editor minus the language: box, gutters, folding, caret, `decorated()`. |
| `MarkdownEditor.tsx`, `SourceEditor.tsx` | A note; and a file that is not one, as its own text: JSON and CSV coloured, a `.conf`, `.yaml` or `.txt` plain (as markdown, every `# comment` was a heading). |
| `editorCommands.ts`, `editorComplete.ts`, `editorFold.ts`, `editorPreview.ts` | Keys that write syntax, the `[[`, `/` and property popups, folding, decorations. |
| `FolderTree.tsx`, `rows.tsx`, `SidebarSection.tsx`, `useDrops.ts` | The left pane; `rows.tsx` is the one row shape everything lists with; `useDrops` is what is dropped onto the tree. |
| `tags.ts`, `properties.ts`, `actionKinds.ts`, `TagView.tsx`, `PropertyView.tsx`, `LineTable.tsx` | Tags and their colours, properties and their types, the Actions pane's kinds, and their pages. |
| `prose.ts` | The one rule for what in a note is code (`maskCode`, `proseLines`), for everything that reads a note for meaning, and for a line's indent (`indentOf`). |
| `configEntries.ts`, `useConfigEntries.ts` | A `.config` file of entries keyed by name (`properties.json`): merged on write, never written over when unreadable, read again on focus with the same text keeping the same entries (new ones rebuilt the graph on every return); `oneOf`, a value read from a file as one of a set. |
| `calendar.ts`, `ics.ts`, `calendarSync.ts`, `useCalendarSync.ts`, `CalendarView.tsx` | The calendar. |
| `timeline.ts` / `TimelineView.tsx` | The daily notes as each day happened / its page. |
| `daySections.ts` | A daily note's sections: where they are, which a line goes in, a line filed in one, a day begun with them, and a day written before them put in them. |
| `tasks.ts` / `TasksView.tsx` | Every `#task` line by when it is due / its page. |
| `table.ts` / `CsvTable.tsx` | A delimited file read as rows, each value knowing where it is written / the table edited in place. |
| `trackers.ts`, `expenses.ts`, `calories.ts`, `habits.ts` / `TrackersView.tsx`, `trackerParts.tsx` | The trackers' tables, each read by its columns' names, and what each adds up / their page and its parts, and the Tracked section ending a daily note. |
| `LineEditor.tsx` | One line in the note's own editor, for a page that takes typing: `EditLine` for one written (saved on Enter or leaving when changed, emptied is not deleted), `NewLine` for a new one; `Typing`, what every editor types with. |
| `ViewerHeader.tsx` | Every page's header: its name (a note's renames it), its status (`statusCount`: nothing at none), its controls, and `ViewSwitch`, a page's ways of being drawn. |
| `plan.ts` / `PlanView.tsx` | The day's plan, Today's 8: its table / its section in a daily note and its page in Trackers. |
| `appTime.ts` | The time in each app: the apps table, and the count from the Mac's reports. |
| `menuBar.ts` / `MenuBarPanel.tsx` | The menu bar's time tracker and line for today: the main window's half that writes / the panel that asks. |
| `useLog.ts` / `LogView.tsx` | What the app says: shown a while, kept in the Log / its page. |
| `crypto.ts`, `useLocks.ts`, `useAutoLock.ts` | Locked notes: the format and the passphrases held / asking and locking / the clock. |
| `sync.ts`, `useSync.ts`, `src-tauri/src/sync.rs` | Git sync. |
| `terminal.ts`, `TerminalPane.tsx`, `src-tauri/src/terminal.rs` | The terminal. |
| `platform.ts`, `Phone.tsx`, `Capture.tsx` | Android, the phone's one place at a time and its bar, the + and what it adds. |
| `share.ts`, `useShares.ts`, `src-tauri/src/phone.rs`, `PhonePlugin.kt` | What other apps share in, filed into the day. |
| `graph.ts`, `GraphView.tsx` | The graph's model, filters and layouts / its view. |
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
  and on window focus, **taking a note again only when its stamp changed**
  (`vaultFileStamp`: size and modified time, read without the contents, so a file
  Drive holds online-only stays so). Unchanged, the rows are the same rows and no view
  is built again; read in full, a return after the Mac slept took 22 seconds. A note
  that could not be read is not kept, so it is tried again. The index, icons, graph,
  backlinks, search, tags and properties are memos over it. A new cross-note fact is a memo, never a
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
  machinery — page properties, `path::`, link rewriting, the icon picker, the `+`.
  `isTextFile` gates what is read and searched; the rest — tags, properties,
  backlinks, the graph — is built from the notes among them (`noteTexts`), or a
  `#comment` in a `.conf` was a tag. A non-note keeps its extension in the tree and
  opens in a `file` tab with no buffer, because a buffer over a PDF is a file the
  first keystroke corrupts.
- **A Word document is drawn as its pages, read only** (`WordPages`, `docx-preview`;
  the owner's choice over Google Docs, which Claude cannot edit). It
  is drawn again when its stamp changes, on a return to the window or to its tab, since
  an agent in the app's own terminal writes while the window keeps the focus; the old
  pages stay until the new ones are drawn. Each document's styles carry their own
  prefix: two open at once shared `.docx p.Normal`. **Drawn as Word draws it**, measured
  in WebKit against a Google Docs export: Calibri and Cambria by their metric twins, Carlito and
  Caladea (`TWINS`, OFL, bundled), loaded before the first drawing, since its tabs are
  measured once (in Times, every line spaced to the margin wrapped); tabs measured to their
  stops (`experimental`) on a 3pt space (`--word-tab-space`: the library rounds a tab to a
  whole point, and a full space ended each one past its stop); a list marker as wide as
  its hanging indent, where the tab after it was a space (`asWord`).
- **And edited in place, as Word edits it** (`WordEditor`, `docx-editor`, the header's
  Edit; desktop only, its toolbar is wider than a phone). Chosen after a test on a real
  document: a word changed rewrites that paragraph alone, every other part byte for byte;
  a new paragraph rewrites the body, keeping every character, its formatting and its
  spaces, and losing only Word's bookkeeping and bookmarks nothing linked to. Its rules:
  - **In a React root of its own**, unmounted only once its save is written: unmounted
    under a save, the save came back empty. Not the library's `renderAsync`, which
    resolves on the first change, so never for a document only opened.
  - **Saved as a note is**: `AUTOSAVE_MS` after a change (`onChange` fires for an edit
    alone, never for a load), when its tab hides, before Pages draws the file again, and
    as its tab closes; registered with `useBuffers`, so a quit, a move and a delete reach
    it. A save that fails stays to be written and throws.
  - **Never over bytes it has not seen** (`writeSeenBytes`): the agent's write meanwhile
    is kept beside as `name (other).docx` and said. `keepOther` copies bytes, or a Word
    file's copy was its zip decoded as text. A write elsewhere with nothing waiting is
    taken in by opening the document again, so its undo goes with it.
  - **Its sheet is kept to it**: five rules were on every editable element in the page,
    and set the note's editor to `display: inline`. Its hidden ProseMirror lives in
    `body`, so a hidden tab blurs it, or it kept the keys.
  - **No font is fetched**: Google Fonts is off (it told Google the document's fonts and
    failed offline), and Calibri and Cambria are the bundled twins.
- **A property is `key:: value`, a page's or a block's.** A note's page
  properties are the `key:: value` lines it opens with; the first other line ends
  them (`properties.ts`). A YAML `---` block is read as page properties too and
  written *as YAML* — a skill must open with one — so nothing converts a note's
  form behind its owner's back; a note with none is given the `::` form. A
  **block property** is `key:: value` on a line, and its value is **exactly its
  type** (`blockProperties`, `PROPERTY_TYPES`): a number, a date, one
  `[[backlink]]`, a url, an icon, or a path or text — one word, or a run between
  quotes (curly ones too; macOS types them). The owner's words may
  follow any value. A value not of its type is not read, and its name stays on the
  line in `--alert`, so nothing vanishes unread; there is no fallback to text.
  `noteProperties` is every property a note carries, and the Properties pages are
  made of it. A page property takes its whole line. A property's type is chosen
  from a menu on its page, into `.config/properties.json`; `icon`, `path`, `aliases`
  and `ends` are the app's, typed `icon`, `path`, `text` and `date`, and no entry
  retypes them. Every pattern for
  a name is built from `PROPERTY_NAME`.
- **The note carries what the app knows about it**: `icon::` and `path::`, the
  app's own properties (`APP_PROPERTIES`, the one place they are named). `path::` is
  `knownPath`, rewritten by a move, a rename, a create and a conversion. What a new
  note is given is one funnel, `endowNote`: its `path::` and the icon of its
  folder's own note, read from disk. Today's page takes the icon and not the
  `path::`, and only on the day it is made.
- **A note's other names are its `aliases::`** (`readAliases`: a page property,
  `aliases:: Captain, The Skipper` or YAML's list), as Obsidian's are, the owner's
  choice over a page that redirects: no second page in the tree. A wikilink by one
  resolves to the note (`byAlias`, after every note's own name), so it is a backlink
  and an edge; the `[[` popup offers it as itself, search finds the note by it, and a
  rename leaves it as written (`aliased`). The index reads them from the corpus, so a
  name typed a moment ago resolves; a link is not made into a note before the first
  read, when no alias is known and the made note would come first.
- **A setting that measures layout is in the app's own units** (steps, `em`, the
  leading), never pixels beside values derived from the type.
- **Judge a feature by whether it is the right design**, not by how often it is
  used; a feature used daily may still be built the wrong way.

## Notes and tables

The direction since 2026-10-12, the owner's: **notes hold memories, tasks and
information in plain words, and trackers are tables.** Each tracker (expenses,
calories, habits) is one CSV file with a header row, kept in the vault's `Trackers/` by
the owner's convention (the app names no folder for it), opened from the tree into the
reading pane as a table edited in place, a value or a row at a time, and never drawn
in the graph, which draws notes alone. The vault's
agent organises the daily notes into the tables (capture first, organise later), checks
for doubles and edits only tables. The calendar is drawn from its feeds, writing nothing
into notes. One device is used at a time, so tables need no merge rule. CSV, not xlsx:
plain text that git can show and merge and the agent writes without a library. The
squeezing of tables into note lines is what grew typed properties, tag structures,
table views and daily totals, and made the notes dense.

**A table is edited a value at a time** (`CsvTable`, `withCell`): a value pressed is a
field, written where the old one was on Enter or leaving, Tab going on; a row is added
at the end once something is typed in it, and taken out by its × after asking; a column's
name sorts what is shown, not the file. Every other byte stays as written, the rest of
the row included: rewritten whole, a row's untouched padded number came back in quotes.

**A table is drawn as Airtable draws a grid, and edited as written** (the owner's
choice, after a ledger with wrapped sentences was "not great at all"): a toolbar with the
filter and the count; a hairline round every cell; the names said as words
(`columnLabel`: `end-amount` is End amount) on a tinted band, each with its column's
glyph (number, day, time, link, text, read off its values); each row numbered as shown
and one line tall, a long value cut at `--data-cell-max` and whole in its `title` and
its field; the row's × in its number's place under the pointer, the heads held at the
left while a wide grid scrolls. A number grouped, to its column's most precise decimals,
on the right; a day as `Mon 5 Oct` (`shortDay`); a `[[link]]` as its name (`Live`),
pressed to open, the rest of the cell editing the value, which is why a cell is not a
`<button>`. **The filter picks rows, never the file** (`passes`): words in any column or
one, as written or shown, or `>`, `<`, `>=`, `<=`, `=` and a number. **A column's total is
the owner's choice**, made under it and kept by the column's name (`columnTotals` in the
settings, `combine`, the daily totals' ways and none), summed until then, over the rows
shown: summed under a balance, it was a number that meant nothing.

**A table's text reads its links as a note does** (`wikiLinkMarks`, `followLink`, shared
with the note's editor): the name shown, the brackets at the caret, a press opening it.

**Trackers is one application over the trackers' tables** (`TrackersView`, the owner's
choice on 2026-10-15, after the separate Expenses and Habits pages were "not useful":
today first, then a page for each, from the header's switch, kept as `trackersView`).
Each tracker's table is picked or made on its page the first time (`trackers` in the
settings; a made one goes beside the others, with the tracker's columns) and read by
its columns' names (`trackedRows`: a row needs a day and its number; what lacks either
is counted and said). From the one read, so what is typed into a table beside the page
shows. A page writes a row at a time through `changeTable` (`withRecord`, `withTick`,
`withHabit`), as every write goes: the queued typing first, then the open tab told.
- **Today**: spent today and this month against the budget, kcal against the target,
  the habits ticked, each a tile with its meter; the habits to tick; an expense and
  something eaten added, stamped now, each form folded behind its chip (`Adder`: two
  open at once took the page), and the usual things eaten offered again.
- **Expenses**: a month at a glance, stepped back and on: spent against the budget and
  the month before over the same days (twelve days set against a whole month read as
  spending less, every month), a day's average and the count; the categories as bars,
  each against its budget; the days as columns, a press opening the day's note; the
  last twelve weeks; where; each account's balance after its last expense; the month's
  expenses; one added; and the budgets. One currency is added up, the one most rows
  are in; the rest are said, not summed.
- **Calories**: today against the target, a day's average over the days tracked this
  week (a day with nothing written is not tracked, not a day of nothing eaten), the
  last thirty days as columns with the target across them, something eaten added.
- **Habits**: see Habits below.
- **Targets are the owner's, set on the page** (`calorieTarget`, `monthlyBudget`,
  `categoryBudgets`); a figure past its target turns `--alert`, beside the words.

**Each daily note ends with what the tables hold for its day** (`TrackedSection`, the
owner's choice): the day's expenses, things eaten and habits, read only, a line opening
its table. What the note says and this does not, the agent has not put in a table yet.

**A table's own page** (Text, the header's other view) mounts over the text as it is
now, not as last read, or its first key saved the old text over the edit. Through the
note's own buffer, so saving, an outside write and a move are a note's.

The steps, in order: (1) any `.csv` opens as an editable table with totals (done); (2)
the Trackers application (done 2026-10-15); (3) habits as a grid over `habits.csv`,
ticked in the app (done); (4) the calendar is drawn from the feeds; (5) the agent's
organising, and the vault's expense and food lines copied into `Trackers/expenses.csv`
and `Trackers/calories.csv` (done) and rewritten in plain words; (6) the line machinery for trackers
goes (done 2026-10-15: tag structures and their tables, daily totals, habits read from
tags, the phone's tag forms; the old `#expense` and `#food` lines rewritten in plain
words). Tags stay as plain labels; tasks and events keep their `key:: value`s. The
vault's `.config/app.md` (Notes and tables) and `.config/claude.md` say the same to the
owner and the agent.

## Notes, buffers and moves

- **Read the note before switching what is open**, or the editor holds the old
  text and the next keystroke saves it into the new file (`app.test.tsx`).
- **A field renames the note it was opened for, or nothing.** Blur is not under a
  field's control; `ViewerHeader` keeps the name it opened with and abandons a
  commit whose note changed underneath it.
- **A write the app makes to an open note reaches its buffer** (`reread`), and
  declines while a save is queued: pending typing outranks a property, which is
  still *seen*, so the save goes over it.
- **A save never writes over text it has not seen** (`seen`, `writeNote`). What is
  on disk and was neither read nor written by this buffer — a pull's (`reread(file,
  false)`), an agent's, Drive's — is kept beside the note as `name (other).ext`
  (`keepOther`, the merge's own rule, as bytes so a locked note stays ciphertext),
  said, and then the typing is written. Typing during a pull used to write the
  pre-pull text over the other device's edit, and the next round pushed it.
- **An outside write reaches the open editor as a change, not a remount**
  (`takeFromDisk`, `EditorHost`'s `incoming`, `smallestChange`), out of the undo
  history, and only with no typing queued. Rebuilt, the editor put the caret at a
  daily note's end and lost its folds and undo after every agent write, and keys
  pressed during the re-read went into an editor about to be replaced. A change that
  leaves the text as it is on disk queues no save. The change is worked out in the
  document's terms, where a line break is one character: in the file's, a CRLF note
  took a `\r` into the changed line, and the save wrote it.
- **A key never deletes what a fold hides** (`keepFolded`): the fold opens and the
  key does nothing. A fold is atomic to the cursor, so Backspace after `#diet …` took
  the heading's five hidden lines, unseen, and the next round committed it.
- **A save that fails stays queued, and the flush throws.** It was said and then
  dropped, so the flush before a quit reported success and the typing was lost. It is
  tried once more first (`SAVE_RETRY_MS`): Drive refuses a write for a moment, and a quit
  just after typing stayed for that and went through when asked again. A
  quit stays, a lock waits, sync and vault operations go on, and focus does not
  read the disk over the typing. A note deleted elsewhere is written, not failed.
- **A move that moves nothing writes nothing** (`relocateFile`, `relocateFolder`):
  a drop where an item already was wrote `path::` into every note under it.
- **A quit writes the open notes first** (`quit.ts`, `lib.rs`'s `quit`). On macOS
  tao ends the app from `applicationWillTerminate`, with no event to hold it on, and
  the last 800ms of autosave went with it. So ⌘Q (the menu's own Quit replaces the
  stock one) and a window's close ask the page, which flushes and answers `quit`,
  or `stay` when a write failed and it has said so. Unanswered, the app quits after
  three seconds. The Dock's Quit and a logout still terminate directly.
- **A queued save follows a move** with the buffer's note and `loadedPath`.
  A file under a moved folder is found by the move map first (`followedFile`, for
  the buffers and the tabs alike): a folder rename changes its own note's basename,
  and re-rooting the path names a file that does not exist.
- **Links follow a rename by resolution, not by text.** `retargetLinks` takes the
  index and paths as they were; a link is rewritten because it resolves to the
  moved note, and its form (bare name, path, alias, anchor) survives.
  `retargetVaultLinks` is the loop; it skips non-notes and notes not on disk, and
  reports only notes that exist and still could not be read.
- **A day's note already in the tree opens directly** (`openDay`): no change, so no
  check on disk, walk of every folder or read of the notes first. Only a day not yet
  made goes through `ensureDailyNote` and `mutate`.
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
  change locks everything; a move carries the unlock, a folder's to everything in it.
  A locked note's extension is whole (`extensionOf`, `other_path`): renamed or
  copied as `x.enc (other).md`, its ciphertext became a plain note.
- **Its owner's alone, unlocked or not.** The vault read skips it (no search,
  tags, properties, backlinks or calendar), the graph drops it after
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
- **A press opens in place of the tab in front, ⌘-press beside it** (`openTab`'s
  `beside`, the owner's choice: a tab for every press made more than anyone could keep
  track of). ⌘ is read on the way down (`besidePress`, a capture listener in `App`),
  before a row or a link acts, and taken once. Nothing opens over a terminal or the
  settings file (`KEPT`), a terminal is a tab of its own, and the graph's toggle opens
  beside, so its second press goes back.
- **Quick open** (⌘P, `QuickOpen`, `quickMatch`): every file by its name (a note by its
  aliases too), the pages and the tags, matched by a name's start, a word's start, a
  part, then its letters in order; ↩ opens in place, ⌘↩ beside. Its own `quickMatch.ts`:
  `quickOpen.ts` beside `QuickOpen.tsx` was the case trap below.
- **A tab goes back and forward** (`stepTab`, ⌘⌥← and ⌘⌥→, a mouse's own buttons): a
  replaced tab keeps what it showed (`back`, `forward`, `TRAIL` deep), and the trail
  follows a move and forgets a delete as the tabs do (`mapFileTabs`). A page open in
  another tab is gone to there. ⌘[ and ⌘] are the editor's indent.
- **A buffer per note tab**, owned by `NotePane` through `useNoteBuffer` and
  registered with `useBuffers`, the one door every vault operation reaches every
  open note through. Inactive note tabs stay mounted, **editor and all**, hidden as a terminal is, so a
  tab keeps its undo (`shown`: the editor takes the keyboard back when it shows, and
  a hidden title field renames nothing). **A hidden editor takes no keys**
  (`hiddenGuard`: read-only and blurred): a tab's press does not move the focus in
  WebKit, so the keyboard stayed in a note when the terminal's tab showed, and
  select-all and Backspace meant for the terminal emptied the note out of sight. A
  terminal takes the keyboard each time its tab shows, not only on its first mount. The editor mounts once, over the bytes
  (never over `''` then re-keyed). Tests ask for `.viewer:not([hidden])`.
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
- **`/` groups tags** in the Actions pane (`branches`): `#listening/podcast` is its
  own tag and page, drawn under a `listening` group keyed in the same
  set (`branchKey`), which Expand all opens (`headsOf`). A head that is a tag itself
  opens from its name, as a folder opens its note (`GroupRow`'s `onOpen`). A group's
  indent is on its header, never on the `li` holding its list, or every row under
  it counts it twice (`rowShape.test.tsx`).
- **One row shape everywhere** (`rows.tsx`: `NoteRow`, `RowIcon`, `GroupRow`,
  `NameField`, `stepIn`, `guideAt`, `GatheredNotes`, `Section`, `EmptyRow` for a section
  with nothing in it, `AddButton` for every `+`); `rowShape.test.tsx` compares
  the boxes in the tree, the Actions pane and a note's footer.
- **One field at a time, and leaving it means what the caller says**: a rename
  commits on blur, a create or search abandons. Buttons that open a field
  `preventDefault` on mousedown; `asking` declines a repeat of the same question.
  Two trees draw one tree (`where`), and only the one asked draws the field.
  A `NameField` types as meant (no autocorrect, capitals or spellcheck: macOS
  made `with:` into `With:`), and a name it cannot take keeps the field and says
  why — dropped as the field closed, it read as the `+` not working.
- **Picking is not opening**: ⌥-click and ⇧-click build a set (⌘-click picked until
  2026-10-14, when it became a new tab everywhere) (`picking.ts`, range
  in drawn order via `visibleFiles`); a plain click opens. A picked set takes a
  ground; the open row is coloured, not filled.
- **Drags start on the primary button only** (`usePrimaryDrag`; WebKit starts one
  on right-press). A drop target's wash clears on the window's `dragend`/`drop`.
- `dragDropEnabled` stays **false**: with it on, every HTML5 drag inside the app
  dies. The window swallows stray file drops, or the webview navigates to the
  file. A dropped file is copied, never over an existing one, and the files of a
  drop together (a file dragged from Drive downloads first: six small PDFs took 27 s
  in turn), said as the copy starts and when it is done, what was copied included: a
  drop that said nothing until the end looked like it had not worked, and was made
  again.
- The `+` on a row appears through `visibility`, not animated opacity.

## The editor

- **`EditorHost` is the editor minus the language**, and every file type mounts
  it: typography is not per file type. `decorated(compute)` redraws when the
  syntax tree changes too, or a long note's end never renders.
- **Presses are `mousedown`** for links, tags and checkboxes: the pressed
  span is replaced before release, so no `click` ever fires. Position from
  `posAtDOM` on the pressed node (`followLink`). ⌘ on a link follows it, into a new
  tab; ⌘ elsewhere is CodeMirror's second caret.
- **`markdown({ addKeymap: false })`** and **`autocompletion({ defaultKeymap:
  false })`**: each adds its keys above anything passed; the one array in
  `MarkdownEditor` is the whole precedence (its props reach the extensions through
  one `latest` ref). Enter over a property's name is a new line, since a line may
  end at its tag. Tab: a popup's pick → block (a line heading a deeper run) → one
  indent width. Enter (`continueIndent`): a list line gets the same marker on the
  next line (the next number), an empty item loses its marker, an empty indented
  line moves out one indent width, any other indented line keeps its indent, and a
  plain line gets a plain new line, in the file's own line break. Only a quote line
  reaches markdown's Enter: on a plain line under a task it took the line for an
  empty item and deleted it.
  **Test keys through the real keymap**; a
  command tested by direct call is a binding nobody tested. A popup refuses keys
  for its first 75 ms (`interactionDelay`), so a key test moves `Date.now` past it,
  or an Enter test passes for the wrong reason.
- **List markers are shown as typed**: nothing draws a bullet or boxes a number
  (the owner prefers the raw lines). An indented line's wrapped rows hang by its
  spaces × `--space-w` (`.cm-md-hang`). An inline-block in the line, like the
  checkbox, inherits the negative `text-indent` and has to reset it.
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
  name of the path; `|!n` shows n names, `|!` all; a link to a line, its note's name.
- **A link to a line** (`[[Note#^id]]`, Obsidian's form, the owner's ask): ⌘⇧C
  (`copyLineLink`, rebindable) gives the caret's line an id at its end unless it has
  one (`BLOCK_ID`, `newBlockId`) and copies the link, naming the note as the `[[` popup
  does, by its path when another note has its name, since it is pasted elsewhere. The
  id shows only while the caret is on its line. Followed from anywhere (`anchorOf`), the
  note opens with that line chosen and in view (`anchorRange`, `EditorHost`'s `reveal`,
  once per request, as soon as the note is read); a heading's words work too. The id
  names the line and what is nested under it, and moves with it. Syntax hides while the caret is
  elsewhere. Bare URLs and emails are links. External targets go to `open_url`,
  which checks the scheme in Rust.
- **One mark per line.** A mark inside a sentence changes colour and nothing else
  — not size, weight, family or line. The clock is `--text-dim` and tabular; a
  tag and a link take `--mark`, underlined only under the pointer.
- Tasks are a scan of the line (`TASK_LINE`: with a list marker, Obsidian's states,
  any single character; with none, the owner's `[ ]` or `[x]` alone, so `[1] ` is not
  one); the checkbox replaces `[ ]`, at any indent but not in fenced code, **once a
  space follows it**: drawn as `]` was typed, it took the brackets from under the
  caret. Enter after a box with no marker gives another `[ ] `. Done text is `--text-dim`, not struck (`~~` is its own syntax).
- `/` opens where a tag's `#` does (line start or after a space) and offers blocks
  only where a block can begin. `[` over a selection makes a link. Backspace
  inside a fresh `[[]]` takes all four characters.
- JSON and CSV are coloured by scans, not grammars (`jsonPreview`, `csvPreview`).
- **A fenced block reads as one** (`cm-md-codeblock`): each line in the code face on
  a code span's ground (`--code-ground`), inside the text column, the backticks hidden
  away from the caret and the info string kept as a caption. Drawn as prose, the
  vault agent's fenced transcripts ran on as the note's own lines. No info string is
  special: the app names none of the vault's formats.
  `.config/settings.json` is the one file with a Save; everything else autosaves.
- A note opens focused with the caret below its page properties; a daily note
  opens at its end (`caretAtEnd`), where the day's next line goes, scrolled into
  sight (`scrollTo`).

## Tags and properties

- **Tags and properties are pages, not files** (`dir: null`, `views`). An empty
  file named after a thing is not the thing. `gatherLines` is the one rule for an
  entry and the run nested under it. Skills are `.claude/skills/<name>/SKILL.md`,
  made valid; Config is `.config`.
- A tag is `#` + a word with a letter (`TAG_NAME`), after start or whitespace,
  outside code (`proseLines`, off `maskCode` — the one rule for what is code, which
  the links read too), and folded to lower case (the only folded name). A property
  keeps the first spelling met.
- **A tag is a label** (2026-10-15, once trackers were tables): its page is its colour
  and every line carrying it, each read as the note does (`readBlock`: names and
  quotes left out). The Actions pane's `+` declares one, an entry in `tags.json`, which
  holds only colours now. A tag's structure of properties, its lines as a table, its
  daily totals and the popup offering its properties as a line was typed were taken
  out: what a tracker counts is in its table.
- `LineTable` (a property's page) is read-only (a cell edit is a write through a partial parse), takes
  its columns and a reader of a line's values, leads with the note, adds `when` and
  `what` (`lineWords`: the line without clock, tags and values; on a prose tag the
  table had amounts and not what they were for), reads every cell by `Live`, as a property's page
  reads its values (a `[[link]]` or an address opens), drops a column no line fills,
  sums a tag's `number` columns, and resizes columns (`useColumnWidths`: auto until
  the first drag, then fixed).

## The calendar

- Feeds are secret iCal addresses (`calendarFeeds: {name, url}[]`). `ics.ts` parses
  (TZID via `Intl`, RRULE, EXDATE, RECURRENCE-ID, first VALARM); `recurrences`
  serves feeds and typed `repeats::` alike.
- **One source of truth**: sync writes `#event` lines into daily notes and the
  view reads every `#event` line back. Synced lines carry no `repeats::`.
  Dedupe is day + clock + title (`eventKey`).
- **An event's line is `clock #event title name:: value…`** (`eventText`, read back
  by `readEvent`): the title is the words before the first property, so words added
  after one leave it the same event; the properties are `EVENT_PROPERTIES`, in that
  order, a value of more than
  one word quoted (`textProperty`). One over days carries `ends::` and a timed one
  its end's clock: with only its start, a flight from 23:00 to 01:00 was a moment, and
  an offsite over three days was on its first. A feed's all-day end is the day after
  its last, and an end at midnight is the day before's.
- **Sync takes back only what is wholly the calendar's**: its `source::` names a
  feed, the feed no longer has it, nothing is nested under it, and it is exactly
  its values (`untouched`). An empty name is never a source.
- `useCalendarSync` runs on vault open, on a new feed, every `calendarMinutes`
  and on a stale focus.
- The fetch is `curl` in Rust, off the main thread, scheme-checked. A body that is
  not a calendar (a Wi-Fi sign-in page) is refused: read as no events, it took
  every synced line back.
- Nothing about the week is assumed (`firstWeekday` from `Intl.Locale`).

## What the app says

- **Every message goes through one funnel** (`useLog`'s `say`, which `App` still
  calls `setError`): shown at the bottom of the window for `SHOWN_MS`, then gone — it
  stayed until dismissed, over sync rounds that had since gone through — and kept in
  the **Log**, an application of its own, for the window's life, in memory. The
  screen before a vault is open has no Log, so it shows `said`, the latest until put
  away.

## A day's sections

- **Every daily note has the same two sections** (the owner's, 2026-10-15): `## Log`
  (what happened, work, meetings) and `## Notes` (tasks, goals, a thought, and what is
  spent or eaten, captured as it comes), named and tagged in `daySections`. A third,
  `## Trackers`, was taken out on 2026-10-17: hard to read, and the agent puts those
  lines in the tables wherever they are; the days written with it keep it as an
  ordinary heading inside Notes. Plain markdown headings, so the
  note stays markdown; the editor draws them apart (`daySectionPreview`: each heading
  its name, small and spaced, and each section's lines with a rule of its own hue at
  the left; no ground, which the owner found ugly), and only in a daily note.
- **A line goes where its kind says** (`sectionOf`): one carrying a section's tag goes
  there, whatever its clock (a video watched at 21:30 is a note: the owner keeps the Log
  for what matters, and lists media tags under Notes); else one with a clock, or with a
  clock under it, goes in the first; else the second. `#event` is the Log's by default,
  so an all-day event, with no clock, is the day's too. What is nested under a line goes with it. Every line the app writes into a
  day goes through it: an entry, a task, the phone's +, a share (`withNewEntry`), and a
  calendar event, always in the first (`syncEvents`).
- **The day's plan is a table, shown in the day** (`plan.ts`, `PlanSection`, the owner's
  `Today's 8`, from a video on starting each day with the eight things to work on):
  `Trackers/plan.csv`, a row per thing per day (day, thing, done), and at the top of
  each daily note its day's things, a box ticking one and its words changing it, and a
  field for the next while there are fewer than `dayPlan`'s count; every write goes to
  the table (`withThing`, `withPlanned`), made beside the others with the first. Until
  2026-10-17 the eight were boxes written into each new day; the owner wanted the data
  in one place and the day only showing it. **A day with all done keeps a habit**
  (`keptDays`), beside the table's habits; pressed, it opens the day. Trackers has its
  page (`PlanPage`): the month by day, the days kept, the streak.
- **A new day is begun with its sections** (`daySkeleton`, through `ensureDailyNote`),
  and an empty one too. A day written before them is filed as it was (`inSections`): a
  heading tacked onto its end read as a section of one line. `sectioned` puts such a day
  in them, once, as the vault's were on 2026-10-15.
- **The timeline reads a day's first section alone**, its log: what is planned, spent
  and eaten are in the others. A day written before the sections is read whole.
- **A daily note ends with what the tables hold** (`TrackedSection`, drawn under the
  note, after its last section, with a green rule of its own), so what was written
  sits over what was processed.

## The timeline

- **The daily notes as each day happened**, oldest first and today at the bottom;
  the page opens at its end. The owner writes a day by kind — a line of tags alone
  heads a group (`#timeline`, `#diet`), its entries nested under it — and the timeline
  reads it by clock across the groups, a tie as written. **An
  entry is a line with a clock** (the owner's choice: the timeline is what happened
  when); what is nested under one is its detail, and a line without a clock is
  neither an entry nor a place for one, so what is nested under it reads on its own.
- **Each day is a page of a journal, raised as a card** (`--bg-raised`; the owner
  found text alone on the ground hard to take in): its date as the head, the day's
  number large over the clocks and its weekday and month over the words, today's
  card edged and named in `--mark`, its figures beside its count (`figuresOf`: spent,
  eaten, habits ticked, from the trackers' tables); the day broken into Night, Morning, Afternoon,
  Evening (`partOf`); tags as tinted chips; room between entries; no group label.
  What is nested under an entry is folded to a count (`timeline-more`) and opens on
  a press: shown whole, a video's notes buried the day. Its totals are tiles at its
  foot. One family still, by size and weight alone.
- **Day view draws a day as a calendar does** (`dayGrid`, the owner's idea, from
  Google Calendar; `timelineView` in settings): height is time (`HOUR_EM`), each
  entry a box as tall as it lasted, a moment one line's slot (`MOMENT`), entries
  that clash side by side in the first free column, and a stretch of over an hour
  with nothing in it folded to a band. A box takes its tag's colour and opens on a
  press. For work done on and off through a day, amid small things.
- **A moment and a block read apart**: one clock is a dot on the rail, a range
  (`to`, `-`, `–`, `—`) a bar with its length, and one that ends before it starts
  ran past midnight.
- **An entry over days is written once, on the day it starts** (the owner's choice:
  `ends::`, a date, the app's): `23:30 to 07:00` runs past midnight, and `08:00
  #trip Lakeside ends:: 2026-10-14` ends on that day, at the range's end or the day's.
  `end` counts on in minutes past its day. It is shown on each later day here that it
  reaches (`withCarried`; a long `ends::` makes no day of its own) as the same entry,
  so a press edits the line where it is written, its start before 0 there. A part
  says where it comes from and goes (`reachOf`: `23:30–` and `until tomorrow, 07:00`;
  `–07:00` and `since yesterday, 23:30`), its bar running out of the entry, faded
  where it goes on. In Day view it is drawn behind the rest at full width (`across`),
  the moments in it over it, square where it came from and faded where it goes on;
  only its own start and end are on the axis, since drawn to scale a trip from 08:00
  made the day's grid sixteen hours tall.
- **An entry and what is nested under it read as the note shows them** (`Live`): a
  link as its name (a wikilink, a markdown link, a bare address), a tag as a button,
  emphasis without its marks. As typed, a markdown link was its whole address. A tag
  that opens is a chip in its colour (`line-tag`) on the timeline and a task alike;
  scoped to the timeline, a task's coloured tag was plain text. Not in a day's box,
  already washed in its colour.
- **A tag's colour is its setting** (`color`, one of `TAG_COLOURS`, the palette's
  six hues, which the CSV columns share): an entry takes its first coloured tag's as
  `data-hue`, a wash on its row and its dot, and each chip its own tag's. A timeline is one more memo over the one
  read (`useVaultTexts`' `timeline`), so it follows typing as the graph does.
- **A press on an entry edits its one line** under the note's own editor in `line`
  mode (no gutters; Enter, Escape and leaving each the caller's, an open popup's own
  keys first), ended once however it ends. An edit writes on Enter or leaving, and
  the write is `withEditedEntry` through `mutate`: that line, its indent and line ending
  kept, refused if the line is no longer the entry's. A day's name opens its note.
- **A new entry is typed at the bottom of today**, and today is **one** section in its
  place among the days — written or not, and before the days ahead a calendar sync
  wrote (placed after the last day, it was a second Today). Its editor is typed as a
  note's is, the time key included. Enter files it, Escape clears it, and leaving
  keeps the draft.
  `withNewEntry` files it in its section (see A day's sections), or in a day written
  before them as the day is written — under the group its tag heads, else beside its
  tag's entries, in their group (`#food` under `#diet`) or after the last at the top
  level, else the settings' `timelineGroup` (`#timeline` unset), made at the end if
  missing — indented as the lines beside it are. It is filed as typed: with no clock it is a line of the note,
  not on the timeline (it was stamped with the time, and the owner asked for it
  not to be). Today's note is made then, with the icon only, as ⌘⇧O makes it.

## Tasks

- **An application over `#task` lines** (the owner's choice: the tag the vault already
  declares, with `project`, `due` and `status`; checkboxes are not tasks here). Read from
  `collectTag`, so it is one more memo over the one read and follows typing.
- **By when it is due** (`tasksByWhen`): Overdue, Today, This week (to the end of the
  locale's week, `firstWeekday`), Later, No date, and Done folded. A row says only what
  its group does not: an overdue task's age, a weekday this week, a date later. **Or by
  page** (`tasksByNote`, the header's switch, `tasksView` in settings): each note a
  section that opens it, its tasks as written there, each row saying when it is due.
- **A task reads as its note shows it, whole** (`taskWords` through `Live`: links,
  other tags as chips, emphasis, other properties by value), less what its row says
  itself (the list mark, `#task`, `due`, `status`, `project`), and wraps. As plain
  text it read as raw line and ellipsis. What is nested under it folds behind a
  chevron in the tree's column. The row's parts sit in a `div`, not as the list item's
  own buttons, which `.file-list li > button` makes full-width rows.
- **A press on a task edits its line** (`LineEditor`), as a timeline entry's does: Enter
  or leaving writes it through `withEditedEntry`, Escape drops it, emptied is not
  deleted. The note's name after the row opens the note (by page, the section does).
- **Done is written into the task's own line** (`withDone`: `status:: done`, over any
  other status; taken back by removing the status) through `withEditedEntry`, refused if
  the line has changed. The box is a note's checkbox, so a task looks the same in both;
  as a button it takes the row's size and leading, or `1lh` is the UA's and it sits high.
- **A task typed at the top goes into today's note**, filed as a timeline entry is
  (`withNewEntry`: in the Notes section, by its tag). The line is empty, says New task,
  and has no box; `#task` is added unless typed (typed in, the tag beside an empty box
  read as something left on the page). The tag alone is no task.

## Habits

- **Habits are a table** (`habits.ts`, the owner's choice on 2026-10-15): a row per day,
  a column per habit, a day's cell marked (`TICK`, a number, so a spreadsheet adds the
  days up; anything but empty or `0` reads as done). A press on a day writes that one
  value (`withTick`), or a row for a day not there yet; `+` adds a column (`withHabit`).
  Until then a habit was a tag marked as one, done where a day's note carried it, and a
  press wrote the tag into the note: the notes are to stay plain.
- **The page is the habits by the last weeks** (`habitDays`: four whole weeks from the
  locale's first day, this one last, scrolled to today when they do not fit, the names
  held at the left): each day a note's checkbox, filled when done, today ringed, a day
  not yet here only an outline. Beside each, its streak (`streakOf`: days in a row up to
  today, or up to yesterday while today is not done, since a day not over breaks
  nothing) and this week's count; under them, the last twelve weeks' share done. The
  target is every day.

## Sync

- **git through libgit2 (`git2`)**, not the binary, because Android has none.
  Every command is `spawn_blocking` via `blocking`. The token is in the keychain
  (`/usr/bin/security`, keyed by remote), never in the vault.
- **The identity is the repository's local config only**; the machine's global
  one may be someone's work account. A clone takes its last commit's author (`clone`):
  the phone's had none, every commit was refused, and each round stopped before its
  pull, so for a week the phone took in nothing and gave nothing.
- A pull: nothing here → take theirs; no merge base → refused; fast-forward →
  checkout; else merge, each conflict kept as this side plus `name (other).md`.
  Checkouts are `safe()`; libgit2's `Conflict` means wait a round. Push only when
  ahead and not behind.
- **One round at a time** (`busy`, taken before the first wait: a blur and the timer
  both passed the check while the status was read, and their commits raced for
  `main.lock`). A lock another git holds (an agent's commit in the terminal) waits a
  round quietly; the next round finding it too says so, naming the file, since one
  left behind stops every round.
- **A round deleting over half the tracked files is refused** unless Sync now is
  pressed.
- `useSync`: flush, commit, pull, push — on vault open, every `syncSeconds`
  (through a `latest` ref, or each render restarts the timer), on focus and on
  blur. A commit that found changes re-walks the tree. `sync_status` cannot fail,
  so an error there is the bridge missing, and the sync says nothing.
- **Offline is the network not being there** (`isOffline`: resolve, connect, timed
  out, unreachable, reset, broken pipe) — quiet, and retried. A certificate the machine does not
  trust is not offline, and is said: a bare `SSL|TLS` in the rule made a sync that
  could never succeed say only "offline".

## The menu bar

- **An icon in the menu bar opens a small panel** (`menubar` in `lib.rs`, a window of its
  own labelled `capture`, `MenuBarPanel` by its label in `main.tsx`; the owner's ask):
  a line for today, and **Now**, what is being done, timed from when it is said.
  Hidden when it loses the focus, never closed (closing a window asks to quit). Its icon
  is a template drawn by `icon.py` (`icons/tray.png`), tinted by macOS for the bar.
- **The panel only asks; the main window writes** (`useMenuBar`, by events, `ASK` and
  `TELL`), through `fileEntry`, so the open note's buffer, the tree and the sync see the
  line as they see any other. The panel's capability names no file.
- **A time stopped is one line in the day it started** (`trackedLine`, the owner's
  choice): `09:12 to 10:40 what`, which the timeline draws as a block; one clock under a
  minute. Starting something else stops what runs first. Running, it is kept in
  `.config/timer.json`, so a quit does not lose it, and its time is beside the icon
  (`tray_title`). A line that could not be written goes back into its field.
- **Brain dumping is one key from any app** (the owner's ask): `openCapture`, ⌃⌥Space by
  default (Raycast often has ⌥Space), registered with the system (`capture_shortcut`,
  `tauri-plugin-global-shortcut`, `acceleratorOf`) and let go while the settings are
  open; a key another app holds is said. The line for today is a box: ⇧↩ the next
  line, ↩ files them all, each its own line in the order typed, and what could not be
  written goes back.
- **Organise** (`ORGANISE`, the vault's agent in a terminal of its own) is in a daily
  note's header, Trackers' and the panel's, whose press brings the main window forward
  (`show_main`). It asks for the days to be organised as the vault's instructions say,
  each line in its section and the trackers into their tables, not only the tables.

- **The time in each app** (`front` in `lib.rs`, `useAppTime`, the owner's ask): every
  five seconds the Mac says which app is in front, by name only, and how long since a
  key or a press (`objc2-app-kit`, `objc2-core-graphics`, already in Tauri's build); a
  report counts up to ten seconds (after a sleep the gap is not time in an app), and
  none while away for two minutes. Whole minutes go into the apps table every five
  minutes, a row per app per day (`withAppMinutes`; each minute was a commit in the
  vault's history), the table made beside the other trackers' the first time. The
  Trackers page's Apps shows and stops it (`trackApps`). Nothing leaves the Mac.

## The terminal

- **Organise** (`ORGANISE`; see The menu bar) opens a terminal on a session of its own,
  `journeys-organise`, and types `claude '…'` once its shell has started (`run`): the
  vault's agent organises the days not yet organised, as its instructions say, asking
  what it cannot tell. Opened again while its tab is there, it goes to that tab.
- **⇧⌘L goes to the terminal** (`openTerminal`, an action in `ACTIONS`, rebindable;
  the owner's pick), as the row does: the last one, else a new one. Not on the phone.
- `portable-pty`, `$SHELL -i -l` in the vault (a Dock-launched app has no PATH),
  `TERM=xterm-256color`. **tmux holds the session**, because the app owns the PTY
  master and its death kills every child.
- tmux by absolute path, on a **private socket per vault** (`socket_for`, FNV-1a
  of the path), `new-session -A` with `terminalName`'s lowest free `journeys-<n>`.
  `end_orphans` ends servers whose sessions' folders are gone. Closing a tab
  detaches; End session kills. `spawn_terminal` says whether it persisted, and
  runs off the main thread: so a pane's events and commands go by its own mount's
  id, and a spawn that lands after its tab closed is detached as it arrives.
- `.config/tmux.conf` is written once, then the user's: `status off`, `mouse off`
  (the wheel stays xterm's), `prefix None` with `C-b` unbound (readline's back).
  **Only for a server about to start** (`tmux_conf`, in the spawn, from the page's
  `TMUX_CONF`; `end_orphans` says whether this vault's server answered): tmux reads it
  then and never after, and the page used to read the whole file through Drive before
  every first open, 2.3 seconds of blank pane. Never written over one the vault has.
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
  `#[cfg_attr(mobile, tauri::mobile_entry_point)]`. **`gen/android/app/build` is a
  symlink to `~/.cargo-target/android-gradle`**, as `CARGO_TARGET_DIR` is for Rust:
  inside the synced folder, each build rewrote 880 MB that Drive then uploaded, and
  the machine's load sat above 30 until tests timed out. The emulator (`journeys`, a
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
- **Look inside the running WebView**: a debug build serves DevTools on
  `webview_devtools_remote_<pid>` (`adb shell cat /proc/net/unix`); `adb forward
  tcp:9222 localabstract:…`, then evaluate over the DevTools protocol's WebSocket.
- **The page is laid out between the system bars** (`MainActivity`): edge-to-edge
  is enforced from targetSdk 35, the WebView read `env(safe-area-inset-bottom)` as 0
  over the gesture bar, and a keyboard no longer resizes the window. So the content
  view is padded by the bars, the cutout and the keyboard, and what shows behind
  the bars is painted `--bg-viewer` (`paintBars`, from `applySettings`).
- **An app switch is only `visibilitychange`**: the WebView sends no focus or blur,
  which the vault read, the sync, the calendar and the lock wait for, so
  `relayVisibility` sends them.
- **One place at a time** (`Phone.tsx`): Browse, the left pane at full width, or a
  page, the workspace's one tab (`openAlone`), over a bar of Today, Timeline,
  Calendar and Browse. Each move keeps where it came from and the back gesture goes
  there, closing the settings first; it is listened for only while there is
  somewhere to go, so with nowhere Android leaves the app.
- **The + adds from any page** (`Capture`; the owner preferred it to a capture line
  under today): a note's line in today, in its section; an expense or a thing eaten as
  a row of its tracker's table, the Trackers page's own form (`AddForm`), and a habit
  ticked for today (until 2026-10-15, a tag's line from a form of its structure); a
  photo or file kept in `filesFolder` and linked (`keepFile`);
  an event in its own day as the calendar writes one (`eventText`, without
  `source::`); or a new note, which opens. A sheet closes once its line is written
  and the page stays; the back gesture closes it. No time is filled in unasked: Now
  fills it. Today is today's note, opened without being made (a look at the day
  writes nothing). A page opened to read does not raise the keyboard (`EditorHost`'s
  `autoFocus`); a line editor does.
- **The home screen's "Add to today"** (`CaptureWidget`, the owner's ask): a bar that
  opens the app on the +'s note line, the keyboard up, so the line is written as every
  other is. The press reaches the page as a share does (`take`'s `capture`), with two
  traps measured on the emulator: launched the same way again, Android brought the
  task forward and said nothing (so `CLEAR_TOP` and `SINGLE_TOP`); and brought back
  from the background, the page took before the press arrived, so it was seen a return
  late (so the plugin asks for a take at once, `journeys:take`). Focused with no touch,
  a WebView's field raises no keyboard, so the plugin shows it after the sheet mounts.
- **A share is filed into the day it arrived** as `HH:MM #shared` (`shareTag`, a Notes
  tag by default: a link seen is a note, not the day's log), its
  subject and first line, and `[[Files/<name>]]` per file, the rest of a message nested
  under it, so the laptop's agent finds it by the tag. Files are copied into the app's
  files while the sender's grant lasts (`PhonePlugin`), then *moved* into `filesFolder` under
  their own name or ` 2`, never over a file. Shares are taken on vault open and on
  each return, one taking at a time; one that could not be filed is kept, with how
  far its files got (`kept`), and tried again on the next return, which is why
  `mutate` says whether it went through.
- **The calendar's feeds are the laptop's** to fetch: Android has no `curl`, and the
  laptop's sync writes the `#event` lines the phone reads, where two devices writing
  the same lines would collide in git. The phone's Calendar has no Sync.
- **A link can name any file** (`collectFiles` builds the index): `[[Files/photo.jpg]]`
  opens the photo, where with notes alone it was external and the OS refused it.
  The graph still drops what is not text.

## The graph

- **Still, not simulated in front of the reader** (the swirl and the crowd were
  called confusing). A picture is laid out before it is drawn, the same every
  time, and moves only when what is asked changes: a 320ms glide (`glideFrames`,
  none under reduced motion) that ends. The picture is keyed on the graph's shape,
  so typing beside it rebuilds nothing on screen.
- **Around this note** by default, centred on the last note in front: it, what it
  touches, what those touch, as rings (`around`, `ringLayout`), each outer node in
  its parent's share of the angle and each ring grouped by cluster: a cluster's run
  on the first ring, with what hangs off it, is a sector, named past its rim (inside
  it, the outer ring's names hung onto the name). Lines the rings rest on lead; the
  rest are `QUIET` until hovered. A fit frames below the bar, which lies over the
  picture.
- **Everything is drawn by cluster** (`clustersOf`: Louvain over the links between
  notes alone, each cluster busiest first, its first naming it). Days and tags take no part — 65% of a vault's connections touch a
  day, and let in they made the whole vault one knot. Each cluster of three or more
  is laid out on its own, then stands as one node as wide as it is among the rest
  (`everything`), drawn as a faint region named for its busiest note; `spread`
  gives each node its room and the smaller gives way, so nothing that is not a
  member lands inside a region. A day or a tag is drawn small, named after the
  notes, and its lines are `QUIET`.
- **Three kinds of connection**, each a checkbox (`settings.graphShows`): a link in
  the text, a link in a property's value (dashed; the page block's count too, in
  either form), a tag (a node of its own). A page property's link is a backlink and
  follows a rename like any other: `parseNoteLinks` reads the whole note. Nodes
  are notes, days and tags. `connectionsOf` filters, and a note left with none is
  counted and listed, not drawn.
- `GraphView` owns a view transform; the layout stays in world space. The wheel
  zooms about the pointer (a native, non-passive listener); background drags pan;
  the view is fitted, gliding, when the centre, scope or checkboxes change.
- **Labels are placed by collision, not zoom** (`decluttered`), most-connected
  first, the open note first of all. **At rest a label is short** (`shortName`:
  whole up to 24 characters, else the words that fit and `…`), a day is unnamed,
  and a region's hub is named by its region, not twice — the owner found the
  picture too much text, long names worst. The hovered node says its whole name;
  its own edges come back and the rest dim. A dragged node stays where it is left until the picture changes; a
  moved press is not a click.
- `graphHides` and encrypted notes are dropped after the walk, so a link into one
  is not a hollow "missing" node.

## Settings and the sheet

- `.config/settings.json` dresses the vault; each value parses on its own and
  falls back to its default. It is read again on every return to the window, as
  `tags.json` is (the vault's agent edits it too), but not over a change still
  waiting to be written, and a file left broken is said once. A file that is not JSON is said, not handed out and
  not written over: read as the defaults, a panel change wrote them over a hand
  edit, calendars and all. `tags.json` and `properties.json` are said once too.
  `readConfigFile`/`writeConfigFile` take a file name — do not add a second pair.
- **The vault's names are its owner's settings**: the daily folder, the files folder,
  the share tag and the timeline's group (`dailyFolder`, `filesFolder`, `shareTag`,
  `timelineGroup`), each checked as it is typed (`validateFolder`, `validateTag`). The
  app's own names stay fixed: `.config`, `icon::`, `path::`, `aliases::`, `ends::`,
  and the calendar's `#event` and `source::`.
- **A vault's calendars, hidden folders, expenses table and column totals are its
  own** (`portable`): not carried into a new vault, not kept in `localStorage`, and not handed out until that
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
- `--space-w` and `--reading-width` are the measured values (`applySettings`): a
  note's indent is spaces in a proportional face, and its measure is characters in it.
- **Layout settings scale with the type** (the principle above): `lineLength` is
  characters, `lineSpacing` and `rowSpacing` shares of a line and a row, resolved where
  each is used (`calc(… * 1em)`, `var(--row-h)`). In pixels a size one step down
  widened the measure from 85 characters to 91. Settings stored in pixels before
  2026-10-07 are read once into the new names (`fromPixels`).
- **The graph's left-out folders** (`graphHides`) are set under Graph in the panel,
  offered from the vault's folders; until 2026-10-07 only by hand in the file.

## What will bite

- **A successful build is not a running one.** Quit before rebuilding; `open` on a
  running app only focuses it. Compare the process start time with the binary's
  mtime.
- **One copy of the app on the machine.** A bundle left in the build folder is
  registered with macOS beside the one in Applications, as the same app at another
  path: launched by name, it ran as a second window over the same vault, and a quit
  by name ended only one.
- **Google Drive replays old versions over edits.** Edit, type-check and commit as
  one command, then check `git show HEAD:<file>`. Stream mode also makes files
  online-only, including most of the vault's `.git`; a read after the Mac sleeps then
  waits on Google's servers (22 s for the vault, once).
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
- **A plugin can move Tauri itself.** `tauri build` refuses a `tauri` crate whose minor
  version differs from `@tauri-apps/api`'s; the global-shortcut plugin's 2.4 asked for
  `tauri` 2.12 and the lock took it. Pin a plugin to a version that asks for the `tauri`
  in use, and check `tauri` in `Cargo.lock` after adding one.
- **A native crate can link Homebrew.** After adding one, run `otool -L` on the
  bundled binary: everything should be under `/System` or `/usr/lib`. OpenSSL is
  static (`src-tauri/.cargo/config.toml`).
- **Tests**: a `waitFor` callback must throw to retry (put an `expect` in it); the
  async budget is one setting in `src/__tests__/setup.ts`, as are the stubs for
  what jsdom lacks (`Range.getClientRects`, `matchMedia`) — a test needing another
  sets its own; `openApp` and `vaultFile` are `fakeVault`'s, not each file's; a
  wall-clock guard needs a runner timeout looser than itself (`testTimeout`, 20 s
  over a `waitFor`'s 5: at 5 each, a test of several waits was cut off under load);
  a message is read in the Log, not the alert, where another can follow it (a
  feed's failure replaced the one a test waited for, one run in three).
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
  display family, and `--keyword` collections with their `<<slots>>` and
  `collections.json` (2026-09-28: a tag's structure and typed `::` properties do
  their work, and the vault was migrated), and drawn list bullets, number boxes,
  markdown's list nesting for Tab and the Marker gap setting (2026-09-29: the
  owner prefers raw list lines), and a tag's structure, its table view, daily totals,
  the property popup and the phone's tag forms (2026-10-15: trackers are tables).
- **Still open**: at `--fw-prose` 600, `####` and below stop reading as headings;
  folders are not pickable; the graph's Everything repels every pair of nodes each
  step (`stepLayout`, then `spread`), fine at hundreds of notes and slow at
  thousands.

## Preferences

Write the fewest lines that meet the goal. A comment earns its place by recording
a trap someone would otherwise reintroduce, not by restating the code.

**Nothing from the owner's vault goes into this repository** — no person, place,
employer, project, account, card, merchant, currency or note name, in code,
comments, tests or docs — because the code is public. Fixtures are fictional
(Mira Vance, Northwind, Harbour Bistro, Lakeside Terminal). After adding a test
from a real report, grep the tree for the vault's note names.

The history before publication is kept beside this folder, never in the public
repository, as one file: `journeys-history.bundle`. Its `history` branch is this
app's 416 commits before the fresh start, which carry the real names the
published tree was scrubbed of; `archive/v1` and the tag `archive/v1-2026-09-02`
are v1, a deliberate restart, whose commits are inside `history` too.
`git clone journeys-history.bundle` reads it.
