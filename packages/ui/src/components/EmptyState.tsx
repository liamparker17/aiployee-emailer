import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-4 border border-dashed border-line-strong rounded-2xl bg-surface/50">
      <div className="grid place-items-center h-12 w-12 rounded-xl bg-magenta/15 text-magenta mb-4">
        <Icon size={24} />
      </div>
      <h3 className="text-base font-medium text-ink">{title}</h3>
      {description && <p className="text-sm text-ink-dim mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
