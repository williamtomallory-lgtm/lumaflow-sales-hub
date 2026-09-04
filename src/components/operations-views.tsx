"use client";

import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  Download,
  FileText,
  History,
  Library,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  adminUsers,
  aiLogs,
  calculateQuote,
  filterKnowledge,
  knowledgeEntries,
  qualityIssues,
  quoteHistory,
  quoteRequiresApproval,
  type AdminUser,
  type Currency,
  type KnowledgeCategory,
  type KnowledgeEntry,
  type QuoteLine,
} from "@/lib/business";
import { products } from "@/lib/catalog";
import styles from "./operations-views.module.css";

type ToastFn = (message: string) => void;

const knowledgeCategories: Array<"全部" | KnowledgeCategory> = ["全部", "FAQ", "销售话术", "产品知识", "公司知识", "政策", "案例", "文档解析"];

export function KnowledgeBaseView({ onToast }: { onToast: ToastFn }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"全部" | KnowledgeCategory>("全部");
  const [entries, setEntries] = useState(knowledgeEntries);
  const [selectedId, setSelectedId] = useState(knowledgeEntries[0].id);
  const [showCreate, setShowCreate] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [draft, setDraft] = useState({ title: "", summary: "", category: "FAQ" as KnowledgeCategory });
  const uploadRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterKnowledge(query, category, entries), [query, category, entries]);
  const selected = entries.find((entry) => entry.id === selectedId) ?? results[0] ?? entries[0];

  async function copyArticle() {
    await navigator.clipboard.writeText(`${selected.title}\n\n${selected.content}`);
    onToast("知识内容已复制");
  }

  function createArticle() {
    if (!draft.title.trim() || !draft.summary.trim()) {
      onToast("请填写标题和摘要");
      return;
    }
    const entry: KnowledgeEntry = {
      id: `kb-${Date.now()}`,
      category: draft.category,
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      content: draft.summary.trim(),
      tags: [draft.category, "新建"],
      owner: "Junjun Hu",
      version: "v0.1",
      updatedAt: "刚刚",
      status: "待审核",
      reads: 0,
    };
    setEntries((current) => [entry, ...current]);
    setSelectedId(entry.id);
    setDraft({ title: "", summary: "", category: "FAQ" });
    setShowCreate(false);
    onToast("知识条目已保存为待审核");
  }

  async function parseDocument(file?: File) {
    if (!file) return;
    setParsing(true);
    onToast(`正在解析 ${file.name}…`);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/parse-document", { method: "POST", body });
      const result = await response.json() as { text?: string; characters?: number; pages?: number; truncated?: boolean; error?: string };
      if (!response.ok || !result.text) throw new Error(result.error || "文档解析失败");
      const entry: KnowledgeEntry = {
        id: `kb-doc-${Date.now()}`,
        category: "文档解析",
        title: `${file.name} · 解析结果`,
        summary: `已从 ${formatBytes(file.size)} 中提取 ${result.characters ?? result.text.length} 个字符${result.pages ? `、${result.pages} 页` : ""}，等待负责人核对。`,
        content: `${result.text}${result.truncated ? "\n\n[内容较长，此处仅保留前 20,000 个字符]" : ""}`,
        tags: [file.type || "未知格式", "真实解析", "待核对"],
        owner: "AI 文档助手",
        version: "v0.1",
        updatedAt: "刚刚",
        status: "待审核",
        reads: 0,
      };
      setEntries((current) => [entry, ...current]);
      setSelectedId(entry.id);
      setCategory("文档解析");
      onToast("文档正文已提取并创建待审核知识");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "文档解析失败");
    } finally {
      setParsing(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  function createVersion() {
    const parts = selected.version.replace(/^v/, "").split(".").map(Number);
    const nextVersion = `v${parts[0] || 0}.${(parts[1] || 0) + 1}`;
    setEntries((current) => current.map((entry) => entry.id === selected.id ? { ...entry, version: nextVersion, status: "待审核", updatedAt: "刚刚" } : entry));
    onToast(`${nextVersion} 草稿已创建，等待审核`);
  }

  return (
    <div className={styles.knowledgeLayout}>
      <section className={styles.knowledgeMain}>
        <div className={styles.toolbar}>
          <div className={styles.searchBox}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 FAQ、话术、政策、案例…" aria-label="搜索知识库" /></div>
          <input ref={uploadRef} hidden type="file" accept=".pdf,.doc,.docx,.txt,.csv,.md" onChange={(event) => parseDocument(event.target.files?.[0])} />
          <button className={styles.secondaryButton} disabled={parsing} onClick={() => uploadRef.current?.click()}><Upload size={16} /> {parsing ? "解析中…" : "解析文档"}</button>
          <button className={styles.primaryButton} onClick={() => setShowCreate(true)}><Plus size={16} /> 新建知识</button>
        </div>
        <div className={styles.categoryTabs} role="tablist" aria-label="知识分类">
          {knowledgeCategories.map((item) => <button role="tab" aria-selected={category === item} className={category === item ? styles.activeTab : ""} key={item} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
        <div className={styles.listSummary}><span>共 {results.length} 条知识</span><small><ShieldCheck size={13} /> {entries.filter((entry) => entry.status === "已发布").length} 条已审核发布</small></div>
        <div className={styles.knowledgeCards}>
          {results.map((entry) => (
            <button key={entry.id} className={`${styles.knowledgeCard} ${selected.id === entry.id ? styles.selectedCard : ""}`} onClick={() => setSelectedId(entry.id)}>
              <span className={styles.categoryIcon}><BookOpen size={17} /></span>
              <span className={styles.knowledgeCopy}><span><em>{entry.category}</em><i className={entry.status === "待审核" ? styles.pending : ""}>{entry.status}</i></span><strong>{entry.title}</strong><small>{entry.summary}</small><span className={styles.tagRow}>{entry.tags.map((tag) => <i key={tag}>{tag}</i>)}</span></span>
              <ChevronRight size={17} />
            </button>
          ))}
          {results.length === 0 && <div className={styles.empty}><Library size={25} /><strong>没有匹配的知识</strong><span>换一个关键词或分类试试。</span></div>}
        </div>
      </section>

      <aside className={styles.knowledgeDetail}>
        <div className={styles.detailHeader}><span>{selected.category}</span><i className={selected.status === "待审核" ? styles.pending : ""}>{selected.status}</i></div>
        <h2>{selected.title}</h2>
        <p className={styles.detailSummary}>{selected.summary}</p>
        <div className={styles.articleBody}>{selected.content}</div>
        <div className={styles.articleMeta}><div><span>负责人</span><strong>{selected.owner}</strong></div><div><span>版本</span><strong>{selected.version}</strong></div><div><span>更新时间</span><strong>{selected.updatedAt}</strong></div><div><span>使用次数</span><strong>{selected.reads}</strong></div></div>
        <div className={styles.detailActions}><button onClick={copyArticle}><Copy size={15} /> 复制内容</button><button onClick={createVersion}><History size={15} /> 创建新版本</button></div>
      </aside>

      {showCreate && (
        <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-label="新建知识">
          <button className={styles.modalScrim} onClick={() => setShowCreate(false)} aria-label="关闭" />
          <div className={styles.modal}>
            <div className={styles.modalHead}><div><span>知识管理</span><h2>新建知识条目</h2></div><button onClick={() => setShowCreate(false)} aria-label="关闭"><X size={19} /></button></div>
            <label>分类<select value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value as KnowledgeCategory }))}>{knowledgeCategories.slice(1).map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>标题<input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="例如：项目现场选型前需确认什么？" /></label>
            <label>摘要 / 正文<textarea value={draft.summary} onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))} placeholder="输入经过审核的知识内容…" /></label>
            <div className={styles.modalActions}><button className={styles.secondaryButton} onClick={() => setShowCreate(false)}>取消</button><button className={styles.primaryButton} onClick={createArticle}>保存待审核</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function QuotationView({ onToast }: { onToast: ToastFn }) {
  const [lines, setLines] = useState<QuoteLine[]>([
    { id: "line-1", productId: "arc-t18", quantity: 20, discount: 5 },
    { id: "line-2", productId: "line-l24", quantity: 12, discount: 0 },
  ]);
  const [currency, setCurrency] = useState<Currency>("CNY");
  const [customer, setCustomer] = useState("NOVA 服饰 · 陈经理");
  const [status, setStatus] = useState<"草稿" | "待审批" | "已批准">("草稿");
  const [version, setVersion] = useState(1);
  const [newProductId, setNewProductId] = useState(products[0].id);
  const previewRef = useRef<HTMLDivElement>(null);
  const totals = calculateQuote(lines, currency);
  const needsApproval = quoteRequiresApproval(lines);
  const symbols: Record<Currency, string> = { CNY: "¥", USD: "$", CAD: "C$" };
  const symbol = symbols[currency];

  function updateLine(id: string, field: "quantity" | "discount", value: number) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, [field]: Math.max(0, value) } : line));
    setStatus("草稿");
  }

  function addLine() {
    setLines((current) => [...current, { id: `line-${Date.now()}`, productId: newProductId, quantity: 1, discount: 0 }]);
    onToast("产品已加入报价");
  }

  function saveVersion() {
    setVersion((current) => current + 1);
    onToast(`报价已保存为 v${version + 1}`);
  }

  function advanceApproval() {
    if (status === "草稿" && needsApproval) {
      setStatus("待审批");
      onToast("报价已提交给销售经理审批");
      return;
    }
    setStatus("已批准");
    onToast("报价已批准，可正式发送");
  }

  async function downloadPdf() {
    if (!previewRef.current) return;
    onToast("正在生成报价 PDF…");
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);
    const canvas = await html2canvas(previewRef.current, { scale: 2, backgroundColor: "#ffffff", logging: false });
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const width = 190;
    const height = (canvas.height * width) / canvas.width;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", 10, 10, width, Math.min(height, 277));
    pdf.save(`LumaFlow-Quote-v${version}.pdf`);
    onToast("报价 PDF 已下载");
  }

  return (
    <div className={styles.quoteLayout}>
      <section className={styles.quoteBuilder}>
        <div className={styles.quoteTopline}>
          <div><span>当前报价</span><strong>QT-2026-0904 · v{version}</strong></div>
          <div className={styles.quoteControls}><select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label="报价币种"><option>CNY</option><option>USD</option><option>CAD</option></select><span className={`${styles.statusPill} ${status === "已批准" ? styles.approved : status === "待审批" ? styles.waiting : ""}`}>{status}</span></div>
        </div>
        <label className={styles.customerField}>客户<select value={customer} onChange={(event) => setCustomer(event.target.value)}><option>NOVA 服饰 · 陈经理</option><option>屿见酒店 · 林女士</option><option>北辰设计 · 周工</option></select></label>

        <div className={styles.lineTableWrap}>
          <table className={styles.lineTable}>
            <thead><tr><th>产品</th><th>单价</th><th>数量</th><th>阶梯</th><th>折扣</th><th>小计</th><th /></tr></thead>
            <tbody>{lines.map((line) => {
              const product = products.find((item) => item.id === line.productId)!;
              const lineTotal = calculateQuote([line], currency).total;
              return <tr key={line.id}><td><strong>{product.name}</strong><small>{product.model}</small></td><td>{symbol}{(calculateQuote([{ ...line, quantity: 1, discount: 0 }], currency).subtotal * (currency === "CNY" ? 1 : currency === "USD" ? .138 : .19)).toFixed(2)}</td><td><input aria-label={`${product.model} 数量`} type="number" min="1" value={line.quantity} onChange={(event) => updateLine(line.id, "quantity", Number(event.target.value))} /></td><td>{line.quantity >= 100 ? "-18%" : line.quantity >= 50 ? "-12%" : line.quantity >= 20 ? "-7%" : line.quantity >= 10 ? "-3%" : "—"}</td><td><div className={styles.percentInput}><input aria-label={`${product.model} 折扣`} type="number" min="0" max="100" value={line.discount} onChange={(event) => updateLine(line.id, "discount", Number(event.target.value))} /><span>%</span></div></td><td><strong>{symbol}{lineTotal.toFixed(2)}</strong></td><td><button aria-label={`删除 ${product.name}`} onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}><Trash2 size={15} /></button></td></tr>;
            })}</tbody>
          </table>
        </div>
        <div className={styles.addLine}><select value={newProductId} onChange={(event) => setNewProductId(event.target.value)}>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.model}</option>)}</select><button className={styles.secondaryButton} onClick={addLine}><Plus size={15} /> 添加产品</button></div>
        {needsApproval && <div className={styles.approvalNotice}><AlertTriangle size={17} /><div><strong>需要经理审批</strong><span>至少一项手动折扣超过 15%，正式发送前必须批准。</span></div></div>}
        <div className={styles.quoteTotals}><div><span>产品原价</span><strong>{symbol}{(totals.subtotal * (currency === "CNY" ? 1 : currency === "USD" ? .138 : .19)).toFixed(2)}</strong></div><div><span>数量阶梯优惠</span><strong>- {symbol}{(totals.tierSavings * (currency === "CNY" ? 1 : currency === "USD" ? .138 : .19)).toFixed(2)}</strong></div><div><span>手动折扣</span><strong>- {symbol}{(totals.discountSavings * (currency === "CNY" ? 1 : currency === "USD" ? .138 : .19)).toFixed(2)}</strong></div><div className={styles.grandTotal}><span>报价合计</span><strong>{symbol}{totals.total.toFixed(2)} <small>{currency}</small></strong></div></div>
        <p className={styles.rateNote}>币种换算使用演示固定汇率，正式报价需接入财务批准汇率。</p>
        <div className={styles.quoteActions}><button className={styles.secondaryButton} onClick={saveVersion}><History size={15} /> 保存新版本</button><button className={styles.secondaryButton} onClick={downloadPdf}><Download size={15} /> 下载 PDF</button><button className={styles.primaryButton} onClick={advanceApproval}><ShieldCheck size={15} /> {status === "待审批" ? "模拟批准" : needsApproval ? "提交审批" : "批准报价"}</button></div>
      </section>

      <aside className={styles.quotePreviewWrap}>
        <div className={styles.previewLabel}><span>报价预览</span><i>实时同步</i></div>
        <div ref={previewRef} className={styles.quotePreview}>
          <div className={styles.quoteBrand}><div><span className={styles.brandMark}>➜</span><strong>LumaFlow</strong></div><span>QUOTATION</span></div>
          <div className={styles.quoteTitle}><div><span>报价单</span><strong>QT-2026-0904</strong></div><div><span>版本 / 日期</span><strong>v{version} · 2026-09-04</strong></div></div>
          <div className={styles.quoteParties}><div><span>报价给</span><strong>{customer}</strong><small>商业照明项目</small></div><div><span>报价方</span><strong>LumaFlow Lighting</strong><small>sales@lumaflow.example</small></div></div>
          <table><thead><tr><th>产品</th><th>数量</th><th>折扣</th><th>金额</th></tr></thead><tbody>{lines.map((line) => { const product = products.find((item) => item.id === line.productId)!; return <tr key={line.id}><td><strong>{product.name}</strong><small>{product.model}</small></td><td>{line.quantity}</td><td>{line.discount}%</td><td>{symbol}{calculateQuote([line], currency).total.toFixed(2)}</td></tr>; })}</tbody></table>
          <div className={styles.previewTotal}><span>合计（{currency}）</span><strong>{symbol}{totals.total.toFixed(2)}</strong></div>
          <div className={styles.quoteTerms}><strong>报价说明</strong><p>报价有效期 14 天；交期以订单确认时库存为准；正式折扣须完成内部审批。产品享受对应型号质保服务。</p></div>
        </div>
      </aside>

      <section className={styles.historyPanel}>
        <div className={styles.sectionHead}><div><span>版本与历史</span><h2>最近报价</h2></div><button onClick={() => onToast("已显示全部报价记录")}>查看全部 <ArrowRight size={14} /></button></div>
        <div className={styles.historyRows}>{quoteHistory.map((quote) => <div key={quote.id}><span className={styles.historyIcon}><FileText size={16} /></span><p><strong>{quote.id}</strong><small>{quote.customer}</small></p><strong>{quote.total}</strong><i>{quote.version}</i><em>{quote.status}</em><time>{quote.updatedAt}</time><ChevronRight size={15} /></div>)}</div>
      </section>
    </div>
  );
}

