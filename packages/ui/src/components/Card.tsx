import type { ReactNode } from 'react';
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-surface border border-line rounded-2xl p-5 ${className}`}>{children}</div>;
}
