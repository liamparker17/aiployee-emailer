export function ProgressBar({ step }: { step: '1' | '2' | '3' }) {
  const items: Array<['1' | '2' | '3', string]> = [['1', 'Tenant'], ['2', 'Sender'], ['3', 'Test']];
  return (
    <ol className="flex items-center gap-4 mb-8">
      {items.map(([n, label], i) => {
        const active = n === step;
        const done = Number(n) < Number(step);
        return (
          <li key={n} className="flex items-center gap-2 text-sm">
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
              active ? 'bg-ink text-white' : done ? 'bg-green-600 text-white' : 'bg-surface text-muted'
            }`}>{n}</span>
            <span className={active ? 'font-medium' : 'text-muted'}>{label}</span>
            {i < items.length - 1 && <span className="w-8 h-px bg-line ml-2" />}
          </li>
        );
      })}
    </ol>
  );
}
