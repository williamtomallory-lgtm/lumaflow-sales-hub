"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Settings2, X } from "lucide-react";
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
  compact?: boolean;
};

const familyOf = (model: AssistantModelOption) => model.family && model.family !== "unknown" ? model.family : model.id.startsWith("local-qwen3-") ? "Qwen3" : "自定义服务";
const familyLabel = (model: AssistantModelOption) => familyOf(model) === "custom" ? "自定义服务" : familyOf(model);
const sizeLabel = (model: AssistantModelOption) => model.parameterSizeB ? `${model.parameterSizeB}B` : "服务器配置";
const modelDisplayLabel = (model: AssistantModelOption) => model.parameterSizeB ? `${familyLabel(model)} ${sizeLabel(model)}` : model.label;
const modelConnectionLabel = (model: AssistantModelOption) => model.reachable ? "已连接，可调用" : model.configured ? "已配置，但当前未连接" : "未配置 / 未安装";
const modeIndex = (mode: InferenceMode) => Math.max(0, INFERENCE_MODES.findIndex((item) => item.id === mode));

function isInside(ref: React.RefObject<HTMLElement | null>, target: EventTarget | null) {
  return target instanceof Node && Boolean(ref.current?.contains(target));
}

export function ModelRuntimeControls({ models, modelProfileId, mode, disabled, onModelChange, onModeChange, compact = false }: Props) {
  const [opened, setOpened] = useState(false);
  const [modeOpened, setModeOpened] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const compactModelDialog = useRef<HTMLDialogElement>(null);
  const compactModeDialog = useRef<HTMLDialogElement>(null);
  const compactModelAnchor = useRef<HTMLDivElement>(null);
  const compactModeAnchor = useRef<HTMLDivElement>(null);
  const modelMenuId = `model-runtime-menu-${useId().replace(/:/g, "")}`;
  const modeMenuId = `${modelMenuId}-effort`;
  const selected = models.find((model) => model.id === modelProfileId);
  const family = selected ? familyOf(selected) : "Qwen3";
  const families = [...new Set(models.map(familyOf))];
  const familyModels = models.filter((model) => familyOf(model) === family);
  const proModel = models.find((model) => model.id === "local-qwen3-14b" && model.reachable && model.supportedModes?.includes("pro"));
  const isProAvailable = Boolean(proModel);

  useEffect(() => {
    if (compact) return;
    if (opened && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!opened && dialog.current?.open) dialog.current.close();
  }, [compact, opened]);

  useEffect(() => {
    if (!compact || (!opened && !modeOpened)) return;

    const closeOnOutside = (event: Event) => {
      if (opened && !isInside(compactModelAnchor, event.target)) setOpened(false);
      if (modeOpened && !isInside(compactModeAnchor, event.target)) setModeOpened(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (opened || modeOpened) {
        event.preventDefault();
        setOpened(false);
        setModeOpened(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("click", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("click", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [compact, modeOpened, opened]);

  useEffect(() => {
    if (!compact || !opened) return;
    compactModelDialog.current?.querySelector<HTMLButtonElement>("[data-model-option]")?.focus();
  }, [compact, opened]);

  useEffect(() => {
    if (!compact || !modeOpened) return;
    compactModeDialog.current?.querySelector<HTMLButtonElement>("[data-mode-option]")?.focus();
  }, [compact, modeOpened]);

  function openModelMenu() {
    if (disabled || !models.length) return;
    setModeOpened(false);
    setOpened((value) => !value);
  }

  function openModeMenu() {
    if (disabled || !mode || !onModeChange) return;
    setOpened(false);
    setModeOpened((value) => !value);
  }

  function openWithArrow(event: React.KeyboardEvent<HTMLButtonElement>, open: () => void) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open();
  }

  function chooseMode(next: InferenceMode) {
    if (disabled || !onModeChange) return;
    const available = next === "pro" ? isProAvailable : selected?.supportedModes?.includes(next);
    if (!available) return;
    // The server policy also resolves Pro to this exact profile. Selecting it
    // here keeps the model pill and the requested mode honest before submit.
    if (next === "pro" && proModel) onModelChange(proModel.id);
    onModeChange(next);
  }

  function chooseCompactMode(next: InferenceMode) {
    chooseMode(next);
    setModeOpened(false);
  }

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDialogElement>, selector: string) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)];
    const current = document.activeElement;
    const index = options.indexOf(current as HTMLButtonElement);
    if (index < 0 || !options.length) return;
    event.preventDefault();
    const nextIndex = event.key === "ArrowDown" ? (index + 1) % options.length : (index - 1 + options.length) % options.length;
    options[nextIndex]?.focus();
  }

  if (compact) {
    const selectedLabel = selected ? modelDisplayLabel(selected) : "等待模型目录";
    const currentMode = mode ? INFERENCE_MODES.find((item) => item.id === mode) : undefined;

    return <section className={`${styles.root} ${styles.compactRoot}`} aria-label="模型与推理配置">
      <div className={styles.compactToolbar}>
        <div className={styles.compactAnchor} ref={compactModelAnchor}>
          <button
            type="button"
            className={styles.compactPill}
            aria-haspopup="dialog"
            aria-expanded={opened}
            aria-controls={modelMenuId}
            aria-label={`选择模型 ${selectedLabel}`}
            disabled={disabled || !models.length}
            onClick={openModelMenu}
            onKeyDown={(event) => openWithArrow(event, openModelMenu)}
          >
            <Cpu size={15} aria-hidden="true" />
            <span className={styles.compactPillLabel}>{selectedLabel}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <dialog
            ref={compactModelDialog}
            id={modelMenuId}
            open={opened}
            aria-label="选择模型与参数规模"
            className={`${styles.compactPopover} ${styles.modelPopover}`}
            onCancel={() => setOpened(false)}
            onClick={(event) => { if (event.target === event.currentTarget) setOpened(false); }}
            onKeyDown={(event) => moveMenuFocus(event, "[data-model-option]")}
          >
            <header className={styles.compactPopoverHeader}>
              <div><small>模型目录</small><strong>选择模型</strong></div>
              <button type="button" className={styles.iconButton} aria-label="关闭模型选择" onClick={() => setOpened(false)}><X size={17} /></button>
            </header>
            <div className={styles.compactModelList} role="group" aria-label="模型与参数规模选项">
              {families.map((name) => <div key={name} className={styles.compactFamilyGroup}>
                {families.length > 1 && <span className={styles.compactFamilyLabel}>{name === "custom" ? "自定义服务" : name}</span>}
                {models.filter((model) => familyOf(model) === name).map((model) => <button
                  type="button"
                  key={model.id}
                  data-model-option="true"
                  className={`${styles.compactOption} ${model.id === modelProfileId ? styles.compactOptionSelected : ""}`}
                  aria-pressed={model.id === modelProfileId}
                  disabled={disabled}
                  onClick={() => { onModelChange(model.id); setOpened(false); }}
                >
                  <span className={styles.compactOptionCopy}>
                    <strong>{modelDisplayLabel(model)}</strong>
                    <small>{modelConnectionLabel(model)}</small>
                  </span>
                  {model.id === modelProfileId && <Check size={16} aria-hidden="true" />}
                </button>)}
              </div>)}
            </div>
            <p className={styles.compactCaveat}>Size 表示模型参数规模，不是答案长度。14B 通常需要更多内存、显存和等待时间，答案质量不保证一定优于 8B。这里仅显示服务端已登记的模型；未连接的模型不会被伪装成可用，也不会自动下载权重或购买 API。</p>
          </dialog>
        </div>

        {currentMode && onModeChange && <div className={styles.compactAnchor} ref={compactModeAnchor}>
          <button
            type="button"
            className={`${styles.compactPill} ${styles.effortPill}`}
            aria-haspopup="dialog"
            aria-expanded={modeOpened}
            aria-controls={modeMenuId}
            aria-label={`选择推理强度 ${currentMode.label}`}
            disabled={disabled}
            onClick={openModeMenu}
            onKeyDown={(event) => openWithArrow(event, openModeMenu)}
          >
            <span className={styles.compactPillLabel}>{currentMode.label}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <dialog
            ref={compactModeDialog}
            id={modeMenuId}
            open={modeOpened}
            aria-label="选择推理强度"
            className={`${styles.compactPopover} ${styles.modePopover}`}
            onCancel={() => setModeOpened(false)}
            onClick={(event) => { if (event.target === event.currentTarget) setModeOpened(false); }}
            onKeyDown={(event) => moveMenuFocus(event, "[data-mode-option]")}
          >
            <header className={styles.compactPopoverHeader}>
              <div><small>回答预算</small><strong>{currentMode.label}</strong></div>
              <button type="button" className={styles.iconButton} aria-label="关闭推理强度选择" onClick={() => setModeOpened(false)}><X size={17} /></button>
            </header>
            <div className={styles.effortReadout}>
              <strong>{currentMode.label}</strong>
              <small>{currentMode.subtitle}</small>
            </div>
            <input
              className={styles.effortRange}
              type="range"
              min="0"
              max={String(INFERENCE_MODES.length - 1)}
              step="1"
              value={modeIndex(currentMode.id)}
              aria-label="推理强度"
              aria-valuetext={`${currentMode.label} · ${currentMode.subtitle}`}
              disabled={disabled}
              onChange={(event) => {
                const next = INFERENCE_MODES[Number(event.target.value)];
                if (next) chooseCompactMode(next.id);
              }}
            />
            <div className={styles.effortTicks} aria-hidden="true">
              {INFERENCE_MODES.map((item) => <span key={item.id} className={item.id === mode ? styles.effortTickActive : ""}>{item.label}</span>)}
            </div>
            <div className={styles.compactModeOptions} role="group" aria-label="推理档位">
              {INFERENCE_MODES.map((item) => {
                const available = item.id === "pro" ? isProAvailable : selected?.supportedModes?.includes(item.id);
                return <button
                  type="button"
                  key={item.id}
                  data-mode-option="true"
                  className={`${styles.compactModeOption} ${item.id === mode ? styles.compactModeOptionSelected : ""}`}
                  aria-pressed={mode === item.id}
                  disabled={disabled || !available}
                  title={available ? item.detail : item.id === "pro" ? "请先安装并连接本地 Qwen3 14B" : "所选模型尚未声明支持此模式"}
                  onClick={() => chooseCompactMode(item.id)}
                >
                  <strong>{item.label}</strong><small>{item.subtitle}</small>
                </button>;
              })}
            </div>
            <p className={styles.compactCaveat}>{currentMode.detail} 当前任务与文件正文合计预算 {getInferenceProfileInputBudget(currentMode.id).toLocaleString()} 字符。Pro 仅使用可连接的本地 Qwen3 14B，不会调用收费云模型。</p>
          </dialog>
        </div>}
      </div>
    </section>;
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
    <dialog ref={dialog} aria-label="模型与 Size 设置" className={styles.dialog} onClose={() => setOpened(false)} onCancel={() => setOpened(false)} onClick={(event) => { if (event.target === event.currentTarget) setOpened(false); }}>
      <header><div><small>本地模型设置</small><h2>选择模型与参数规模</h2></div><button type="button" aria-label="关闭模型设置" onClick={() => setOpened(false)}><X size={20} /></button></header>
      <div className={styles.selects}>
        <label>模型系列<select aria-label="模型系列" value={family} disabled={disabled} onChange={(event) => {
          const candidate = models.find((model) => familyOf(model) === event.target.value);
          if (candidate) onModelChange(candidate.id);
        }}>{families.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>参数规模 Size<select aria-label="模型规模 Size" value={modelProfileId} disabled={disabled} onChange={(event) => onModelChange(event.target.value)}>{familyModels.map((model) => <option key={model.id} value={model.id}>{sizeLabel(model)} · {model.reachable ? "已连接" : model.configured ? "未连接 / 未安装" : "未配置"}</option>)}</select></label>
      </div>
      <div className={styles.modelCards}>{familyModels.map((model) => <button type="button" key={model.id} className={model.id === modelProfileId ? styles.selected : ""} aria-pressed={model.id === modelProfileId} disabled={disabled} onClick={() => onModelChange(model.id)}><strong>{modelDisplayLabel(model)}</strong><span>{model.model}</span><p>{model.description}</p><small>{modelConnectionLabel(model)}</small></button>)}</div>
      <p className={styles.warning}>Size 表示模型参数规模，不是答案长度。14B 通常需要更多内存、显存和等待时间，答案质量仍取决于任务、资料与模型；不能保证一定优于 8B。这里只选择服务端已登记的模型，不会自动下载权重或购买 API。</p>
      <button type="button" className={styles.done} onClick={() => setOpened(false)}>完成选择</button>
    </dialog>
  </section>;
}

export function InferenceReceiptView({ receipt }: { receipt: InferenceReceipt | null }) {
  return receipt ? <p className={styles.receipt} data-testid="inference-receipt">本轮实际：{receipt.model} · {inferenceModeLabel(receipt.mode)} · {receipt.thinking === null ? "思考开关未验证" : receipt.thinking ? "思考已开启" : "思考已关闭"} · 生成上限 {receipt.outputBudget.toLocaleString()} tokens（含思考和答案） · 输入预算 {receipt.inputBudget.toLocaleString()} 字符</p> : null;
}
