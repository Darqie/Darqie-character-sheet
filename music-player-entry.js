// This file is no longer used — all audio playback moved to music-bg-entry.js (audio-bg.html background_url)
import OBR from '@owlbear-rodeo/sdk';

/**
 * Music Player — persistent OBR popover (320×197px) — DEPRECATED
 * - YouTube: full native YouTube iframe, plain src + postMessage API for unmute/volume
 * - Dropbox / audio: hidden <audio> element, plays in background
 * - Spotify: hidden off-screen iframe
 *
 * Individual volume: localStorage per player
 * Global volume:     from OBR room metadata (set by GM)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const PLAYLIST_KEY   = 'darqie.v2.musicPlaylist';
const STATE_KEY      = 'darqie.v2.musicState';
const VOL_PREFIX     = 'darqie.v2.musicVolume';
const DEFAULT_VOL    = 0.7;

const SUPABASE_URL   = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_TABLE = 'room_music_state';

// ── DOM ───────────────────────────────────────────────────────────────────────

const ytIframe      = document.getElementById('ytIframe');
const bgAudio       = document.getElementById('bgAudio');
const spotifyIframe = document.getElementById('spotifyIframe');

// ── State ─────────────────────────────────────────────────────────────────────

let volKey     = `${VOL_PREFIX}.global.player`;
let globalVol  = 1;
let runtimeKey = '';
let isGM       = false;  // set on OBR.onReady; GM hears YouTube via the music tab, not the popover
let ytUnmuteTimer = null; // retry timer to ensure YouTube unmutes

// ── Utilities ─────────────────────────────────────────────────────────────────

const clamp = (v, fb = 1) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fb; };
const tsMs  = (v, fb)     => { const n = Number(v); return (Number.isFinite(n) && n > 0) ? Math.floor(n) : (fb ?? Date.now()); };

function normalizeState(raw) {
  const updatedAt         = tsMs(raw?.updatedAt);
  const anchorPositionSec = Math.max(0, Number(raw?.anchorPositionSec ?? raw?.positionSec ?? 0) || 0);
  const anchorTimestampMs = tsMs(raw?.anchorTimestampMs, updatedAt);
  return {
    currentTrackId:   String(raw?.currentTrackId || ''),
    isPlaying:        Boolean(raw?.isPlaying),
    repeat:           Boolean(raw?.repeat),
    anchorPositionSec,
    anchorTimestampMs,
    globalVolume:     clamp(raw?.globalVolume, 1),
    updatedAt,
  };
}

function getPosSec(state) {
  if (!state.isPlaying) return state.anchorPositionSec;
  return state.anchorPositionSec + Math.max(0, (Date.now() - state.anchorTimestampMs) / 1000);
}

function detectType(url) {
  const c = String(url || '').toLowerCase();
  if (c.includes('youtube.com/') || c.includes('youtu.be/')) return 'youtube';
  if (c.includes('open.spotify.com/'))                        return 'spotify';
  if (c.includes('dropbox.com/'))                             return 'dropbox';
  return 'audio';
}

function normalizeDropbox(u) {
  try {
    const url = new URL(String(u || '').trim());
    if (!url.hostname.toLowerCase().includes('dropbox.com')) return u;
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return url.toString();
  } catch (_) { return u; }
}

function extractYtId(u) {
  try {
    const url = new URL(String(u || '').trim());
    const h   = url.hostname.toLowerCase();
    if (h === 'youtu.be') return url.pathname.replace(/^\//, '').trim();
    if (h.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return v.trim();
      const m = url.pathname.match(/\/embed\/([^/?]+)/i) || url.pathname.match(/\/shorts\/([^/?]+)/i);
      if (m?.[1]) return m[1].trim();
    }
  } catch (_) {}
  return '';
}

function toSpotifyUrl(u) {
  try {
    const parts = new URL(String(u || '').trim()).pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `https://open.spotify.com/embed/${parts[0]}/${parts[1]}` : '';
  } catch (_) { return ''; }
}

function localVol() {
  try { const v = Number(localStorage.getItem(volKey)); return Number.isFinite(v) ? clamp(v) : DEFAULT_VOL; }
  catch (_) { return DEFAULT_VOL; }
}

function effectiveVol()    { return localVol() * globalVol; }
function effectiveVolPct() { return Math.round(effectiveVol() * 100); }

// ── YouTube postMessage API ───────────────────────────────────────────────────

function ytCmd(func, args = []) {
  try {
    ytIframe.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args }),
      'https://www.youtube.com'
    );
  } catch (_) {}
}

// When YouTube player is ready, unmute immediately
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://www.youtube.com') return;
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (data?.event === 'onReady') {
      console.log('[Music] YouTube onReady — unmuting, volume:', effectiveVolPct());
      ytCmd('unMute');
      ytCmd('setVolume', [effectiveVolPct()]);
      // Stop the retry timer — onReady confirms the API channel is open
      if (ytUnmuteTimer) { clearInterval(ytUnmuteTimer); ytUnmuteTimer = null; }
    }
    if (data?.event === 'infoDelivery' && data?.info?.muted) {
      console.log('[Music] YouTube reported muted — forcing unmute');
      ytCmd('unMute');
      ytCmd('setVolume', [effectiveVolPct()]);
    }
  } catch (_) {}
});

// ── Stop helpers ──────────────────────────────────────────────────────────────

function stopYt() {
  if (ytUnmuteTimer) { clearInterval(ytUnmuteTimer); ytUnmuteTimer = null; }
  ytIframe.src           = '';
  ytIframe.style.display = 'none';
}

function stopAudio() {
  bgAudio.pause();
  bgAudio.removeAttribute('src');
  bgAudio.load();
}

function stopSpotify() { spotifyIframe.src = ''; }

function stopAll() {
  console.log('[Music] stopAll — clearing playback');
  runtimeKey = '';
  stopYt();
  stopAudio();
  stopSpotify();
}

// ── Apply Music ───────────────────────────────────────────────────────────────

function applyMusic(metadata) {
  const playlist = Array.isArray(metadata?.[PLAYLIST_KEY]) ? metadata[PLAYLIST_KEY] : [];
  const state    = normalizeState(metadata?.[STATE_KEY]);
  const track    = playlist.find((t) => String(t?.id || '') === state.currentTrackId);

  console.log('[Music] applyMusic — isPlaying:', state.isPlaying, '| track:', track?.name || 'none', '| runtimeKey:', runtimeKey);

  if (!track?.url || !state.isPlaying) { stopAll(); return; }

  const type   = track.type || detectType(track.url);
  const posSec = getPosSec(state);
  globalVol    = state.globalVolume;
  const repeat = state.repeat;
  const rk     = `${track.id}|${type}|${state.anchorTimestampMs}`;

  // ── YouTube ───────────────────────────────────────────────────────────────
  if (type === 'youtube') {
    stopAudio();
    stopSpotify();    // GM hears YouTube through the embedded player in the music tab
    if (isGM) { stopYt(); return; }    if (runtimeKey !== rk) {
      runtimeKey = rk;
      const id = extractYtId(track.url);
      if (!id) { stopAll(); return; }

      console.log('[Music] Loading YouTube ID:', id, '| startSec:', Math.floor(posSec));

      // enablejsapi=1 — enables postMessage commands (unMute, setVolume)
      // autoplay=1    — YouTube starts; we unmute in the onReady postMessage handler
      // controls=1    — user sees native YouTube controls (pause, seek, volume)
      const q = new URLSearchParams({
        enablejsapi:    '1',
        autoplay:       '1',
        controls:       '1',
        rel:            '0',
        playsinline:    '1',
        modestbranding: '1',
        origin:         (window.location?.origin || ''),
      });
      if (Number(posSec) > 1) q.set('start', String(Math.floor(posSec)));
      if (repeat) { q.set('loop', '1'); q.set('playlist', id); }

      ytIframe.src           = `https://www.youtube.com/embed/${encodeURIComponent(id)}?${q}`;
      ytIframe.style.display = 'block';
      // Start retry timer in case onReady postMessage is delayed or blocked
      if (ytUnmuteTimer) clearInterval(ytUnmuteTimer);
      let _retryCount = 0;
      ytUnmuteTimer = setInterval(() => {
        if (++_retryCount > 30) { clearInterval(ytUnmuteTimer); ytUnmuteTimer = null; return; }
        ytCmd('unMute');
        ytCmd('setVolume', [effectiveVolPct()]);
      }, 500);
    }
    return;
  }

  // ── Audio / Dropbox ───────────────────────────────────────────────────────
  if (type === 'audio' || type === 'dropbox') {
    stopYt();
    stopSpotify();
    document.body.style.background = 'transparent';
    const url = type === 'dropbox' ? normalizeDropbox(track.url) : String(track.url).trim();
    if (runtimeKey !== rk) {
      runtimeKey     = rk;
      bgAudio.loop   = repeat;
      bgAudio.volume = effectiveVol();
      bgAudio.src    = url;
      console.log('[Music] Loading audio:', url, '| startSec:', Math.floor(posSec), '| vol:', effectiveVol().toFixed(2));
      bgAudio.play().then(() => {
        const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
        if (drift > 2) { try { bgAudio.currentTime = posSec; } catch (_) {} }
        console.log('[Music] Audio playing ✓');
      }).catch((err) => { console.warn('[Music] Audio play() rejected:', err?.message || err); });
    } else {
      bgAudio.volume = effectiveVol();
    }
    return;
  }

  // ── Spotify ───────────────────────────────────────────────────────────────
  if (type === 'spotify') {
    stopYt();
    stopAudio();
    document.body.style.background = 'transparent';
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      const u = toSpotifyUrl(track.url);
      if (!u) { stopAll(); return; }
      spotifyIframe.src = u;
    }
    return;
  }

  stopAll();
}

// ── Supabase snapshot ─────────────────────────────────────────────────────────

async function loadFromSupabase(roomId) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?select=playlist_json,state_json,updated_at&room_id=eq.${encodeURIComponent(roomId)}&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    const row  = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return {
      playlist:    Array.isArray(row.playlist_json) ? row.playlist_json : [],
      state:       normalizeState(row.state_json || {}),
      updatedAtMs: tsMs(Date.parse(row.updated_at || ''), 0),
    };
  } catch (_) { return null; }
}

// ── Volume sync via localStorage events ──────────────────────────────────────

window.addEventListener('storage', (e) => {
  if (e.key !== volKey) return;
  if (bgAudio.src) bgAudio.volume = effectiveVol();
  ytCmd('setVolume', [effectiveVolPct()]);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

OBR.onReady(async () => {
  console.log('[Music] OBR ready — booting music player');
  const roomId     = OBR.room?.id || '';
  const playerName = await OBR.player.getName().catch(() => 'player');
  const role       = await OBR.player.getRole().catch(() => 'PLAYER');
  isGM = role === 'GM';
  console.log('[Music] roomId:', roomId, '| player:', playerName, '| isGM:', isGM);
  volKey    = `${VOL_PREFIX}.${roomId}.${playerName}`;
  globalVol = 1;

  let metadata = {};
  try { metadata = await OBR.room.getMetadata(); } catch (_) {}

  // Prefer Supabase if it has a newer snapshot
  if (roomId) {
    const snap   = await loadFromSupabase(roomId);
    const metaTs = tsMs(metadata?.[STATE_KEY]?.updatedAt, 0);
    console.log('[Music] Supabase snap:', snap ? `updatedAt=${snap.updatedAtMs}` : 'null', '| OBR metaTs:', metaTs);
    if (snap && snap.updatedAtMs > metaTs) {
      console.log('[Music] Using Supabase snapshot (newer)');
      metadata = { ...metadata, [PLAYLIST_KEY]: snap.playlist, [STATE_KEY]: snap.state };
    }
  }

  applyMusic(metadata);
  OBR.room.onMetadataChange(applyMusic);

  // Poll every 15s as safety net
  setInterval(async () => {
    try { applyMusic(await OBR.room.getMetadata()); } catch (_) {}
  }, 15000);
});
