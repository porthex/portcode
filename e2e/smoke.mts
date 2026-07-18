import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

type DevToolsTarget = {
  type: string;
  webSocketDebuggerUrl?: string;
};

type RenderState = {
  title: string;
  rootChildren: number;
  shellVisible: boolean;
  headerVisible: boolean;
};

type JourneyState = {
  settingsOpened: boolean;
  modelMenuOpened: boolean;
  settingsClosed: boolean;
  composerAcceptedDraft: boolean;
  fatalFallbackVisible: boolean;
};

type CdpResponse = {
  id?: number;
  error?: { message: string };
  result?: { result?: { value?: unknown } };
};

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const application = path.join(projectRoot, "src-tauri", "target", "debug", "portcode.exe");
const logs: string[] = [];
let appProcess: ChildProcess | undefined;
let appPid: number | undefined;

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const ensurePortAvailable = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`DevTools port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

const capture = (chunk: Buffer) => {
  logs.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
  if (logs.length > 100) logs.splice(0, logs.length - 100);
};

const stopApp = async () => {
  const child = appProcess;
  appProcess = undefined;
  if (appPid !== undefined) {
    const stopped = spawnSync("taskkill.exe", ["/PID", String(appPid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (stopped.status !== 0) {
      try {
        process.kill(appPid);
      } catch {
        // The app already exited.
      }
    }
    appPid = undefined;
  }
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(10000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

const startApp = async () => {
  appProcess = spawn(application, [], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  appProcess.stdout?.on("data", capture);
  appProcess.stderr?.on("data", capture);
  appPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out while launching Portcode.")),
      30000,
    );
    appProcess?.once("spawn", () => {
      clearTimeout(timeout);
      const pid = appProcess?.pid;
      if (pid !== undefined) resolve(pid);
      else reject(new Error("Portcode started without a process id."));
    });
    appProcess?.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
};

const waitForTarget = async (port: number) => {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (appProcess?.exitCode !== null) {
      throw new Error(`Portcode exited before its UI became ready (code ${appProcess?.exitCode}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      const targets = (await response.json()) as DevToolsTarget[];
      const target = targets.find(
        (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      // WebView2 is still starting.
    }
    await delay(500);
  }
  throw new Error("Portcode did not expose its WebView2 page within 120 seconds.");
};

const connect = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not connect to the WebView2 debugger.")),
      { once: true },
    );
  });

