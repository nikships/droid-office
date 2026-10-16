import type { ButtonHTMLAttributes } from 'react';

const variants = {
  primary: 'bg-[#eeeeee] border-[#eeeeee] text-[#020202] font-semibold hover:enabled:bg-white hover:enabled:border-white hover:enabled:text-[#020202] active:enabled:bg-[#8c8c8c]',
  ghost: 'bg-transparent border-transparent text-[#8c8c8c] hover:enabled:text-[#ef6f2e]',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: 'sm';
};

export function Button({ variant, size, className = '', style, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-[3px] border border-solid font-heading font-medium uppercase tracking-[0.08em] whitespace-nowrap transition-colors duration-[120ms] disabled:opacity-40',
        size === 'sm' ? 'h-[28px] px-3 text-[10px]' : 'h-[34px] px-4 text-[11px]',
        variant ? variants[variant] : 'border-line-strong bg-bg-raised text-text hover:enabled:border-accent hover:enabled:text-accent-bright',
        className,
      ].join(' ')}
      style={style}
      {...props}
    />
  );
}
