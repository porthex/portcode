// THROWAWAY Phase-0 iOS spike — glue between index.html and the wasm client.
//
// Loads the wasm-pack bundle (built into ./pkg by build.sh), wires the
// Connect/Send UI, and — critically for the iOS go/no-go test — implements the
// background -> resume RECONNECT path: on visibilitychange->visible, pageshow,
// and online, we treat the connection as DEAD and re-dial, because iOS suspends
// the JS context on background and silently drops the socket (plan §4.2 / §5.8).

import init, { EchoClient } from "./pkg/echo_web.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const stateEl = $("state");

function log(line, cls = "log-sys") {
  const div = document.createElement("div");
  div.className = "log-line " + cls;
  const t = new Date().toLocaleTimeString();
  div.textContent = `[${t}] ${line}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function setState(text, color) {
  stateEl.textContent = text;
  stateEl.style.background = color;
}

let client = null;
let connected = false;
let connecting = false;

// Last-used dial params, so resume can re-dial without re-typing.
function dialParams() {
  return {
    nodeId: $("nodeId").value.trim(),
    relayUrl: $("relayUrl").value.trim(),
  };
}

async function ensureClient() {
  if (client) return client;
  log("loading wasm…");
  await init(); // wasm-pack --target web: default-export init()
  client = new EchoClient();
  client.onStatus((line) => {
    const cls = /error|fail|bad|ended/i.test(line) ? "log-err" : "log-sys";
    log(line, cls);
  });
  client.onMessage((text) => {
    log("ECHO <- " + text, "log-rx");
  });
  log("wasm ready.");
  return client;
}

async function connect() {
  const { nodeId, relayUrl } = dialParams();
  if (!nodeId) {
    log("enter the desktop endpoint id first", "log-err");
    return;
  }
  if (connecting) return;
  connecting = true;
  setState("connecting", "#a60");
  $("connectBtn").disabled = true;
  try {
    const c = await ensureClient();
    await c.connect(nodeId, relayUrl);
    connected = true;
    setState("connected", "#2563eb");
    $("sendBtn").disabled = false;
    log("CONNECTED. send a message to test the echo.", "log-rx");
  } catch (e) {
    connected = false;
    setState("error", "#a33");
    log("connect failed: " + (e?.message || e), "log-err");
  } finally {
    connecting = false;
    $("connectBtn").disabled = false;
  }
}

function send() {
  if (!connected || !client) return;
  const text = $("msg").value;
  if (!text) return;
  log("SEND -> " + text);
  client.send(text);
}

// --- iOS lifecycle: background -> resume reconnect (the critical test) -------
//
// On iOS the JS VM is suspended on background; the relay WebSocket dies. There
// is NO reliable "still alive?" signal on resume, so we do NOT trust state —
// we proactively drop and re-dial. Each step is logged so the on-device tester
// can see the resume happen.

async function resumeReconnect(reason) {
  if (connecting) return;
  if (!$("nodeId").value.trim()) return; // never connected; nothing to resume
  log(`resume (${reason}): assuming connection is dead, re-dialing…`);
  setState("resuming", "#a60");
  $("sendBtn").disabled = true;
  if (client) {
    try {
      client.disconnect();
    } catch (_) {
      /* idempotent */
    }
  }
  connected = false;
  await connect();
}

function onHidden() {
  // Proactively close on background so the next resume always re-dials clean.
  if (client && connected) {
    log("background (hidden): closing channel.");
    try {
      client.disconnect();
    } catch (_) {}
    connected = false;
    $("sendBtn").disabled = true;
    setState("backgrounded", "#555");
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    resumeReconnect("visibilitychange->visible");
  } else {
    onHidden();
  }
});
// pageshow fires when iOS restores a frozen page from the back/forward cache.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) resumeReconnect("pageshow(persisted)");
});
// Network came back (e.g. after sleep): also a good moment to re-dial.
window.addEventListener("online", () => resumeReconnect("online"));

$("connectBtn").addEventListener("click", connect);
$("sendBtn").addEventListener("click", send);
$("msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});

setState("idle", "#444");
log("ready. paste the desktop endpoint id, then tap Connect.");
log("installed-PWA test: Share -> Add to Home Screen, then launch from the icon.");
