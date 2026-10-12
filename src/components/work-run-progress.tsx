import type { WorkRun } from "@/lib/contracts/work-run";
import styles from "./work-run-progress.module.css";

export function WorkRunProgress({ run, busy }: { run?: WorkRun; busy: boolean }) {
  if (!run) return null;
  const title = run.state === "running" ? busy ? "正在执行" : "执行已中断，结果待核验"
    : { answered: "执行记录", partial: "任务仍未完成", "needs-review": "任务需要核对", "needs-input": "等待补充条件", interrupted: "执行已中断", failed: "任务未完成" }[run.state];
  const labels = { pending: "待处理", running: busy ? "进行中" : "待核验", completed: "已处理", blocked: "待解决" };
  return <section className={styles.root} aria-label="Work 任务进度">
    <div className={styles.heading}><strong>{title}</strong><span>{run.receipts.filter((item) => item.state === "succeeded").length} 项操作已返回</span></div>
    {run.outcome && <div><strong>{run.outcome.verdict === "checked" ? "任务验收已通过" : run.outcome.verdict === "partial" ? "任务仍有未完成项" : "任务验收待确认"}</strong>{run.outcome.missing.length > 0 && <ul>{run.outcome.missing.map((item, index) => <li key={index}>{item}</li>)}</ul>}</div>}
    {!!run.steps.length && <ol className={styles.steps}>{run.steps.map((step, index) => <li key={index} data-state={step.state}><span>{step.title}</span><small>{labels[step.state]}</small></li>)}</ol>}
    {!!run.receipts.length && <details className={styles.details}><summary>查看实际执行回执</summary><ul>{run.receipts.map((item) => <li key={item.id}><strong>{item.action} · {item.state === "succeeded" ? "已返回" : item.state === "failed" ? "失败" : "结果待确认"}</strong><pre>{item.summary}</pre></li>)}</ul></details>}
  </section>;
}
