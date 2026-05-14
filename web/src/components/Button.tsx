import type { ButtonHTMLAttributes, ReactNode } from 'react';
type Variant = 'primary' | 'ghost' | 'danger';
const cls: Record<Variant, string> = {
  primary: 'bg-primary text-primary-ink hover:opacity-90',
  ghost: 'bg-transparent text-ink hover:bg-surface',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};
export function Button({ variant = 'primary', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button {...rest}
      className={`inline-flex items-center justify-center rounded-btn text-sm font-medium px-4 py-2 transition disabled:opacity-50 ${cls[variant]}`}>
      {children}
    </button>
  );
}
