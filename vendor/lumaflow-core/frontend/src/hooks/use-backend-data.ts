"use client";

import { useCallback, useEffect, useState } from "react";
import { bootstrapResponseSchema, type BootstrapResponse } from "@/lib/contracts/api";

type BackendState = {
  response: BootstrapResponse | null;
  loading: boolean;
  error: string | null;
};

export function useBackendData() {
  const [state, setState] = useState<BackendState>({ response: null, loading: true, error: null });

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const parsed = await fetchBackendData();
      setState({ response: parsed, loading: false, error: null });
    } catch (error) {
      setState({ response: null, loading: false, error: error instanceof Error ? error.message : "无法读取后端数据" });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchBackendData(controller.signal)
      .then((response) => setState({ response, loading: false, error: null }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ response: null, loading: false, error: error instanceof Error ? error.message : "无法读取后端数据" });
      });
    return () => controller.abort();
  }, []);

  return { ...state, refresh };
}

async function fetchBackendData(signal?: AbortSignal) {
  const response = await fetch("/api/v1/bootstrap", {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(`后端返回 ${response.status}`);
  return bootstrapResponseSchema.parse(payload);
}
