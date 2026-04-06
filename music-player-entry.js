import OBR from '@owlbear-rodeo/sdk';

/**
 * Music Player — persistent OBR popover (300×60px, bottom-right)
 * Runs inside an OBR popover which has allow="autoplay" so Chrome lets audio play.
 * Reads OBR room metadata and plays the current track (dropbox/audio/<audio>,
 * YouTube/iframe, Spotify/iframe).  Stays alive independently of the action popup.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const DARQIE_MUSIC_PLAYLIST_KEY = 'darqie.v2.musicPlaylist';
const DARQIE_MUSIC_STATE_KEY    = 'darqie.v2.musicState';
const MUSIC_VOLUME_PREFIX       = 'darqie.v2.musicVolume';
const MUSIC_DEFAULT_VOLUME      = 0.7;

const SUPABASE_URL         = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_ANON_KEY    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_MUSIC_TABLE = 'room_music_state';

// ── DOM ───────────────────────────────────────────────────────────────────────

const bgAudio       = document.getElementById('bgAudio');
const ytClip        = document.getElementById('ytClip');
const ytIframe      = document.getElementById('ytIframe');
const spotifyIframe = document.getElementById('spotifyIframe');

// ── State ─────────────────────────────────────────────────────────────────────

let volumeStorageKey  = `${MUSIC_VOLUME_PREFIX}.global.player`;
let lastGlobalVolume  = 1;
let currentRuntimeKey = '';
let ytPlayer          = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

function clampVol(v, fallback = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function normalizeTs(v, fallback) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0) ? Math.floor(n) : (fallback ?? Date.now());
}

function normalizeState(raw) {
  const updatedAt         = normalizeTs(raw?.updatedAt);
  const anchorPositionSec = Math.max(0, Number(raw?.anchorPositionSec ?? raw?.positionSec ?? 0) || 0);
  const anchorTimestampMs = normalizeTs(raw?.anchorTimestampMs, updatedAt);
  return {
    currentTrackId:   String(raw?.currentTrackId || ''),
    isPlaying:        Boolean(raw?.isPlaying),
    repeat:           Boolean(raw?.repeat),
    anchorPositionSec,
    anchorTimestampMs,
    globalVolume:     clampVol(raw?.globalVolume, 1),
    updatedAt,
  };
}

function getPositionSec(state) {
  if (!state.isPlaying) return state.anchorPositionSec;
  const delta = Math.max(0, (Date.now() - state.anchorTimestampMs) / 1000);
  return state.anchorPositionSec + delta;
}

function detectType(url) {
  const c = String(url || '').toLowerCase();
  if (c.includes('youtube.com/') || c.includes('youtu.be/')) return 'youtube';
  if (c.includes('open.spotify.com/'))                        return 'spotify';
  if (c.includes('dropbox.com/'))                             return 'dropbox';
  return 'audio';
}

function normalizeDropbox(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (!url.hostname.toLowerCase().includes('dropbox.com')) return rawUrl;
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return url.toString();
  } catch (_) { return rawUrl; }
}

function extractYtId(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
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

function toSpotifyUrl(rawUrl) {
  try {
    const parts = new URL(String(rawUrl || '').trim()).pathname.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    return `https://open.spotify.com/embed/${parts[0]}/${parts[1]}`;
  } catch (_) { return ''; }
}

function localVol() {
  try {
    const v = Number(localStorage.getItem(volumeStorageKey));
    return Number.isFinite(v) ? clampVol(v) : MUSIC_DEFAULT_VOLUME;
  } catch (_) { return MUSIC_DEFAULT_VOLUME; }
}

function effectiveVol() { return localVol() * lastGlobalVolume; }

// ── YouTube IFrame API loader ─────────────────────────────────────────────────

function loadYtApi() {
  if (window._ytApiPromise) return window._ytApiPromise;
  window._ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(window.YT); return; }
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return window._ytApiPromise;
}

function destroyYtPlayer() {
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch (_) {}
    ytPlayer = null;
  }
  // destroy() removes the iframe from DOM — recreate it so next YT.Player call works
  const fresh = document.createElement('iframe');
  fresh.id = 'ytIframe';
  fresh.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
  ytClip.innerHTML = '';
  ytClip.appendChild(fresh);
}

async function startYouTube(videoId, startSec, repeat) {
  destroyYtPlayer();
  const YT = await loadYtApi();
  // Pass element ID — YT.Player reuses the static iframe, keeping its allow=autoplay.
  // Do NOT use autoplay:1 in playerVars — YouTube forces mute when it sees autoplay=1.
  // Instead we call unMute() + playVideo() in onReady (page already has autoplay permission
  // from OBR popover's allow="autoplay" attribute).
  ytPlayer = new YT.Player('ytIframe', {
    videoId,
    width: 300,
    height: 200,
    playerVars: {
      controls: 1,
      rel: 0,
      playsinline: 1,
      modestbranding: 1,
      loop: repeat ? 1 : 0,
      playlist: repeat ? videoId : '',
      start: Math.max(0, Math.floor(startSec)),
    },
    events: {
      onReady(e) {
        e.target.unMute();
        e.target.setVolume(100);
        e.target.playVideo();
      },
      onStateChange(e) {
        if (e.data === 1 /* PLAYING */) {
          e.target.unMute();
          e.target.setVolume(100);
        }
      },
    },
  });
}

