/**
 * Darqie Music Background Player
 *
 * Runs as OBR background_url — stays alive the entire time the room is open,
 * even when the extension popup is closed.
 *
 * Handles ALL music playback for every connected user (GM and players alike).
 * The GM panel only writes to OBR metadata (controls); this page plays the audio.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const DARQIE_MUSIC_PLAYLIST_KEY = 'darqie.v2.musicPlaylist';
const DARQIE_MUSIC_STATE_KEY    = 'darqie.v2.musicState';
const MUSIC_VOLUME_PREFIX       = 'darqie.v2.musicVolume';
const MUSIC_DEFAULT_VOLUME      = 0.7;

const SUPABASE_URL        = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_ANON_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_MUSIC_TABLE = 'room_music_state';

// ── State ────────────────────────────────────────────────────────────────────

let volumeStorageKey    = `${MUSIC_VOLUME_PREFIX}.global.bg`;
let lastGlobalVolume    = 1;
let currentRuntimeKey   = '';

// ── DOM ──────────────────────────────────────────────────────────────────────

const bgAudio         = document.getElementById('bgAudio');
const bgYtIframe      = document.getElementById('bgYtIframe');
const bgSpotifyIframe = document.getElementById('bgSpotifyIframe');

// ── Utilities ─────────────────────────────────────────────────────────────────

function normalizeTimestampMs(v, fallback) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0) ? Math.floor(n) : (fallback !== undefined ? fallback : Date.now());
}

function normalizePositionSec(v) {
  const n = Number(v);
  return (Number.isFinite(n) && n >= 0) ? n : 0;
}

function normalizeVolume(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : (fallback !== undefined ? fallback : 1);
}

function normalizeState(raw) {
  const updatedAt        = normalizeTimestampMs(raw?.updatedAt);
  const anchorPositionSec = normalizePositionSec(raw?.anchorPositionSec ?? raw?.positionSec ?? 0);
  const anchorTimestampMs = normalizeTimestampMs(raw?.anchorTimestampMs, updatedAt);
  return {
    currentTrackId:   String(raw?.currentTrackId || ''),
    isPlaying:        Boolean(raw?.isPlaying),
    repeat:           Boolean(raw?.repeat),
    anchorPositionSec,
    anchorTimestampMs,
    globalVolume:     normalizeVolume(raw?.globalVolume, 1),
    updatedAt,
  };
}

function getPositionSec(state, nowMs) {
  if (!state.isPlaying) return state.anchorPositionSec;
  const delta = Math.max(0, (normalizeTimestampMs(nowMs) - state.anchorTimestampMs) / 1000);
  return state.anchorPositionSec + delta;
}

function detectTrackType(url) {
  const c = String(url || '').toLowerCase();
  if (c.includes('youtube.com/') || c.includes('youtu.be/')) return 'youtube';
  if (c.includes('open.spotify.com/'))                        return 'spotify';
  if (c.includes('dropbox.com/'))                             return 'dropbox';
  return 'audio';
}

function normalizeDropboxUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (!url.hostname.toLowerCase().includes('dropbox.com')) return rawUrl;
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return url.toString();
  } catch (_) { return rawUrl; }
}

function extractYouTubeVideoId(rawUrl) {
  try {
    const url  = new URL(String(rawUrl || '').trim());
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') return url.pathname.replace(/^\//, '').trim();
    if (host.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return v.trim();
      const m = url.pathname.match(/\/embed\/([^/?]+)/i) || url.pathname.match(/\/shorts\/([^/?]+)/i);
      if (m?.[1]) return m[1].trim();
    }
  } catch (_) {}
  return '';
}

function toYouTubeEmbedUrl(rawUrl, repeat, startSec) {
  const videoId = extractYouTubeVideoId(rawUrl);
  if (!videoId) return '';
  const origin = window.location?.origin || '';
  const q = new URLSearchParams({ autoplay: '1', controls: '1', rel: '0', playsinline: '1', modestbranding: '1' });
  if (origin) q.set('origin', origin);
  const start = Math.max(0, Math.floor(Number(startSec) || 0));
  if (start > 0) q.set('start', String(start));
  if (repeat) { q.set('loop', '1'); q.set('playlist', videoId); }
  // No mute=1 — we rely on OBR delegating allow="autoplay" to this background page
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${q.toString()}`;
}

function toSpotifyEmbedUrl(rawUrl) {
  try {
    const url   = new URL(String(rawUrl || '').trim());
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    return `https://open.spotify.com/embed/${parts[0]}/${parts[1]}`;
  } catch (_) { return ''; }
}

function getLocalVolume() {
  try {
    const raw = localStorage.getItem(volumeStorageKey);
    const v   = Number(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : MUSIC_DEFAULT_VOLUME;
  } catch (_) { return MUSIC_DEFAULT_VOLUME; }
}

function effectiveVolume() {
  return getLocalVolume() * lastGlobalVolume;
}

// ── Playback ──────────────────────────────────────────────────────────────────

function stopAll() {
  currentRuntimeKey = '';
  bgAudio.pause();
  bgAudio.removeAttribute('src');
  bgAudio.load();
  bgYtIframe.src      = '';
  bgSpotifyIframe.src = '';
}

function applyMusic(metadata) {
  const rawPlaylist = metadata?.[DARQIE_MUSIC_PLAYLIST_KEY];
  const playlist    = Array.isArray(rawPlaylist) ? rawPlaylist : [];
  const state       = normalizeState(metadata?.[DARQIE_MUSIC_STATE_KEY]);

  const track = playlist.find((t) => String(t?.id || '') === state.currentTrackId);

  if (!track || !track.url || !state.isPlaying) {
    stopAll();
    return;
  }

  const type       = track.type || detectTrackType(track.url);
  const positionSec = getPositionSec(state, Date.now());
  lastGlobalVolume  = state.globalVolume;
  const repeat      = state.repeat;

  // Unique key per playback session — changes only when GM intentionally restarts the track
  const runtimeKey = `${track.id}|${type}|${state.anchorTimestampMs}`;

  // ── Audio / Dropbox ──────────────────────────────────────────────────────
  if (type === 'audio' || type === 'dropbox') {
    bgYtIframe.src      = '';
    bgSpotifyIframe.src = '';

    const url = type === 'dropbox' ? normalizeDropboxUrl(track.url) : String(track.url).trim();

    if (currentRuntimeKey !== runtimeKey) {
      currentRuntimeKey = runtimeKey;
      bgAudio.loop   = repeat;
      bgAudio.src    = url;
      bgAudio.volume = effectiveVolume();
      bgAudio.play()
        .then(() => {
          // Sync position only on first load; don't re-seek on every metadata update
          const drift = Math.abs((bgAudio.currentTime || 0) - positionSec);
          if (drift > 2) {
            try { bgAudio.currentTime = positionSec; } catch (_) {}
          }
        })
        .catch(() => {});
    } else {
      // Track is already playing — just keep volume in sync
      bgAudio.volume = effectiveVolume();
    }
    return;
  }

  // Stop audio when switching to a non-audio type
  if (bgAudio.src) {
    bgAudio.pause();
    bgAudio.removeAttribute('src');
    bgAudio.load();
  }

  // ── YouTube ───────────────────────────────────────────────────────────────
  if (type === 'youtube') {
    bgSpotifyIframe.src = '';
    if (currentRuntimeKey !== runtimeKey) {
      currentRuntimeKey = runtimeKey;
      const ytUrl = toYouTubeEmbedUrl(track.url, repeat, positionSec);
      if (!ytUrl) { stopAll(); return; }
      bgYtIframe.src = ytUrl;
    }
    return;
  }

  // ── Spotify ───────────────────────────────────────────────────────────────
  if (type === 'spotify') {
    bgYtIframe.src = '';
    if (currentRuntimeKey !== runtimeKey) {
      currentRuntimeKey = runtimeKey;
      const spotUrl = toSpotifyEmbedUrl(track.url);
      if (!spotUrl) { stopAll(); return; }
      bgSpotifyIframe.src = spotUrl;
    }
    return;
  }

  stopAll();
}

// ── Supabase (initial load only) ──────────────────────────────────────────────

async function loadFromSupabase(roomId) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/${SUPABASE_MUSIC_TABLE}` +
      `?select=playlist_json,state_json,updated_at&room_id=eq.${encodeURIComponent(roomId)}&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!response.ok) return null;
    const rows = await response.json().catch(() => []);
    const row  = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return {
      playlist:   Array.isArray(row.playlist_json) ? row.playlist_json : [],
      state:      normalizeState(row.state_json || {}),
      updatedAtMs: normalizeTimestampMs(Date.parse(row.updated_at || ''), 0),
    };
  } catch (_) { return null; }
}

// ── Volume sync from popup ────────────────────────────────────────────────────

// When the user adjusts the volume slider in the main popup, it writes to
// localStorage (same origin). The storage event fires here so we update immediately.
window.addEventListener('storage', (e) => {
  if (e.key === volumeStorageKey && bgAudio.src) {
    bgAudio.volume = effectiveVolume();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  const OBR = window.OBR;
  if (!OBR) {
    // OBR SDK not yet injected — retry shortly
    setTimeout(init, 500);
    return;
  }

  OBR.onReady(async () => {
    const roomId    = OBR.room?.id || '';
    const playerName = await OBR.player.getName().catch(() => 'player');

    // Use same key format as main.js so volume slider in popup is shared
    volumeStorageKey = `${MUSIC_VOLUME_PREFIX}.${roomId}.${playerName}`;

    // Get initial metadata
    let metadata = {};
    try { metadata = await OBR.room.getMetadata(); } catch (_) {}

    // Check Supabase for a snapshot that might be newer than OBR metadata
    if (roomId) {
      const snapshot     = await loadFromSupabase(roomId);
      const metaUpdatedAt = normalizeTimestampMs(metadata?.[DARQIE_MUSIC_STATE_KEY]?.updatedAt, 0);
      if (snapshot && snapshot.updatedAtMs > metaUpdatedAt) {
        metadata = {
          ...metadata,
          [DARQIE_MUSIC_PLAYLIST_KEY]: snapshot.playlist,
          [DARQIE_MUSIC_STATE_KEY]:    snapshot.state,
        };
      }
    }

    applyMusic(metadata);

    // Real-time updates via OBR pub/sub
    OBR.room.onMetadataChange((md) => applyMusic(md));

    // Periodic re-sync every 10 s as a safety net
    setInterval(async () => {
      try {
        const md = await OBR.room.getMetadata();
        applyMusic(md);
      } catch (_) {}
    }, 10000);
  });
}

init();
