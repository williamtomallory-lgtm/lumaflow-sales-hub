"use client";

import { useEffect, useRef, useState } from "react";
import { Cpu, Settings2, X } from "lucide-react";
import type { AssistantModelOption } from "@/lib/contracts/api";
import { INFERENCE_MODES, inferenceModeLabel, type InferenceMode, type InferenceReceipt } from "@/config/inference-ui";
import { getInferenceProfileInputBudget } from "@/lib/ai/inference-policy";
import styles from "./model-runtime-controls.module.css";

type Props = {
  models: AssistantModelOption[];
  modelProfileId: string;
  mode?: InferenceMode;
  disabled?: boolean;
  onModelChange: (id: string) => void;
  onModeChange?: (mode: InferenceMode) => void;
};

const familyOf = (model: AssistantModelOption) => model.family && model.family !== "unknown" ? model.family : model.id.startsWith("local-qwen3-") ? "Qwen3" : "自定义服务";
const sizeLabel = (model: AssistantModelOption) => model.parameterSizeB ? `${model.parameterSizeB}B` : "服务器配置";

export function ModelRuntimeControls({ models, modelProfileId, mode, disabled, onModelChange, onModeChange }: Props) {
  const [opened, setOpened] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = models.find((model) => model.id === modelProfileId);
  const family = selected ? familyOf(selected) : "Qwen3";
  const families = [...new Set(models.map(familyOf))];
  const familyModels = models.filter((model) => familyOf(model) === family);
  const proModel = models.find((model) => model.id === "local-qwen3-14b" && model.reachable);
  const isProAvailable = selected?.id !== "configured" && Boolean(proModel?.supportedModes?.includes("pro"));

  useEffect(() => {
    if (opened && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!opened && dialog.current?.open) dialog.current.close();
  }, [opened]);

  function chooseMode(next: InferenceMode) {
    if (disabled || !onModeChange) return;
    if (next === "pro" && isProAvailable && proModel) onModelChange(proModel.id);
    onModeChange(next);
  }

  return <section className={styles.root} aria-label="模型与推理配置">
    <div className={styles.toolbar}>
      <span><Cpu size={16} /> {family} · {selected ? sizeLabel(selected) : "等待模型目录"}{mode ? ` · ${inferenceModeLabel(mode)}` : ""}</span>
      <button type="button" disabled={disabled || !models.length} onClick={() => setOpened(true)}><Settings2 size={15} /> 模型与 Size</button>
    </div>
    {mode && onModeChange && <div className={styles.modes} role="group" aria-label="推理强度">
      {INFERENCE_MODES.map((item) => {
        const available = item.id === "pro" ? isProAvailable : selected?.supportedModes?.includes(item.id);
        return <button type="button" key={item.id} aria-pressed={mode === item.id} disabled={disabled || !available} title={available ? item.detail : item.id === "pro" ? "请先安装并连接本地 Qwen3 14B" : "所选模型尚未声明支持此模式"} onClick={() => chooseMode(item.id)}><strong>{item.label}</strong><small>{item.subtitle}</small></button>;
      })}
    </div>}
    {mode && <p className={styles.note}>{selected?.id === "configured" ? "自定义服务仅开放快速生成预算；其原生思考开关未实测。" : INFERENCE_MODES.find((item) => item.id === mode)?.detail} 当前任务与文件正文合计预算 {getInferenceProfileInputBudget(mode).toLocaleString()} 字符。本地版无套餐限制；Qwen3 的档位采用思考开关和生成预算，不保证每题都用满预算。</p>}
    <dialog ref={dialog} aria-label="模型与 Size 设置" className={styles.dialog} onClose={() => setOpened(false)} onCancel={() => setOpened(false)}>
      <header><div><small>本地模型设置</small><h2>选择模型与参数规模</h2></div><button type="button" aria-label="关闭模型设置" onClick={() => setOpened(false)}><X size={20} /></button></header>
      <div className={styles.selects}>
        <label>模型系列<select aria-label="模型系列" value={family} disabled={disabled} onChange={(event) => {
          const candidate = models.find((model) => familyOf(model) === event.target.value);
          if (candidate) onModelChange(candidate.id);
        }}>{families.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>参数规模 Size<select aria-label="模型规模 Size" value={modelProfileId} disabled={disabled} onChange={(event) => onModelChange(event.target.value)}>{familyModels.map((model) => <option key={model.id} value={model.id}>{sizeLabel(model)} · {model.reachable ? "已连接" : model.configured ? "未连接 / 未安装" : "未配置"}</option>)}</select></label>
      </div>
      <div className={styles.modelCards}>{familyModels.map((model) => <button type="button" key={model.id} className={model.id === modelProfileId ? styles.selected : ""} aria-pressed={model.id === modelProfileId} disabled={disabled} onClick={() => onModelChange(model.id)}><strong>{familyOf(model)} · {sizeLabel(model)}</strong><span>{model.model}</span><p>{model.description}</p><small>{model.reachable ? "已连接，可调用" : "尚未连接，不会伪造模型回答"}</small></button>)}</div>
      <p className={styles.warning}>Size 表示模型参数规模，不是答案长度。14B 通常需要更多内存、显存和等待时间，答案质量仍取决于任务、资料与模型；不能保证一定优于 8B。这里只选择服务端已登记的模型，不会自动下载权重或购买 API。</p>
      <button type="button" className={styles.done} onClick={() => setOpened(false)}>完成选择</button>
    </dialog>
  </section>;
}

export function InferenceReceiptView({ receipt }: { receipt: InferenceReceipt | null }) {
  return receipt ? <p className={styles.receipt} data-testid="inference-receipt">本轮实际：{receipt.model} · {inferenceModeLabel(receipt.mode)} · {receipt.thinking === null ? "思考开关未验证" : receipt.thinking ? "思考已开启" : "思考已关闭"} · 生成上限 {receipt.outputBudget.toLocaleString()} tokens（含思考和答案） · 输入预算 {receipt.inputBudget.toLocaleString()} 字符</p> : null;
}