type AdminTab = "总览" | "用户权限" | "知识管理" | "数据质量" | "AI 日志";

export function AdminView({ onToast }: { onToast: ToastFn }) {
  const [tab, setTab] = useState<AdminTab>("总览");
  const [users, setUsers] = useState(adminUsers);
  const [managedKnowledge, setManagedKnowledge] = useState(knowledgeEntries);
  const [issues, setIssues] = useState(qualityIssues);
  const [logQuery, setLogQuery] = useState("");
  const tabs: AdminTab[] = ["总览", "用户权限", "知识管理", "数据质量", "AI 日志"];

  function toggleUser(user: AdminUser) {
    setUsers((current) => current.map((item) => item.id === user.id ? { ...item, status: item.status === "活跃" ? "已停用" : "活跃" } : item));
    onToast(`${user.name} 已${user.status === "活跃" ? "停用" : "启用"}`);
  }

  function inviteUser() {
    const number = users.length + 1;
    setUsers((current) => [...current, { id: `u-local-${Date.now()}`, name: `受邀用户 ${number}`, initials: `U${number}`, role: "只读访客", department: "待分配", status: "已停用", lastActive: "等待接受邀请" }]);
    onToast("邀请记录已创建，新用户接受后可启用");
  }

  function manageKnowledge(entry: KnowledgeEntry) {
    if (entry.status === "待审核") {
      setManagedKnowledge((current) => current.map((item) => item.id === entry.id ? { ...item, status: "已发布", updatedAt: "刚刚" } : item));
      onToast("条目已批准发布");
      return;
    }
    onToast(`${entry.title} 当前版本 ${entry.version}`);
  }

  return (
    <div className={styles.adminLayout}>
      <div className={styles.adminTabs} role="tablist" aria-label="管理后台栏目">{tabs.map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? styles.activeAdminTab : ""} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>
      {tab === "总览" && <AdminOverview />}
      {tab === "用户权限" && (
        <section className={styles.adminPanel}>
          <div className={styles.sectionHead}><div><span>访问控制</span><h2>用户与权限</h2></div><button className={styles.primaryButton} onClick={inviteUser}><UserPlus size={15} /> 邀请用户</button></div>
          <div className={styles.userRows}>{users.map((user) => <div key={user.id}><span className={styles.userAvatar}>{user.initials}</span><p><strong>{user.name}</strong><small>{user.department} · {user.lastActive}</small></p><select value={user.role} onChange={(event) => setUsers((current) => current.map((item) => item.id === user.id ? { ...item, role: event.target.value } : item))} aria-label={`${user.name} 角色`}><option>管理员</option><option>销售经理</option><option>产品编辑</option><option>销售顾问</option><option>只读访客</option></select><span className={`${styles.userStatus} ${user.status === "已停用" ? styles.disabled : ""}`}>{user.status}</span><button className={styles.textButton} onClick={() => toggleUser(user)}>{user.status === "活跃" ? "停用" : "启用"}</button></div>)}</div>
        </section>
      )}
      {tab === "知识管理" && (
        <section className={styles.adminPanel}>
          <div className={styles.sectionHead}><div><span>内容治理</span><h2>知识发布状态</h2></div><span className={styles.summaryBadge}>{managedKnowledge.length} 条</span></div>
          <div className={styles.manageRows}>{managedKnowledge.map((entry) => <div key={entry.id}><span><BookOpen size={15} /></span><p><strong>{entry.title}</strong><small>{entry.category} · {entry.owner} · {entry.version}</small></p><em className={entry.status === "待审核" ? styles.pending : ""}>{entry.status}</em><button className={styles.textButton} onClick={() => manageKnowledge(entry)}>{entry.status === "待审核" ? "审核发布" : "查看版本"}</button></div>)}</div>
        </section>
      )}
      {tab === "数据质量" && (
        <section className={styles.adminPanel}>
          <div className={styles.sectionHead}><div><span>质量门禁</span><h2>待处理问题</h2></div><span className={styles.summaryBadge}>{issues.length} 项</span></div>
          {issues.length ? <div className={styles.issueRows}>{issues.map((issue) => <div key={issue.id}><span className={`${styles.severity} ${styles[`severity${issue.severity}`]}`}>{issue.severity}</span><p><strong>{issue.subject}</strong><small>{issue.field} · {issue.detail}</small></p><em>{issue.owner}</em><button className={styles.secondaryButton} onClick={() => { setIssues((current) => current.filter((item) => item.id !== issue.id)); onToast("问题已标记解决"); }}><Check size={14} /> 标记解决</button></div>)}</div> : <div className={styles.empty}><CheckCircle2 size={26} /><strong>质量问题已清零</strong><span>当前没有待处理的数据问题。</span></div>}
        </section>
      )}
      {tab === "AI 日志" && (
        <section className={styles.adminPanel}>
          <div className={styles.sectionHead}><div><span>可追溯性</span><h2>AI 操作日志</h2></div><div className={styles.miniSearch}><Search size={14} /><input value={logQuery} onChange={(event) => setLogQuery(event.target.value)} placeholder="筛选日志" /></div></div>
          <div className={styles.logTableWrap}><table className={styles.logTable}><thead><tr><th>时间</th><th>用户</th><th>动作</th><th>输入</th><th>结果</th><th>状态</th></tr></thead><tbody>{aiLogs.filter((log) => `${log.user}${log.action}${log.input}`.toLowerCase().includes(logQuery.toLowerCase())).map((log) => <tr key={log.id}><td>{log.time}</td><td>{log.user}</td><td>{log.action}</td><td>{log.input}</td><td>{log.result}</td><td><span className={log.status === "需审核" ? styles.pending : ""}>{log.status}</span></td></tr>)}</tbody></table></div>
        </section>
      )}
    </div>
  );
}

