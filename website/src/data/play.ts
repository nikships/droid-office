import type { FunThing, Pillar, VideoBrief } from '../types/content';

export const pillars: Pillar[] = [
  {
    id: 'fun',
    title: 'Genuinely fun',
    body: 'Walk the floor, hire workers, pull cards off the wall and hand them over. When a PR lands, ring the merge gong. Running a team of agents starts to feel like a game.',
  },
  {
    id: 'spatial',
    title: 'Built for visual thinkers',
    body: 'Work has a place. Billing is on floor 2 and the auth refactor is at desk 4. You remember where things are the way you remember a room, not a list of tabs.',
  },
  {
    id: 'glance',
    title: 'Everything in one room',
    body: 'Workers, boards, pipelines and the Whiteboard all live in the same space. Look around and you know what the whole team is doing.',
  },
];

export const funThings: FunThing[] = [
  { name: 'Rooftop', note: 'over the city, string lights included' },
  { name: 'Jukebox', note: 'put something on while they work' },
  { name: 'Weather', note: 'outside the windows, follows a real city' },
  { name: 'Merge gong', note: 'ring it when a PR lands' },
  { name: 'Fire pole', note: 'the fast way down a floor' },
  { name: 'Lounge TV', note: 'every Droid session on one screen' },
  { name: 'Bean bags', note: 'for when all 16 desks are taken' },
  { name: 'Droid wand', note: 'send a finished worker home' },
];

export const playVideo: VideoBrief = {
  slot: 'play',
  title: 'A lap around the office',
  duration: '0:30',
  shows: [
    'Slide down the fire pole to the floor below, landing next to a row of busy workers.',
    'Hand an issue card to a worker. It finishes, does a spin and throws confetti.',
    'The PR merges and someone rings the merge gong.',
    'Ride the elevator to the rooftop: jukebox playing, real weather over the city.',
    'Wave the Droid wand to send a finished worker home.',
  ],
};
