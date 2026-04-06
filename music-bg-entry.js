import OBR from '@owlbear-rodeo/sdk';

/**
 * Music Background Bootstrap
 * Runs as background_url — stays alive the entire room session.
 * Opens a persistent popover (music-player.html) that plays audio.
 * The popover gets allow="autoplay" from OBR, so Chrome autoplay works there.
 */

OBR.onReady(async () => {
  try {
    await OBR.popover.open({
      id: 'darqie.music.player',
      url: '/audio-player.html',
      // 300×60px — large enough for YouTube control bar and Chrome autoplay grants
      width: 300,
      height: 60,
      anchorOrigin:    { horizontal: 'RIGHT', vertical: 'BOTTOM' },
      transformOrigin: { horizontal: 'RIGHT', vertical: 'BOTTOM' },
      disableClickAway: true,
      hidePaper: true,
      marginThreshold: 0,
    });
  } catch (_) {
    // popover already open — ignore
  }
});
