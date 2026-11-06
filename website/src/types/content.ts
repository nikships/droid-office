export type VideoClip = {
  title: string;
  duration: string;
  src: string;
  poster: string;
};

export type TourChapter = {
  id: string;
  index: string;
  label: string;
  title: string;
  summary: string;
  video: VideoClip;
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

export type WhyPoint = {
  id: string;
  title: string;
  body: string;
};

export type Stat = {
  value: string;
  label: string;
};

export type RunsOn = {
  id: string;
  name: string;
  where: string;
  tool: string;
  body: string;
  does: string[];
};

export type HookSignal = {
  name: string;
  note: string;
};

export type OfficeTool = {
  name: string;
  note: string;
};

export type NavLink = {
  href: string;
  label: string;
};
