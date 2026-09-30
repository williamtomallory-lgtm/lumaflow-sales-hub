import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, ".local-runtime", "ollama-0.33.3");
const data = join(root, ".local-data");
const buildStatePath = join(data, "next-build-state.json");
const executable = join(runtime, "ollama.exe");
const baseUrl = "http://127.0.0.1:11434";
const LOCAL_MODELS = {
  "8b": {
    source: "qwen3:8b",
    model: "lumaflow-qwen3-8b:latest",
    modelfile: join(root, "agent", "Qwen3-8B.Modelfile"),
    weightEstimate: "约 5.2GB",
    description: "Qwen3-8B Q4_K_M",
  },
  "14b": {
    // Keep the official Ollama tag. This avoids making an additional alias
    // (and avoids a second copy of the base weights) for the larger model.
    source: "qwen3:14b",
    model: "qwen3:14b",
    modelfile: null,
    weightEstimate: "约 9GB",
    description: "官方 Ollama Qwen3:14b Q4_K_M",
  },
};
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

async function collectFiles(directory, output = []) {
  if (!(await exists(directory))) return output;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, output);
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function buildInputs() {
  const files = [];
  for (const directory of [join(root, "src"), join(root, "public")]) {
    await collectFiles(directory, files);
  }
  for (const name of ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "eslint.config.mjs"]) {
    const path = join(root, name);
    if (await exists(path)) files.push(path);
  }
  // NEXT_PUBLIC_* values are embedded during `next build`; include env file
  // bytes in the fingerprint without ever writing or printing their contents.
  for (const name of await readdir(root)) {
    if (name.startsWith(".env")) {
      const path = join(root, name);
      if ((await stat(path)).isFile()) files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function buildInputHashes() {
  const hashes = [];
  for (const path of await buildInputs()) {
    hashes.push({
      path: path.slice(root.length + 1).replaceAll("\\", "/"),
      sha256: await hashFile(path),
    });
  }
  return hashes;
}

function buildFingerprintFromHashes(hashes) {
  const digest = createHash("sha256");
  for (const input of hashes) {
    digest.update(input.path);
    digest.update("\0");
    digest.update(input.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function buildRequired(fingerprint) {
  if (!(await exists(join(root, ".next", "BUILD_ID")))) return true;
  try {
    const state = JSON.parse(await readFile(buildStatePath, "utf8"));
    return state.version !== 1 || state.fingerprint !== fingerprint || !Array.isArray(state.inputs);
  } catch {
    // A build produced before this marker was introduced is usable, but the
    // first launcher run rebuilds it so source changes can be detected later.
    return true;
  }
}

async function recordBuild(fingerprint, inputs) {
  await mkdir(dirname(buildStatePath), { recursive: true });
  const partial = `${buildStatePath}.${process.pid}.partial`;
  await writeFile(partial, JSON.stringify({ version: 1, fingerprint, builtAt: new Date().toISOString(), inputs }, null, 2));
  await rename(partial, buildStatePath);
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
  return (await response.json()).models?.some((entry) => entry.name === modelConfig.model) === true;
}

function parseModelSelection(args = process.argv.slice(3)) {
  let requested;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith("--model=")) requested = argument.slice("--model=".length);
    else if (argument === "--model") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--model requires 8b or 14b.");
      requested = value;
      index += 1;
    }
    else if (argument.startsWith("--port=")) parsePort(argument.slice("--port=".length));
    else if (argument === "--port") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--port requires a TCP port number.");
      parsePort(value);
      index += 1;
    }
    else if (argument === "--force-build") continue;
    else if (argument) throw new Error(`Unknown option: ${argument}`);
  }
  const modelKey = requested || "8b";
  if (!Object.hasOwn(LOCAL_MODELS, modelKey)) throw new Error("--model must be 8b or 14b.");
  if (modelKey === "14b") console.warn("Qwen3:14b is about 9GB and may exceed 8GB VRAM; Ollama will use CPU/GPU hybrid, which can be slow or exceed 16GB RAM.");
  return LOCAL_MODELS[modelKey];
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be an integer from 1024 to 65535.");
  return port;
}

function parseLaunchOptions(args = process.argv.slice(3)) {
  const model = parseModelSelection(args);
  let port = 3000;
  let forceBuild = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith("--port=")) port = parsePort(argument.slice("--port=".length));
    else if (argument === "--port") {
      port = parsePort(args[index + 1]);
      index += 1;
    }
    else if (argument === "--force-build") forceBuild = true;
  }
  return { model, port, forceBuild };
}

let modelConfig = LOCAL_MODELS["8b"];

async function setup() {
  modelConfig = parseModelSelection();
  await installRuntime();
  await ensureService();
  if (await hasModel()) { console.log(`${modelConfig.model} is already installed.`); return; }
  console.log(`Downloading ${modelConfig.description} (${modelConfig.weightEstimate}). Ollama verifies the model blobs.`);
  const response = await fetch(`${baseUrl}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: modelConfig.source, stream: true }) });
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
  if (modelConfig.modelfile) await run(executable, ["create", modelConfig.model, "-f", modelConfig.modelfile]);
  if (!(await hasModel())) throw new Error("Downloaded model was not advertised by Ollama.");
  console.log(`${modelConfig.model} installed. Next: npm run local:up -- --model=${modelConfig.model === "qwen3:14b" ? "14b" : "8b"}`);
}

async function up() {
  const options = parseLaunchOptions();
  modelConfig = options.model;
  await ensureService();
  if (!(await hasModel())) throw new Error(`${modelConfig.description} is missing. Run npm run local:setup -- --model=${modelConfig.model === "qwen3:14b" ? "14b" : "8b"} first.`);
  const next = join(root, "node_modules", "next", "dist", "bin", "next");
  const inputHashes = await buildInputHashes();
  const fingerprint = buildFingerprintFromHashes(inputHashes);
  if (options.forceBuild || await buildRequired(fingerprint)) {
    console.log("Building LumaFlow because this is the first start or source/dependency/environment inputs changed...");
    await run(process.execPath, [next, "build"], process.env);
    // Next rewrites generated files while building. Record the final inputs
    // so a successful first build is not perpetually treated as stale.
    const finalHashes = await buildInputHashes();
    await recordBuild(buildFingerprintFromHashes(finalHashes), finalHashes);
  } else {
    console.log("Reusing the existing Next.js production build; tracked inputs are unchanged.");
  }
  console.log(`Starting LumaFlow at http://127.0.0.1:${options.port}. Select ${modelConfig.description} in the assistant.`);
  await run(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(options.port)], process.env);
}

try {
  const action = process.argv[2];
  if (action === "setup") await setup();
  else if (action === "up") await up();
  else throw new Error("Usage: node scripts/local-model.mjs setup|up [--model=8b|14b] [--port=1024..65535]");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
