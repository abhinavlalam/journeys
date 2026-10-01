//! The vault's sync: git, in-process.
//!
//! The vault is a folder and the repository is its `.git`, so syncing is
//! commit, push and pull, and git already handles history, merges and
//! hosting. libgit2 rather than the `git` binary, because Android has none.
//! Every command is blocking work passed to `blocking` in `lib.rs`: a command
//! that is not `async` runs on the main thread, and a fetch takes seconds.
//!
//! A merge never guesses. Changes to different files, or different lines of one, merge
//! quietly. The same lines changed on both sides keep both: this device's text stays
//! in the file, the other's arrives beside it as `name (other).md`, and the caller
//! names the file. A remote with a history this vault does not share is refused.
//!
//! The token never touches the vault or `settings.json`;
//! `secrets.rs` keeps it, keyed by the remote's address.

use git2::{
    build::{CheckoutBuilder, RepoBuilder},
    Cred, CredentialType, FetchOptions, IndexAddOption, Oid, PushOptions, RemoteCallbacks,
    Repository, StatusOptions,
};
use crate::{blocking, secrets};
use serde::Serialize;
use std::path::{Path, PathBuf};

const REMOTE: &str = "origin";
/// The user sent with a token when the server names none; GitHub
/// reads the token as the password and ignores the user.
const TOKEN_USER: &str = "x-access-token";
/// The branch a new vault starts on; a vault that already has one keeps it.
const DEFAULT_BRANCH: &str = "main";

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub is_repo: bool,
    pub remote: Option<String>,
    pub name: String,
    pub email: String,
    /// Files changed since the last commit, untracked ones included.
    pub dirty: usize,
    pub ahead: usize,
    pub behind: usize,
    /// Unix seconds of the last commit, if any.
    pub last_commit: Option<i64>,
    pub has_token: bool,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pulled {
    /// Vault-relative paths the pull changed on disk, `(other)` copies included.
    pub changed: Vec<String>,
    /// Files both sides changed; the other version was kept beside them.
    pub conflicts: Vec<String>,
}

type Result<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn open(vault: &str) -> Result<Repository> {
    Repository::open(vault).map_err(|_| "This vault is not backed up yet.".to_string())
}

fn head_branch(repo: &Repository) -> String {
    repo.head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
        .unwrap_or_else(|| DEFAULT_BRANCH.to_string())
}

fn remote_url(repo: &Repository) -> Option<String> {
    repo.find_remote(REMOTE).ok().and_then(|r| r.url().map(str::to_string))
}

/// A value from this repository's own config and no other level.
/// The machine's global identity may be a work account; a
/// vault's commits carry what Settings → Sync set, or nothing.
fn config_string(repo: &Repository, key: &str) -> String {
    repo.config()
        .and_then(|c| c.open_level(git2::ConfigLevel::Local))
        .ok()
        .and_then(|c| c.get_string(key).ok())
        .unwrap_or_default()
}

fn signature(repo: &Repository) -> Result<git2::Signature<'static>> {
    let (name, email) = (config_string(repo, "user.name"), config_string(repo, "user.email"));
    if name.is_empty() || email.is_empty() {
        return Err("Set your name and email in Settings → Sync before the first commit.".to_string());
    }
    git2::Signature::now(&name, &email).map_err(err)
}

/// Android's certificates, given to libgit2's OpenSSL from memory. OpenSSL
/// built for Android has no file access (`no-stdio`), so no bundle or folder
/// can be pointed at: each certificate the phone trusts is parsed here and
/// added to the store. The updatable store first, since Android 14.
#[cfg(target_os = "android")]
pub fn trust_system_certificates() -> Result<usize> {
    use std::ffi::{c_int, c_void};
    use std::ptr::null_mut;
    let dirs = ["/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"];
    let dir = dirs.iter().find(|d| Path::new(d).is_dir()).ok_or("this phone has no system certificates")?;
    libgit2_sys::init();
    let mut added = 0;
    for entry in std::fs::read_dir(dir).map_err(err)?.flatten() {
        let Ok(pem) = std::fs::read(entry.path()) else { continue };
        // SAFETY: the BIO reads `pem`, which outlives it; libgit2 takes its own
        // reference to the certificate, so this one is freed after the add.
        unsafe {
            let bio = openssl_sys::BIO_new_mem_buf(pem.as_ptr() as *const c_void, pem.len() as c_int);
            if bio.is_null() {
                continue;
            }
            let cert = openssl_sys::PEM_read_bio_X509(bio, null_mut(), None, null_mut());
            openssl_sys::BIO_free_all(bio);
            if cert.is_null() {
                continue;
            }
            if libgit2_sys::git_libgit2_opts(libgit2_sys::GIT_OPT_ADD_SSL_X509_CERT as c_int, cert) == 0 {
                added += 1;
            }
            openssl_sys::X509_free(cert);
        }
    }
    if added == 0 {
        return Err(format!("none of the certificates in {dir} could be read"));
    }
    Ok(added)
}

