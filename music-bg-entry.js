import OBR from '@owlbear-rodeo/sdk';

/**
 * Music Background — runs as background_url (audio-bg.html).
 * Stays alive the entire room session. Plays audio directly here — NO popover.
 * DOM elements (ytIframe, bgAudio, spotifyIframe) are defined in audio-bg.html.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const PLAYLIST_KEY   = 'darqie.v2.musicPlaylist';
const STATE_KEY      = 'darqie.v2.musicState';
const VOL_PREFIX     = 'darqie.v2.musicVolume';
const DEFAULT_VOL    = 0.7;

const SUPABASE_URL   = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_TABLE = 'room_music_state';

// ── Cobalt API — YouTube → direct audio stream ────────────────────────────────

const cobaltCache = new Map(); // ytUrl → { url, ts }
const COBALT_TTL = 60 * 60 * 1000; // 1 hour

async function resolveYouTubeAsAudio(ytUrl) {
  const cached = cobaltCache.get(ytUrl);
  if (cached && Date.now() - cached.ts < COBALT_TTL) return cached.url;
  try {
    const res = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: ytUrl, downloadMode: 'audio' }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if ((data?.status === 'tunnel' || data?.status === 'redirect') && data.url) {
      cobaltCache.set(ytUrl, { url: data.url, ts: Date.now() });
      console.log('[MusicBG] Cobalt resolved:', ytUrl.slice(-20), '→', data.url.slice(0, 60));
      return data.url;
    }
  } catch (_) {}
  console.warn('[MusicBG] Cobalt failed for:', ytUrl);
  return null;
}

// ── DOM ───────────────────────────────────────────────────────────────────────

const bgAudio       = document.getElementById('bgAudio');
const spotifyIframe = document.getElementById('spotifyIframe');

// ── State ─────────────────────────────────────────────────────────────────────

let volKey     = `${VOL_PREFIX}.global.player`;
let globalVol  = 1;
let runtimeKey = '';
let isGM       = false;
let pendingYtResolve = false; // prevent concurrent Cobalt calls

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

// ── Stop helpers ──────────────────────────────────────────────────────────────

function stopAudio() {
  bgAudio.pause();
  bgAudio.removeAttribute('src');
  bgAudio.load();
}

function stopSpotify() { spotifyIframe.src = ''; }

function stopAll() {
  console.log('[MusicBG] stopAll');
  runtimeKey = '';
  stopAudio(); stopSpotify();
}

// ── Apply Music ───────────────────────────────────────────────────────────────

function applyMusic(metadata) {
  const playlist = Array.isArray(metadata?.[PLAYLIST_KEY]) ? metadata[PLAYLIST_KEY] : [];
  const state    = normalizeState(metadata?.[STATE_KEY]);
  const track    = playlist.find((t) => String(t?.id || '') === state.currentTrackId);

  console.log('[MusicBG] applyMusic — isPlaying:', state.isPlaying, '| track:', track?.name || 'none');

  if (!track?.url || !state.isPlaying) { stopAll(); return; }

  const type   = track.type || detectType(track.url);
  const posSec = getPosSec(state);
  globalVol    = state.globalVolume;
  const repeat = state.repeat;
  const rk     = `${track.id}|${type}|${state.anchorTimestampMs}`;

  // ── YouTube → Cobalt → bgAudio ────────────────────────────────────────────
  if (type === 'youtube') {
    stopSpotify();
    const rk = `${track.id}|yt|${state.anchorTimestampMs}`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      stopAudio();
      console.log('[MusicBG] Resolving YouTube via Cobalt:', track.url.slice(-30));
      resolveYouTubeAsAudio(track.url).then((audioUrl) => {
        if (!audioUrl || runtimeKey !== rk) return;
        bgAudio.loop   = repeat;
        bgAudio.volume = effectiveVol();
        bgAudio.src    = audioUrl;
        bgAudio.play().then(() => {
          const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
          if (drift > 2) { try { bgAudio.currentTime = posSec; } catch (_) {} }
          console.log('[MusicBG] YouTube audio playing ✓ (via Cobalt)');
        }).catch((err) => { console.warn('[MusicBG] YouTube audio play() rejected:', err?.message || err); });
      }).catch(() => {});
    } else {
      bgAudio.volume = effectiveVol();
    }
    return;
  }

  // ── Audio / Dropbox ───────────────────────────────────────────────────────
  if (type === 'audio' || type === 'dropbox') {
    stopYt(); stopSpotify();
    const url = type === 'dropbox' ? normalizeDropbox(track.url) : String(track.url).trim();
    if (runtimeKey !== rk) {
      runtimeKey     = rk;
      bgAudio.loop   = repeat;
      bgAudio.volume = effectiveVol();
      bgAudio.src    = url;
      console.log('[MusicBG] Loading audio:', url);
      bgAudio.play().then(() => {
        const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
        if (drift > 2) { try { bgAudio.currentTime = posSec; } catch (_) {} }
        console.log('[MusicBG] Audio playing ✓');
      }).catch((err) => { console.warn('[MusicBG] Audio play() rejected:', err?.message || err); });
    } else {
      bgAudio.volume = effectiveVol();
    }
    return;
  }

  // ── Spotify ───────────────────────────────────────────────────────────────
  if (type === 'spotify') {
    stopYt(); stopAudio();
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
  console.log('[MusicBG] OBR ready — starting background music player (no popover)');

  const roomId     = OBR.room?.id || '';
  const playerName = await OBR.player.getName().catch(() => 'player');
  const role       = await OBR.player.getRole().catch(() => 'PLAYER');
  isGM = role === 'GM';
  console.log('[MusicBG] roomId:', roomId, '| player:', playerName, '| isGM:', isGM);
  volKey    = `${VOL_PREFIX}.${roomId}.${playerName}`;
  globalVol = 1;

  let metadata = {};
  try { metadata = await OBR.room.getMetadata(); } catch (_) {}

  if (roomId) {
    const snap   = await loadFromSupabase(roomId);
    const metaTs = tsMs(metadata?.[STATE_KEY]?.updatedAt, 0);
    if (snap && snap.updatedAtMs > metaTs) {
      console.log('[MusicBG] Using Supabase snapshot (newer)');
      metadata = { ...metadata, [PLAYLIST_KEY]: snap.playlist, [STATE_KEY]: snap.state };
    }
  }

  applyMusic(metadata);
  OBR.room.onMetadataChange(applyMusic);

  setInterval(async () => {
    try { applyMusic(await OBR.room.getMetadata()); } catch (_) {}
  }, 15000);
});

