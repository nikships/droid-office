import { h } from './dom';
import { MODEL_BRANDS, modelBrand, providerBrand, type ModelBrand, type ModelIdentity } from './model-brand';

/** Decorative: the adjacent text always supplies the accessible model/provider name. */
function logo(brand: ModelBrand | undefined): HTMLElement {
  if (!brand) return h('span.ai-logo.fallback', { 'aria-hidden': 'true' }, '◇');
  const mark: { file: string; mono?: boolean; tile?: boolean } = MODEL_BRANDS[brand];
  return h('img.ai-logo', { src: `/icons/models/${mark.file}`, class: [mark.mono ? 'mono' : '', mark.tile ? 'tile' : ''].filter(Boolean).join(' '), alt: '', 'aria-hidden': 'true', width: 20, height: 20, draggable: 'false' });
}

export const modelLogo = (model: ModelIdentity): HTMLElement => logo(modelBrand(model));

export const providerLogo = (provider: string): HTMLElement | null => {
  const brand = providerBrand(provider);
  return brand ? logo(brand) : null;
};
