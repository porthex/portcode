#!/usr/bin/env node
// Self-dev restart loop (Phase 2, Slice 2).
//
// Runs the "Portcode Dev" build and relaunches it whenever the app exits with
// RESTART_EXIT_CODE — which recompiles, applying a Rust change the in-app
// promotion gate just approved. Any other exit code stops the loop.
//
// Why a wrapper at all? `tauri dev` compiles the Rust binary once at startup, and
// `app.restart()` would relaunch the SAME compiled binary — so the running app
// cannot recompile itself. Exiting and having an external supervisor relaunch
// `tauri dev` is what actually picks up Rust changes. The app signals "relaunch
// me" by exiting with RESTART_EXIT_CODE (see `promote_apply` in
// src-tauri/src/selfdev/promote.rs); this script is that supervisor.
//
// We pass `--no-watch` so the tauri CLI's own Rust file-watcher is OFF: changes
// apply ONLY through the gated promote → apply → restart path, never on every
// save. Vite still hot-reloads the frontend (it is the beforeDevCommand, run
// inside `tauri dev`, independent of this).
//
// RESTART_EXIT_CODE here MUST match `RESTART_EXIT_CODE` in
// src-tauri/src/selfdev/promote.rs.

import { spawn } from "node:child_process";

const RESTART_EXIT_CODE = 86;
// Crash-loop backstop. Each apply is user-initiated (needs a green gate + a click),
// so a tight loop is unlikely — but a child that exits 86 almost immediately, over
// and over, is treated as a loop and stops the supervisor.
const MAX_RESTARTS = 50;
// A child that ran at least this long before exiting was a real working session,
// not a crash loop, so the counter resets — keeping MAX_RESTARTS a guard against
// rapid failures rather than a per-session lifetime cap.
const HEALTHY_RUN_MS = 30_000;

// `--features self-dev` compiles in the promotion supervisor (the `promote_*`
// commands + PromoteState); without it the in-app gate would invoke commands the
// binary doesn't contain. `--no-watch` turns off the tauri CLI's own Rust
// file-watcher so changes apply ONLY through the gated promote → apply → restart
// path, never on every save (Vite still hot-reloads the frontend).
const TAURI_ARGS = [
  "tauri",
  "dev",
  "--config",
  "src-tauri/tauri.dev.conf.json",
  "--no-watch",
  "--features",
  "self-dev",
];

let child = null;
let restarts = 0;
let startedAt = 0;

function launch() {
  startedAt = Date.now();
  child = spawn("pnpm", TAURI_ARGS, {
    stdio: "inherit",
    shell: true, // resolve the `pnpm` shim (e.g. pnpm.cmd on Windows)
    env: { ...process.env, PORTCODE_SELFDEV_RESTART_LOOP: "1" },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`\n[self-dev loop] dev build terminated by signal ${signal}; stopping.`);
      process.exit(1);
    }
    if (code === RESTART_EXIT_CODE) {
      // A long, healthy session before this apply is not a crash loop — reset.
      if (Date.now() - startedAt > HEALTHY_RUN_MS) restarts = 0;
      restarts += 1;
      if (restarts > MAX_RESTARTS) {
        console.error(
          `\n[self-dev loop] hit ${MAX_RESTARTS} rapid restarts; stopping to avoid a loop.`,
        );
        process.exit(1);
      }
      console.log(
        `\n[self-dev loop] ↻ apply requested (exit ${RESTART_EXIT_CODE}) — relaunching` +
          ` (restart #${restarts}; this recompiles)…`,
      );
      launch();
      return;
    }
    console.log(`\n[self-dev loop] dev build exited with code ${code ?? 0}; stopping.`);
    process.exit(code ?? 0);
  });
}

// Forward Ctrl+C / termination to the current child, then let its exit handler stop
// the loop. On Windows, `child.kill()` only ends the `pnpm` shell and can orphan its
// `tauri`/`cargo` grandchildren, so kill the whole tree by PID. Registered once (not
// per-launch) to avoid piling up listeners.
function stopChild() {
  if (!child) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}
process.on("SIGINT", stopChild);
process.on("SIGTERM", stopChild);

console.log("[self-dev loop] starting Portcode Dev with apply-on-restart enabled…");
launch();
