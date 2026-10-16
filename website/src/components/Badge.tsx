import type { HTMLAttributes } from 'react';

const colors = {
  neutral: 'var(--text-dim)',
  accent: 'var(--accent)',
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof colors };

export function Badge({ tone = 'neutral', className = '', style, ...props }: BadgeProps) {
  const color = colors[tone];
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[3px] px-2 font-heading text-[10px] font-semibold uppercase tracking-[0.08em] ${className}`}
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)`, ...style }}
      {...props}
    />
  );
}

export function BadgeDot({ spinning = false }: { spinning?: boolean }) {
  return <span aria-hidden="true" className={`h-1.5 w-1.5 flex-none rounded-full bg-current ${spinning ? 'animate-pulse' : ''}`} />;
}
