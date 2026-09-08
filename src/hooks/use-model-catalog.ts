"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  assistantModelProfileIdSchema,
  assistantModelsResponseSchema,
  type AssistantModelProfileId,
  type AssistantModelsResponse,
} from "@/lib/contracts/api";

const preferenceKey = "lumaflow.assistant.model-profile";
const initialProfileId: AssistantModelProfileId = "local-qwen3-8b";

export function useModelCatalog() {
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<AssistantModelProfileId>();
  const [result, setResult] = useState<{
    revision: number;
    response?: AssistantModelsResponse;
    initialSelection: AssistantModelProfileId;
    error?: string;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    async function loadCatalog() {
      try {
        const response = await fetch("/api/v1/assistant/models", {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(`Model catalog returned ${response.status}`);
        const parsed = assistantModelsResponseSchema.parse(payload);
        let preferredId = parsed.data.defaultProfileId;
        try {
          const saved = assistantModelProfileIdSchema.safeParse(localStorage.getItem(preferenceKey));
          if (saved.success && parsed.data.models.some((model) => model.id === saved.data)) preferredId = saved.data;
        } catch {
          // Local storage can be unavailable in private or restricted browsing.
        }
        if (!controller.signal.aborted) setResult((current) => ({ revision, response: parsed, initialSelection: current?.response ? current.initialSelection : preferredId }));
      } catch {
        if (!controller.signal.aborted) setResult((current) => ({ revision, response: current?.response, initialSelection: current?.initialSelection ?? initialProfileId, error: "暂时无法读取模型列表，请刷新重试。" }));
      }
    }
    void loadCatalog();
    return () => controller.abort();
  }, [revision]);

  const models = useMemo(() => result?.response?.data.models ?? [], [result?.response]);
  const modelProfileId = selection ?? result?.initialSelection ?? initialProfileId;
  const selectModel = useCallback((value: string) => {
    const parsed = assistantModelProfileIdSchema.safeParse(value);
    if (!parsed.success || !models.some((model) => model.id === parsed.data)) return;
    setSelection(parsed.data);
    try {
      localStorage.setItem(preferenceKey, parsed.data);
    } catch {
      // Selection still works when the browser cannot persist preferences.
    }
  }, [models]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  return {
    models,
    modelProfileId,
    selectedModel: models.find((model) => model.id === modelProfileId),
    selectModel,
    loading: result?.revision !== revision,
    error: result?.revision === revision ? result.error : undefined,
    refresh,
  };
}
