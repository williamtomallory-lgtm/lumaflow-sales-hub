import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(frontend, "..");
const configPath = path.join(root, ".local-data", "agent-bridge.json");
await mkdir(path.dirname(configPath), { recursive: true });
let token;
try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(config.knowledgeToken ?? "")) throw new Error("Existing bridge credentials are invalid; refusing to replace them silently.");
  token = config.knowledgeToken;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  token = randomBytes(32).toString("hex");
  await writeFile(configPath, JSON.stringify({ version: 1, knowledgeToken: token,
    knowledgeUrl: "http://127.0.0.1:3000/api/v1/knowledge/agent-library" }, null, 2), { flag: "wx", mode: 0o600 });
}
const envPath = path.join(frontend, ".env.local");
let content = "";
try { content = await readFile(envPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const replacement = `LUMAFLOW_KNOWLEDGE_TOKEN=${token}`;
content = /^LUMAFLOW_KNOWLEDGE_TOKEN=.*$/m.test(content)
  ? content.replace(/^LUMAFLOW_KNOWLEDGE_TOKEN=.*$/m, replacement) : `${content.trimEnd()}\n${replacement}\n`;
await writeFile(envPath, content, { mode: 0o600 });
console.log("Website knowledge bridge configured. Private token stays on this computer. Restart frontend and CowAgent to load it.");
