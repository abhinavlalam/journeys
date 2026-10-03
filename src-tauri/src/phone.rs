//! What the phone adds: what other apps share in, and the colour behind the
//! system bars. Both are `PhonePlugin.kt` in the app's Android sources; on a
//! desktop nothing is shared in and there are no bars to paint.
//!
//! The commands are `async`: a sync command runs on the main thread, where the
//! Kotlin side runs too, and waiting there for its answer would never end.

use serde::{Deserialize, Serialize};

type Result<T> = std::result::Result<T, String>;

/// One share as the sending app gave it. Kotlin leaves out what is null.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Share {
    /// When it arrived, in ms since the epoch.
    at: f64,
    text: Option<String>,
    subject: Option<String>,
    files: Vec<SharedFile>,
}

/// A copy in the app's own files, or why the file could not be read.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SharedFile {
    name: String,
    path: Option<String>,
    error: Option<String>,
}

#[cfg(target_os = "android")]
mod kotlin {
    use super::{Result, Share};
    use serde::{Deserialize, Serialize};
    use std::sync::OnceLock;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::Wry;

    static KOTLIN: OnceLock<PluginHandle<Wry>> = OnceLock::new();

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("phone")
            .setup(|_app, api| {
                let _ = KOTLIN.set(api.register_android_plugin("app.journeys.journal", "PhonePlugin")?);
                Ok(())
            })
            .build()
    }

    fn call<A: Serialize, R: for<'de> Deserialize<'de>>(command: &str, args: A) -> Result<R> {
        KOTLIN
            .get()
            .ok_or("the phone's half of the app is not ready")?
            .run_mobile_plugin(command, args)
            .map_err(|e| e.to_string())
    }

    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Taken {
        shares: Vec<Share>,
    }

    #[derive(Serialize)]
    struct Paint<'a> {
        color: &'a str,
        light: bool,
    }

    pub fn take() -> Result<Vec<Share>> {
        call::<_, Taken>("take", ()).map(|taken| taken.shares)
    }

    pub fn paint(color: &str, light: bool) -> Result<()> {
        call::<_, serde::de::IgnoredAny>("paint", Paint { color, light }).map(|_| ())
    }
}

#[cfg(target_os = "android")]
pub use kotlin::init;

/// Every share that arrived since the last call, each once.
#[tauri::command]
pub async fn phone_shares() -> Result<Vec<Share>> {
    #[cfg(target_os = "android")]
    return kotlin::take();
    #[cfg(not(target_os = "android"))]
    Ok(Vec::new())
}

/// Paints behind the system bars, `#rrggbb`, with icons for a `light` colour or a dark one.
#[tauri::command]
#[allow(unused_variables)]
pub async fn phone_paint(color: String, light: bool) -> Result<()> {
    #[cfg(target_os = "android")]
    return kotlin::paint(&color, light);
    #[cfg(not(target_os = "android"))]
    Ok(())
}