/// Callbacks that answer a credential prompt with the token, and refuse
/// without one. A `file://` remote never asks, which is how the tests run.
fn callbacks<'a>(token: Option<&'a str>) -> RemoteCallbacks<'a> {
    let mut cbs = RemoteCallbacks::new();
    cbs.credentials(move |_url, username, allowed| {
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(token) = token {
                return Cred::userpass_plaintext(username.unwrap_or(TOKEN_USER), token);
            }
        }
        Err(git2::Error::from_str("Needs the token: set it in Settings → Sync."))
    });
    cbs
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

fn status_of(vault: &str) -> SyncStatus {
    let Ok(repo) = Repository::open(vault) else {
        return SyncStatus::default();
    };
    let remote = remote_url(&repo);
    let mut status = SyncStatus {
        is_repo: true,
        has_token: remote.as_deref().map(|r| secrets::get(r).is_some()).unwrap_or(false),
        remote,
        name: config_string(&repo, "user.name"),
        email: config_string(&repo, "user.email"),
        ..SyncStatus::default()
    };
    status.dirty = changes(&repo).len();
    if let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
        status.last_commit = Some(head.time().seconds());
        let branch = head_branch(&repo);
        if let Ok(upstream) = repo.refname_to_id(&format!("refs/remotes/{REMOTE}/{branch}")) {
            if let Ok((ahead, behind)) = repo.graph_ahead_behind(head.id(), upstream) {
                status.ahead = ahead;
                status.behind = behind;
            }
        }
    }
    status
}

