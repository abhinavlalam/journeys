//! The sync token, kept by the OS and never in the vault or
//! `settings.json`, keyed by the remote's address.
//!
//! On macOS it is the keychain, through macOS's own `security`. On Android
//! it is `SecretsPlugin.kt` in the app's sources: an Android Keystore key
//! seals the token into the app's private files. Written here rather than
//! taken from a plugin, because it is the app's one credential.

type Result<T> = std::result::Result<T, String>;

#[cfg(not(target_os = "android"))]
mod store {
    use super::Result;

    const SERVICE: &str = "Journeys sync";
    /// macOS's keychain tool, by absolute path (see `lib.rs`).
    const SECURITY: &str = "/usr/bin/security";

    fn security(args: &[&str]) -> Result<std::process::Output> {
        std::process::Command::new(SECURITY)
            .args(args)
            .output()
            .map_err(|e| format!("could not run security: {e}"))
    }

    pub fn get(remote: &str) -> Option<String> {
        let out = security(&["find-generic-password", "-s", SERVICE, "-a", remote, "-w"]).ok()?;
        if !out.status.success() {
            return None;
        }
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!token.is_empty()).then_some(token)
    }

    pub fn set(remote: &str, token: &str) -> Result<()> {
        // `-U` updates an existing item instead of failing.
        let out = security(&["add-generic-password", "-U", "-s", SERVICE, "-a", remote, "-w", token])?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("the keychain refused the token: {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    }

    pub fn forget(remote: &str) -> Result<()> {
        // Already absent is what was asked for, not a failure.
        security(&["delete-generic-password", "-s", SERVICE, "-a", remote]).map(|_| ())
    }
}

#[cfg(target_os = "android")]
mod store {
    use super::Result;
    use serde::{Deserialize, Serialize};
    use std::sync::OnceLock;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::Wry;

    /// The Kotlin half, registered once at startup.
    static KOTLIN: OnceLock<PluginHandle<Wry>> = OnceLock::new();

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("secrets")
            .setup(|_app, api| {
                let _ = KOTLIN.set(api.register_android_plugin("app.journeys.journal", "SecretsPlugin")?);
                Ok(())
            })
            .build()
    }

    #[derive(Serialize)]
    struct Args<'a> {
        name: &'a str,
        value: Option<&'a str>,
    }

    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Answer {
        value: Option<String>,
    }

    /// `set` and `forget` answer with nothing, which arrives as null rather than
    /// an empty `Answer`: read as one, every token the phone was given was refused.
    fn call(command: &str, name: &str, value: Option<&str>) -> Result<Answer> {
        KOTLIN
            .get()
            .ok_or("the phone's secret store is not ready")?
            .run_mobile_plugin::<Option<Answer>>(command, Args { name, value })
            .map(Option::unwrap_or_default)
            .map_err(|e| format!("the phone's secret store refused: {e}"))
    }

    pub fn get(remote: &str) -> Option<String> {
        call("get", remote, None).ok()?.value.filter(|token| !token.is_empty())
    }

    pub fn set(remote: &str, token: &str) -> Result<()> {
        call("set", remote, Some(token)).map(|_| ())
    }

    pub fn forget(remote: &str) -> Result<()> {
        call("forget", remote, None).map(|_| ())
    }
}

#[cfg(target_os = "android")]
pub use store::init;
pub use store::{forget, get, set};
