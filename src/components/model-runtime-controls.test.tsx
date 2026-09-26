import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantModelOptionSchema } from "@/lib/contracts/api";
import { parseInferenceReceipt } from "@/config/inference-ui";
import { ModelRuntimeControls } from "./model-runtime-controls";

const model = (id: "local-qwen3-8b" | "local-qwen3-14b", size: number, reachable = true) => assistantModelOptionSchema.parse({
  id, label: `Qwen3 ${size}B`, model: `qwen3:${size}b`, description: "本机模型，size 不代表准确率保证", configured: true, reachable,
  connectionKind: "live", contextTokens: 8192, family: "Qwen3", parameterSizeB: size, supportedModes: ["light", "medium", "ultra"],
});
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

describe("model and size settings", () => {
  it("opens a real settings dialog with family and size choices", async () => {
    const select = vi.fn();
    render(<ModelRuntimeControls models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14)]} modelProfileId="local-qwen3-8b" mode="light" onModelChange={select} onModeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "模型与 Size" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "模型系列" })).toHaveValue("Qwen3");
    fireEvent.change(screen.getByRole("combobox", { name: "模型规模 Size" }), { target: { value: "local-qwen3-14b" } });
    expect(select).toHaveBeenCalledWith("local-qwen3-14b");
    fireEvent.click(screen.getByRole("button", { name: "关闭模型设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("shows exactly three usable modes for a connected model", () => {
    render(<ModelRuntimeControls models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14, false)]} modelProfileId="local-qwen3-8b" mode="light" onModelChange={vi.fn()} onModeChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ultra 深度处理" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Pro/ })).not.toBeInTheDocument();
  });
  it("keeps the compact model pill quiet until its model menu is opened", async () => {
    const onModelChange = vi.fn();
    render(<ModelRuntimeControls compact models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14)]} modelProfileId="local-qwen3-8b" mode="light" onModelChange={onModelChange} onModeChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "选择模型 Qwen3 8B" })).toBeInTheDocument();
    expect(screen.queryByText(/本地版无套餐限制/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "选择模型 Qwen3 8B" }));
    const menu = await screen.findByRole("dialog", { name: "选择模型与参数规模" });
    expect(within(menu).getByRole("button", { name: /Qwen3 8B/ })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: /Qwen3 14B/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("button", { name: /Qwen3 14B/ }));
    expect(onModelChange).toHaveBeenCalledWith("local-qwen3-14b");
    expect(screen.queryByRole("dialog", { name: "选择模型与参数规模" })).not.toBeInTheDocument();
  });
  it("lists upcoming models with memory references and disables selection", () => {
    const onModelChange = vi.fn();
    const upcoming = assistantModelOptionSchema.parse({ id: "local-gemma4-31b", label: "Gemma 4 31B", model: "未下载", description: "尚未安装", configured: false, reachable: false, connectionKind: "live", contextTokens: null, family: "Gemma 4", parameterSizeB: 31, supportedModes: [], installationStatus: "not-downloaded", memoryRequirement: "参考内存 ≥32 GB" });
    render(<ModelRuntimeControls compact models={[model("local-qwen3-8b", 8), upcoming]} modelProfileId="local-qwen3-8b" mode="light" onModelChange={onModelChange} onModeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "选择模型 Qwen3 8B" }));
    const candidate = within(screen.getByRole("dialog", { name: "选择模型与参数规模" })).getByRole("button", { name: /Gemma 4 31B.*参考内存 ≥32 GB/ });
    expect(candidate).toBeDisabled();
    expect(candidate).toHaveTextContent("未下载");
    fireEvent.click(candidate);
    expect(onModelChange).not.toHaveBeenCalled();
  });
  it("supports Auto, Light, Medium and Ultra without switching models", () => {
    const onModelChange = vi.fn();
    const onModeChange = vi.fn();
    const options = [model("local-qwen3-8b", 8), model("local-qwen3-14b", 14)];
    const view = render(<ModelRuntimeControls compact models={options} modelProfileId="local-qwen3-8b" mode="light" onModelChange={onModelChange} onModeChange={onModeChange} />);
    const trigger = screen.getByRole("button", { name: "选择推理强度 Light" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "选择推理强度" });
    const slider = within(menu).getByRole("slider", { name: "推理强度" });
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "3");
    for (const [value, label] of [["2", "medium"], ["3", "ultra"], ["0", "auto"], ["1", "light"]] as const) {
      fireEvent.change(slider, { target: { value } });
      view.rerender(<ModelRuntimeControls compact models={options} modelProfileId="local-qwen3-8b" mode={label} onModelChange={onModelChange} onModeChange={onModeChange} />);
      expect(slider).toHaveAttribute("aria-valuetext", label === "auto" ? "Auto" : label === "light" ? "Light" : label === "medium" ? "Medium" : "Ultra");
    }
    expect(onModeChange).toHaveBeenNthCalledWith(1, "medium");
    expect(onModeChange).toHaveBeenNthCalledWith(2, "ultra");
    expect(onModeChange).toHaveBeenNthCalledWith(3, "auto");
    expect(onModeChange).toHaveBeenNthCalledWith(4, "light");
    expect(onModelChange).not.toHaveBeenCalled();
  });
  it("closes compact menus with Escape or an outside click", () => {
    render(<ModelRuntimeControls compact models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14, false)]} modelProfileId="local-qwen3-8b" mode="light" onModelChange={vi.fn()} onModeChange={vi.fn()} />);
    const modelTrigger = screen.getByRole("button", { name: "选择模型 Qwen3 8B" });
    fireEvent.click(modelTrigger);
    expect(screen.getByRole("dialog", { name: "选择模型与参数规模" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "选择模型与参数规模" })).not.toBeInTheDocument();

    const modeTrigger = screen.getByRole("button", { name: "选择推理强度 Light" });
    fireEvent.click(modeTrigger);
    const menu = screen.getByRole("dialog", { name: "选择推理强度" });
    expect(within(menu).getByRole("slider", { name: "推理强度" })).toBeEnabled();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "选择推理强度" })).not.toBeInTheDocument();
  });
  it("renders execution metadata only when real response headers validate", () => {
    expect(parseInferenceReceipt(new Headers())).toBeNull();
    expect(parseInferenceReceipt(new Headers({ "X-Model-Id": "ternary-bonsai-2-27b", "X-Inference-Mode": "ultra", "X-Thinking-Enabled": "unknown", "X-Output-Budget": "3072", "X-Input-Budget": "4000" }))).toEqual({ model: "ternary-bonsai-2-27b", mode: "ultra", thinking: null, outputBudget: 3072, inputBudget: 4000 });
  });
});
