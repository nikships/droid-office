import { Eyebrow } from '../Eyebrow';

type SectionHeaderProps = {
  id?: string;
  index: string;
  label: string;
  title: string;
  lede?: string;
};

export function SectionHeader({ id, index, label, title, lede }: SectionHeaderProps) {
  return (
    <div className="max-w-[720px]">
      <Eyebrow index={index}>{label}</Eyebrow>
      <h2 id={id} className="mt-4 font-body text-[34px] font-medium leading-[1.08] tracking-[-0.025em] text-text md:text-[48px]">
        {title}
      </h2>
      {lede && <p className="mt-4 text-[17px] leading-[1.6] text-text-dim">{lede}</p>}
    </div>
  );
}
