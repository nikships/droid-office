import type { TourChapter, VideoBrief } from '../types/content';

export const demoReel: VideoBrief = {
  slot: 'reel',
  title: 'Droid Office in 90 seconds',
  duration: '1:30',
  shows: [
    'Opening shot: the Mac app opens full screen on the night-time cutaway of the building, then the camera pushes in to one floor.',
    'A worker gets hired at an empty desk and its live terminal starts on the laptop.',
    'An issue card comes off the Issues board, gets carried across the room and handed to that worker.',
    'Pipelines board goes red, Auto-heal wakes the Pipeline agent, and a fixer worker sits down at a desk.',
    'A PR merges: the worker spins and throws confetti and the merge gong rings across the floor.',
    'Ride the glass elevator to another project floor, then end on the rooftop.',
  ],
};

export const tourChapters: TourChapter[] = [
  {
    id: 'hire',
    index: '01',
    label: 'Hire',
    title: 'A desk for every agent',
    summary: 'Walk up, press E, pick a model and reasoning effort. A Droid worker sits down and its live terminal opens on the laptop in front of it.',
    video: {
      slot: 'tour-01',
      title: 'Hiring a Droid worker at an empty desk',
      duration: '0:20',
      shows: [
        'Player walks up to an empty desk and the "press E" prompt appears.',
        'The hire panel opens: pick a model (show a custom model in the list) and set reasoning effort.',
        'A robot worker walks in and sits down; the laptop boots into a live droid session.',
        'Cut to the top bar ticking the working count from 4 to 5.',
      ],
    },
  },
  {
    id: 'terminals',
    index: '02',
    label: 'Terminals',
    title: 'One terminal, every window',
    summary: 'Step into any worker’s real terminal. Open the same session in a second tab and it streams in both, with full scrollback.',
    video: {
      slot: 'tour-02',
      title: 'Stepping into a live worker terminal',
      duration: '0:18',
      shows: [
        'Camera zooms from the desk into the laptop screen until the terminal fills the view.',
        'Type a prompt into the composer; the droid session responds live.',
        'Split screen: the same session open in a second browser tab, both streaming the same output.',
        'Scroll back through earlier output to show full scrollback is kept.',
      ],
    },
  },
  {
    id: 'floors',
    index: '03',
    label: 'Floors',
    title: 'A floor per project',
    summary: 'Ride the elevator, pick a git project you already have, and the office opens a new floor right where it is. Nothing is cloned.',
    video: {
      slot: 'tour-03',
      title: 'Opening a new floor from the elevator',
      duration: '0:22',
      shows: [
        'Player steps into the glass elevator and opens the floor picker.',
        'Pick an existing local git repo from the list; call out that nothing gets cloned.',
        'Doors open on a fresh floor with its own desks, boards and wall and floor colours.',
        'Quick ride back down to show the other floors still running.',
      ],
    },
  },
  {
    id: 'boards',
    index: '04',
    label: 'Boards',
    title: 'Boards you can touch',
    summary: 'Issues and pull requests hang on the wall. Take a card off the board, carry it across the room and hand it to a worker.',
    video: {
      slot: 'tour-04',
      title: 'Handing an issue card to a worker',
      duration: '0:20',
      shows: [
        'Wide shot of the Issues and PR boards on the wall.',
        'Player pulls an issue card off the board, filters by label first if possible.',
        'Carry the card across the room and hand it to an idle worker, who starts on it.',
        'End on the matching PR or merge request card appearing on the PR board.',
      ],
    },
  },
  {
    id: 'pipelines',
    index: '05',
    label: 'Pipelines',
    title: 'CI on the wall',
    summary: 'GitHub Actions runs or GitLab pipelines show up as they run, wait and finish. Open a run, re-run what failed, or ask the Pipeline agent.',
    video: {
      slot: 'tour-05',
      title: 'Watching and re-running CI from the Pipelines board',
      duration: '0:20',
      shows: [
        'The Pipelines board updating live: runs moving from queued to running to passed or failed.',
        'Open a failed run to see its jobs and steps.',
        'Re-run the failed job straight from the board.',
        'Turn on Auto-heal for the floor with the toggle.',
      ],
    },
  },
  {
    id: 'whiteboard',
    index: '06',
    label: 'Whiteboard',
    title: 'A Whiteboard you share',
    summary: 'Workers put live HTML pages, screenshots and forms on the wall. Mark them up with comments and stickies, and the next read picks up your changes.',
    video: {
      slot: 'tour-06',
      title: 'Marking up a worker’s Whiteboard page',
      duration: '0:24',
      shows: [
        'A worker posts a live HTML page to the Whiteboard.',
        'Open it full screen and use it (click through the page or fill in a form).',
        'Add a comment and a sticky note on top of it.',
        'The worker reads the board again and posts an updated version.',
      ],
    },
  },
];