const inspectUi = async (socket: WebSocket) => {
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }
  >();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpResponse;
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message);
  });

  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++sequence;
    return new Promise<CdpResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`DevTools command ${method} timed out.`));
      }, 10000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  await send("Runtime.enable");
  const evaluate = async <T,>(expression: string): Promise<T | undefined> => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true });
    return response.result?.result?.value as T | undefined;
  };

  const waitForValue = async <T,>(
    label: string,
    expression: string,
    accept: (value: T | undefined) => boolean,
    timeoutMs = 10000,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let value: T | undefined;
    while (Date.now() < deadline) {
      value = await evaluate<T>(expression);
      if (accept(value)) return value as T;
      await delay(100);
    }
    throw new Error(`${label} did not become ready: ${JSON.stringify(value)}`);
  };

  const deadline = Date.now() + 30000;
  let state: RenderState | undefined;
  while (Date.now() < deadline) {
    state = await evaluate<RenderState>(`(() => {
        const root = document.querySelector('#root');
        const shell = document.querySelector('#root > div');
        const header = document.querySelector('header');
        const visible = (element) => !!element && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
        return {
          title: document.title,
          rootChildren: root?.children.length ?? 0,
          shellVisible: visible(shell),
          headerVisible: visible(header),
        };
      })()`);
    if (
      state?.title === "Portcode" &&
      state.rootChildren > 0 &&
      state.shellVisible &&
      state.headerVisible
    ) {
      break;
    }
    await delay(250);
  }
  if (!state?.shellVisible || !state.headerVisible) {
    throw new Error(`React shell did not become ready: ${JSON.stringify(state)}`);
  }

  // Exercise the real WebView journey that previously escaped the smoke gate:
  // Settings render isolation, the Portcode-native model listbox, and React's
  // controlled composer. No prompt is submitted and no provider call is made.
  const settingsButtonClicked = await evaluate<boolean>(`(() => {
    const button = document.querySelector('button[aria-label="Settings"], button[title="Settings"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (!settingsButtonClicked) throw new Error("Could not find the Settings button.");

  const settingsOpened = await waitForValue<boolean>(
    "Settings dialog",
    `!!document.querySelector('[role="dialog"][aria-labelledby="pc-settings-title"]')`,
    Boolean,
  );

  const modelClicked = await evaluate<boolean>(`(() => {
    const model = document.querySelector('#pc-settings-claude-model[role="combobox"]');
    if (!(model instanceof HTMLButtonElement)) return false;
    model.click();
    return true;
  })()`);
  if (!modelClicked) throw new Error("Could not find the themed model picker.");
  const modelMenuOpened = await waitForValue<boolean>(
    "Model listbox",
    `(() => {
      const list = document.querySelector('#pc-settings-claude-model-listbox[role="listbox"]');
      return !!list && list.querySelectorAll('[role="option"]').length >= 2;
    })()`,
    Boolean,
  );

  await evaluate(`document.querySelector('#pc-settings-claude-model[role="combobox"]')?.click()`);
  await evaluate(`document.querySelector('button[aria-label="Close settings"]')?.click()`);
  const settingsClosed = await waitForValue<boolean>(
    "Settings close",
    `!document.querySelector('[role="dialog"][aria-labelledby="pc-settings-title"]')`,
    Boolean,
  );

  await waitForValue<boolean>(
    "Composer readiness",
    `(() => {
      const composer = document.querySelector('textarea[aria-label="Message Portcode"]');
      return composer instanceof HTMLTextAreaElement && !composer.disabled;
    })()`,
    Boolean,
    30000,
  );
  const composerFocused = await evaluate<boolean>(`(() => {
      const composer = document.querySelector('textarea[aria-label="Message Portcode"]');
      if (!(composer instanceof HTMLTextAreaElement)) return false;
      composer.focus();
      composer.select();
      return true;
    })()`);
  if (!composerFocused) throw new Error("Could not find the controlled composer.");
  await send("Input.insertText", { text: "Portcode E2E draft — never sent" });
  const composerAcceptedDraft = await waitForValue<boolean>(
    "Composer draft",
    `document.querySelector('textarea[aria-label="Message Portcode"]')?.value === 'Portcode E2E draft — never sent'`,
    Boolean,
  );
  await evaluate(`(() => {
      const composer = document.querySelector('textarea[aria-label="Message Portcode"]');
      if (!(composer instanceof HTMLTextAreaElement)) return false;
      composer.focus();
      composer.select();
      return true;
    })()`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await waitForValue<boolean>(
    "Composer clear",
    `document.querySelector('textarea[aria-label="Message Portcode"]')?.value === ''`,
    Boolean,
  );

  const fatalFallbackVisible = Boolean(
    await evaluate<boolean>(`(() => {
      const text = document.body.textContent ?? '';
      return text.includes('Something went wrong') || !!document.querySelector('[role="alertdialog"]');
    })()`),
  );
  if (fatalFallbackVisible) throw new Error("A fatal or Settings recovery fallback appeared.");

  return {
    ...state,
    settingsOpened,
    modelMenuOpened,
    settingsClosed,
    composerAcceptedDraft,
    fatalFallbackVisible,
  } satisfies RenderState & JourneyState;
};

const main = async () => {
  if (process.platform !== "win32") {
    throw new Error("The desktop smoke test currently supports Windows only.");
  }
  if (!process.env.PORTCODE_E2E_SKIP_BUILD) {
    const pnpmCli = process.env.npm_execpath;
    if (!pnpmCli) throw new Error("pnpm did not provide npm_execpath.");
    const build = spawnSync(
      process.execPath,
      [
        pnpmCli,
        "tauri",
        "build",
        "--config",
        "src-tauri/tauri.e2e.conf.json",
        "--debug",
        "--no-bundle",
      ],
      { cwd: projectRoot, stdio: "inherit" },
    );
    if (build.status !== 0) {
      throw new Error(`Debug app build failed (exit ${build.status ?? "unknown"}).`);
    }
  }

  const port = 9222;
  await ensurePortAvailable(port);
  await startApp();

  const targetUrl = await waitForTarget(port);
  const socket = await connect(targetUrl);
  try {
    const state = await inspectUi(socket);
    console.log(`E2E desktop journey passed: ${JSON.stringify(state)}`);
  } finally {
    socket.close();
  }
};

try {
  await main();
} catch (error) {
  if (logs.length) console.error(`Portcode output:\n${logs.join("\n")}`);
  throw error;
} finally {
  await stopApp();
}
