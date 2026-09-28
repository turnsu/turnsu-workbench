import { useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import { Button } from "../../design-system/index.jsx";

export function NativeAgentSetup({ locale }) {
  const zh = locale.startsWith("zh");
  const words = (cn, en) => zh ? cn : en;
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState("codex");
  const [notice, setNotice] = useState("");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const quotedOrigin = `'${origin.replaceAll("'", "'\\''")}'`;
  const command = `node ./turnsu-connector/turnsu.mjs start --agent ${agent} --url ${quotedOrigin}`;
  async function copy() {
    try { await navigator.clipboard.writeText(command); setNotice(words("已复制。请在项目目录的终端中运行。", "Copied. Run it in your project's terminal.")); }
    catch { setNotice(words("无法自动复制，请选择下方命令手动复制。", "Select the command below to copy it manually.")); }
  }
  return <div className="nativeAgentSetup">
    <button className="settingsAddModel" type="button" aria-expanded={open} aria-controls="native-agent-setup" onClick={() => setOpen(!open)}>{words("连接我的 Agent", "Connect my Agent")}<ChevronDown size={15} /></button>
    {open ? <div id="native-agent-setup">
      <p>{words("使用自己已安装的 Agent 处理团队工作。当前支持 macOS / Linux，需要 Node.js 22.19 或更新版本。", "Use your installed Agent for team work. Currently supports macOS / Linux with Node.js 22.19 or later.")}</p>
      <div role="group" aria-label={words("选择 Agent", "Choose Agent")} className="nativeAgentChoices">
        {[["codex", "Codex CLI"], ["claude", "Claude Code"], ["pi", "Pi"]].map(([value, title]) => <button key={value} type="button" aria-pressed={agent === value} onClick={() => { setAgent(value); setNotice(""); }}>{title}</button>)}
      </div>
      <ol>
        <li><strong>{words("下载并解压", "Download and extract")}</strong><p>{words("把 turnsu-connector 文件夹放进要工作的项目目录。", "Place the turnsu-connector folder in your project directory.")}</p><a className="nativeConnectorDownload" href="/downloads/turnsu-connector.zip" download="turnsu-connector.zip"><Download size={14} />{words("下载连接器", "Download connector")}</a></li>
        <li><strong>{words("在该项目的终端运行", "Run in the project's terminal")}</strong><pre tabIndex={0}>{command}</pre><Button size="sm" onClick={copy}>{words("复制启动命令", "Copy start command")}</Button>{notice ? <p role="status">{notice}</p> : null}</li>
        <li><strong>{words("打开终端给出的链接，批准连接", "Open the terminal's link and approve")}</strong><p>{words("用你自己的团队账户授权后，Agent 会打开。下次使用同一命令启动即可；全局配置不会被改写。", "Approve with your team account and the Agent will open. Use the same command next time; global settings stay unchanged.")}</p></li>
      </ol>
      <p>{words("完成后刷新授权列表。只有你明确要求分享的进展和结果才会提交给团队。", "Refresh authorizations afterwards. Only updates and results you explicitly ask to share are submitted to the team.")}</p>
    </div> : null}
  </div>;
}
