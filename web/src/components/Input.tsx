import type { InputHTMLAttributes, ReactNode } from 'react';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted mt-1">{hint}</span>}
    </label>
  );
}
