#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEVTOOLS_URL = process.env.PORTCODE_QA_DEVTOOLS_URL ?? "http://127.0.0.1:9222";

async function target() {
  const response = await fetch(`${DEVTOOLS_URL}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`DevTools target list failed: HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find(
    (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl,
  );
  if (!page) throw new Error("No debuggable Portcode WebView2 page was found.");
  return page;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not connect to WebView2 CDP.")),
      {
        once: true,
      },
    );
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => {
    const id = ++sequence;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  return { socket, send };
}

async function evaluate(send, expression) {
  await send("Runtime.enable");
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`WebView evaluation failed: ${detail}`);
  }
  return result.result?.value;
}

function usage() {
  throw new Error(
    "Usage: webview-cdp.mjs info | eval --file <script.js> | screenshot --output <image.png> | reload",
  );
}

async function main() {
  const command = process.argv[2];
  if (!command) usage();
  const page = await target();
  const { socket, send } = await connect(page.webSocketDebuggerUrl);
  try {
    if (command === "info") {
      const state = await evaluate(
        send,
        `({ title: document.title, url: location.href, readyState: document.readyState, rootChildren: document.querySelector('#root')?.childElementCount ?? 0 })`,
      );
      console.log(JSON.stringify({ target: { title: page.title, url: page.url }, state }, null, 2));
      return;
    }
    if (command === "eval") {
      if (process.argv[3] !== "--file" || !process.argv[4]) usage();
      const scriptPath = resolve(process.argv[4]);
      const value = await evaluate(send, await readFile(scriptPath, "utf8"));
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    if (command === "screenshot") {
      if (process.argv[3] !== "--output" || !process.argv[4]) usage();
      const output = resolve(process.argv[4]);
      await send("Page.enable");
      const capture = await send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, Buffer.from(capture.data, "base64"));
      console.log(output);
      return;
    }
    if (command === "reload") {
      await send("Page.enable");
      await send("Page.reload", { ignoreCache: true });
      console.log("reload requested");
      return;
    }
    usage();
  } finally {
    socket.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
