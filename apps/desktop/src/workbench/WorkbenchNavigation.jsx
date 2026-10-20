import React from 'react';
import { ChevronDown, Clock, Folder, Laptop, MessageSquare, Monitor, Moon, Plus, Puzzle, Settings2, Sun } from 'lucide-react';
import { Button, ChoiceMenu, MenuItem, MenuLabel, MenuSeparator } from '../shared/ResearchControls.jsx';

export function WorkbenchNavigation({ open, view, onView, onSchedules, appearance, onAppearance, onPopupChange, settingsRef, onSettings, children }) {
  return <aside className="sidebar" aria-label="工作导航" id="work-navigation" hidden={!open}>
    <div className="brandMark" title="Turnsu 工作台"><img src="./brand/turnsu-symbol.svg" alt=""/><span>Turnsu</span><small>工作空间</small></div>
    <nav className="railPrimary" aria-label="主要功能">
      <Button aria-label="对话" aria-current={view === 'workbench' ? 'page' : undefined} onClick={() => onView('workbench')}><MessageSquare size={17}/>工作台</Button>
      <Button aria-label="插件与技能" aria-current={view === 'skills' ? 'page' : undefined} onClick={() => onView('skills')}><Puzzle size={17}/>插件与技能</Button>
      <Button aria-label="定时任务" onClick={onSchedules}><Clock size={17}/>定时任务</Button>
    </nav>
    <div className="workspaceRail">{children}</div>
    <div className="sidebarFooter"><span className="localLabel"><Laptop size={14}/>本地工作空间</span><div className="railUtilities">
      <ChoiceMenu label="切换阅读外观" className="appearanceMenu" side="top" align="end" onOpenChange={open => onPopupChange('appearance', open)} trigger={appearance === 'system' ? <Monitor size={17}/> : appearance === 'dark' ? <Moon size={17}/> : <Sun size={17}/>}>
        <MenuLabel>阅读外观</MenuLabel>{[['system','跟随系统',Monitor],['light','明亮',Sun],['dark','暗色',Moon]].map(([value,label,Icon]) => <MenuItem key={value} icon={Icon} selected={appearance === value} onClick={() => onAppearance(value)}>{label}</MenuItem>)}
      </ChoiceMenu>
      <Button title="设置" aria-label="设置" ref={settingsRef} onClick={onSettings}><Settings2 size={17}/></Button>
    </div></div>
  </aside>;
}

export function ProjectSwitcher({ projects, currentId, title, disabled, onSelect, onOpen, onManage, triggerRef, onOpenChange }) {
  return <ChoiceMenu label="选择工作文件夹" className="projectSwitcher" triggerRef={triggerRef} onOpenChange={onOpenChange} trigger={<><Folder size={16}/><span>{title || '选择工作文件夹'}</span><ChevronDown size={14}/></>}>
    <MenuLabel>工作文件夹</MenuLabel>{projects.map(project => <MenuItem key={project.id} icon={Folder} selected={project.id === currentId} disabled={disabled} onClick={() => onSelect(project.id)}>{project.sharing?.title || project.name}</MenuItem>)}
    <MenuSeparator/><MenuItem icon={Plus} disabled={disabled} onClick={onOpen}>打开工作文件夹</MenuItem><MenuItem icon={Settings2} onClick={onManage}>管理项目</MenuItem>
  </ChoiceMenu>;
}
