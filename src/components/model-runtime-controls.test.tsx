import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantModelOptionSchema } from "@/lib/contracts/api";
import { parseInferenceReceipt } from "@/config/inference-ui";
import { ModelRuntimeControls } from "./model-runtime-controls";

const model = (id: "local-qwen3-8b" | "local-qwen3-14b", size: number, reachable = true) => assistantModelOptionSchema.parse({
  id, label: `Qwen3 ${size}B`, model: `qwen3:${size}b`, description: "本机模型，size 不代表准确率保证", configured: true, reachable,
  connectionKind: "live", contextTokens: 8192, family: "Qwen3", parameterSizeB: size, supportedModes: ["instant", "medium", "high", "extra-high", ...(size === 14 ? ["pro"] : [])],
});
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

describe("model and size settings", () => {
  it("opens a real settings dialog with family and size choices", async () => {
    const select = vi.fn();
    render(<ModelRuntimeControls models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14)]} modelProfileId="local-qwen3-8b" mode="instant" onModelChange={select} onModeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "模型与 Size" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "模型系列" })).toHaveValue("Qwen3");
    fireEvent.change(screen.getByRole("combobox", { name: "模型规模 Size" }), { target: { value: "local-qwen3-14b" } });
    expect(select).toHaveBeenCalledWith("local-qwen3-14b");
    fireEvent.click(screen.getByRole("button", { name: "关闭模型设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("disables Pro when 14B is not actually connected", () => {
    render(<ModelRuntimeControls models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14, false)]} modelProfileId="local-qwen3-8b" mode="instant" onModelChange={vi.fn()} onModeChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pro 较大模型" })).toBeDisabled();
  });
  it("renders execution metadata only when real response headers validate", () => {
    expect(parseInferenceReceipt(new Headers())).toBeNull();
    expect(parseInferenceReceipt(new Headers({ "X-Model-Id": "qwen3:14b", "X-Inference-Mode": "pro", "X-Thinking-Enabled": "true", "X-Output-Budget": "4096", "X-Input-Budget": "1500" }))).toEqual({ model: "qwen3:14b", mode: "pro", thinking: true, outputBudget: 4096, inputBudget: 1500 });
  });
});
