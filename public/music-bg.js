/**
 * Darqie Music Background Bootstrap
 *
 * Runs as OBR background_url — stays alive the entire time the room is open.
 * This page does NOT play audio itself because background_url pages never receive
 * a browser user-activation event, so Chrome blocks all autoplay here.
 *
 * The only job of this script is to open (and keep open) the persistent OBR popover
 * "darqie.music.player" that loads /music-player.html.  OBR grants allow="autoplay"
 * to popovers, so the actual audio (Dropbox, YouTube, Spotify) plays there.
 */

// ── Bootstrap ────────────────────────────────────────────────────────────────

const PLAYER_POPOVER_ID = 'darqie.music.player';

function openPlayerPopover(OBR) {
  OBR.popover.open({
    id: PLAYER_POPOVER_ID,
    url: '/music-player.html',
    // Non-zero dimensions required so YouTube iframe inside gets Chrome autoplay.
    width: 300,
    height: 60,
    anchorOrigin:    { horizontal: 'RIGHT', vertical: 'BOTTOM' },
    transformOrigin: { horizontal: 'RIGHT', vertical: 'BOTTOM' },
    disableClickAway: true,
    hidePaper: true,
    marginThreshold: 0,
  }).catch(() => { /* already open */ });
}

function waitForOBR(cb) {
  if (window.OBR) { cb(window.OBR); return; }
  setTimeout(() => waitForOBR(cb), 200);
}

waitForOBR((OBR) => {
  OBR.onReady(() => openPlayerPopover(OBR));
});

// ── end of file ───────────────────────────────────────────────────────────────
