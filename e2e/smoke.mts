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

type CdpResponse = {
  id?: number;
  error?: { message: string };
  result?: { result?: { value?: RenderState } };
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
    try {
      process.kill(appPid);
    } catch {
      // The app already exited.
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
  const escapedApplication = application.replaceAll("'", "''");
  const command =
    `$app = Start-Process -FilePath '${escapedApplication}' -PassThru -WindowStyle Normal; ` +
    `[Console]::Out.WriteLine($app.Id); Wait-Process -Id $app.Id`;
  appProcess = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  appProcess.stderr?.on("data", capture);
  appPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out while launching Portcode.")),
      10000,
    );
    appProcess?.stdout?.once("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      const pid = Number.parseInt(chunk.toString().trim(), 10);
      if (Number.isFinite(pid)) resolve(pid);
      else reject(new Error(`Invalid Portcode process id: ${chunk.toString()}`));
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
  const deadline = Date.now() + 30000;
  let state: RenderState | undefined;
  while (Date.now() < deadline) {
    const response = await send("Runtime.evaluate", {
      expression: `(() => {
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
      })()`,
      returnByValue: true,
    });
    state = response.result?.result?.value;
    if (
      state?.title === "Portcode" &&
      state.rootChildren > 0 &&
      state.shellVisible &&
      state.headerVisible
    ) {
      return state;
    }
    await delay(250);
  }
  throw new Error(`React shell did not become ready: ${JSON.stringify(state)}`);
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
    console.log(`E2E smoke passed: ${JSON.stringify(state)}`);
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
