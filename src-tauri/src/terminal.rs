//! A pseudo-terminal per terminal tab: the owner's login shell, in the
//! vault folder. A reader thread streams the PTY's bytes to the webview as
//! one event per session. A session ends when the tab ends it
//! (`end_terminal`) or the shell exits (the thread reaps it and says so).
//!
//! A session outlives the window, and tmux holds it. The app owns the PTY
//! master, so when it exits every child dies with it. The shell is tmux's
//! child instead, and the app is a client attached to it. Close the
//! window and the tmux server keeps the session, its scrollback and what
//! runs in it; open a terminal again and `new-session -A` reattaches.
//!
//! Three things make this safe. The server is on a private socket per vault
//! (`socket_for`), so it never shows in the owner's own `tmux ls` or reads
//! their config. The config is the vault's (`.config/tmux.conf`, written by
//! the TS side): no status bar, the mouse left to xterm, and `prefix None`,
//! since `C-b` is back one character in every readline shell. And closing a
//! tab only detaches; ending a session is a separate act.
//!
//! Without tmux (`find_tmux`) it falls back to the plain login
//! shell, and `spawn_terminal` says which it did.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::blocking;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Set before a session is killed, so the reader thread can tell the
    /// process ending from the tab closing, and report only the first.
    killed: Arc<AtomicBool>,
}

/// Length of a trailing byte run that may start a multi-byte character. Converting
/// each 8 KB read with `from_utf8_lossy` on its own turned a character split across
/// two reads into U+FFFD twice; `claude`'s TUI is full of box-drawing and emoji.
/// Returns 0 for a complete or malformed tail, which is then converted lossily.
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

/// The app's tmux servers, each on a private socket named with this: `tmux ls`
/// in the owner's shell shows none of them, and `~/.tmux.conf` reaches none.
const SOCKET_PREFIX: &str = "journeys";

/// One server per vault, named from the vault's path. With one server for
/// every vault, a vault copied to a new folder reattached to the session
/// still running in the old one. FNV-1a, not `DefaultHasher`, whose
/// algorithm may change with the toolchain and orphan every session.
pub(crate) fn socket_for(vault: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in vault.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{SOCKET_PREFIX}-{hash:016x}")
}

/// A server whose vault is gone is ended, so no agent keeps running in
/// a moved or deleted folder, writing a stray copy back by absolute
/// path. One whose every session folder no longer exists is killed. A
/// server that cannot answer (a socket left by a crash) is skipped.
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
// ---------------------------------------------------------------------------

/// Claude Code's folder name for a project: its path with every
/// character that is not a letter, digit or `-` made a `-`.
fn claude_slug(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect()
}

fn move_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    // Across volumes (`~/.claude` on the disk, the vault in a cloud
    // folder) a rename is refused, so it is a copy and a delete.
    std::fs::rename(from, to).or_else(|_| std::fs::copy(from, to).and_then(|_| std::fs::remove_file(from)))
}

/// The agent's memory lives in the vault at `.claude/memory`, and Claude Code's
/// folder for the vault's path links to it. Claude Code keys memory by absolute
/// path, so a moved vault started its agent with none of its rules; in the
/// vault, the memory moves and syncs with it. Run as a terminal starts. A folder
/// already linked here is left alone. A real folder has its files moved in, a
/// differing file kept as `(other)`. A link to somewhere else is replaced. With
/// no `projects` folder there is no Claude Code, and nothing happens.
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

/// tmux by absolute path, since a GUI-launched app's PATH has no Homebrew.
/// Asking the login shell would cover every layout but spawn a shell per
/// terminal; these are the two Mac prefixes, plus the PATH there is.
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

/// Start or reattach a session off the main thread: ending orphaned servers,
/// moving the memory and starting tmux are process and disk work. A tab closed
/// meanwhile sends its detach first; the pane detaches again when this answers.
#[tauri::command]
pub async fn spawn_terminal(
    app: AppHandle,
    id: String,
    name: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    blocking(move || spawn(app, id, name, cwd, cols, rows)).await
}

fn spawn(app: AppHandle, id: String, name: String, cwd: String, cols: u16, rows: u16) -> Result<bool, String> {
    let pair = native_pty_system()
        .openpty(size(cols.max(2), rows.max(1)))
        .map_err(|e| e.to_string())?;

    // A GUI-launched app does not get the interactive shell's PATH (nvm and
    // Homebrew's shellenv live in `.zshrc`), so this is an interactive
    // login shell, where `claude` resolves as in a real terminal.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // tmux by absolute path for the same reason, or every
    // session would fall back to a shell that does not persist.
    let tmux = find_tmux();
    let mut cmd = match &tmux {
        Some(bin) => {
            let mut cmd = CommandBuilder::new(bin);
            end_orphans(bin);
            cmd.arg("-L");
            cmd.arg(socket_for(&cwd));
            // Read only when this server starts, and it is our
            // own server, thanks to the private socket.
            let conf = std::path::Path::new(&cwd).join(".config/tmux.conf");
            if conf.is_file() {
                cmd.arg("-f");
                cmd.arg(&conf);
            }
            // `-A` attaches to `name` if the server has it and creates
            // it if not, so a name that is the same across launches
            // brings the session back. The TS side derives it.
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
    // A GUI-launched app has no TERM; terminal emulators set it.
    // Without it programs drop colour.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killed = Arc::new(AtomicBool::new(false));

    {
        let state = app.state::<TerminalState>();
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        // Reusing an id kills the old child first: dropping a
        // `Box<dyn Child>` neither kills nor reaps it.
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
    // Said in the pane, not swallowed: a terminal that starts matters more
    // than the link, but an agent without its memory should not be a surprise.
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
        // A shell that exits on its own is reaped here, since nothing else
        // will. Matched on the `killed` flag's identity, not the id: ids
        // may be reused, and reaping a newer session would kill a live one.
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
            // Otherwise a dead session looks live and swallows every key:
            // `write_terminal` succeeds whether anything reads or not.
            let _ = app.emit(&exit_event, ());
        }
    });
    // Say which backend: the pane tells the owner when a session
    // will not outlive the window.
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

/// Closing a tab detaches; it does not end the session. The child here is the tmux
/// client, so killing it leaves the server holding the session. Ending one is
/// `end_terminal`. Without tmux the child is the shell, and the session is gone.
#[tauri::command]
pub fn kill_terminal(state: State<TerminalState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        session.killed.store(true, Ordering::Relaxed);
        let _ = session.child.kill();
        // `kill()` alone leaves a zombie until the app exits.
        let _ = session.child.wait();
    }
    Ok(())
}

/// End a session for good: `kill-session` on our own server, by name. A name the
/// server does not have is not an error; either way there is no such session now.
#[tauri::command]
pub async fn end_terminal(name: String, cwd: String) -> Result<(), String> {
    blocking(move || {
        let Some(bin) = find_tmux() else { return Ok(()) };
        std::process::Command::new(bin)
            .args(["-L", &socket_for(&cwd), "kill-session", "-t", &name])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
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
        // The vault moves, and the memory inside it goes along.
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

    /// The PTY layer works here: a shell spawned in a folder answers
    /// with that folder. The app's command is this plus an event stream.
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
