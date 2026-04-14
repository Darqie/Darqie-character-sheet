import OBR from '@owlbear-rodeo/sdk';

const PLAYLIST_KEY = 'darqie.v2.musicPlaylist';
const STATE_KEY = 'darqie.v2.musicState';
const VOL_PREFIX = 'darqie.v2.musicVolume';
const DEFAULT_VOL = 0.7;

const SUPABASE_URL = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_TABLE = 'room_music_state';
const YT_AUDIO_ENDPOINT = `${SUPABASE_URL}/functions/v1/yt-audio`;

const bgAudio = document.getElementById('bgAudio');
const spotifyIframe = document.getElementById('spotifyIframe');

let volKey = `${VOL_PREFIX}.global.player`;
let globalVol = 1;
let runtimeKey = '';
let currentRoomId = '';
let currentYtTrackId = '';
let ytAudioCache = new Map();


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
    if (host.includes('youtube.com') || host.includes('music.youtube.com')) {
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

async function fetchYouTubeAudioUrl(videoId) {
  const cached = ytAudioCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
      const r = await fetch(`${YT_AUDIO_ENDPOINT}?v=${encodeURIComponent(videoId)}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!r.ok) continue;
      const json = await r.json();
      if (json?.url) {
        ytAudioCache.set(videoId, { url: json.url, expiresAt: Date.now() + 30 * 60_000 });
        return json.url;
      }
    } catch (_) {}
  }
  return null;
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

function setVol() {
  bgAudio.volume = effectiveVol();
}

function stopAudio() {
  bgAudio.pause();
  bgAudio.removeAttribute('src');
  bgAudio.load();
}

function stopSpotify() {
  spotifyIframe.src = '';
}

function stopAll() {
  runtimeKey = '';
  currentYtTrackId = '';
  _wantPlay = false;
  stopAudio();
  stopSpotify();
}

window.addEventListener('storage', (e) => {
  if (e.key === volKey && bgAudio.src) {
    bgAudio.volume = effectiveVol();
  }
});

function writeYtRuntime(currentTime, duration) {
  if (!currentRoomId || !currentYtTrackId) return;
  const key = `darqie.v2.ytRuntime.${currentRoomId}.${currentYtTrackId}`;
  const c = Number(currentTime);
  const d = Number(duration);
  try {
    localStorage.setItem(key, JSON.stringify({
      ts: Date.now(),
      currentTime: Number.isFinite(c) ? Math.max(0, c) : null,
      duration: Number.isFinite(d) && d > 0 ? d : null,
    }));
  } catch (_) {}
}

bgAudio.addEventListener('timeupdate', () => {
  if (currentYtTrackId) writeYtRuntime(bgAudio.currentTime, bgAudio.duration);
});
bgAudio.addEventListener('loadedmetadata', () => {
  if (currentYtTrackId) writeYtRuntime(bgAudio.currentTime, bgAudio.duration);
});

let _wantPlay = false;
let _pendingPos = 0;
let _retryTimer = null;

function _doPlay() {
  if (!_wantPlay || !bgAudio.src) return;
  bgAudio.volume = effectiveVol();
  bgAudio.muted = false;

  bgAudio.play().then(() => {
    _wantPlay = false;
    _clearRetry();
  }).catch(() => {
    _scheduleRetry();
  });
}

function _scheduleRetry() {
  if (_retryTimer) return;
  _retryTimer = setInterval(() => {
    if (!_wantPlay || !bgAudio.src) { _clearRetry(); return; }
    _doPlay();
  }, 3000);
}

function _clearRetry() {
  if (_retryTimer) { clearInterval(_retryTimer); _retryTimer = null; }
}

bgAudio.addEventListener('canplay', () => {
  if (_pendingPos > 1) {
    const target = _pendingPos;
    _pendingPos = 0;
    try { bgAudio.currentTime = target; } catch (_) {}
  } else {
    _pendingPos = 0;
  }
  if (_wantPlay) _doPlay();
});

function tryPlay(posSec) {
  _wantPlay = true;
  _pendingPos = posSec;
  _doPlay();
}

function syncPosition(posSec) {
  if (!bgAudio.src || bgAudio.paused) return;
  // Don't sync position for Edge Function streams — seeking re-fetches the whole stream
  if (currentYtTrackId) return;
  const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
  if (drift > 5) {
    try { bgAudio.currentTime = posSec; } catch (_) {}
  }
}

function applyMusic(metadata) {
  const playlist = Array.isArray(metadata?.[PLAYLIST_KEY]) ? metadata[PLAYLIST_KEY] : [];
  const state = normalizeState(metadata?.[STATE_KEY]);
  const track = playlist.find((t) => String(t?.id || '') === state.currentTrackId);

  if (!track?.url || !state.isPlaying) {
    stopAll();
    return;
  }

  const type = track.type || detectType(track.url);
  const posSec = getPosSec(state);
  globalVol = state.globalVolume;

  if (type === 'youtube') {
    stopSpotify();
    const videoId = extractYtId(track.url);
    if (!videoId) { stopAll(); return; }

    const rk = `${track.id}|yt`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      currentYtTrackId = track.id;
      bgAudio.loop = state.repeat;
      setVol();
      // Stream through Edge Function to avoid ERR_CONTENT_DECODING_FAILED
      bgAudio.src = `${YT_AUDIO_ENDPOINT}?v=${encodeURIComponent(videoId)}&stream=1`;
      tryPlay(posSec);
    } else {
      bgAudio.loop = state.repeat;
      setVol();
      if (bgAudio.src && bgAudio.paused) {
        tryPlay(posSec);
      } else {
        syncPosition(posSec);
      }
    }
    return;
  }

  if (type === 'audio' || type === 'dropbox') {
    stopSpotify();
    currentYtTrackId = '';
    const url = type === 'dropbox' ? normalizeDropbox(track.url) : String(track.url).trim();
    const rk = `${track.id}|${type}`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      bgAudio.loop = state.repeat;
      setVol();
      bgAudio.src = url;
      tryPlay(posSec);
    } else {
      bgAudio.loop = state.repeat;
      setVol();
      if (bgAudio.src && bgAudio.paused) {
        tryPlay(posSec);
      } else {
        syncPosition(posSec);
      }
    }
    return;
  }

  if (type === 'spotify') {
    stopAudio();
    currentYtTrackId = '';
    const rk = `${track.id}|spotify`;
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
  const roomId = OBR.room?.id || '';
  currentRoomId = roomId;

  const playerName = await OBR.player.getName().catch(() => 'player');
  volKey = `${VOL_PREFIX}.${roomId}.${playerName}`;
  globalVol = 1;

  let metadata = {};
  try { metadata = await OBR.room.getMetadata(); } catch (_) {}

  applyMusic(metadata);

  // Then check Supabase for fresher state and update if needed
  if (roomId) {
    const snap = await loadFromSupabase(roomId);
    const metaTs = tsMs(metadata?.[STATE_KEY]?.updatedAt, 0);
    if (snap && snap.updatedAtMs > metaTs) {
      metadata = { ...metadata, [PLAYLIST_KEY]: snap.playlist, [STATE_KEY]: snap.state };
      applyMusic(metadata);
    }
  }

  OBR.room.onMetadataChange(applyMusic);

  setInterval(async () => {
    try { applyMusic(await OBR.room.getMetadata()); } catch (_) {}
  }, 15000);
});
