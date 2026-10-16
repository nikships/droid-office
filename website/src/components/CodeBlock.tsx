import type { HTMLAttributes } from 'react';

export function CodeBlock({ className = '', ...props }: HTMLAttributes<HTMLPreElement>) {
  return <pre className={`m-0 select-text whitespace-pre-wrap break-words rounded-[3px] bg-bg-void p-3 font-heading text-[12px] leading-[1.5] text-text-dim ${className}`} {...props} />;
}
