import * as THREE from 'three';
import { SANS, MONO, loadFonts } from '../fonts';
import { ANISOTROPY } from './texture-quality';
import { paintGlyph, track } from './toon';

/** Static artwork for the unused room's screens. No state or interactions. */
export function glassRoomTexture(kind: 'board' | 'sign'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const board = kind === 'board';
  canvas.width = board ? 1500 : 500;
  canvas.height = board ? 500 : 800;
  const g = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = ANISOTROPY;
  const paint = () => {
    g.fillStyle = board ? '#050505' : '#0a0a0a';
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    if (!board) {
      g.strokeStyle = 'rgba(255, 255, 255, .18)';
      g.lineWidth = 3;
      g.strokeRect(1.5, 1.5, W - 3, H - 3);
      g.fillStyle = '#3ccf91';
      g.fillRect(28, 34, 18, 18);
      g.font = `600 30px ${MONO}`;
      track(g, 4);
      g.fillText('FREE', 62, 54);
      track(g, 0);
    }
    const x = board ? 60 : 28;
    const y = board ? 92 : 136;
    const px = board ? 26 : 20;
    g.fillStyle = '#ee6018';
    paintGlyph(g, x + px * 0.5, y - px * 0.36, px * 1.05);
    g.font = `600 ${px}px ${MONO}`;
    track(g, px * 0.16);
    g.fillText('MISSION CONTROL', x + px * 1.5, y);
    track(g, 0);
    g.fillStyle = 'rgba(255, 255, 255, .12)';
    g.fillRect(board ? 60 : 0, board ? 122 : 84, board ? W - 120 : W, 2);
    g.fillStyle = '#eeeeee';
    g.font = `600 ${board ? 64 : 46}px ${SANS}`;
    g.fillText('The table is free', x, board ? 250 : 210);
    texture.needsUpdate = true;
  };
  paint();
  if (document.fonts) void loadFonts().then(paint);
  return texture;
}
