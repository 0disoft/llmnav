import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

// Evaluation-only transport. No SDK or runtime dependency is added to llmnav.
export async function stopProcessTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await once(killer, "close");
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

export function createMcpClient(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env,
    shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0, diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
  const lines = readline.createInterface({ input: child.stdout });
  function fail(error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", code => fail(new Error(`MCP process closed (${code}): ${diagnostics}`)));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return {
    child,
    request(method, params = {}, timeoutMs = 180000) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async initialize() {
      const result = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "llmnav-evaluation", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return result;
    },
    async close() {
      fail(new Error("MCP evaluation closed"));
      // Kill the owned tree while its parent still exists; this also owns LSP children.
      await stopProcessTree(child);
      lines.close();
    },
  };
}

export const SERENA_VERSION = "2.1.0";
export function serenaArguments(root) {
  return ["--no-python-downloads", "--python", "3.11", "--from", `serena-agent==${SERENA_VERSION}`, "serena",
    "start-mcp-server", "--project", root, "--context", "ide-assistant", "--agent-interface", "tools",
    "--enable-web-dashboard", "false", "--open-web-dashboard", "false", "--enable-gui-log-window", "false",
    "--log-level", "WARNING", "--tool-timeout", "90"];
}

export function toolText(result) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return (result.content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
}