// ── Playback ──────────────────────────────────────────────────────────────────

function stopAll() {
  currentRuntimeKey    = '';
  bgAudio.pause();
  bgAudio.removeAttribute('src');
  bgAudio.load();
  destroyYtPlayer();
  ytClip.style.display = 'none';
  spotifyIframe.src    = '';
}

function applyMusic(metadata) {
  const playlist = Array.isArray(metadata?.[DARQIE_MUSIC_PLAYLIST_KEY]) ? metadata[DARQIE_MUSIC_PLAYLIST_KEY] : [];
  const state    = normalizeState(metadata?.[DARQIE_MUSIC_STATE_KEY]);
  const track    = playlist.find((t) => String(t?.id || '') === state.currentTrackId);

  if (!track?.url || !state.isPlaying) { stopAll(); return; }

  const type       = track.type || detectType(track.url);
  const posSec     = getPositionSec(state);
  lastGlobalVolume = state.globalVolume;
  const repeat     = state.repeat;
  // Key changes only when GM intentionally restarts (new anchorTimestampMs)
  const rk = `${track.id}|${type}|${state.anchorTimestampMs}`;

  // ── Audio / Dropbox ───────────────────────────────────────────────────────
  if (type === 'audio' || type === 'dropbox') {
    destroyYtPlayer();
    ytClip.style.display = 'none';
    spotifyIframe.src    = '';

    const url = type === 'dropbox' ? normalizeDropbox(track.url) : String(track.url).trim();
    if (currentRuntimeKey !== rk) {
      currentRuntimeKey = rk;
      bgAudio.loop   = repeat;
      bgAudio.src    = url;
      bgAudio.volume = effectiveVol();
      bgAudio.play().then(() => {
        const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
        if (drift > 2) { try { bgAudio.currentTime = posSec; } catch (_) {} }
      }).catch(() => {});
    } else {
      bgAudio.volume = effectiveVol();
    }
    return;
  }

  if (bgAudio.src) { bgAudio.pause(); bgAudio.removeAttribute('src'); bgAudio.load(); }

  // ── YouTube ───────────────────────────────────────────────────────────────
  if (type === 'youtube') {
    spotifyIframe.src = '';
    if (currentRuntimeKey !== rk) {
      currentRuntimeKey = rk;
      const videoId = extractYtId(track.url);
      if (!videoId) { stopAll(); return; }
      ytClip.style.display = 'block';
      startYouTube(videoId, posSec, repeat);
    }
    return;
  }

  // ── Spotify ───────────────────────────────────────────────────────────────
  if (type === 'spotify') {
    destroyYtPlayer();
    ytClip.style.display = 'none';
    if (currentRuntimeKey !== rk) {
      currentRuntimeKey = rk;
      const spUrl = toSpotifyUrl(track.url);
      if (!spUrl) { stopAll(); return; }
      spotifyIframe.src = spUrl;
    }
    return;
  }

  stopAll();
}

// ── Supabase initial snapshot ─────────────────────────────────────────────────

async function loadFromSupabase(roomId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${SUPABASE_MUSIC_TABLE}?select=playlist_json,state_json,updated_at&room_id=eq.${encodeURIComponent(roomId)}&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    const row  = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return {
      playlist:    Array.isArray(row.playlist_json) ? row.playlist_json : [],
      state:       normalizeState(row.state_json || {}),
      updatedAtMs: normalizeTs(Date.parse(row.updated_at || ''), 0),
    };
  } catch (_) { return null; }
}

// ── Volume sync ───────────────────────────────────────────────────────────────

window.addEventListener('storage', (e) => {
  if (e.key === volumeStorageKey && bgAudio.src) bgAudio.volume = effectiveVol();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

OBR.onReady(async () => {
  const roomId     = OBR.room?.id || '';
  const playerName = await OBR.player.getName().catch(() => 'player');

  // Match volume key format used in main.js
  volumeStorageKey = `${MUSIC_VOLUME_PREFIX}.${roomId}.${playerName}`;

  let metadata = {};
  try { metadata = await OBR.room.getMetadata(); } catch (_) {}

  // Prefer Supabase if it has a newer state
  if (roomId) {
    const snap = await loadFromSupabase(roomId);
    const metaTs = normalizeTs(metadata?.[DARQIE_MUSIC_STATE_KEY]?.updatedAt, 0);
    if (snap && snap.updatedAtMs > metaTs) {
      metadata = {
        ...metadata,
        [DARQIE_MUSIC_PLAYLIST_KEY]: snap.playlist,
        [DARQIE_MUSIC_STATE_KEY]:    snap.state,
      };
    }
  }

  applyMusic(metadata);

  OBR.room.onMetadataChange(applyMusic);

  setInterval(async () => {
    try { applyMusic(await OBR.room.getMetadata()); } catch (_) {}
  }, 10000);
});
