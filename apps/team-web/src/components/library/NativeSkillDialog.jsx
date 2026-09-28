import { useState } from "react";
import { Download } from "lucide-react";
import { Button, Dialog } from "../../design-system/index.jsx";
import { workbenchApi } from "../../api/client.js";
import { createNativeSkillZip, saveSkillZip } from "./native-skill-download.js";
import "./native-skill-dialog.css";

const AGENTS = [{ id: "codex", name: "Codex", folder: ".agents/skills" },
  { id: "claude", name: "Claude Code", folder: ".claude/skills" },
  { id: "pi", name: "Pi", folder: ".pi/skills" }];

export function NativeSkillDialog({ release, locale, onClose }) {
  const zh = locale === "zh";
  const [agent, setAgent] = useState(AGENTS[0]);
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState(null);
  const [error, setError] = useState("");
  async function prepareDownload() {
    setBusy(true); setError("");
    try {
      const response = await workbenchApi.getNativeSkillPackage(release.releaseId);
      const archive = await createNativeSkillZip(response.data);
      saveSkillZip(archive);
      setDownload({ name: response.data.skillName, compatibility: response.data.compatibility });
    } catch (cause) {
      setError(["native_skill_dependencies_unavailable", "native_skill_package_unsupported"].includes(cause.code)
        ? (zh ? "这个技能需要专用工具或运行环境，目前请在 Turnsu 中使用。" : "This skill needs dedicated tools or a runtime. Use it in Turnsu for now.")
        : (zh ? "未能下载技能，请重试。若访问权限已变更，请返回资源库刷新。" : "Could not download this skill. Retry, or refresh the library if your access changed."));
    } finally { setBusy(false); }
  }
  return <Dialog open title={zh ? "用自己的 Agent 使用技能" : "Use this skill with your Agent"} onClose={() => !busy && onClose()}
    actions={<><Button variant="plain" disabled={busy} onClick={onClose}>{zh ? "关闭" : "Close"}</Button><Button variant="primary" icon={<Download size={15} />} disabled={busy} onClick={prepareDownload}>{busy ? (zh ? "正在准备…" : "Preparing…") : download ? (zh ? "重新下载" : "Download again") : (zh ? "下载技能包" : "Download skill")}</Button></>}>
    <div className="nativeSkillDialog">
      <p className="nativeSkillIdentity"><strong>{release.title}</strong><span>v{release.versionLabel}</span></p>
      <fieldset><legend>{zh ? "你使用哪个 Agent？" : "Which Agent do you use?"}</legend>
        <div className="nativeSkillAgentChoices">{AGENTS.map((item) => <label key={item.id}><input type="radio" name="native-skill-agent" value={item.id} checked={agent.id === item.id} onChange={() => setAgent(item)} /><span>{item.name}</span></label>)}</div>
      </fieldset>
      <ol>
        <li>{zh ? "下载并解压技能包。" : "Download and unzip the package."}</li>
        <li>{zh ? "把解压后的技能文件夹放进你的项目：" : "Move the skill folder into your project:"}<code>{agent.folder}/{download?.name || (zh ? "技能文件夹" : "skill-folder")}</code></li>
        <li>{zh ? `在 ${agent.name} 中选择这个技能，提供要处理的内容。` : `Select this skill in ${agent.name} and provide your task.`}</li>
      </ol>
      <p className="nativeSkillNote">{zh ? "使用你自己的模型账户。处理结果留在你的 Agent 中，需要你再提交给团队。" : "Uses your model account. Results stay in your Agent until you submit them to the team."}</p>
      <details><summary>{zh ? "已有同名技能，或需要更新？" : "Already have this skill, or need an update?"}</summary><p>{zh ? "先保留本地修改和原版本，再选择是否替换。下载不会自动更新现有安装；以后发布的新版本也不会自动覆盖。" : "Keep local edits and the previous version before replacing it. Downloads and future releases never update an existing installation automatically."}</p></details>
      {download ? <p role="status" className="nativeSkillDownloadStatus">{zh ? "已发起下载。按上面的步骤放入项目后，再到 Agent 中使用。" : "Download started. Follow the steps above to install and use it."}</p> : null}
      {download?.compatibility ? <p>{zh ? "作者说明：" : "Author notes: "}{download.compatibility}</p> : null}
      {error ? <p role="alert" className="workFormError">{error}</p> : null}
    </div>
  </Dialog>;
}
