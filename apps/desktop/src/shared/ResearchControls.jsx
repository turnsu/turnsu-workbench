import React from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown, Settings2 } from 'lucide-react';

export const Button = React.forwardRef(function Button({ variant = 'ghost', size = 'default', className = '', type = 'button', ...props }, ref) {
  return <BaseButton ref={ref} type={type} data-slot="button" data-variant={variant} data-size={size} className={className} {...props}/>;
});
export const Input = React.forwardRef(function Input(props, ref) { return <input ref={ref} data-slot="input" {...props}/>; });
export const Textarea = React.forwardRef(function Textarea(props, ref) { return <textarea ref={ref} data-slot="textarea" {...props}/>; });
export function Badge({ variant = 'secondary', ...props }) { return <span data-slot="badge" data-variant={variant} {...props}/>; }

// The same controls ship inside the sandbox App. Only the host owns permissions
// and data; these controls own keyboard navigation, focus and presentation.
export function ChoiceMenu({ label, trigger, triggerRef, className = '', side = 'bottom', align = 'start', onOpenChange, children }) {
  return <Menu.Root onOpenChange={onOpenChange}>
    <Menu.Trigger ref={triggerRef} className={className} aria-label={label}>{trigger}</Menu.Trigger>
    <Menu.Portal><Menu.Positioner side={side} align={align} sideOffset={6} className="researchPopoverPositioner">
      <Menu.Popup className="researchMenu">{children}</Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}
export function MenuItem({ icon: Icon, selected, children, ...props }) {
  return <Menu.Item className="researchMenuItem" {...props}>{Icon && <Icon size={15}/>}<span>{children}</span>{selected && <Check size={14}/>}</Menu.Item>;
}
export function MenuLabel({ children }) { return <div className="researchMenuLabel">{children}</div>; }
export function MenuSeparator() { return <Menu.Separator className="researchMenuSeparator"/>; }

export function SelectField({ label, value, items, disabled, onChange }) {
  return <Select.Root value={value} items={items} disabled={disabled} onValueChange={onChange}>
    <Select.Trigger aria-label={label} className="researchSelect"><Select.Value/><Select.Icon><ChevronDown size={14}/></Select.Icon></Select.Trigger>
    <Select.Portal><Select.Positioner alignItemWithTrigger={false} sideOffset={5} className="researchPopoverPositioner"><Select.Popup className="researchMenu researchSelectPopup">
      <Select.List>{items.map(item => <Select.Item key={item.value} value={item.value} disabled={item.disabled} className="researchMenuItem"><Select.ItemText>{item.label}</Select.ItemText><Select.ItemIndicator><Check size={14}/></Select.ItemIndicator></Select.Item>)}</Select.List>
    </Select.Popup></Select.Positioner></Select.Portal>
  </Select.Root>;
}

export function AssistantOptions({ model, onOpenChange, children }) {
  const trigger = React.useRef(null);
  return <Popover.Root onOpenChange={onOpenChange}>
    <Popover.Trigger ref={trigger} className="agentOptionsTrigger" aria-label="助手选项" title="模型与连接设置"><span className="composerModel">{model || '模型设置'}</span><Settings2 size={15}/><ChevronDown size={12}/></Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="top" align="start" sideOffset={10} className="researchPopoverPositioner"><Popover.Popup finalFocus={trigger} className="connectionSource" aria-label="助手设置">{children}</Popover.Popup></Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
