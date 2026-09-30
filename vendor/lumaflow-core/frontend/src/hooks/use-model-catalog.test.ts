import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useModelCatalog } from "./use-model-catalog";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it("does not restore a removed Qwen preference over the active Bonsai default", async () => {
  localStorage.setItem("lumaflow.assistant.model-profile", "local-qwen3-8b");
  const model = (id: string, reachable: boolean) => ({
    id, model: id, label: id, description: "test", configured: true,
    reachable, connectionKind: "live", contextTokens: 8192,
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    data: {
      defaultProfileId: "configured",
      models: [model("local-qwen3-8b", false), model("configured", true)],
    },
    meta: { apiVersion: "v1", requestId: "test-bonsai-default" },
  })));
  const { result } = renderHook(() => useModelCatalog());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBeUndefined();
  expect(result.current.modelProfileId).toBe("configured");
});
