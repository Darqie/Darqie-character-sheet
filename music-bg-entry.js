import OBR from '@owlbear-rodeo/sdk';

/**
 * Music Background Bootstrap
 * Runs as background_url — stays alive the entire room session.
 * Opens a persistent popover (music-player.html) that plays audio.
 * The popover gets allow="autoplay" from OBR, so Chrome autoplay works there.
 */

OBR.onReady(async () => {
  console.log('[MusicBG] OBR ready — opening 1×1 background music popover');
  // Always close first so stale popovers (loaded from old URLs) don't persist
  try { await OBR.popover.close('darqie.music.player'); } catch (_) {}

  // The popover is 1×1 invisible for everyone.
  // — GM:      hears YouTube via the iframe in the music tab; popover plays audio/dropbox/spotify only.
  // — Players: popover plays everything (incl. YouTube audio in 1×1 iframe via allow="autoplay").
  const openArgs = {
    id: 'darqie.music.player',
    url: '/audio-player.html',
    width:  1,
    height: 1,
    anchorOrigin:    { horizontal: 'RIGHT', vertical: 'BOTTOM' },
    transformOrigin: { horizontal: 'RIGHT', vertical: 'BOTTOM' },
    disableClickAway: true,
    hidePaper: true,
    marginThreshold: 0,
  };

  try {
    await OBR.popover.open(openArgs);
    console.log('[MusicBG] Popover opened successfully');
  } catch (err) {
    console.error('[MusicBG] Popover open FAILED:', err?.message || err);
    setTimeout(async () => {
      try {
        await OBR.popover.open(openArgs);
        console.log('[MusicBG] Popover opened on retry');
      } catch (e) { console.error('[MusicBG] Retry failed:', e?.message || e); }
    }, 2000);
  }
});