/// Every path that differs from the last commit (modified, added,
/// deleted or untracked, ignored ones left out), and whether it is gone.
fn changes(repo: &Repository) -> Vec<(String, bool)> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    repo.statuses(Some(&mut opts))
        .map(|statuses| {
            statuses
                .iter()
                .filter(|s| !s.status().is_ignored() && !s.status().is_empty())
                .filter_map(|s| {
                    let gone = s.status().is_wt_deleted() || s.status().is_index_deleted();
                    Some((s.path()?.to_string(), gone))
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Configure, commit, push, pull, clone
// ---------------------------------------------------------------------------

fn configure(vault: &str, remote: Option<&str>, name: &str, email: &str) -> Result<()> {
    let repo = match Repository::open(vault) {
        Ok(repo) => repo,
        Err(_) => {
            let mut opts = git2::RepositoryInitOptions::new();
            opts.initial_head(DEFAULT_BRANCH);
            Repository::init_opts(vault, &opts).map_err(err)?
        }
    };
    let mut config = repo.config().map_err(err)?;
    config.set_str("user.name", name.trim()).map_err(err)?;
    config.set_str("user.email", email.trim()).map_err(err)?;
    match remote.map(str::trim).filter(|r| !r.is_empty()) {
        Some(url) if repo.find_remote(REMOTE).is_ok() => repo.remote_set_url(REMOTE, url).map_err(err)?,
        Some(url) => {
            repo.remote(REMOTE, url).map_err(err)?;
        }
        None => {
            if repo.find_remote(REMOTE).is_ok() {
                repo.remote_delete(REMOTE).map_err(err)?;
            }
        }
    }
    Ok(())
}

/// Commits everything that changed and returns whether anything did. The
/// message names a few of the files, so the history reads like a journal's.
///
/// A deletion of more than half the vault is not committed on its own. Deletions
/// sync, so a folder emptied by hand, a sync service replaying an old state, or a
/// disk that unmounted mid-walk would reach every device within a minute. Refused
/// with the count, and allowed only by hand (`allow_mass_deletion`, from Sync now).
fn commit(vault: &str, allow_mass_deletion: bool) -> Result<bool> {
    let repo = open(vault)?;
    let changed = changes(&repo);
    if changed.is_empty() {
        return Ok(false);
    }
    if !allow_mass_deletion {
        let deleted = changed.iter().filter(|(_, gone)| *gone).count();
        let tracked = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok())
            .map(|t| tree_paths(&t).len())
            .unwrap_or(0);
        if deleted * 2 > tracked && tracked > 0 {
            return Err(format!(
                "{deleted} of the {tracked} files in the vault were deleted since the last save. Not saving that on its own: if you meant it, press Sync now in Settings → Sync."
            ));
        }
    }
    let signature = signature(&repo)?;
    let mut index = repo.index().map_err(err)?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).map_err(err)?;
    index.update_all(["*"].iter(), None).map_err(err)?;
    index.write().map_err(err)?;
    let tree_id = index.write_tree().map_err(err)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(parent) = &parent {
        if parent.tree_id() == tree_id {
            return Ok(false);
        }
    }
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let mut message = changed.iter().take(3).map(|(path, _)| path.as_str()).collect::<Vec<_>>().join(", ");
    if changed.len() > 3 {
        message.push_str(&format!(" and {} more", changed.len() - 3));
    }
    repo.commit(Some("HEAD"), &signature, &signature, &message, &tree, &parents)
        .map_err(err)?;
    Ok(true)
}

/// What a trip to the remote needs: the repository, its branch,
/// and the token for its address.
fn connect(vault: &str) -> Result<(Repository, String, Option<String>)> {
    let repo = open(vault)?;
    let url = remote_url(&repo).ok_or("No repository address is set.")?;
    let branch = head_branch(&repo);
    Ok((repo, branch, secrets::get(&url)))
}

/// A checkout or merge that stopped because a file was written after this
/// round's commit (typing during the fetch). libgit2 refuses before writing
/// anything, so nothing is lost; the next round commits the file and merges.
fn waits(e: &git2::Error) -> bool {
    e.code() == git2::ErrorCode::Conflict
}

fn push(vault: &str) -> Result<()> {
    let (repo, branch, token) = connect(vault)?;
    // Only what the remote can take, as of this round's fetch: nothing when
    // there is nothing new, and nothing while the other side has commits
    // not merged here yet (a pull waiting a round). Pushed anyway, the
    // remote refuses it as a rewind and the round reports a false failure.
    let tracking = repo.refname_to_id(&format!("refs/remotes/{REMOTE}/{branch}"));
    if let (Ok(head), Ok(theirs)) = (repo.refname_to_id("HEAD"), tracking) {
        let (ahead, behind) = repo.graph_ahead_behind(head, theirs).map_err(err)?;
        if ahead == 0 || behind > 0 {
            return Ok(());
        }
    }
    let mut remote = repo.find_remote(REMOTE).map_err(err)?;
    let mut cbs = callbacks(token.as_deref());
    // A refused update is an error with the server's reason, not a silent success.
    cbs.push_update_reference(|_, status| match status {
        Some(reason) => Err(git2::Error::from_str(reason)),
        None => Ok(()),
    });
    let mut opts = PushOptions::new();
    opts.remote_callbacks(cbs);
    remote
        .push(&[format!("refs/heads/{branch}:refs/heads/{branch}")], Some(&mut opts))
        .map_err(err)?;
    // So `ahead` and `behind` mean something, and plain `git` on this folder agrees.
    if let Ok(mut local) = repo.find_branch(&branch, git2::BranchType::Local) {
        let _ = local.set_upstream(Some(&format!("{REMOTE}/{branch}")));
    }
    Ok(())
}

fn pull(vault: &str) -> Result<Pulled> {
    let (repo, branch, token) = connect(vault)?;
    {
        let mut remote = repo.find_remote(REMOTE).map_err(err)?;
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(callbacks(token.as_deref()));
        remote.fetch(&[branch.as_str()], Some(&mut opts), None).map_err(err)?;
    }
    let Ok(remote_ref) = repo.find_reference(&format!("refs/remotes/{REMOTE}/{branch}")) else {
        // An empty repository on the other end: nothing to bring down.
        return Ok(Pulled::default());
    };
    let theirs = repo.reference_to_annotated_commit(&remote_ref).map_err(err)?;
    let their_commit = repo.find_commit(theirs.id()).map_err(err)?;

    // Checkouts are safe, never forced. Forced, a note typed into
    // after this round's commit was overwritten on disk, and the
    // buffer then re-read the overwritten text. Returns their tree,
    // or `None` when a file here is being edited and the round waits.
    let take_theirs = || -> Result<Option<git2::Tree>> {
        let tree = their_commit.tree().map_err(err)?;
        match repo.checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe())) {
            Err(e) if waits(&e) => Ok(None),
            done => done.map(|_| Some(tree)).map_err(err),
        }
    };
    let Some(our_commit) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) else {
        // Nothing committed here yet: take theirs as the start.
        let Some(tree) = take_theirs()? else { return Ok(Pulled::default()) };
        repo.reference(&format!("refs/heads/{branch}"), theirs.id(), true, "sync: first pull").map_err(err)?;
        repo.set_head(&format!("refs/heads/{branch}")).map_err(err)?;
        return Ok(Pulled { changed: tree_paths(&tree), conflicts: vec![] });
    };

    let (analysis, _) = repo.merge_analysis(&[&theirs]).map_err(err)?;
    if analysis.is_up_to_date() {
        return Ok(Pulled::default());
    }
    if repo.merge_base(our_commit.id(), theirs.id()).is_err() {
        return Err("The repository holds a different history from this vault. Open it as a separate vault, or point this vault at an empty repository.".to_string());
    }
    let before = our_commit.tree().map_err(err)?;

    if analysis.is_fast_forward() {
        let Some(tree) = take_theirs()? else { return Ok(Pulled::default()) };
        repo.reference(&format!("refs/heads/{branch}"), theirs.id(), true, "sync: fast-forward").map_err(err)?;
        return Ok(Pulled { changed: changed_between(&repo, &before, &tree), conflicts: vec![] });
    }

    // A real merge. libgit2 writes the result into the working tree,
    // conflict markers included; each conflicted file is then put back
    // as this side had it, with the other side's version beside it.
    match repo.merge(&[&theirs], None, None) {
        Err(e) if waits(&e) => return Ok(Pulled::default()),
        done => done.map_err(err)?,
    }
    let mut index = repo.index().map_err(err)?;
    let mut conflicts = vec![];
    let mut extra = vec![];
    if index.has_conflicts() {
        let found: Vec<_> = index.conflicts().map_err(err)?.filter_map(|c| c.ok()).collect();
        for conflict in found {
            let path = conflict
                .our
                .as_ref()
                .or(conflict.their.as_ref())
                .map(|e| String::from_utf8_lossy(&e.path).to_string())
                .ok_or("a conflict with no path")?;
            let full = Path::new(vault).join(&path);
            match (&conflict.our, &conflict.their) {
                (Some(ours), Some(their)) => {
                    write_blob(&repo, ours.id, &full)?;
                    let other = other_path(&path);
                    write_blob(&repo, their.id, &Path::new(vault).join(&other))?;
                    index.add_path(Path::new(&path)).map_err(err)?;
                    index.add_path(Path::new(&other)).map_err(err)?;
                    extra.push(other);
                }
                (Some(ours), None) => {
                    // They deleted what this side changed: this side's text stays.
                    write_blob(&repo, ours.id, &full)?;
                    index.add_path(Path::new(&path)).map_err(err)?;
                }
                (None, Some(their)) => {
                    // This side deleted what they changed: theirs arrives as the other.
                    let other = other_path(&path);
                    write_blob(&repo, their.id, &Path::new(vault).join(&other))?;
                    index.remove_path(Path::new(&path)).map_err(err)?;
                    if full.exists() {
                        let _ = std::fs::remove_file(&full);
                    }
                    index.add_path(Path::new(&other)).map_err(err)?;
                    extra.push(other);
                }
                (None, None) => {}
            }
            conflicts.push(path);
        }
    }
    index.write().map_err(err)?;
    let tree_id = index.write_tree().map_err(err)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let signature = signature(&repo)?;
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "sync: merged the other device's changes",
        &tree,
        &[&our_commit, &their_commit],
    )
    .map_err(err)?;
    repo.cleanup_state().map_err(err)?;
    let mut changed = changed_between(&repo, &before, &tree);
    changed.extend(extra);
    changed.sort();
    changed.dedup();
    Ok(Pulled { changed, conflicts })
}

