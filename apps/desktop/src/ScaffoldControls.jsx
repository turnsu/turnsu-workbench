import React from 'react';

// Adapted for the existing esbuild/CSS desktop entry from turnsu/frontend-scaffold
// button.tsx, badge.tsx, input.tsx and textarea.tsx at 02203ea4. See THIRD_PARTY_NOTICES.md.
export const Button = React.forwardRef(function Button({ variant = 'ghost', size = 'default', className = '', type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} data-slot="button" data-variant={variant} data-size={size} className={className} {...props} />;
});

export function Badge({ variant = 'secondary', className = '', ...props }) {
  return <span data-slot="badge" data-variant={variant} className={className} {...props} />;
}

export const Input = React.forwardRef(function Input({ className = '', type = 'text', ...props }, ref) {
  return <input ref={ref} type={type} data-slot="input" className={className} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className = '', ...props }, ref) {
  return <textarea ref={ref} data-slot="textarea" className={className} {...props} />;
});