function AdminOverview() {
  const bars = [58, 72, 66, 84, 78, 91, 88];
  return (
    <div className={styles.adminOverview}>
      <section className={styles.adminMetrics}>
        <AdminMetric icon={UsersRound} label="活跃用户" value="18" delta="+12%" />
        <AdminMetric icon={Sparkles} label="AI 问答" value="426" delta="+28%" />
        <AdminMetric icon={Clock3} label="平均节省" value="2m 18s" delta="每次查询" />
        <AdminMetric icon={CircleDollarSign} label="资料促成" value="31" delta="+7 本周" />
      </section>
      <section className={styles.chartPanel}>
        <div className={styles.sectionHead}><div><span>使用统计</span><h2>近 7 日团队使用量</h2></div><span className={styles.summaryBadge}>+24.6%</span></div>
        <div className={styles.barChart}>{bars.map((height, index) => <div key={index}><span style={{ height: `${height}%` }} /><small>{["周六", "周日", "周一", "周二", "周三", "周四", "今天"][index]}</small></div>)}</div>
      </section>
      <section className={styles.effectPanel}>
        <div className={styles.sectionHead}><div><span>效果评估</span><h2>本月业务效果</h2></div></div>
        <div className={styles.effectRows}><div><span>资料查找时间</span><strong>42 秒</strong><em>目标 &lt; 60 秒</em></div><div><span>回答采用率</span><strong>78%</strong><em>较上月 +9%</em></div><div><span>资料包打开率</span><strong>71%</strong><em>行业基准 54%</em></div><div><span>知识覆盖率</span><strong>86%</strong><em>待补 7 条</em></div></div>
      </section>
    </div>
  );
}

function AdminMetric({ icon: Icon, label, value, delta }: { icon: typeof UsersRound; label: string; value: string; delta: string }) {
  return <div><span><Icon size={18} /></span><p><small>{label}</small><strong>{value}</strong><em>{delta}</em></p></div>;
}
