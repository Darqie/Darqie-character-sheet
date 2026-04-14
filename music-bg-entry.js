import OBR from '@owlbear-rodeo/sdk';

/**
 * Background bootstrap only.
 * Keep audio playback in popover document where OBR grants autoplay.
 */

const PLAYER_POPOVER_ID = 'darqie.music.player';

OBR.onReady(async () => {
  console.info('[MusicBG] Opening music player popover');

  try { await OBR.popover.close(PLAYER_POPOVER_ID); } catch (_) {}

  try {
    await OBR.popover.open({
      id: PLAYER_POPOVER_ID,
      url: '/audio-player.html',
      width: 1,
      height: 1,
      anchorOrigin: { horizontal: 'RIGHT', vertical: 'BOTTOM' },
      transformOrigin: { horizontal: 'RIGHT', vertical: 'BOTTOM' },
      hidePaper: true,
      marginThreshold: 0,
      disableClickAway: false,
    });
    console.info('[MusicBG] Music player popover opened');
  } catch (e) {
    console.error('[MusicBG] Failed to open music player popover:', e?.message || e);
  }
});
