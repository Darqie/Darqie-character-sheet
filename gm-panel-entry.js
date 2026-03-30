import OBR, { buildImage, buildLabel } from '@owlbear-rodeo/sdk';

// Make OBR available globally so dynamically-loaded scripts (gm-pages/*.js) can access it
window.OBR = OBR;

// GM pages rely on builders off window.OBR; expose them explicitly in this entry context.
window.OBR.buildImage = buildImage;
window.OBR.buildLabel = buildLabel;
