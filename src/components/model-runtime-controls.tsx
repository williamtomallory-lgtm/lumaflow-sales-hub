"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, RotateCcw, Settings2, X, Zap } from "lucide-react";
import type { AssistantModelOption } from "@/lib/contracts/api";
import { INFERENCE_MODES, inferenceModeLabel, type InferenceMode } from "@/config/inference-ui";
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
const sizeLabel = (model: AssistantModelOption) => model.installationStatus === "not-downloaded" ? model.label : model.parameterSizeB ? `${model.parameterSizeB}B` : "服务器配置";
const modelDisplayLabel = (model: AssistantModelOption) => model.installationStatus === "not-downloaded" ? `${model.label}${model.memoryRequirement ? `（${model.memoryRequirement}）` : ""}` : model.parameterSizeB ? `${familyLabel(model)} ${sizeLabel(model)}` : model.label;
const modelConnectionLabel = (model: AssistantModelOption) => model.installationStatus === "not-downloaded" ? "未下载" : model.reachable ? "已连接，可调用" : model.configured ? "已配置，但当前未连接" : "未配置 / 未安装";

function isInside(ref: React.RefObject<HTMLElement | null>, target: EventTarget | null) {
  return target instanceof Node && Boolean(ref.current?.contains(target));
}

export function ModelRuntimeControls({ models, modelProfileId, mode, disabled, onModelChange, onModeChange, compact = false }: Props) {
  const [opened, setOpened] = useState(false);
  const [modeOpened, setModeOpened] = useState(false);
  const [viewedFamily, setViewedFamily] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const compactModelDialog = useRef<HTMLDialogElement>(null);
  const compactModeDialog = useRef<HTMLDialogElement>(null);
  const compactModelAnchor = useRef<HTMLDivElement>(null);
  const compactModeAnchor = useRef<HTMLDivElement>(null);
  const modelMenuId = `model-runtime-menu-${useId().replace(/:/g, "")}`;
  const modeMenuId = `${modelMenuId}-effort`;
  const selected = models.find((model) => model.id === modelProfileId);
  const families = [...new Set(models.map(familyOf))];
  const readyModels = models.filter((model) => model.installationStatus !== "not-downloaded");
  const pendingModels = models.filter((model) => model.installationStatus === "not-downloaded");
  const family = viewedFamily && families.includes(viewedFamily) ? viewedFamily : selected ? familyOf(selected) : "当前模型";
  const familyModels = models.filter((model) => familyOf(model) === family);

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
    compactModeDialog.current?.querySelector<HTMLInputElement>("input[type=range]")?.focus();
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
    const available = next === "auto" ? Boolean(selected?.supportedModes?.length) : selected?.supportedModes?.includes(next);
    if (!available) return;
    onModeChange(next);
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
    const availableModes = INFERENCE_MODES.filter((item) => item.id === "auto" ? Boolean(selected?.supportedModes?.length) : selected?.supportedModes?.includes(item.id));
    const modeIndex = Math.max(0, availableModes.findIndex((item) => item.id === mode));
    const modeProgress = availableModes.length > 1 ? modeIndex / (availableModes.length - 1) * 100 : 0;

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
              {[{ name: "可使用", items: readyModels }, { name: "未下载", items: pendingModels }].filter((group) => group.items.length).map((group) => <div key={group.name} className={styles.compactFamilyGroup}>
                <span className={styles.compactFamilyLabel}>{group.name}</span>
                {group.items.map((model) => <button
                  type="button"
                  key={model.id}
                  data-model-option="true"
                  className={`${styles.compactOption} ${model.id === modelProfileId ? styles.compactOptionSelected : ""}`}
                  aria-pressed={model.id === modelProfileId}
                  disabled={disabled || model.installationStatus === "not-downloaded"}
                  onClick={() => { onModelChange(model.id); setOpened(false); }}
                >
                  <span className={styles.compactOptionCopy}>
                    <strong>{model.installationStatus === "not-downloaded" ? model.label : modelDisplayLabel(model)}</strong>
                    {model.memoryRequirement && <em>（{model.memoryRequirement}）</em>}
                    <small>{modelConnectionLabel(model)}</small>
                  </span>
                  {model.id === modelProfileId && <Check size={16} aria-hidden="true" />}
                </button>)}
              </div>)}
            </div>
            <p className={styles.compactCaveat}>括号中的内存是按所列量化版本与权重大小估算的本机参考值，实际需求取决于上下文、硬件和运行方式。未下载模型目前不能选择。</p>
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
          >
            <header className={styles.effortHeader}>
              <Zap size={18} aria-hidden="true" />
              <div className={styles.effortReadout}><strong>{currentMode.label}</strong><small title={selectedLabel}>{selectedLabel}</small></div>
              <button type="button" className={styles.iconButton} aria-label="重置为 Light" disabled={disabled || !availableModes.some((item) => item.id === "light")} onClick={() => chooseMode("light")}><RotateCcw size={17} /></button>
            </header>
            <div className={styles.effortSlider}>
              <input
                type="range"
                className={styles.effortRange}
                aria-label="推理强度"
                aria-valuetext={currentMode.label}
                min={0}
                max={Math.max(0, availableModes.length - 1)}
                step={1}
                value={modeIndex}
                disabled={disabled || availableModes.length <= 1}
                style={{ background: `linear-gradient(90deg, #248557 0%, #248557 ${modeProgress}%, #e4e1e3 ${modeProgress}%, #e4e1e3 100%)` }}
                onChange={(event) => {
                  const next = availableModes[Number(event.target.value)];
                  if (next) chooseMode(next.id);
                }}
              />
              <div className={styles.effortTicks} aria-hidden="true">
                {availableModes.map((item, index) => <span key={item.id} className={index === modeIndex ? styles.effortTickCurrent : index < modeIndex ? styles.effortTickActive : ""} />)}
              </div>
            </div>
            <p className={styles.compactCaveat} title={`${currentMode.detail} 三档会调整指令、生成上限与超时；通用 Bonsai 接口未提供可验证的原生思考开关。`} aria-label={`${currentMode.detail} 三档会调整指令、生成上限与超时；通用 Bonsai 接口未提供可验证的原生思考开关。`}>调整生成预算与等待时间</p>
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
        const available = item.id === "auto" ? Boolean(selected?.supportedModes?.length) : selected?.supportedModes?.includes(item.id);
        return <button type="button" key={item.id} aria-pressed={mode === item.id} disabled={disabled || !available} title={available ? item.detail : "请先连接支持此模式的模型"} onClick={() => chooseMode(item.id)}><strong>{item.label}</strong><small>{item.subtitle}</small></button>;
      })}
    </div>}
    {mode && <p className={styles.note}>{INFERENCE_MODES.find((item) => item.id === mode)?.detail} 长答案会自动续写；实际使用服务端所选模型。</p>}
    <dialog ref={dialog} aria-label="模型与 Size 设置" className={styles.dialog} onClose={() => setOpened(false)} onCancel={() => setOpened(false)} onClick={(event) => { if (event.target === event.currentTarget) setOpened(false); }}>
      <header><div><small>本地模型设置</small><h2>选择模型与参数规模</h2></div><button type="button" aria-label="关闭模型设置" onClick={() => setOpened(false)}><X size={20} /></button></header>
      <div className={styles.selects}>
        <label>模型系列<select aria-label="模型系列" value={family} disabled={disabled} onChange={(event) => {
          setViewedFamily(event.target.value);
          const candidate = models.find((model) => familyOf(model) === event.target.value);
          if (candidate && candidate.installationStatus !== "not-downloaded") onModelChange(candidate.id);
        }}>{families.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>参数规模 Size<select aria-label="模型规模 Size" value={familyModels.some((model) => model.id === modelProfileId) ? modelProfileId : ""} disabled={disabled} onChange={(event) => { const candidate = familyModels.find((model) => model.id === event.target.value); if (candidate && candidate.installationStatus !== "not-downloaded") onModelChange(event.target.value); }}><option value="" disabled>选择型号</option>{familyModels.map((model) => <option key={model.id} value={model.id} disabled={model.installationStatus === "not-downloaded"}>{sizeLabel(model)} · {modelConnectionLabel(model)}</option>)}</select></label>
      </div>
      <div className={styles.modelCards}>{familyModels.map((model) => <button type="button" key={model.id} className={model.id === modelProfileId ? styles.selected : ""} aria-pressed={model.id === modelProfileId} disabled={disabled || model.installationStatus === "not-downloaded"} onClick={() => onModelChange(model.id)}><strong>{modelDisplayLabel(model)}</strong><span>{model.installationStatus === "not-downloaded" ? "尚无本机运行文件" : model.model}</span><p>{model.description}</p><small>{modelConnectionLabel(model)}</small></button>)}</div>
      <p className={styles.warning}>Size 表示模型参数规模，不是答案长度。14B 通常需要更多内存、显存和等待时间，答案质量仍取决于任务、资料与模型；不能保证一定优于 8B。这里只选择服务端已登记的模型，不会自动下载权重或购买 API。</p>
      <button type="button" className={styles.done} onClick={() => setOpened(false)}>完成选择</button>
    </dialog>
  </section>;
}
