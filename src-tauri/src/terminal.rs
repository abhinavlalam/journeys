//! A pseudo-terminal per Terminal tab: the user's own shell, in the vault folder.
//!
//! Lifted from v1's `terminal.rs`, which ran one fixed `claude`; this runs the login
//! shell and the tab types whatever it likes into it — `claude`, `git`, `yt-dlp`.
//! The reader thread streams the PTY's bytes to the webview as one event per
//! session, and the session ends when the tab closes (`kill_terminal`) or the shell
//! exits on its own (the thread reaps it and says so).
//!
//! **A session outlives the window, and tmux is what holds it.** Reported as
//! everything starting from scratch after a restart, `claude` sessions included.
//! The app cannot hold a shell across its own death: it owns the PTY *master*, and
//! when the process exits that handle closes, the slave is hung up, and every child
//! dies with it. So the shell is not the app's child any more — it is tmux's, and
//! the app is only a client attached to it. Close the window and the tmux server
//! keeps the session, its scrollback and whatever was running in it; open a Terminal
//! again and `new-session -A` reattaches instead of creating. Measured before
//! building it: with no client attached, a session's pane content is intact and its
//! child process is still running.
//!
//! Three things make that safe to do. The server is on a **private socket**, one
//! per vault (`socket_for`), so this never appears in the user's own `tmux ls`,
//! never joins their server and never reads their config. The **config is the vault's**
//! (`.config/tmux.conf`, written by the TS side, which owns vault files) and turns
//! the status bar off, leaves the mouse to xterm.js so the pane's own scrollback and
//! wheel behave as they did, and sets `prefix None` — because the default `C-b` is
//! *back one character* to every readline shell, and a multiplexer silently eating
//! it is the kind of thing that reads as the app being broken. And closing a tab
//! **detaches**: killing the client leaves the server holding the session, which is
//! the whole point, so ending one for good is a separate act.
//!
//! Without tmux (`find_tmux`) it falls back to the login shell exactly as before, and
//! `spawn_terminal` answers which of the two it did — a fallback that reported
//! itself as an ordinary success is this project's most repeated bug.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Set before we kill a session, so the reader thread can tell "the process
    /// ended" from "the tab closed" and only report the first.
    killed: Arc<AtomicBool>,
}

