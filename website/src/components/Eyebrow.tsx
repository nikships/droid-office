import type { HTMLAttributes } from 'react';

export function Eyebrow({ index, className = '', children, ...props }: HTMLAttributes<HTMLParagraphElement> & { index?: string }) {
  return (
    <p className={`inline-flex items-baseline gap-2 font-heading text-[10px] font-semibold uppercase tracking-[0.16em] text-text-dim ${className}`} {...props}>
      {index && <span className="text-accent">{index}</span>}
      {children}
    </p>
  );
}
