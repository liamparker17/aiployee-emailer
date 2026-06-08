import type { ButtonHTMLAttributes, ReactNode } from 'react';
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const cls: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:shadow-glow hover:brightness-110',
  secondary: 'bg-transparent text-ink border border-line-strong hover:border-accent hover:text-white',
  ghost: 'bg-transparent text-ink-muted hover:bg-surface hover:text-white',
  danger: 'bg-error text-white hover:brightness-110',
};
export function Button({ variant = 'primary', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-btn text-sm font-medium px-4 py-2 transition disabled:opacity-50 disabled:cursor-not-allowed ${cls[variant]}`}>
      {children}
    </button>
  );
}