/// Length of a trailing byte run that may be the start of a multi-byte character.
///
/// Converting a read's bytes with `from_utf8_lossy` on their own replaces a
/// sequence split across the 8 KB boundary with U+FFFD in both halves, and the
/// bytes are discarded per read so the glyph never comes back — `claude`'s TUI is
/// box-drawing and emoji throughout. Returns 0 for anything already complete, or
/// malformed, which is then converted lossily rather than held forever.
fn incomplete_tail(buf: &[u8]) -> usize {
    for back in 1..=std::cmp::min(3, buf.len()) {
        let byte = buf[buf.len() - back];
        if byte < 0x80 {
            return 0;
        }
        if byte >= 0xC0 {
            let needed = if byte >= 0xF0 {
                4
            } else if byte >= 0xE0 {
                3
            } else {
                2
            };
            return if back < needed { back } else { 0 };
        }
    }
    0
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The app's own tmux servers, each on a private socket named with this: `tmux ls`
/// in the user's shell shows none of them, and their `~/.tmux.conf` reaches none.
const SOCKET_PREFIX: &str = "journeys";

/// **One server per vault, named from the vault's path.** It was one server for
/// every vault, with sessions called `journeys-1`, `journeys-2`: after the vault was
/// copied to a new folder, the Terminal tab reattached to the session still running
/// `claude` in the old one, and that agent's notes went where the app no longer
/// looked. A vault at a new path is a new server. FNV-1a rather than Rust's
/// `DefaultHasher`, whose algorithm may change with the toolchain and would orphan
/// every session when it did.
pub(crate) fn socket_for(vault: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in vault.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{SOCKET_PREFIX}-{hash:016x}")
}

/// **A server whose vault has gone is ended**, so no agent is left running in a
/// folder that was moved or deleted — writing by absolute path, it would put a
/// stray copy of the vault back where the old one was. Each of the app's servers
/// says where its sessions started; one whose every start folder no longer exists
/// is killed. A server that cannot answer (a socket left by a crash) is skipped.
fn end_orphans(tmux: &str) {
    let Ok(uid) = std::process::Command::new("/usr/bin/id").arg("-u").output() else { return };
    let uid = String::from_utf8_lossy(&uid.stdout).trim().to_string();
    let base = std::env::var("TMUX_TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    let Ok(sockets) = std::fs::read_dir(format!("{base}/tmux-{uid}")) else { return };
    for socket in sockets.flatten() {
        let name = socket.file_name().to_string_lossy().to_string();
        if !name.starts_with(SOCKET_PREFIX) {
            continue;
        }
        let Ok(out) = std::process::Command::new(tmux)
            .args(["-L", &name, "list-sessions", "-F", "#{session_path}"])
            .output()
        else {
            continue;
        };
        let paths = String::from_utf8_lossy(&out.stdout).to_string();
        let starts: Vec<&str> = paths.lines().filter(|p| !p.is_empty()).collect();
        if out.status.success() && !starts.is_empty() && starts.iter().all(|p| !std::path::Path::new(p).exists()) {
            let _ = std::process::Command::new(tmux).args(["-L", &name, "kill-server"]).output();
        }
    }
}

// ---------------------------------------------------------------------------
// The agent's memory

/// Claude Code's folder name for a project: its path with every character that is
/// not a letter, a digit or `-` made a `-` — the rule its own folders are named by.
fn claude_slug(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect()
}

fn move_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    // Across volumes — `~/.claude` on the disk, the vault in a cloud folder — a rename
    // is refused, so it is a copy and a delete.
    std::fs::rename(from, to).or_else(|_| std::fs::copy(from, to).and_then(|_| std::fs::remove_file(from)))
}

/// **The agent's memory lives in the vault**, at `.claude/memory`, and Claude Code's
/// folder for the vault's path points at it. Claude Code keys memory by the
/// project's absolute path, so a vault that moved started its agent with none of the
/// rules it had been given — never invent a note's content, no em dashes — which is
/// what happened when this vault was copied to a new folder. In the vault, the
/// memory moves with it and syncs with it. Run as a terminal starts, the moment an
/// agent can begin: a folder already pointing at the vault is left alone; a real
/// one has its files moved in, a file both hold that differs kept as `(other)`, the
/// sync's convention; a link to somewhere else — where the vault used to be — is
/// replaced. With no `projects` folder there is no Claude Code, and nothing is done.
fn link_memory(projects: &std::path::Path, vault: &std::path::Path) -> Result<(), String> {
    use std::fs;
    if !projects.is_dir() {
        return Ok(());
    }
    let home = vault.join(".claude").join("memory");
    let link = projects.join(claude_slug(&vault.to_string_lossy())).join("memory");
    if fs::read_link(&link).map(|target| target == home).unwrap_or(false) {
        return Ok(());
    }
    let err = |e: std::io::Error| e.to_string();
    fs::create_dir_all(&home).map_err(err)?;
    if link.is_symlink() {
        fs::remove_file(&link).map_err(err)?;
    } else if link.is_dir() {
        for entry in fs::read_dir(&link).map_err(err)?.flatten() {
            let from = entry.path();
            if !from.is_file() {
                continue;
            }
            let to = home.join(entry.file_name());
            if !to.exists() {
                move_file(&from, &to).map_err(err)?;
            } else if fs::read(&from).map_err(err)? == fs::read(&to).map_err(err)? {
                fs::remove_file(&from).map_err(err)?;
            } else {
                let other = crate::sync::other_path(&entry.file_name().to_string_lossy());
                move_file(&from, &home.join(other)).map_err(err)?;
            }
        }
        fs::remove_dir(&link).map_err(err)?;
    }
    fs::create_dir_all(link.parent().unwrap_or(projects)).map_err(err)?;
    std::os::unix::fs::symlink(&home, &link).map_err(err)
}

/// tmux by absolute path, because a GUI-launched app's PATH has no Homebrew in it.
///
/// `SHELL -lc 'command -v tmux'` would answer for every install layout, but it
/// spawns a shell on the way to every terminal; these are the two prefixes a Mac
/// puts it under, plus whatever PATH we do have for anything hand-placed.
fn find_tmux() -> Option<String> {
    let mut roots = vec![
        "/opt/homebrew/bin/tmux".to_string(),
        "/usr/local/bin/tmux".to_string(),
        "/usr/bin/tmux".to_string(),
    ];
    if let Ok(path) = std::env::var("PATH") {
        roots.extend(path.split(':').filter(|dir| !dir.is_empty()).map(|dir| {
            std::path::Path::new(dir)
                .join("tmux")
                .to_string_lossy()
                .into_owned()
        }));
    }
    roots
        .into_iter()
        .find(|bin| std::path::Path::new(bin).is_file())
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<TerminalState>,
    id: String,
    name: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    let pair = native_pty_system()
        .openpty(size(cols.max(2), rows.max(1)))
        .map_err(|e| e.to_string())?;

    // GUI-launched apps on macOS don't inherit the user's interactive shell PATH
    // (nvm, homebrew shellenv live in .zshrc, which only an interactive shell
    // sources) — an interactive login shell, so `claude` resolves as it would in a
    // real terminal.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // The same reason tmux has to be looked up by absolute path: a GUI-launched app
    // has Homebrew's bin on no PATH of its own, so a bare `tmux` would not be found
    // and every session would silently fall back to a shell that does not persist.
    let tmux = find_tmux();
    let mut cmd = match &tmux {
        Some(bin) => {
            let mut cmd = CommandBuilder::new(bin);
            end_orphans(bin);
            cmd.arg("-L");
            cmd.arg(socket_for(&cwd));
            // Only read when this server starts, and it is *our* server — the
            // private socket is what makes that true.
            let conf = std::path::Path::new(&cwd).join(".config/tmux.conf");
            if conf.is_file() {
                cmd.arg("-f");
                cmd.arg(&conf);
            }
            // `-A` is the whole feature: attach to `name` if the server has it,
            // create it if not. So a name that is the same across launches is a
            // session that comes back, and the TS side derives one.
            cmd.args(["new-session", "-A", "-s", &name, "-c", &cwd]);
            cmd
        }
        None => {
            let mut cmd = CommandBuilder::new(&shell);
            cmd.args(["-i", "-l"]);
            cmd
        }
    };
    cmd.cwd(&cwd);
    // A GUI-launched app has no TERM — terminal emulators set it, and nothing else
    // does. Without it TUIs take their no-colour path.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killed = Arc::new(AtomicBool::new(false));

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        // Reusing an id kills the old child first: dropping a Box<dyn Child>
        // neither kills nor reaps it.
        if let Some(mut previous) = sessions.remove(&id) {
            previous.killed.store(true, Ordering::Relaxed);
            let _ = previous.child.kill();
            let _ = previous.child.wait();
        }
        sessions.insert(
            id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
                killed: killed.clone(),
            },
        );
    }

    let event_name = format!("terminal-output-{id}");
    let exit_event = format!("terminal-exit-{id}");
    // Said in the pane rather than swallowed: a terminal that starts is worth more
    // than a link, but an agent without its memory should not be a surprise.
    if let Some(home) = std::env::var_os("HOME") {
        let projects = std::path::Path::new(&home).join(".claude").join("projects");
        if let Err(e) = link_memory(&projects, std::path::Path::new(&cwd)) {
            let _ = app.emit(&event_name, format!("Journeys could not link the agent's memory into the vault: {e}\r\n"));
        }
    }
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let split = pending.len() - incomplete_tail(&pending);
                    if split == 0 {
                        continue;
                    }
                    let chunk = String::from_utf8_lossy(&pending[..split]).into_owned();
                    pending.drain(..split);
                    if app.emit(&event_name, chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // A shell that exits on its own is reaped here, because nothing else will.
        // Matched on the `killed` flag's identity and not the id: ids could be
        // reused, and reaping a newer session under this name would kill a live one.
        if !killed.load(Ordering::Relaxed) {
            if let Ok(mut sessions) = app.state::<TerminalState>().sessions.lock() {
                if sessions
                    .get(&id)
                    .is_some_and(|s| Arc::ptr_eq(&s.killed, &killed))
                {
                    if let Some(mut done) = sessions.remove(&id) {
                        let _ = done.child.kill();
                        let _ = done.child.wait();
                    }
                }
            }
            // Without this a dead session looks like a live one that swallows every
            // keystroke: `write_terminal` succeeds whether or not anything reads.
            let _ = app.emit(&exit_event, ());
        }
    });
    // **Which backend, said out loud.** A fallback that reports itself as an
    // ordinary success is the bug this project has hit three times; the pane says
    // so when a session will not outlive the window.
    Ok(tmux.is_some())
}

