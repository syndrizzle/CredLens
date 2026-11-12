import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: bun tests/run-workspace-ui.ts /path/to/chromium-or-chrome");
const directory = await mkdtemp(join(tmpdir(), "credlens-workspace-ui-"));
const profile = join(directory, "profile");
let browser: ReturnType<typeof Bun.spawn> | undefined;
let socket: WebSocket | undefined;
try {
  const bundle = await Bun.build({ entrypoints: ["tests/workspace-ui.browser.tsx"], target: "browser", format: "iife", outdir: directory });
  if (!bundle.success) throw new Error(bundle.logs.join("\n"));
  const html = join(directory, "index.html");
  await Bun.write(html, '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="workspace-ui.browser.js"></script>');
  browser = Bun.spawn([executable, "--headless", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run", "--allow-file-access-from-files", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 15000;
  let port = "";
  while (!port) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!; } catch {
      if (Date.now() > deadline) throw new Error("Browser failed to start debugging endpoint");
      await Bun.sleep(100);
    }
  }
  const page = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then(response => response.json());
  socket = new WebSocket(page.webSocketDebuggerUrl);
  const replies = new Map<number, (value: any) => void>();
  let sequence = 0;
  socket.onmessage = event => {
    const reply = JSON.parse(String(event.data));
    replies.get(reply.id)?.(reply);
    replies.delete(reply.id);
  };
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
  function call(method: string, params: object) {
    return new Promise<any>(resolve => {
      const id = ++sequence;
      replies.set(id, resolve);
      socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  await call("Page.navigate", { url: pathToFileURL(html).href });
  let result;
  do {
    await Bun.sleep(100);
    result = await call("Runtime.evaluate", { expression: "document.querySelector('#result')?.textContent", returnByValue: true });
    if (Date.now() > deadline + 15000) throw new Error("Browser regression checks timed out");
  } while (!result.result?.result?.value);
  const output = result.result.result.value as string;
  console.log(output);
  if (!output.startsWith("PASS")) process.exitCode = 1;
} finally {
  socket?.close();
  if (browser) { browser.kill(); await browser.exited; }
  await rm(directory, { recursive: true, force: true });
}
