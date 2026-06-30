//! Self-dev Phase-2 promotion supervisor (SLICE 1: the automated GATE + UX).
//!
//! Portcode can be built while it runs it, dogfood-style (see `docs/SELF_DEV.md`).
//! "Promotion" is the act of moving the working tree into the running dev build.
//! This module owns the SAFE FRONT HALF of that pipeline:
//!
//! ```text
//! Idle → Snapshotting → Testing{Frontend} → Testing{Rust} → Done | Failed{step,msg}
//! ```
//!
//! 1. **Snapshot** the SQLite DB (a recoverable point if a later swap goes wrong).
//! 2. **Gate** the change behind the test suites: `pnpm test` then
//!    `cargo test --workspace`.
//!
//! On green, a future SLICE 2 would restart the dev build onto the new binary.
//! That restart — and any process/binary swap — is explicitly NOT built here:
//! Slice 1 stops once the gate has run and reports pass/fail. No process is
//! touched.
//!
//! The WHOLE module is compiled only under `cfg(all(desktop, feature =
//! "self-dev"))`, so a production build (no `--features self-dev`) contains zero
//! self-dev code. `lib.rs` gates its `mod selfdev;`, its `PromoteState`, and the
//! three commands the same way.

#![cfg(all(desktop, feature = "self-dev"))]

pub mod health;
pub mod promote;
pub mod snapshot;

// `lib.rs` manages `selfdev::PromoteState` and registers the commands at their
// real `selfdev::promote::*` paths (so `generate_handler!` can reach each
// command's macro-generated `__cmd__*` items, which a re-export would not carry).
pub use promote::PromoteState;
