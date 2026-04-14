import OBR from '@owlbear-rodeo/sdk';

/**
 * Music Background Bootstrap — runs as background_url (audio-bg.html).
 * Stays alive the entire room session.
 * Opens a persistent 1×1 invisible popover (audio-player.html) that has
 * allow="autoplay" from OBR — all audio playback happens there.
 */

OBR.onReady(async () => {
  console.log('[MusicBG] OBR ready — opening 1×1 music player popover');
  try { await OBR.popover.close('darqie.music.player'); } catch (_) {}

  await OBR.popover.open({
    id: 'darqie.music.player',
    url: '/audio-player.html',
    width: 1,
    height: 1,
    anchorOrigin:    { horizontal: 'RIGHT', vertical: 'BOTTOM' },
    transformOrigin: { horizontal: 'RIGHT', vertical: 'BOTTOM' },
    disableClickAway: true,
    hidePaper: true,
    marginThreshold: 0,
  });
  console.log('[MusicBG] Music player popover opened');
});
