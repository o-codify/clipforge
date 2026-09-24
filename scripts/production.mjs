import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retainWebAssets } from './web-assets.mjs';

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
process.env.NODE_ENV = "production";
process.env.RUNTIME_INSTANCE = randomUUID();
process.env.WORKER_HEARTBEAT_FILE = "/tmp/clipforge/worker.json";
await mkdir("/tmp/clipforge", { recursive: true });
const children = new Map();
let stopping = false;
let monitor;
let killTimer;

function signalTree(child, signal) {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== "ESRCH") console.error(error.message); }
}

async function stop(code, reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(monitor);
  console.log(`Stopping ClipForge: ${reason}`);
  // Signal all process groups, including ffmpeg and the Python process.
  const running = [...children.keys()];
  const exited = running.map(child => new Promise(r => child.once("close", r)));
  killTimer = setTimeout(() => {
    for (const child of running) signalTree(child, "SIGKILL");
    process.exit(code);
  }, 40_000);
  for (const child of running) signalTree(child, "SIGTERM");
  await Promise.all(exited);
  // Descendants can outlive their parent, so clean the entire group as well.
  for (const child of running) signalTree(child, "SIGKILL");
  clearTimeout(killTimer);
  process.exit(code);
}

function run(name, args, cwd = process.cwd(), once = false) {
  const child = spawn(process.execPath, args, {
    cwd, env: process.env, stdio: "inherit", detached: process.platform !== "win32",
  });
  children.set(child, name);
  console.log(`Started ${name}, pid ${child.pid}`);
  return new Promise((resolveRun, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      children.delete(child);
      if (stopping) return;
      signalTree(child, "SIGKILL");
      if (once) code === 0 ? resolveRun() : reject(new Error(`${name} exited with ${code}`));
      else void stop(1, `${name} exited unexpectedly (${code})`);
    });
  });
}

process.on("SIGTERM", () => void stop(0, "deployment or shutdown"));
process.on("SIGINT", () => void stop(0, "interrupted"));
process.on("uncaughtException", error => void stop(1, error.message));
process.on("unhandledRejection", error => void stop(1, String(error)));

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  for (const dir of [process.env.DATA_ROOT, process.env.OUT_ROOT, process.env.MODELS_ROOT]) {
    if (!dir) throw new Error("DATA_ROOT, OUT_ROOT and MODELS_ROOT must use persistent storage");
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  }
  if (process.env.WORKER_ROLE !== "control") {
    await copyFile("models/face_detection_yunet_2023mar.onnx",
      resolve(process.env.MODELS_ROOT, "face_detection_yunet_2023mar.onnx"), constants.COPYFILE_EXCL)
      .catch(error => { if (error.code !== "EEXIST") throw error; });
  }
  await retainWebAssets(resolve('apps/web/.next/static'), resolve(process.env.DATA_ROOT,'web-assets'));
  await run("migrations", ["packages/db/dist/migrate.js"], process.cwd(), true);
  if (!stopping) {
    void run("api", ["apps/api/dist/main.js"]);
    void run("worker", ["apps/worker/dist/main.js"]);
    void run("web", [resolve("apps/web/node_modules/next/dist/bin/next"), "start", "-p", "3000", "-H", "0.0.0.0"], resolve("apps/web"));
    const start = Date.now();
    let failures = 0;
    let ready = false;
    let checking = false;
    monitor = setInterval(async () => {
      if (stopping || checking) return;
      checking = true;
      try {
        const response = await fetch("http://127.0.0.1:3000/api/health/ready", { signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error("Service not ready");
        if (!ready) console.log("ClipForge is ready");
        ready = true;
        failures = 0;
      } catch {
        // Docker does not restart unhealthy containers by itself. Exit the
        // supervised unit so restart: unless-stopped can recover it.
        if ((ready || Date.now() - start > 120_000) && ++failures >= 3) void stop(1, "readiness checks failed");
      } finally { checking = false; }
    }, 10_000);
  }
} catch (error) { await stop(1, error.message); }
