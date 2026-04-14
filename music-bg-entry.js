import OBR from '@owlbear-rodeo/sdk';

/**
 * Music Background — runs in background_url (audio-bg.html).
 * No OBR popover is used, so extension UI stays clickable.
 *
 * Playback strategy:
 * - Audio/Dropbox: hidden <audio>
 * - Spotify: hidden <iframe>
 * - YouTube: hidden embed <iframe> (avoids CORS fetch errors from Cobalt/Piped)
 */

const PLAYLIST_KEY = 'darqie.v2.musicPlaylist';
const STATE_KEY = 'darqie.v2.musicState';
const VOL_PREFIX = 'darqie.v2.musicVolume';
const DEFAULT_VOL = 0.7;

const SUPABASE_URL = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_TABLE = 'room_music_state';

const bgAudio = document.getElementById('bgAudio');
const spotifyIframe = document.getElementById('spotifyIframe');
const ytIframe = document.getElementById('ytIframe');

let volKey = `${VOL_PREFIX}.global.player`;
let globalVol = 1;
let runtimeKey = '';
let pendingPlay = null; // { src, posSec, loop }

const clamp = (v, fb = 1) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fb;
};

const tsMs = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : (fb ?? Date.now());
};

function normalizeState(raw) {
  const updatedAt = tsMs(raw?.updatedAt);
  const anchorPositionSec = Math.max(0, Number(raw?.anchorPositionSec ?? raw?.positionSec ?? 0) || 0);
  const anchorTimestampMs = tsMs(raw?.anchorTimestampMs, updatedAt);
  return {
    currentTrackId: String(raw?.currentTrackId || ''),
    isPlaying: Boolean(raw?.isPlaying),
    repeat: Boolean(raw?.repeat),
    anchorPositionSec,
    anchorTimestampMs,
    globalVolume: clamp(raw?.globalVolume, 1),
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
  if (c.includes('open.spotify.com/')) return 'spotify';
  if (c.includes('dropbox.com/')) return 'dropbox';
  return 'audio';
}

function normalizeDropbox(u) {
  try {
    const url = new URL(String(u || '').trim());
    if (!url.hostname.toLowerCase().includes('dropbox.com')) return u;
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return url.toString();
  } catch (_) {
    return u;
  }
}

function toSpotifyUrl(u) {
  try {
    const parts = new URL(String(u || '').trim()).pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `https://open.spotify.com/embed/${parts[0]}/${parts[1]}` : '';
  } catch (_) {
    return '';
  }
}

function extractYtId(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    const host = url.hostname.toLowerCase();

    if (host === 'youtu.be') return url.pathname.replace(/^\//, '').trim();

    if (host.includes('youtube.com')) {
      const fromSearch = url.searchParams.get('v');
      if (fromSearch) return fromSearch.trim();

      const pathMatch =
        url.pathname.match(/\/embed\/([^/?]+)/i) ||
        url.pathname.match(/\/shorts\/([^/?]+)/i);
      if (pathMatch?.[1]) return pathMatch[1].trim();
    }
  } catch (_) {}

  return '';
}

function toYouTubeEmbedUrl(rawUrl, repeat = false, startSec = 0) {
  const videoId = extractYtId(rawUrl);
  if (!videoId) return '';

  const origin = window.location?.origin || '';
  const query = new URLSearchParams({
    autoplay: '1',
    controls: '0',
    rel: '0',
    playsinline: '1',
    modestbranding: '1',
    iv_load_policy: '3',
    enablejsapi: '1',
  });

  if (origin) query.set('origin', origin);

  const normalizedStart = Math.max(0, Math.floor(Number(startSec) || 0));
  if (normalizedStart > 0) query.set('start', String(normalizedStart));

  if (repeat) {
    query.set('loop', '1');
    query.set('playlist', videoId);
  }

  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${query.toString()}`;
}

function localVol() {
  try {
    const v = Number(localStorage.getItem(volKey));
    return Number.isFinite(v) ? clamp(v) : DEFAULT_VOL;
  } catch (_) {
    return DEFAULT_VOL;
  }
}

function effectiveVol() {
  return localVol() * globalVol;
}

function stopAudio() {
  bgAudio.pause();
  bgAudio.removeAttribute('src');
  bgAudio.load();
}

function stopSpotify() {
  spotifyIframe.src = '';
}

function stopYouTube() {
  ytIframe.src = '';
}

function stopAll() {
  runtimeKey = '';
  pendingPlay = null;
  stopAudio();
  stopSpotify();
  stopYouTube();
}

function attemptPlay(src, posSec, loop) {
  bgAudio.loop = loop;
  bgAudio.volume = effectiveVol();
  bgAudio.src = src;
  bgAudio.play().then(() => {
    pendingPlay = null;
    const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
    if (drift > 2) {
      try { bgAudio.currentTime = posSec; } catch (_) {}
    }
    console.log('[MusicBG] Audio playing ✓');
  }).catch((e) => {
    console.warn('[MusicBG] play() blocked — waiting for user interaction:', e?.message || e);
    pendingPlay = { src, posSec, loop };
  });
}

window.addEventListener('storage', (e) => {
  if (e.key === 'darqie.userInteracted' && pendingPlay) {
    const { src, posSec, loop } = pendingPlay;
    pendingPlay = null;
    attemptPlay(src, posSec, loop);
    return;
  }

  if (e.key === volKey && bgAudio.src) {
    bgAudio.volume = effectiveVol();
  }
});

function applyMusic(metadata) {
  const playlist = Array.isArray(metadata?.[PLAYLIST_KEY]) ? metadata[PLAYLIST_KEY] : [];
  const state = normalizeState(metadata?.[STATE_KEY]);
  const track = playlist.find((t) => String(t?.id || '') === state.currentTrackId);

  console.log('[MusicBG] applyMusic — isPlaying:', state.isPlaying, '| track:', track?.name || 'none');

  if (!track?.url || !state.isPlaying) {
    stopAll();
    return;
  }

  const type = track.type || detectType(track.url);
  const posSec = getPosSec(state);
  globalVol = state.globalVolume;
  const repeat = state.repeat;

  if (type === 'youtube') {
    stopAudio();
    stopSpotify();

    const rk = `${track.id}|yt|${state.anchorTimestampMs}`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      const embedUrl = toYouTubeEmbedUrl(track.url, repeat, posSec);
      if (!embedUrl) {
        stopAll();
        return;
      }
      ytIframe.src = embedUrl;
      console.log('[MusicBG] YouTube iframe started ✓');
    }
    return;
  }

  stopYouTube();

  if (type === 'audio' || type === 'dropbox') {
    stopSpotify();
    const url = type === 'dropbox' ? normalizeDropbox(track.url) : String(track.url).trim();
    const rk = `${track.id}|${type}|${state.anchorTimestampMs}`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      attemptPlay(url, posSec, repeat);
    } else {
      bgAudio.volume = effectiveVol();
    }
    return;
  }

  if (type === 'spotify') {
    stopAudio();
    const rk = `${track.id}|spotify`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      const u = toSpotifyUrl(track.url);
      if (!u) {
        stopAll();
        return;
      }
      spotifyIframe.src = u;
    }
    return;
  }

  stopAll();
}

async function loadFromSupabase(roomId) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?select=playlist_json,state_json,updated_at&room_id=eq.${encodeURIComponent(roomId)}&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return {
      playlist: Array.isArray(row.playlist_json) ? row.playlist_json : [],
      state: normalizeState(row.state_json || {}),
      updatedAtMs: tsMs(Date.parse(row.updated_at || ''), 0),
    };
  } catch (_) {
    return null;
  }
}

OBR.onReady(async () => {
  console.log('[MusicBG] OBR ready — starting music player (no popover)');

  const roomId = OBR.room?.id || '';
  const playerName = await OBR.player.getName().catch(() => 'player');
  volKey = `${VOL_PREFIX}.${roomId}.${playerName}`;
  globalVol = 1;

  let metadata = {};
  try {
    metadata = await OBR.room.getMetadata();
  } catch (_) {}

  if (roomId) {
    const snap = await loadFromSupabase(roomId);
    const metaTs = tsMs(metadata?.[STATE_KEY]?.updatedAt, 0);
    if (snap && snap.updatedAtMs > metaTs) {
      metadata = { ...metadata, [PLAYLIST_KEY]: snap.playlist, [STATE_KEY]: snap.state };
    }
  }

  applyMusic(metadata);
  OBR.room.onMetadataChange(applyMusic);

  setInterval(async () => {
    try {
      applyMusic(await OBR.room.getMetadata());
    } catch (_) {}
  }, 15000);
});
