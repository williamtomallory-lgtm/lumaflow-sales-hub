"use client";

import { useCallback, useEffect, useState } from "react";
import { assistantHealthResponseSchema, type AssistantHealthResponse } from "@/lib/contracts/api";

export function useModelHealth() {
  const [response, setResponse] = useState<AssistantHealthResponse>();
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const result = await fetch("/api/v1/assistant/health", { cache: "no-store", headers: { Accept: "application/json" } });
      const payload: unknown = await result.json();
      if (!result.ok) throw new Error(`Model health returned ${result.status}`);
      setResponse(assistantHealthResponseSchema.parse(payload));
    } catch {
      setResponse(undefined);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function loadInitialHealth() {
      try {
        const result = await fetch("/api/v1/assistant/health", { cache: "no-store", headers: { Accept: "application/json" } });
        const payload: unknown = await result.json();
        if (!result.ok) throw new Error(`Model health returned ${result.status}`);
        if (active) setResponse(assistantHealthResponseSchema.parse(payload));
      } catch {
        if (active) setResponse(undefined);
      } finally {
        if (active) setChecking(false);
      }
    }
    void loadInitialHealth();
    return () => { active = false; };
  }, []);

  return { health: response?.data, checking, refresh };
}
