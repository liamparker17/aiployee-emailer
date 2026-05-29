export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-raised ${className}`} />;
}
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-line-strong border-t-magenta"
      style={{ width: size, height: size }}
    />
  );
}
