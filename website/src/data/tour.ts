import type { TourChapter, VideoClip } from '../types/content';

export const demoReel: VideoClip = {
  title: 'Droid Office in 90 seconds',
  duration: '1:34',
  src: '/videos/reel.mp4',
  poster: '/videos/reel.jpg',
};

export const tourChapters: TourChapter[] = [
  {
    id: 'hire',
    index: '01',
    label: 'Hire',
    title: 'A desk for every agent',
    summary: 'Walk up, press E, pick a model and reasoning effort. A Droid worker sits down and its live terminal opens on the laptop in front of it.',
    video: {
      title: 'Hiring a Droid worker at an empty desk',
      duration: '0:19',
      src: '/videos/tour-01.mp4',
      poster: '/videos/tour-01.jpg',
    },
  },
  {
    id: 'terminals',
    index: '02',
    label: 'Terminals',
    title: 'One terminal, every window',
    summary: 'Step into any worker’s real terminal. Open the same session in a second tab and it streams in both, with full scrollback.',
    video: {
      title: 'Stepping into a live worker terminal',
      duration: '0:23',
      src: '/videos/tour-02.mp4',
      poster: '/videos/tour-02.jpg',
    },
  },
  {
    id: 'floors',
    index: '03',
    label: 'Floors',
    title: 'A floor per project',
    summary: 'Ride the elevator, pick a git project you already have, and the office opens a new floor right where it is. Nothing is cloned.',
    video: {
      title: 'Opening a new floor from the elevator',
      duration: '0:21',
      src: '/videos/tour-03.mp4',
      poster: '/videos/tour-03.jpg',
    },
  },
  {
    id: 'boards',
    index: '04',
    label: 'Boards',
    title: 'Boards you can touch',
    summary: 'Issues and pull requests hang on the wall. Take a card off the board, carry it across the room and hand it to a worker.',
    video: {
      title: 'Handing an issue card to a worker',
      duration: '0:24',
      src: '/videos/tour-04.mp4',
      poster: '/videos/tour-04.jpg',
    },
  },
  {
    id: 'pipelines',
    index: '05',
    label: 'Pipelines',
    title: 'CI on the wall',
    summary: 'GitHub Actions runs or GitLab pipelines show up as they run, wait and finish. Open a run, re-run what failed, or ask the Pipeline agent.',
    video: {
      title: 'Watching and re-running CI from the Pipelines board',
      duration: '0:23',
      src: '/videos/tour-05.mp4',
      poster: '/videos/tour-05.jpg',
    },
  },
  {
    id: 'whiteboard',
    index: '06',
    label: 'Whiteboard',
    title: 'A Whiteboard you share',
    summary: 'Workers put live HTML pages, screenshots and forms on the wall. Mark them up with comments and stickies, and the next read picks up your changes.',
    video: {
      title: 'Marking up a worker’s Whiteboard page',
      duration: '0:30',
      src: '/videos/tour-06.mp4',
      poster: '/videos/tour-06.jpg',
    },
  },
];
