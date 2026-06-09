import type { InputHTMLAttributes, ReactNode } from 'react';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props}
    className="w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40" />;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-ink-muted mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-dim mt-1">{hint}</span>}
    </label>
  );
}
