"use client";

import { useCallback, useEffect, useState } from "react";
import { assistantHealthResponseSchema, type AssistantHealthResponse, type AssistantModelProfileId } from "@/lib/contracts/api";

export function useModelHealth(modelProfileId: AssistantModelProfileId) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    profileId: AssistantModelProfileId;
    revision: number;
    response?: AssistantHealthResponse;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    async function loadHealth() {
      try {
        const response = await fetch(`/api/v1/assistant/health?modelProfileId=${encodeURIComponent(modelProfileId)}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(`Model health returned ${response.status}`);
        const parsed = assistantHealthResponseSchema.parse(payload);
        if (!controller.signal.aborted) setResult({ profileId: modelProfileId, revision, response: parsed });
      } catch {
        if (!controller.signal.aborted) setResult({ profileId: modelProfileId, revision });
      }
    }
    void loadHealth();
    return () => controller.abort();
  }, [modelProfileId, revision]);

  const current = result?.profileId === modelProfileId && result.revision === revision;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { health: current ? result.response?.data : undefined, checking: !current, refresh };
}
