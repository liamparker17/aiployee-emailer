import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm overflow-y-auto" onClick={onClose}>
      <div className="flex min-h-full items-start justify-center p-4">
        <div className="bg-surface-raised border border-line-strong rounded-2xl w-[480px] max-w-full my-8 p-6 shadow-glow" onClick={e => e.stopPropagation()}>
          <h3 className="text-lg font-semibold text-ink mb-4">{title}</h3>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
