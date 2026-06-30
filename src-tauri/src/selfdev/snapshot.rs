//! DB snapshot for the promotion pipeline.
//!
//! Before the gate runs we take a recoverable copy of the live SQLite database,
//! so a later (Slice-2) binary swap that misbehaves can be rolled back to a known
//! point. We FIRST checkpoint the WAL (`PRAGMA wal_checkpoint(TRUNCATE)` via the
//! db.rs `Mutex<Connection>` — see [`Db::checkpoint_wal`](crate::db::Db::checkpoint_wal))
//! so every committed write is folded into the main `portcode.db` file, THEN copy
//! that file. Without the checkpoint a plain file copy could miss writes still
//! sitting in `portcode.db-wal`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::db::Db;

/// Snapshot the live database to `<config_dir>/selfdev/db-snapshot.db`, returning
/// the snapshot path. Checkpoints the WAL first so the copy is complete.
///
/// All blocking work (the synchronous `PRAGMA` + the `std::fs::copy`) runs inside
/// `tokio::task::spawn_blocking`, so calling this from an async pipeline never
/// stalls the runtime.
pub async fn snapshot_db(db: Arc<Db>, config_dir: PathBuf) -> Result<PathBuf, String> {
    tokio::task::spawn_blocking(move || snapshot_db_blocking(&db, &config_dir))
        .await
        .map_err(|e| format!("snapshot task failed: {e}"))?
}

/// The synchronous body of [`snapshot_db`], factored out so it is directly unit-
/// testable without a tokio runtime. Checkpoints the WAL, ensures the
/// `selfdev/` dir exists, then copies the live DB file to `db-snapshot.db`.
fn snapshot_db_blocking(db: &Db, config_dir: &Path) -> Result<PathBuf, String> {
    // 1. Fold the WAL back into the main DB file so a plain copy is complete.
    db.checkpoint_wal()
        .map_err(|e| format!("WAL checkpoint failed: {e}"))?;

    // 2. The live DB lives at `<config_dir>/portcode.db` (see `lib.rs` setup), and
    //    the snapshot goes under a `selfdev/` subdir we own.
    let live = config_dir.join("portcode.db");
    let dir = config_dir.join("selfdev");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create selfdev dir: {e}"))?;
    let dest = dir.join("db-snapshot.db");

    // 3. Copy the (now-checkpointed) DB file.
    std::fs::copy(&live, &dest).map_err(|e| format!("could not copy database to snapshot: {e}"))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch dir for a test, holding a real DB so the snapshot has a
    /// `portcode.db` file to copy.
    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pc_selfdev_snap_{tag}_{}", crate::db::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn snapshot_produces_a_readable_copy() {
        let dir = scratch("readable");
        // Open a real DB AT the live path, write a row, then snapshot.
        let db = Db::open(&dir.join("portcode.db")).expect("open db");
        db.create_session("s1", "Snapshot me", None, None, crate::db::now_ms())
            .expect("seed row");

        let snap = snapshot_db_blocking(&db, &dir).expect("snapshot");
        assert!(snap.exists(), "snapshot file must exist");
        assert_eq!(snap, dir.join("selfdev").join("db-snapshot.db"));

        // The copy must be a working SQLite DB carrying the seeded row.
        let restored = Db::open(&snap).expect("open snapshot");
        let sessions = restored.list_sessions().expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "s1");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshot_creates_the_selfdev_dir_when_missing() {
        let dir = scratch("mkdir");
        let db = Db::open(&dir.join("portcode.db")).expect("open db");
        // `selfdev/` does not exist yet — the snapshot must create it.
        assert!(!dir.join("selfdev").exists());
        let snap = snapshot_db_blocking(&db, &dir).expect("snapshot");
        assert!(snap.exists());
        assert!(dir.join("selfdev").is_dir());
        std::fs::remove_dir_all(&dir).ok();
    }
}