#[tauri::command]
pub fn write_terminal(state: State<TerminalState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&id) {
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_terminal(state: State<TerminalState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&id) {
        session.master.resize(size(cols, rows)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Closing a tab **detaches**; it does not end the session.
///
/// The child here is the tmux *client*, so killing it leaves the server holding the
/// session, its scrollback and whatever is running in it — which is the whole
/// feature, not a leak. Ending one for good is `end_terminal`. Without tmux the
/// child is the shell itself and this is the old behaviour: the session is gone,
/// because there was never anywhere for it to be.
#[tauri::command]
pub fn kill_terminal(state: State<TerminalState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        session.killed.store(true, Ordering::Relaxed);
        let _ = session.child.kill();
        // kill() alone leaves a zombie until the app exits.
        let _ = session.child.wait();
    }
    Ok(())
}

/// End a session for good: `kill-session` on our own server, by name.
///
/// Detaching is what closing a tab does, so this is the deliberate other act — for
/// a session someone is finished with rather than stepping away from. A name the
/// server does not have is not an error: the answer either way is that there is no
/// such session now.
#[tauri::command]
pub fn end_terminal(name: String, cwd: String) -> Result<(), String> {
    let Some(bin) = find_tmux() else { return Ok(()) };
    std::process::Command::new(bin)
        .args(["-L", &socket_for(&cwd), "kill-session", "-t", &name])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "journeys-memory-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_vault_has_a_server_of_its_own_whose_name_does_not_drift() {
        let a = socket_for("/Users/mira/Documents/Journal");
        assert_eq!(a, socket_for("/Users/mira/Documents/Journal"));
        assert_ne!(a, socket_for("/Users/mira/Library/CloudStorage/Drive/journeys"));
        assert!(a.starts_with("journeys-") && a.len() == "journeys-".len() + 16, "{a}");
        // FNV-1a of the empty string is its offset basis: the algorithm, pinned.
        assert_eq!(socket_for(""), "journeys-cbf29ce484222325");
    }

    #[test]
    fn claude_names_a_project_by_its_path() {
        assert_eq!(
            claude_slug("/Users/mira/Library/CloudStorage/GoogleDrive-mira@example.com/My Drive/journeys"),
            "-Users-mira-Library-CloudStorage-GoogleDrive-mira-example-com-My-Drive-journeys"
        );
    }

    #[test]
    fn the_memory_moves_into_the_vault_and_the_folder_points_at_it() {
        let projects = temp("projects");
        let vault = temp("vault");
        let folder = projects.join(claude_slug(&vault.to_string_lossy())).join("memory");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("MEMORY.md"), "- [Rule](rule.md)\n").unwrap();
        std::fs::write(folder.join("rule.md"), "never invent content\n").unwrap();
        std::fs::write(folder.join("same.md"), "x").unwrap();
        let home = vault.join(".claude/memory");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("rule.md"), "the other device's wording\n").unwrap();
        std::fs::write(home.join("same.md"), "x").unwrap();

        link_memory(&projects, &vault).unwrap();
        assert_eq!(std::fs::read_link(&folder).unwrap(), home);
        assert_eq!(std::fs::read_to_string(home.join("MEMORY.md")).unwrap(), "- [Rule](rule.md)\n");
        assert_eq!(std::fs::read_to_string(home.join("rule.md")).unwrap(), "the other device's wording\n");
        assert_eq!(std::fs::read_to_string(home.join("rule (other).md")).unwrap(), "never invent content\n");
        assert!(!home.join("same (other).md").exists(), "an identical file is one file");
        // Through the link, Claude Code sees the vault's memory.
        assert!(folder.join("MEMORY.md").is_file());

        // Again: nothing to do.
        link_memory(&projects, &vault).unwrap();
        assert_eq!(std::fs::read_link(&folder).unwrap(), home);
    }

    #[test]
    fn a_moved_vault_gets_its_memory_back_and_no_claude_means_nothing() {
        let projects = temp("projects2");
        let before = temp("before");
        link_memory(&projects, &before).unwrap();
        std::fs::write(before.join(".claude/memory/rule.md"), "kept\n").unwrap();
        // The vault moves; the memory is inside it, so it goes along.
        let after = temp("after").join("journeys");
        std::fs::rename(&before, &after).unwrap();
        link_memory(&projects, &after).unwrap();
        let folder = projects.join(claude_slug(&after.to_string_lossy())).join("memory");
        assert_eq!(std::fs::read_to_string(folder.join("rule.md")).unwrap(), "kept\n");

        let nowhere = temp("no-claude").join("projects");
        link_memory(&nowhere, &after).unwrap();
        assert!(!nowhere.exists());
    }

    #[test]
    fn a_split_utf8_tail_is_held_back() {
        // "é" is C3 A9; the first byte alone is an incomplete tail of 1.
        assert_eq!(incomplete_tail(&[b'a', 0xC3]), 1);
        assert_eq!(incomplete_tail(&[b'a', 0xC3, 0xA9]), 0);
        // An emoji is four bytes; three of them are a tail of 3.
        assert_eq!(incomplete_tail(&[0xF0, 0x9F, 0x94]), 3);
        assert_eq!(incomplete_tail(b"plain"), 0);
    }

    /// The PTY layer works on this machine: a shell spawned in a directory answers
    /// with that directory. The app's command is this with an event stream on it.
    #[test]
    fn a_shell_in_a_directory_answers_from_it() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "pwd; exit 0"]);
        cmd.cwd("/tmp");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        child.wait().unwrap();
        assert!(out.contains("/tmp") || out.contains("/private/tmp"), "{out}");
    }
}
