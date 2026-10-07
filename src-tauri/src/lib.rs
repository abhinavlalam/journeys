//! Plugin registration, and the app's own commands.
//!
//! Reading and writing the vault goes through the `dialog` and `fs` plugins,
//! limited by `capabilities/default.json`, not by code here. Every new
//! filesystem call needs a matching entry there, or it fails only at runtime.
//!
//! Each command is one narrow verb and refuses anything else: `reveal` and
//! `open_url` (instead of `tauri-plugin-opener`'s general "open anything"),
//! `fetch_feed`, the sync in `sync.rs` and the terminal in `terminal.rs`.

/// System tools by absolute path, as `terminal.rs` finds tmux:
/// an app started from the Dock has no shell PATH.
const OPEN: &str = "/usr/bin/open";
const CURL: &str = "/usr/bin/curl";

/// Slow work off the main thread. A command that is not `async` runs
/// on it, and a fetch or a push would freeze the window for seconds.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the work did not finish: {e}"))?
}

/// Runs `open` with these arguments, given to the binary directly and never through a
/// shell, so a quote or semicolon in a path is just part of it. `failed` is what is said
/// when `open` refuses, as it does a path that is not there.
fn run_open(args: &[&str], failed: String) -> Result<(), String> {
    let status = std::process::Command::new(OPEN)
        .args(args)
        .status()
        .map_err(|err| format!("could not run open: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(failed)
    }
}

/// Selects a path in Finder with `open -R`.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    run_open(&["-R", &path], format!("could not reveal {path}"))
}

/// Opens a note's link in the system's app for it. The scheme is checked here,
/// not in the webview: `open` can launch apps, mount volumes or run `file://`
/// paths, so only `http`, `https` and `mailto` pass. `--` ends the options, so
/// a target starting with a dash is not a flag.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !has_scheme(&url, &["http", "https", "mailto"]) {
        return Err(format!("not a link this app opens: {url}"));
    }
    run_open(&["--", &url], format!("could not open {url}"))
}

fn has_scheme(url: &str, allowed: &[&str]) -> bool {
    url.split_once(':')
        .map(|(scheme, _)| allowed.contains(&scheme.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// The body at a calendar feed's address.
///
/// `curl` rather than an HTTP crate: macOS's own `curl` does a GET over TLS
/// with the system's certificates, where a crate would add a TLS stack. `http`
/// and `https` only; `--` ends the options. Off the main thread (`blocking`).
///
/// `FEED_TIMEOUT_SECS` is the one limit: `curl` has none, and a
/// feed that never answers would leave Sync stuck on "Syncing…".
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

mod phone;
mod secrets;
mod sync;
mod terminal;

/// A quit waits for the page to write what is being typed. On macOS tao
/// ends the app straight from `applicationWillTerminate`, with no event to
/// hold, so the last 800ms of autosave were lost. ⌘Q and closing a window
/// come here instead: the page flushes and answers `quit`, or `stay` when a
/// write failed and it has said so. A page that never answers gets a few
/// seconds. The Dock's Quit and a logout still end the app directly.
#[cfg(desktop)]
mod quit {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    /// Each request is a generation, so a `stay` or a later
    /// request cancels an earlier one's fallback.
    static ASKED: AtomicU64 = AtomicU64::new(0);
    /// Set once the page says `quit`, so the close that follows is let through.
    pub static LEAVING: AtomicBool = AtomicBool::new(false);
    const ANSWER_WITHIN: Duration = Duration::from_secs(3);

    pub fn ask(app: &AppHandle) {
        let asked = ASKED.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit("quit-requested", ());
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(ANSWER_WITHIN);
            if ASKED.load(Ordering::SeqCst) == asked {
                LEAVING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
        });
    }

    #[tauri::command]
    pub fn quit(app: AppHandle) {
        LEAVING.store(true, Ordering::SeqCst);
        app.exit(0);
    }

    #[tauri::command]
    pub fn stay() {
        ASKED.fetch_add(1, Ordering::SeqCst);
    }

    /// The default menu with its Quit replaced by one that asks
    /// first; the stock item sends `terminate:`, which has no event.
    #[cfg(target_os = "macos")]
    pub fn menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
        use tauri::menu::{Menu, MenuItem, MenuItemKind};
        let menu = Menu::default(app)?;
        if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
            let stock = app_menu.items()?.into_iter().find(|item| {
                matches!(item, MenuItemKind::Predefined(one) if one.text().is_ok_and(|text| text.starts_with("Quit")))
            });
            if let Some(stock) = stock {
                app_menu.remove(&stock)?;
                let name = format!("Quit {}", app.package_info().name);
                app_menu.append(&MenuItem::with_id(app, "quit", name, true, Some("CmdOrCtrl+Q"))?)?;
            }
        }
        Ok(menu)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(secrets::init()).plugin(phone::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(quit::menu).on_menu_event(|app, event| {
        if event.id() == "quit" {
            quit::ask(app);
        }
    });
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if !quit::LEAVING.load(std::sync::atomic::Ordering::SeqCst) {
                api.prevent_close();
                quit::ask(tauri::Manager::app_handle(window));
            }
        }
    });
    builder
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
            terminal::end_terminal,
            phone::phone_shares,
            phone::phone_paint,
            #[cfg(desktop)]
            quit::quit,
            #[cfg(desktop)]
            quit::stay
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
            // Not fatal: without them the app still opens, and a
            // sync says it could not connect.
            #[cfg(target_os = "android")]
            match sync::trust_system_certificates() {
                Ok(count) => log::info!("trusting {count} system certificates"),
                Err(e) => log::warn!("sync will not connect: {e}"),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
