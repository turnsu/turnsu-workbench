import { useEffect, useState } from "react";
import { Check, ChevronRight, Cpu, Palette, Users, Laptop } from "lucide-react";
import { Button, Dialog } from "../../design-system/index.jsx";
import { useModelCatalog } from "../../state/models/index.js";
import { NativeConnections } from "./NativeConnections.jsx";
import { ModelSetupDialog } from "../models/ModelSetupDialog.jsx";

export function WorkspaceSettings({ open, onClose, workspace }) {
  const zh = workspace.locale === "zh";
  const [section, setSection] = useState("models");
  const [connecting, setConnecting] = useState(false);
  const catalog = useModelCatalog({ enabled: open });
  const admin = ["admin", "owner"].includes(workspace.membershipRole);
  const principal = { workspaceId: workspace.serverState?.workspace?.workspaceId || "", userId: workspace.session?.userId || "" };
  useEffect(() => { if (!open) setConnecting(false); }, [open]);
  const sections = [["models", Cpu, zh ? "模型" : "Models"], ["agents", Laptop, zh ? "我的 Agent" : "My Agents"], ["appearance", Palette, zh ? "外观与语言" : "Appearance"], ["team", Users, zh ? "团队" : "Team"]];
  return <>
    <Dialog open={open && !connecting} title={zh ? "设置" : "Settings"} onClose={onClose} returnFocusSelector=".workbenchSettingsTrigger"
      actions={<Button onClick={onClose}>{zh ? "完成" : "Done"}</Button>}>
      <div className="workbenchSettings">
        <nav aria-label={zh ? "设置分类" : "Settings sections"}>
          {sections.map(([id, Icon, title]) => <button key={id} type="button" className={section === id ? "selected" : ""} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}><Icon size={16} />{title}</button>)}
        </nav>
        <section>
          {section === "models" ? <>
            <h3>{zh ? "我的模型" : "My models"}</h3>
            <p>{zh ? "任务会使用默认模型。需要时，在输入框下方切换即可。" : "Tasks use your default model. Switch below the composer whenever you need."}</p>
            {catalog.isPending ? <p role="status">{zh ? "正在读取…" : "Loading…"}</p> : catalog.error ? <p role="alert">{zh ? "模型暂时无法读取。" : "Models could not be loaded."} <button type="button" onClick={() => catalog.refetch()}>{zh ? "重试" : "Retry"}</button></p> : catalog.profiles.length ? <ul className="settingsModelList">
              {catalog.profiles.map((profile) => <li key={profile.profileId}><span className="settingsProviderIcon"><Cpu size={18} /></span><div><strong>{profile.displayName}</strong><small>{profile.selectable ? (zh ? "可用于任务" : "Ready for tasks") : profile.readinessReason || (zh ? "暂不可用" : "Unavailable")}</small></div>{profile.defaultForCapabilities?.includes("chat") ? <span className="settingsDefault"><Check size={13} />{zh ? "默认" : "Default"}</span> : null}</li>)}
            </ul> : <div className="settingsEmpty"><strong>{zh ? "还没有连接模型" : "No models connected"}</strong><p>{admin ? (zh ? "连接一个模型后，就可以开始任务。" : "Connect a model to start a task.") : (zh ? "请联系团队管理员为你开通模型。" : "Ask your team administrator to enable a model for you.")}</p></div>}
            {admin ? <button type="button" className="settingsAddModel" onClick={() => setConnecting(true)}>＋ {zh ? "连接模型" : "Connect a model"}<ChevronRight size={15} /></button> : null}
          </> : section === "agents" ? <NativeConnections key={`${principal.workspaceId}:${principal.userId}`} workspace={workspace} principal={principal} enabled={open} /> : section === "appearance" ? <>
            <h3>{zh ? "外观与语言" : "Appearance and language"}</h3>
            <div className="settingsPreference"><span>{zh ? "外观" : "Theme"}</span><div role="group" aria-label={zh ? "外观" : "Theme"}>{["light", "dark"].map((mode) => <button key={mode} type="button" aria-pressed={workspace.theme === mode} onClick={() => workspace.setTheme(mode)}>{mode === "light" ? (zh ? "浅色" : "Light") : (zh ? "深色" : "Dark")}</button>)}</div></div>
            <div className="settingsPreference"><span>{zh ? "语言" : "Language"}</span><div role="group" aria-label={zh ? "语言" : "Language"}><button type="button" aria-pressed={zh} onClick={() => workspace.setLocale("zh")}>中文</button><button type="button" aria-pressed={!zh} onClick={() => workspace.setLocale("en")}>English</button></div></div>
          </> : <>
            <h3>{zh ? "团队空间" : "Team workspace"}</h3>
            <p>{zh ? "私人任务只属于你。共享给团队后，成员才会看到你选择的交接内容。" : "Private tasks belong to you. Teammates see only the handoff you choose to share."}</p>
            <button type="button" className="settingsAddModel" onClick={() => { onClose(); workspace.setActivePage("work"); }}>{zh ? "查看团队工作" : "Open team work"}<ChevronRight size={15} /></button>
            {admin ? <button type="button" className="settingsAddModel" onClick={() => { onClose(); workspace.setActivePage("members"); }}>{zh ? "管理成员与邀请" : "Manage members and invitations"}<ChevronRight size={15} /></button> : null}
          </>}
        </section>
      </div>
    </Dialog>
    <ModelSetupDialog open={open && connecting} principal={principal} locale={workspace.locale} onClose={() => setConnecting(false)} onCreated={(_, recipient) => {
      workspace.pushToast(zh ? `已为 ${recipient.recipientName || "你"} 启用模型。` : `Model enabled for ${recipient.recipientName || "you"}.`);
    }} />
  </>;
}
