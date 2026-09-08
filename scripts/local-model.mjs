import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, ".local-runtime", "ollama-0.33.3");
const data = join(root, ".local-data");
const executable = join(runtime, "ollama.exe");
const baseUrl = "http://127.0.0.1:11434";
const model = "lumaflow-qwen3-8b:latest";
const archiveUrl = "https://github.com/ollama/ollama/releases/download/v0.33.3/ollama-windows-amd64.zip";
const archiveHash = "52cb36a62e7e501f61514f60212dec7117b6c098811357585e02fffe32d2fcd7";
const runtimeEnv = {
  ...process.env,
  OLLAMA_HOST: "127.0.0.1:11434",
  OLLAMA_MODELS: join(data, "models"),
  OLLAMA_NO_CLOUD: "true",
  OLLAMA_NUM_PARALLEL: "1",
  OLLAMA_MAX_LOADED_MODELS: "1",
  OLLAMA_CONTEXT_LENGTH: "8192",
  OLLAMA_FLASH_ATTENTION: "1",
  OLLAMA_KV_CACHE_TYPE: "q8_0",
  OLLAMA_KEEP_ALIVE: "5m",
};

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function run(command, args, env = runtimeEnv) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function installRuntime() {
  if (process.platform !== "win32") throw new Error("This portable installer is for Windows. Install Ollama for your OS and use the documented model profile.");
  if (await exists(executable)) return;
  await mkdir(runtime, { recursive: true });
  const archive = join(root, ".local-runtime", "ollama-windows-amd64-0.33.3.zip");
  if (!(await exists(archive)) || await hashFile(archive) !== archiveHash) {
    console.log("Downloading official Ollama 0.33.3 (~1.47 GB) to the project drive...");
    const response = await fetch(archiveUrl);
    if (!response.ok || !response.body) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length"));
    let received = 0;
    let lastProgress = 0;
    const progress = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (Date.now() - lastProgress > 5_000) {
        console.log(`Ollama download: ${(received / 1e6).toFixed(0)} MB${total ? ` / ${(total / 1e6).toFixed(0)} MB` : ""}`);
        lastProgress = Date.now();
      }
      callback(null, chunk);
    } });
    const partial = `${archive}.partial`;
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial));
    if (await hashFile(partial) !== archiveHash) throw new Error("Ollama archive SHA-256 mismatch; refusing to extract or execute it.");
    await rename(partial, archive);
  }
  console.log("Official archive SHA-256 verified. Extracting portable runtime...");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(runtime)} -Force`]);
  if (!(await exists(executable))) throw new Error("Ollama executable was not found after extraction.");
}

async function isOllamaReady() {
  try {
    const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1_500) });
    return response.ok && typeof (await response.json()).version === "string";
  } catch { return false; }
}

async function ensureService() {
  if (await isOllamaReady()) {
    console.log("Using the existing local Ollama service; its storage/settings are unchanged.");
    return;
  }
  if (!(await exists(executable))) throw new Error("Portable Ollama is not installed. Run npm run local:setup first.");
  await mkdir(join(data, "logs"), { recursive: true });
  const log = await open(join(data, "logs", "ollama.log"), "a");
  const child = spawn(executable, ["serve"], { cwd: root, env: runtimeEnv, detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
  let launchError;
  child.once("error", (error) => { launchError = error; });
  child.unref();
  await log.close();
  for (let count = 0; count < 40; count++) {
    if (launchError) throw launchError;
    if (await isOllamaReady()) { console.log("Local Ollama ready (loopback only, cloud disabled, one model/request at a time)."); return; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Ollama did not become ready. Inspect ${join(data, "logs", "ollama.log")}`);
}

async function hasModel() {
  const response = await fetch(`${baseUrl}/api/tags`);
  if (!response.ok) throw new Error(`Cannot list local models: ${response.status}`);
  return (await response.json()).models?.some((entry) => entry.name === model) === true;
}

async function setup() {
  await installRuntime();
  await ensureService();
  if (await hasModel()) { console.log(`${model} is already installed.`); return; }
  console.log("Downloading Qwen3-8B Q4_K_M (~5.2 GB). Ollama verifies the model blobs.");
  const response = await fetch(`${baseUrl}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3:8b", stream: true }) });
  if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
  let pending = "";
  let last = 0;
  let complete = false;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const progress = JSON.parse(line);
      if (progress.error) throw new Error(progress.error);
      if (Date.now() - last > 5_000 || !progress.total) {
        console.log(`${progress.status}${progress.total ? ` ${Math.round(100 * (progress.completed ?? 0) / progress.total)}%` : ""}`);
        last = Date.now();
      }
      if (progress.status === "success") complete = true;
    }
  }
  if (!complete) throw new Error("Model download ended without a success acknowledgement. Rerun local:setup to resume.");
  await run(executable, ["create", model, "-f", join(root, "agent", "Qwen3-8B.Modelfile")]);
  if (!(await hasModel())) throw new Error("Created model was not advertised by Ollama.");
  console.log(`${model} installed. Next: npm run local:up`);
}

async function up() {
  await ensureService();
  if (!(await hasModel())) throw new Error("Qwen3-8B demo model is missing. Run npm run local:setup first.");
  const next = join(root, "node_modules", "next", "dist", "bin", "next");
  if (!(await exists(join(root, ".next", "BUILD_ID")))) await run(process.execPath, [next, "build"], process.env);
  console.log("Starting LumaFlow at http://localhost:3000. Select Qwen3-8B in the sales assistant.");
  await run(process.execPath, [next, "start", "--hostname", "127.0.0.1"], process.env);
}

try {
  const action = process.argv[2];
  if (action === "setup") await setup();
  else if (action === "up") await up();
  else throw new Error("Usage: node scripts/local-model.mjs setup|up");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
