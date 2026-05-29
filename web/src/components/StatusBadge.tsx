const styles: Record<string, string> = {
  sent: 'bg-success/15 text-success border-success/30',
  delivered: 'bg-success/15 text-success border-success/30',
  queued: 'bg-cyan/15 text-cyan border-cyan/30',
  sending: 'bg-cyan/15 text-cyan border-cyan/30',
  failed: 'bg-error/15 text-error border-error/30',
  bounced: 'bg-error/15 text-error border-error/30',
};
export function StatusBadge({ status }: { status: string }) {
  const s = styles[status.toLowerCase()] ?? 'bg-violet/15 text-violet border-violet/30';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${s}`}>
      {status}
    </span>
  );
}
