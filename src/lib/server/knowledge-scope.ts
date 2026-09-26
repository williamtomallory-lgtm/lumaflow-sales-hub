import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const knowledgeOwner = new AsyncLocalStorage<string>();

export function setKnowledgeOwner(subject: string) {
  // The hash avoids putting an email address or identity-provider subject in a blob path.
  knowledgeOwner.enterWith(createHash("sha256").update(subject).digest("hex").slice(0, 32));
}

export function getKnowledgeOwner() {
  const owner = knowledgeOwner.getStore();
  if (!owner) throw new Error("Private knowledge owner is missing from this request.");
  return owner;
}
