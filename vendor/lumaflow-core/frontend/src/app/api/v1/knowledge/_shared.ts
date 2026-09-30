import { ApiHttpError, apiError, authorizeLocalKnowledgeRead } from "@/lib/server/api-security";
import { KnowledgeStoreError } from "@/lib/knowledge/store";

export function knowledgeError(error: unknown, requestId: string) {
  if (error instanceof KnowledgeStoreError) {
    return apiError(new ApiHttpError(error.status, error.code, error.message), requestId);
  }
  return apiError(error, requestId);
}

export const authorizeKnowledgeRead = authorizeLocalKnowledgeRead;
