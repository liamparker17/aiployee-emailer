import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

type Toast = { id: number; kind: 'success' | 'error'; message: string };
type ToastApi = { success: (m: string) => void; error: (m: string) => void };
const Ctx = createContext<ToastApi>({ success: () => {}, error: () => {} });
export function useToast() { return useContext(Ctx); }

let nextId = 1;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const remove = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);
  const push = useCallback((kind: 'success' | 'error', message: string) => {
    const id = nextId++;
    setToasts(t => [...t, { id, kind, message }]);
    setTimeout(() => remove(id), 4000);
  }, [remove]);
  const api: ToastApi = {
    success: (m) => push('success', m),
    error: (m) => push('error', m),
  };
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map(t => (
          <div key={t.id}
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-glow bg-surface-raised ${
              t.kind === 'success' ? 'border-success/40 text-success' : 'border-error/40 text-error'
            }`}>
            {t.kind === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <span className="text-ink">{t.message}</span>
            <button onClick={() => remove(t.id)} className="ml-2 text-ink-dim hover:text-ink"><X size={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
