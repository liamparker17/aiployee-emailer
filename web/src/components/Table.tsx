import type { ReactNode } from 'react';
export function Table({ children }: { children: ReactNode }) {
  return <table className="w-full text-sm border border-line rounded-lg overflow-hidden">{children}</table>;
}
export function Th({ children }: { children: ReactNode }) {
  return <th className="text-left font-medium text-muted bg-surface px-4 py-2 border-b border-line">{children}</th>;
}
export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-2 border-b border-line align-middle ${className}`}>{children}</td>;
}
