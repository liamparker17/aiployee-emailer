import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { useToast } from './Toast';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button type="button" onClick={async () => {
      await navigator.clipboard.writeText(value);
      setDone(true); setTimeout(() => setDone(false), 1500);
      toast.success('Copied');
    }} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-line hover:bg-surface text-ink-muted hover:text-ink shrink-0 transition">
      {done ? <Check size={12} /> : <Copy size={12} />}{done ? 'Copied' : label}
    </button>
  );
}
