import React, { useEffect, useRef } from "react";
import {
  Bot,
  ChevronRight,
  Globe,
  Monitor,
  Settings2,
  Users,
  X,
} from "lucide-react";
export function WorkbenchSettings({
  onClose,
  onAgents,
  onModels,
  onCapabilities,
  onTeam,
}) {
  const dialog = useRef(null);
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  const entries = [
    {
      icon: Bot,
      title: "我的助手",
      text: "连接你习惯使用的 Agent，检查登录状态。",
      action: onAgents,
    },
    {
      icon: Monitor,
      title: "文件与电脑操作",
      text: "准备文件处理工具，管理可操作的网站和应用。",
      action: onCapabilities,
    },
    {
      icon: Users,
      title: "团队连接",
      text: "需要共享或云端协作时，再连接团队。",
      action: onTeam,
    },
    {
      icon: Globe,
      title: "模型服务",
      text: "使用公司模型网关或自己的模型服务。",
      action: onModels,
    },
  ];
  return (
    <dialog
      ref={dialog}
      className="workbenchSettings"
      aria-labelledby="settings-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="settingsHeading">
        <span>
          <Settings2 size={18} />
          <h2 id="settings-title">设置</h2>
        </span>
        <button aria-label="关闭设置" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <p>按你的工作方式配置，日常使用从对话开始。</p>
      <div>
        {entries.map(({ icon: Icon, title, text, action }) => (
          <button className="settingsEntry" key={title} onClick={action}>
            <Icon size={19} />
            <span>
              <strong>{title}</strong>
              <small>{text}</small>
            </span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
    </dialog>
  );
}
