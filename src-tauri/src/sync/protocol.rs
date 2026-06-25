//! Phone Sync wire protocol — re-export shim.
//!
//! Phase 1 of `docs/IOS_WEB_CLIENT_PLAN.md` (§5.1) moved the wire types into the
//! shared `portcode-sync` crate. Re-exported here so every existing
//! `crate::sync::protocol::…` path keeps resolving to the SAME types.

pub use portcode_sync::protocol::{Cursor, RemoteCommand, SyncFrame};
