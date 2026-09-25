//! Plugin registration, and the app's own commands.
//!
//! Reading and writing the vault — pick a folder, walk it, read and write its files
//! — is the `dialog` and `fs` plugins, whose reach is bounded by
//! `capabilities/default.json` rather than by code here. A capability entry is the
//! only thing standing between the webview and the disk, so **every new filesystem
//! operation needs a matching entry** or it fails at runtime only.
//!
//! The commands are each one narrow verb and refuse anything else: `reveal` and
//! `open_url` (where `tauri-plugin-opener` would hand the webview a general "open
//! this with the OS"), `fetch_feed`, the vault's sync in `sync.rs` and the terminal
//! in `terminal.rs`.

/// The system's own tools, **by absolute path**, as tmux is found in `terminal.rs`: an
/// app launched from the Dock has none of the PATH a shell sets, so a bare name is
/// whatever that PATH happens to reach first, or nothing.
const OPEN: &str = "/usr/bin/open";
const CURL: &str = "/usr/bin/curl";

/// Slow work off the main thread. A command that is not `async` runs *on* it, and a
/// fetch or a push is seconds of a frozen window; every command that touches the
/// network or the disk at length hands its work here.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the work did not finish: {e}"))?
}

/// Selects a path in Finder — macOS's own `open -R`.
///
/// Arguments are passed to the binary directly and never through a shell, so a path
/// holding a quote or a semicolon is a path and not a second command. The path
/// always comes from the tree the app walked; `open` refuses one that is not there,
/// and the caller shows that.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let status = std::process::Command::new(OPEN)
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|err| format!("could not run open: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("could not reveal {path}"))
    }
}

/// Opens a link a note carries, in whatever the OS has for it.
///
/// **The scheme is checked here, not in the webview.** `open` will launch an
/// application, mount a volume or run a `file://` path, and a note is a document
/// that can say anything — so this answers for `http`, `https` and `mailto` and
/// refuses the rest. `--` ends the option list, or a target beginning with a dash
/// would be read as a flag. Arguments never go through a shell.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !has_scheme(&url, &["http", "https", "mailto"]) {
        return Err(format!("not a link this app opens: {url}"));
    }
    let status = std::process::Command::new(OPEN)
        .arg("--")
        .arg(&url)
        .status()
        .map_err(|err| format!("could not run open: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("could not open {url}"))
    }
}

fn has_scheme(url: &str, allowed: &[&str]) -> bool {
    url.split_once(':')
        .map(|(scheme, _)| allowed.contains(&scheme.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// The body at a calendar's feed address.
///
/// **`curl`, and not an HTTP crate**: the app already speaks to the OS through
/// `open` for the two verbs above, and the one thing wanted here is a GET of a
/// `.ics` over TLS — which macOS's own `curl` does with its own certificate store,
/// where an HTTP crate would add a TLS stack to the build to do the same. `http`
/// and `https` only, since a note or a settings file can say anything; `--` ends
/// the options, so an address beginning with a dash is an address. Off the main
/// thread, because a command that is not `async` runs on it and a fetch is
/// seconds (`blocking`).
///
/// `FEED_TIMEOUT_SECS` is the one bound: `curl` has none of its own, and a feed
/// that never answers would otherwise hold the Sync button at "Syncing…" for good.
const FEED_TIMEOUT_SECS: &str = "30";

#[tauri::command]
async fn fetch_feed(url: String) -> Result<String, String> {
    if !has_scheme(&url, &["http", "https"]) {
        return Err(format!("not a feed address: {url}"));
    }
    blocking(move || {
        let output = std::process::Command::new(CURL)
            .args(["--fail", "--silent", "--show-error", "--location", "--max-time", FEED_TIMEOUT_SECS, "--"])
            .arg(&url)
            .output()
            .map_err(|err| format!("could not run curl: {err}"))?;
        if output.status.success() {
            String::from_utf8(output.stdout).map_err(|_| format!("{url} is not text"))
        } else {
            Err(format!(
                "could not fetch {url}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    })
    .await
}

mod sync;
mod terminal;

pub fn run() {
    tauri::Builder::default()
        .manage(terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            reveal,
            open_url,
            fetch_feed,
            sync::sync_status,
            sync::sync_configure,
            sync::sync_commit,
            sync::sync_push,
            sync::sync_pull,
            sync::sync_clone,
            sync::sync_set_token,
            sync::sync_forget_token,
            terminal::spawn_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::kill_terminal,
            terminal::end_terminal
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
