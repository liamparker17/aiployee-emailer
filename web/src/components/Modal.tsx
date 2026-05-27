import type { ReactNode } from 'react';
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 overflow-y-auto" onClick={onClose}>
      <div className="flex min-h-full items-start justify-center p-4">
        <div className="bg-bg rounded-lg w-[480px] max-w-full my-8 p-6 shadow-xl" onClick={e => e.stopPropagation()}>
          <h3 className="text-lg font-semibold mb-4">{title}</h3>
          {children}
        </div>
      </div>
    </div>
  );
}
