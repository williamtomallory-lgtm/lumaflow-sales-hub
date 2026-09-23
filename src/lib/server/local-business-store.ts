import "server-only";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { customerSchema, followupTaskSchema, productSchema } from "../contracts/api";

const schema = z.object({
  products: z.array(productSchema).default([]),
  customers: z.array(customerSchema).default([]),
  followups: z.array(followupTaskSchema).default([]),
});
export type LocalBusinessData = z.infer<typeof schema>;
function directory() { return path.resolve(/* turbopackIgnore: true */ process.env.LUMAFLOW_BUSINESS_DIR || path.join(process.cwd(), ".local-data", "business")); }

export async function readLocalBusinessData(): Promise<LocalBusinessData> {
  try { return schema.parse(JSON.parse(await readFile(path.join(directory(), "records.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { products: [], customers: [], followups: [] }; throw error; }
}

/** Atomic, cross-process serialized writes for user-created runtime records. */
export async function mutateLocalBusinessData<T>(operation: (data: LocalBusinessData) => T): Promise<T> {
  const root = directory();
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, "write.lock");
  let lock;
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await open(lockPath, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const temporary = path.join(root, `${randomUUID()}.tmp`);
  try {
    const data = await readLocalBusinessData();
    const result = operation(data);
    await writeFile(temporary, JSON.stringify(schema.parse(data), null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(root, "records.json"));
    return result;
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
