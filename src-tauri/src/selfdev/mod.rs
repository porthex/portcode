//! Self-dev Phase-2 promotion supervisor (the automated GATE + UX + apply-restart).
//!
//! Portcode can be built while it runs it, dogfood-style (see `docs/SELF_DEV.md`).
//! "Promotion" is the act of moving the working tree into the running dev build:
//!
//! ```text
//! Idle → Snapshotting → Testing{Frontend} → Testing{Rust} → Done → Applying
//!                                                           ↘ Failed{step,msg}
//! ```
//!
//! 1. **Snapshot** the SQLite DB (a recoverable point if a change misbehaves).
//! 2. **Gate** the change behind the test suites: `pnpm test` then
//!    `cargo test --workspace` (SLICE 1).
//! 3. **Apply** — on a green gate, a user-confirmed `promote_apply` restarts the
//!    dev build so the change takes effect (SLICE 2).
//!
//! The restart can't happen in-process — `tauri dev` compiles the Rust binary once
//! at startup and `app.restart()` would relaunch the SAME binary. So `promote_apply`
//! exits with [`promote::RESTART_EXIT_CODE`] and an external restart-loop wrapper
//! (`scripts/dev-self-loop.mjs`, run via `pnpm app:dev:self:loop`) relaunches
//! `tauri dev`, which recompiles. Safety lives in the GATE that runs first; rollback
//! is a `git revert` + another apply.
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
