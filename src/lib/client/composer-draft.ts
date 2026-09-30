import type { FileUIPart } from "ai";
import type { CollaborationMode } from "@/lib/contracts/agent-progress";

export type ComposerDraft = {
  text: string;
  images: FileUIPart[];
  imageOperationMode?: boolean;
  documentIds: string[];
  customerId: string;
  agentId?: string;
  collaboratorIds: string[];
  collaborationMode?: CollaborationMode;
  capabilityIds: string[];
  workflowMode: "normal" | "goal" | "plan";
  goal: string;
};

export function composerDraftKey(experience: "chat" | "work", projectId?: string | null, chatId?: string | null) {
  return `lumaflow.composer.v1:${projectId || "global"}:${experience}:${chatId || "new"}`;
}

// Drafts belong to this browser tab. Neither unsent text nor image data is sent
// to history/the model until the user submits it.
export function readComposerDraft(key: string): ComposerDraft | null {
  try {
    if (typeof window === "undefined") return null;
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!value || typeof value.text !== "string" || !Array.isArray(value.images)) return null;
    const images = value.images.filter((image: unknown): image is FileUIPart => {
      if (!image || typeof image !== "object") return false;
      const item = image as Record<string, unknown>;
      return item.type === "file" && typeof item.mediaType === "string" && typeof item.url === "string";
    }).map((image: FileUIPart) => ({
      ...image,
      ...(typeof image.filename === "string" && image.filename.trim() ? { filename: image.filename.slice(0, 160) } : {}),
    }));
    const strings = (candidate: unknown): string[] => Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === "string") : [];
    const collaborationMode = value.collaborationMode === "parallel" || value.collaborationMode === "sequential" || value.collaborationMode === "debate"
      ? value.collaborationMode
      : undefined;
    const workflowMode = value.workflowMode === "goal" || value.workflowMode === "plan" ? value.workflowMode : "normal";
    return {
      text: value.text,
      images,
      imageOperationMode: value.imageOperationMode === true ? true : value.imageOperationMode === false ? false : undefined,
      documentIds: strings(value.documentIds),
      customerId: typeof value.customerId === "string" ? value.customerId : "",
      agentId: typeof value.agentId === "string" ? value.agentId : undefined,
      collaboratorIds: strings(value.collaboratorIds),
      collaborationMode,
      capabilityIds: strings(value.capabilityIds),
      workflowMode,
      goal: typeof value.goal === "string" ? value.goal.slice(0, 500) : "",
    };
  } catch { return null; }
}

export function writeComposerDraft(key: string, draft: ComposerDraft) {
  try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* A full/disabled tab store must not discard the live composer. */ }
}

export function removeComposerDraft(key: string) {
  try { sessionStorage.removeItem(key); } catch { /* optional tab storage */ }
}
