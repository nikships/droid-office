// ⚙️ Settings → Appearance (the companions only): the theme, the wallpaper behind the glass, how
// see-through the glass is and whether the backdrop moves. Saved in this browser (companion-theme.ts)
// and applied live to the whole page.

import { COMPANION_THEMES, type GlassLevel } from '../../shared/companion-themes';
import { APPEARANCE_MOTION, appearancePrefs, isDefaultAppearancePrefs, onAppearancePrefs, resetAppearancePrefs, setAppearancePrefs, type AppearancePrefs } from './companion-theme';
import { h } from './dom';

interface Parts {
  desc: Node;
  control?: Node;
  below?: Node[];
}

function seg<K extends keyof AppearancePrefs>(key: K, label: string, options: readonly (readonly [AppearancePrefs[K], string])[]) {
  const row = h('div.seg', { role: 'radiogroup', 'aria-label': label });
  const paint = () => {
    const at = appearancePrefs()[key];
    row.replaceChildren(
      ...options.map(([value, text]) =>
        h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(at === value), class: at === value ? 'on' : '', onclick: () => setAppearancePrefs({ [key]: value } as Partial<AppearancePrefs>) }, text),
      ),
    );
  };
  return { row, paint };
}

export function appearanceSettings(): { theme: Parts; wallpaper: Parts; glass: Parts; motion: Parts; restore: Parts; dispose: () => void } {
  const select = h(
    'select.select',
    { 'aria-label': 'Theme', onchange: () => setAppearancePrefs({ theme: select.value as AppearancePrefs['theme'] }) },
    ...COMPANION_THEMES.map((t) => h('option', { value: t.id }, t.name)),
  ) as HTMLSelectElement;
  const wallpaper = seg('wallpaper', 'Wallpaper', [
    ['theme', 'Theme artwork'],
    ['none', 'None'],
  ]);
  const glass = seg('glass', 'Glass', [
    ['clear', 'Clear'],
    ['frosted', 'Frosted'],
    ['solid', 'Solid'],
  ] as const satisfies readonly (readonly [GlassLevel, string])[]);
  const motion = seg(
    'motion',
    'Motion',
    APPEARANCE_MOTION.map((m) => [m, m === 'live' ? 'Live' : 'Still'] as const),
  );
  const restore = h('button.btn', { type: 'button', onclick: resetAppearancePrefs }, 'Restore defaults') as HTMLButtonElement;
  const paint = () => {
    select.value = appearancePrefs().theme;
    for (const s of [wallpaper, glass, motion]) s.paint();
    restore.disabled = isDefaultAppearancePrefs(appearancePrefs());
  };
  paint();
  const off = onAppearancePrefs(paint);
  return {
    theme: { desc: h('small', {}, 'How the companion looks. OG is the original.'), control: select },
    wallpaper: { desc: h('small', {}, 'The picture behind the glass.'), control: wallpaper.row },
    glass: { desc: h('small', {}, 'How much of the backdrop shows through the panels.'), control: glass.row },
    motion: { desc: h('small', {}, 'Whether the backdrop moves.'), control: motion.row },
    restore: { desc: h('small', {}, 'Put every Appearance setting back to how it came.'), control: restore },
    dispose: off,
  };
}