fn clone(url: &str, into: &str) -> Result<()> {
    let token = secrets::get(url);
    let mut opts = FetchOptions::new();
    opts.remote_callbacks(callbacks(token.as_deref()));
    let repo = RepoBuilder::new().fetch_options(opts).clone(url, Path::new(into)).map_err(err)?;
    // When HEAD names a branch nobody pushed, the clone has
    // nothing checked out; take the branch that is there.
    if repo.head().is_err() {
        let branches: Vec<String> = repo
            .branches(Some(git2::BranchType::Remote))
            .map_err(err)?
            .filter_map(|b| b.ok())
            .filter_map(|(b, _)| b.name().ok().flatten().map(str::to_string))
            .filter(|n| !n.ends_with("/HEAD"))
            .collect();
        let pick = branches
            .iter()
            .find(|n| n.ends_with(&format!("/{DEFAULT_BRANCH}")))
            .or(branches.first())
            .ok_or("The repository is empty.")?;
        let local = pick.split_once('/').map(|(_, b)| b).unwrap_or(DEFAULT_BRANCH);
        let target = repo.refname_to_id(&format!("refs/remotes/{pick}")).map_err(err)?;
        repo.reference(&format!("refs/heads/{local}"), target, true, "sync: first checkout").map_err(err)?;
        repo.set_head(&format!("refs/heads/{local}")).map_err(err)?;
        repo.checkout_head(Some(CheckoutBuilder::new().force())).map_err(err)?;
        if let Ok(mut branch) = repo.find_branch(local, git2::BranchType::Local) {
            let _ = branch.set_upstream(Some(pick));
        }
    }
    Ok(())
}

