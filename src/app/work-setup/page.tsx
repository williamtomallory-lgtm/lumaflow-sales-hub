import Link from "next/link";
import { ArrowLeft, Laptop, ShieldCheck } from "lucide-react";
import { WorkStartCommand } from "@/components/work-start-command";
import styles from "./work-setup.module.css";

const cowAgentUrl = "https://cowagent.ai/download/";

export default function WorkSetup() {
  return <main className={styles.page}>
    <Link className={styles.back} href="/"><ArrowLeft size={16} /> 返回 Chat-AI</Link>
    <header className={styles.header}>
      <span className={styles.badge}><Laptop size={24} /></span>
      <h1>让 Work 连接这台电脑</h1>
      <p>安装 CowAgent，运行连接命令，再完成配对。每位访客都连接自己的电脑。</p>
    </header>
    <div className={styles.steps}>
      <section className={styles.step}>
        <span className={styles.number}>1</span>
        <div><h2>安装并打开 CowAgent</h2><p>在准备操作的电脑上运行 CowAgent，并在其中设置可用的模型和 Agent。</p><a className={styles.secondary} href={cowAgentUrl} target="_blank" rel="noreferrer">打开 CowAgent 下载页</a></div>
      </section>
      <section className={styles.step}>
        <span className={styles.number}>2</span>
        <div><h2>启动本机连接器</h2><p>点击复制，在 Windows 开始菜单打开 <strong>PowerShell</strong>，粘贴并按回车。启动窗口会显示配对码；保持窗口打开。</p><WorkStartCommand className={styles.primary} /><small>这条命令会从 LumaFlow 网站下载连接器，核对文件后使用本机 Node.js 启动。没有 Node.js 时，先安装 <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">Node.js 官方 Windows 版</a>。</small></div>
      </section>
      <section className={styles.step}>
        <span className={styles.number}>3</span>
        <div><h2>回到 Work 输入配对码</h2><p>登录网站，在 Work 输入启动窗口显示的配对码。如果浏览器询问是否允许访问本地网络，确认网址是 lumaflow-sales-hub.vercel.app 后授权。</p><Link className={styles.secondary} href="/?work=1">返回 Work</Link></div>
      </section>
      <section className={styles.step}>
        <span className={styles.number}>4</span>
        <div><h2>可选：接入微信机器人</h2><p>在本机 CowAgent 打开“通道”→“接入通道”→“微信”，用手机扫码确认。随后在微信搜索“微信ClawBot”或“WeixinClawBot”。回到 Work 点击“生成微信绑定码”，把绑定码发给机器人；页面会自动显示绑定完成。</p><Link className={styles.secondary} href="/?work=1">打开微信绑定</Link></div>
      </section>
    </div>
    <p className={styles.note}><ShieldCheck size={18} /> 连接器只在你自己的电脑上运行；关闭启动窗口后，网站就无法继续向这台电脑发送任务。</p>
    <details className={styles.advanced}><summary>安装遇到问题？</summary><p>Windows 智能应用控制可能拦截未签名的下载启动器。使用上面的手动命令即可启动本机 Node.js；无需关闭系统防护。连接器会自动查找 CowAgent。若未检测到，请先打开 CowAgent，再重新运行命令。配对码一次性有效 10 分钟；过期后关闭启动窗口，重新运行命令取得新码。</p><p>高级用户可查看 <a href="https://github.com/williamtomallory-lgtm/lumaflow-cowagent" target="_blank" rel="noreferrer">CowAgent 项目说明</a>，并按需设置本机 CowAgent 地址。</p></details>
  </main>;
}
