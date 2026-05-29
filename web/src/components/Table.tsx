import type { ReactNode } from 'react';
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="border border-line rounded-xl overflow-hidden bg-surface">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}
export function Th({ children }: { children: ReactNode }) {
  return <th className="text-left font-medium text-ink-dim uppercase text-xs tracking-wide bg-surface-raised px-4 py-3 border-b border-line">{children}</th>;
}
export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 border-b border-line text-ink-muted align-middle ${className}`}>{children}</td>;
}
