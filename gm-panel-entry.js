import OBR, { buildImage, buildLabel } from '@owlbear-rodeo/sdk';

// Make OBR available globally so dynamically-loaded scripts (gm-pages/*.js) can access it
window.OBR = OBR;

// GM pages rely on builders off window.OBR; expose them explicitly in this entry context.
window.OBR.buildImage = buildImage;
window.OBR.buildLabel = buildLabel;

// Signal user interaction to audio-bg.html (background_url) so it can retry play() if blocked by autoplay policy.
document.addEventListener('click', () => {
  try { localStorage.setItem('darqie.userInteracted', String(Date.now())); } catch (_) {}
}, { capture: true, once: true });
