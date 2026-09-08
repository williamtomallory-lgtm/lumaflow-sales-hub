import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("keeps the compact model pill quiet until its model menu is opened", async () => {
    const onModelChange = vi.fn();
    render(<ModelRuntimeControls compact models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14)]} modelProfileId="local-qwen3-8b" mode="instant" onModelChange={onModelChange} onModeChange={vi.fn()} />);
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
  it("supports every compact inference profile and lets Pro force the reachable 14B profile", () => {
    const onModelChange = vi.fn();
    const onModeChange = vi.fn();
    render(<ModelRuntimeControls compact models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14)]} modelProfileId="local-qwen3-8b" mode="instant" onModelChange={onModelChange} onModeChange={onModeChange} />);
    const trigger = screen.getByRole("button", { name: "选择推理强度 Instant" });
    for (const label of ["Instant", "Medium", "High", "Extra High", "Pro"]) {
      fireEvent.click(trigger);
      const menu = screen.getByRole("dialog", { name: "选择推理强度" });
      fireEvent.click(within(menu).getByRole("button", { name: new RegExp(`^${label}`) }));
    }
    expect(onModeChange).toHaveBeenNthCalledWith(1, "instant");
    expect(onModeChange).toHaveBeenNthCalledWith(2, "medium");
    expect(onModeChange).toHaveBeenNthCalledWith(3, "high");
    expect(onModeChange).toHaveBeenNthCalledWith(4, "extra-high");
    expect(onModeChange).toHaveBeenNthCalledWith(5, "pro");
    expect(onModelChange).toHaveBeenCalledWith("local-qwen3-14b");

    fireEvent.click(trigger);
    const slider = screen.getByRole("slider", { name: "推理强度" });
    expect(slider).toHaveValue("0");
    fireEvent.change(slider, { target: { value: "2" } });
    expect(onModeChange).toHaveBeenLastCalledWith("high");
  });
  it("disables compact Pro and closes menus with Escape or an outside click", () => {
    render(<ModelRuntimeControls compact models={[model("local-qwen3-8b", 8), model("local-qwen3-14b", 14, false)]} modelProfileId="local-qwen3-8b" mode="instant" onModelChange={vi.fn()} onModeChange={vi.fn()} />);
    const modelTrigger = screen.getByRole("button", { name: "选择模型 Qwen3 8B" });
    fireEvent.click(modelTrigger);
    expect(screen.getByRole("dialog", { name: "选择模型与参数规模" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "选择模型与参数规模" })).not.toBeInTheDocument();

    const modeTrigger = screen.getByRole("button", { name: "选择推理强度 Instant" });
    fireEvent.click(modeTrigger);
    const menu = screen.getByRole("dialog", { name: "选择推理强度" });
    expect(within(menu).getByRole("button", { name: /^Pro/ })).toBeDisabled();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "选择推理强度" })).not.toBeInTheDocument();
  });
  it("renders execution metadata only when real response headers validate", () => {
    expect(parseInferenceReceipt(new Headers())).toBeNull();
    expect(parseInferenceReceipt(new Headers({ "X-Model-Id": "qwen3:14b", "X-Inference-Mode": "pro", "X-Thinking-Enabled": "true", "X-Output-Budget": "4096", "X-Input-Budget": "1500" }))).toEqual({ model: "qwen3:14b", mode: "pro", thinking: true, outputBudget: 4096, inputBudget: 1500 });
  });
});