/// `Daily/2026-09-24.md` → `Daily/2026-09-24 (other).md`. A v1 locked note keeps
/// its whole `.enc.md`, as `keepOther` does: `x.enc (other).md` was ciphertext
/// under a plain note's name, which the app would then write into.
pub(crate) fn other_path(path: &str) -> String {
    let p = PathBuf::from(path);
    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let cut = if name.to_lowercase().ends_with(".enc.md") {
        name.len() - ".enc.md".len()
    } else {
        p.file_stem().map(|s| s.len()).unwrap_or(name.len())
    };
    let (stem, ext) = name.split_at(cut);
    p.with_file_name(format!("{stem} (other){ext}")).to_string_lossy().to_string()
}

fn write_blob(repo: &Repository, id: Oid, to: &Path) -> Result<()> {
    let blob = repo.find_blob(id).map_err(err)?;
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(to, blob.content()).map_err(err)
}

fn changed_between(repo: &Repository, before: &git2::Tree, after: &git2::Tree) -> Vec<String> {
    repo.diff_tree_to_tree(Some(before), Some(after), None)
        .map(|diff| {
            diff.deltas()
                .flat_map(|d| [d.old_file().path(), d.new_file().path()])
                .flatten()
                .map(|p| p.to_string_lossy().to_string())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

fn tree_paths(tree: &git2::Tree) -> Vec<String> {
    let mut out = vec![];
    let _ = tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            out.push(format!("{dir}{}", entry.name().unwrap_or_default()));
        }
        git2::TreeWalkResult::Ok
    });
    out
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_status(vault: String) -> Result<SyncStatus> {
    blocking(move || Ok(status_of(&vault))).await
}

#[tauri::command]
pub async fn sync_configure(vault: String, remote: Option<String>, name: String, email: String) -> Result<()> {
    blocking(move || configure(&vault, remote.as_deref(), &name, &email)).await
}

#[tauri::command]
pub async fn sync_commit(vault: String, allow_mass_deletion: bool) -> Result<bool> {
    blocking(move || commit(&vault, allow_mass_deletion)).await
}

#[tauri::command]
pub async fn sync_push(vault: String) -> Result<()> {
    blocking(move || push(&vault)).await
}

#[tauri::command]
pub async fn sync_pull(vault: String) -> Result<Pulled> {
    blocking(move || pull(&vault)).await
}

#[tauri::command]
pub async fn sync_clone(url: String, into: String) -> Result<()> {
    blocking(move || clone(&url, &into)).await
}

#[tauri::command]
pub async fn sync_set_token(remote: String, token: String) -> Result<()> {
    blocking(move || secrets::set(&remote, token.trim())).await
}

#[tauri::command]
pub async fn sync_forget_token(remote: String) -> Result<()> {
    blocking(move || secrets::forget(&remote)).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "journeys-sync-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }
    fn write(vault: &Path, rel: &str, text: &str) {
        let full = vault.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    fn read(vault: &Path, rel: &str) -> String {
        fs::read_to_string(vault.join(rel)).unwrap()
    }
    /// A vault of its own, with `bare` as its `file://` remote.
    fn vault(name: &str, bare: &Path) -> PathBuf {
        let v = temp(name);
        configure(&s(&v), Some(&format!("file://{}", s(bare))), "Mira Vance", "mira@example").unwrap();
        v
    }

    #[test]
    fn a_folder_becomes_a_repo_and_commits_what_changed() {
        let v = temp("commit");
        assert!(!status_of(&s(&v)).is_repo);
        configure(&s(&v), None, "Mira Vance", "mira@example").unwrap();
        let st = status_of(&s(&v));
        assert!(st.is_repo);
        assert_eq!(st.name, "Mira Vance");
        assert_eq!(st.remote, None);
        write(&v, "Daily/2026-09-24.md", "# Thursday\n");
        assert_eq!(status_of(&s(&v)).dirty, 1);
        assert!(commit(&s(&v), false).unwrap());
        assert!(!commit(&s(&v), false).unwrap(), "nothing changed, nothing committed");
        let st = status_of(&s(&v));
        assert_eq!(st.dirty, 0);
        assert!(st.last_commit.is_some());
        write(&v, "Daily/2026-09-24.md", "# Thursday\n\nWoke late.\n");
        fs::remove_file(v.join("Daily/2026-09-24.md")).unwrap();
        write(&v, "Ideas.md", "");
        assert_eq!(status_of(&s(&v)).dirty, 2, "a deletion and an addition");
        // The one tracked file gone is more than half the vault: by hand only.
        assert!(commit(&s(&v), true).unwrap());
        assert_eq!(status_of(&s(&v)).dirty, 0);
    }

    #[test]
    fn refuses_to_commit_without_an_identity() {
        let v = temp("noid");
        Repository::init(&v).unwrap();
        write(&v, "a.md", "a");
        let e = commit(&s(&v), false).unwrap_err();
        assert!(e.contains("name and email"), "{e}");
    }

    #[test]
    fn two_vaults_sync_through_a_remote_and_a_pull_reports_what_changed() {
        let bare = temp("bare");
        Repository::init_bare(&bare).unwrap();
        let a = vault("a", &bare);
        write(&a, "Daily/2026-09-24.md", "# Thursday\n");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        let st = status_of(&s(&a));
        assert_eq!((st.ahead, st.behind), (0, 0));

        // The second device: an empty folder pulling the history.
        let b = vault("b", &bare);
        let pulled = pull(&s(&b)).unwrap();
        assert_eq!(pulled.changed, vec!["Daily/2026-09-24.md"]);
        assert_eq!(read(&b, "Daily/2026-09-24.md"), "# Thursday\n");

        // B writes and pushes; A is behind, pulls, and is told which file changed.
        write(&b, "Daily/2026-09-25.md", "# Friday\n");
        commit(&s(&b), false).unwrap();
        push(&s(&b)).unwrap();
        let pulled = pull(&s(&a)).unwrap();
        assert_eq!(pulled.changed, vec!["Daily/2026-09-25.md"]);
        assert!(pulled.conflicts.is_empty());
        assert_eq!(read(&a, "Daily/2026-09-25.md"), "# Friday\n");
        // Nothing more to pull.
        assert!(pull(&s(&a)).unwrap().changed.is_empty());
    }

    #[test]
    fn edits_on_both_sides_merge_and_a_collision_keeps_both() {
        let bare = temp("bare2");
        Repository::init_bare(&bare).unwrap();
        let a = vault("a2", &bare);
        write(&a, "Daily/2026-09-24.md", "# Thursday\n");
        write(&a, "Plans.md", "- one\n");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        let b = vault("b2", &bare);
        pull(&s(&b)).unwrap();

        // Different files: quiet.
        write(&a, "Plans.md", "- one\n- two\n");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        write(&b, "Daily/2026-09-24.md", "# Thursday\n\nFrom the phone.\n");
        commit(&s(&b), false).unwrap();
        let e = push(&s(&b)).unwrap_err();
        assert!(!e.is_empty(), "a push behind the remote is refused with a reason");
        let pulled = pull(&s(&b)).unwrap();
        assert!(pulled.conflicts.is_empty());
        assert_eq!(read(&b, "Plans.md"), "- one\n- two\n");
        push(&s(&b)).unwrap();

        // The same lines of one file: this side's stays, the other's arrives beside it.
        pull(&s(&a)).unwrap();
        write(&a, "Daily/2026-09-24.md", "# Thursday\n\nFrom the Mac.\n");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        write(&b, "Daily/2026-09-24.md", "# Thursday\n\nFrom the phone, again.\n");
        commit(&s(&b), false).unwrap();
        let pulled = pull(&s(&b)).unwrap();
        assert_eq!(pulled.conflicts, vec!["Daily/2026-09-24.md"]);
        assert_eq!(read(&b, "Daily/2026-09-24.md"), "# Thursday\n\nFrom the phone, again.\n");
        assert_eq!(read(&b, "Daily/2026-09-24 (other).md"), "# Thursday\n\nFrom the Mac.\n");
        assert!(pulled.changed.contains(&"Daily/2026-09-24 (other).md".to_string()));
        assert_eq!(status_of(&s(&b)).dirty, 0, "the merge is committed, markers and all gone");
        push(&s(&b)).unwrap();
        let pulled = pull(&s(&a)).unwrap();
        assert!(pulled.conflicts.is_empty());
        assert_eq!(read(&a, "Daily/2026-09-24 (other).md"), "# Thursday\n\nFrom the Mac.\n");
    }

    /// Typing that lands during the fetch (after this round's commit, before its
    /// checkout) is never overwritten: a note the other side left alone keeps
    /// it, and a note both sides changed waits for the next round's merge.
    #[test]
    fn a_pull_never_overwrites_a_note_written_since_the_rounds_commit() {
        let bare = temp("bare5");
        Repository::init_bare(&bare).unwrap();
        let a = vault("a5", &bare);
        write(&a, "Daily/2026-09-24.md", "# Thursday\n");
        write(&a, "Plans.md", "- one\n");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        let b = vault("b5", &bare);
        pull(&s(&b)).unwrap();

        // A fast-forward past a note the other side left alone.
        write(&a, "Daily/2026-09-24.md", "# Thursday\n\nFrom the Mac.\n");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        write(&b, "Plans.md", "- one\n- typed during the fetch\n");
        let pulled = pull(&s(&b)).unwrap();
        assert_eq!(pulled.changed, vec!["Daily/2026-09-24.md"]);
        assert_eq!(read(&b, "Plans.md"), "- one\n- typed during the fetch\n");
        assert_eq!(read(&b, "Daily/2026-09-24.md"), "# Thursday\n\nFrom the Mac.\n");

        // A fast-forward onto a note typed into here: nothing is written this round.
        commit(&s(&b), false).unwrap();
        push(&s(&b)).unwrap();
        pull(&s(&a)).unwrap();
        write(&a, "Plans.md", "- one\n- from the Mac\n");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        write(&b, "Plans.md", "- one\n- from the phone\n");
        let pulled = pull(&s(&b)).unwrap();
        assert!(pulled.changed.is_empty() && pulled.conflicts.is_empty());
        assert_eq!(read(&b, "Plans.md"), "- one\n- from the phone\n");
        // Behind the other side, the push sends nothing rather than a rewind.
        push(&s(&b)).unwrap();

        // A merge onto one: the same. The next round commits it and merges.
        write(&b, "Ideas.md", "committed here\n");
        commit(&s(&b), false).unwrap();
        write(&b, "Plans.md", "- one\n- from the phone, again\n");
        assert!(pull(&s(&b)).unwrap().changed.is_empty());
        assert_eq!(read(&b, "Plans.md"), "- one\n- from the phone, again\n");
        assert_eq!(repo_state(&b), git2::RepositoryState::Clean, "no merge left half-made");
        // Diverged, the same: the commit here waits for the merge before it goes up.
        push(&s(&b)).unwrap();
        commit(&s(&b), false).unwrap();
        let pulled = pull(&s(&b)).unwrap();
        assert_eq!(pulled.conflicts, vec!["Plans.md"]);
        assert_eq!(read(&b, "Plans.md"), "- one\n- from the phone, again\n");
        assert_eq!(read(&b, "Plans (other).md"), "- one\n- from the Mac\n");
        // And the merged round's push goes through.
        push(&s(&b)).unwrap();
        pull(&s(&a)).unwrap();
        assert_eq!(read(&a, "Plans (other).md"), "- one\n- from the Mac\n");
    }

    fn repo_state(v: &Path) -> git2::RepositoryState {
        Repository::open(v).unwrap().state()
    }

    #[test]
    fn a_remote_with_another_history_is_refused() {
        let bare = temp("bare3");
        Repository::init_bare(&bare).unwrap();
        let a = vault("a3", &bare);
        write(&a, "x.md", "x");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        let c = vault("c3", &bare);
        write(&c, "y.md", "y");
        commit(&s(&c), false).unwrap();
        let e = pull(&s(&c)).unwrap_err();
        assert!(e.contains("different history"), "{e}");
        assert_eq!(read(&c, "y.md"), "y", "and nothing was touched");
    }

    #[test]
    fn a_clone_is_a_vault() {
        let bare = temp("bare4");
        Repository::init_bare(&bare).unwrap();
        let a = vault("a4", &bare);
        write(&a, "Notes/Hello.md", "hi");
        commit(&s(&a), false).unwrap();
        push(&s(&a)).unwrap();
        let into = temp("clone4").join("Journal");
        clone(&format!("file://{}", s(&bare)), &s(&into)).unwrap();
        assert_eq!(read(&into, "Notes/Hello.md"), "hi");
        assert!(status_of(&s(&into)).remote.is_some());
    }

    #[test]
    fn a_deletion_of_more_than_half_the_vault_waits_to_be_asked_for() {
        let v = temp("mass");
        configure(&s(&v), None, "Mira Vance", "mira@example").unwrap();
        for n in 0..4 {
            write(&v, &format!("n{n}.md"), "x");
        }
        assert!(commit(&s(&v), false).unwrap());
        // Two of four is not more than half: committed.
        fs::remove_file(v.join("n0.md")).unwrap();
        fs::remove_file(v.join("n1.md")).unwrap();
        assert!(commit(&s(&v), false).unwrap());
        // Two of the two left is: refused with the count, and nothing committed.
        fs::remove_file(v.join("n2.md")).unwrap();
        fs::remove_file(v.join("n3.md")).unwrap();
        let e = commit(&s(&v), false).unwrap_err();
        assert!(e.starts_with("2 of the 2 files"), "{e}");
        assert_eq!(status_of(&s(&v)).dirty, 2);
        // Asked for by hand, it goes.
        assert!(commit(&s(&v), true).unwrap());
        assert_eq!(status_of(&s(&v)).dirty, 0);
    }

    #[test]
    fn the_other_name() {
        assert_eq!(other_path("Daily/2026-09-24.md"), "Daily/2026-09-24 (other).md");
        assert_eq!(other_path("notes"), "notes (other)");
        assert_eq!(other_path("Secure/Keys.enc"), "Secure/Keys (other).enc");
        assert_eq!(other_path("Secure/Accounts.enc.md"), "Secure/Accounts (other).enc.md");
    }
}
