import React, { useEffect, useRef } from "react";
import {
  Bot,
  ChevronRight,
  Globe,
  Puzzle,
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
  appearance = 'system',
  textSize = 'standard',
  onAppearance,
  onTextSize,
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
      icon: Puzzle,
      title: "插件与技能",
      text: "添加电脑操作、办公文件工具和自己的 Skill。",
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
      <section className="readingSettings" aria-labelledby="reading-settings-title">
        <h3 id="reading-settings-title">外观和阅读</h3>
        <fieldset><legend>外观</legend><div className="readingChoices">{[['system','跟随系统'],['light','明亮'],['dark','暗色']].map(([value,label]) => <label key={value}><input type="radio" name="appearance" value={value} checked={appearance === value} onChange={() => onAppearance(value)}/><span>{label}</span></label>)}</div></fieldset>
        <fieldset><legend>字号</legend><div className="readingChoices">{[['standard','标准'],['large','大字']].map(([value,label]) => <label key={value}><input type="radio" name="text-size" value={value} checked={textSize === value} onChange={() => onTextSize(value)}/><span>{label}</span></label>)}</div></fieldset>
        <p>对话和交互内容一起调整。大字增加字号和行高，照片保持原色。</p>
      </section>
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
