export type VideoBrief = {
  slot: string;
  title: string;
  duration: string;
  shows: string[];
};

export type TourChapter = {
  id: string;
  index: string;
  label: string;
  title: string;
  summary: string;
  video: VideoBrief;
};

export type Pillar = {
  id: string;
  title: string;
  body: string;
};

export type FunThing = {
  name: string;
  note: string;
};

export type BoardAgent = {
  id: string;
  name: string;
  station: string;
  tool: string;
  body: string;
  does: string[];
};

export type AutoHealStep = {
  time: string;
  actor: string;
  message: string;
  status: 'failed' | 'running' | 'success';
};

export type WhyPoint = {
  id: string;
  title: string;
  body: string;
};

export type Stat = {
  value: string;
  label: string;
};

export type NavLink = {
  href: string;
  label: string;
};
