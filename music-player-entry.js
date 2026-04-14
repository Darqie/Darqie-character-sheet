import OBR from '@owlbear-rodeo/sdk';

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

let currentRoomId = '';
let currentYtTrackId = '';
let ytPlayerReady = false;
let ytLastRuntimeAt = 0;
let ytLastNoRuntimeWarnAt = 0;
let ytLastState = null;
let ytLastProgressAt = 0;
let ytLastProgressSec = null;

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

function toYouTubeEmbedUrl(rawUrl, repeat = false, startSec = 0) {
  const videoId = extractYtId(rawUrl);
  if (!videoId) {
    console.warn('[MusicPlayer][YT] Could not extract video id from URL:', rawUrl);
    return '';
  }

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

  // In OBR webview, large start offsets can leave YT embed in state -1 (unstarted).
  // Start from 0 for reliability; timeline still uses shared anchor metadata.
  void startSec;

  if (repeat) {
    query.set('loop', '1');
    query.set('playlist', videoId);
  }

  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${query.toString()}`;
}

function sendYouTubeCommand(func, args = []) {
  const w = ytIframe?.contentWindow;
  if (!w) return;
  try {
    w.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
  } catch (_) {}
}

function sendYouTubeListeningHandshake() {
  const w = ytIframe?.contentWindow;
  if (!w) return;
  try {
    w.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
  } catch (_) {}
}

function kickYouTubePlayback() {
  if (!ytIframe?.src) return;
  sendYouTubeCommand('playVideo');
  sendYouTubeCommand('setVolume', [100]);
}

function ytRuntimeStorageKey() {
  if (!currentRoomId || !currentYtTrackId) return '';
  return `darqie.v2.ytRuntime.${currentRoomId}.${currentYtTrackId}`;
}

function writeYtRuntime(currentTime, duration) {
  const key = ytRuntimeStorageKey();
  if (!key) return;
  const c = Number(currentTime);
  const d = Number(duration);
  const payload = {
    ts: Date.now(),
    currentTime: Number.isFinite(c) ? Math.max(0, c) : null,
    duration: Number.isFinite(d) && d > 0 ? d : null,
  };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
    ytLastRuntimeAt = Date.now();
  } catch (_) {}
}

function clearYtRuntime() {
  const key = ytRuntimeStorageKey();
  if (!key) return;
  try { localStorage.removeItem(key); } catch (_) {}
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
  ytPlayerReady = false;
  ytLastRuntimeAt = 0;
  ytLastProgressAt = 0;
  ytLastProgressSec = null;
  ytLastNoRuntimeWarnAt = 0;
  ytLastState = null;
  clearYtRuntime();
  currentYtTrackId = '';
  ytIframe.src = '';
}

function stopAll() {
  runtimeKey = '';
  stopAudio();
  stopSpotify();
  stopYouTube();
}

window.addEventListener('storage', (e) => {
  if (e.key === volKey && bgAudio.src) {
    bgAudio.volume = effectiveVol();
  }
});

ytIframe?.addEventListener('load', () => {
  ytPlayerReady = false;
  setTimeout(sendYouTubeListeningHandshake, 120);
  setTimeout(sendYouTubeListeningHandshake, 500);
});

window.addEventListener('message', (event) => {
  const origin = String(event.origin || '');
  const isYouTubeOrigin =
    origin.includes('youtube.com') ||
    origin.includes('youtube-nocookie.com');
  if (!isYouTubeOrigin) return;

  let data = event.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return; }
  }
  if (!data || typeof data !== 'object') return;

  if (data.event === 'onReady') {
    ytPlayerReady = true;
    console.info('[MusicPlayer][YT] onReady received');
    kickYouTubePlayback();
    return;
  }

  if (data.event === 'infoDelivery' && data.info) {
    const info = data.info;
    const state = Number(info.playerState);
    if (Number.isFinite(state) && state !== ytLastState) {
      ytLastState = state;
      console.info('[MusicPlayer][YT] playerState changed:', state);
    }

    const currentTime = Number(info.currentTime);
    const duration = Number(info.duration);
    if (Number.isFinite(currentTime)) {
      if (!Number.isFinite(ytLastProgressSec) || currentTime > (ytLastProgressSec + 0.15)) {
        ytLastProgressSec = currentTime;
        ytLastProgressAt = Date.now();
      }
    }

    if (Number.isFinite(currentTime) || (Number.isFinite(duration) && duration > 0)) {
      writeYtRuntime(currentTime, duration);
    }
  }
});

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
  const repeat = state.repeat;

  if (type === 'youtube') {
    stopAudio();
    stopSpotify();

    const rk = `${track.id}|yt|${state.anchorTimestampMs}`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      currentYtTrackId = track.id;
      const embedUrl = toYouTubeEmbedUrl(track.url, repeat, posSec);
      if (!embedUrl) {
        stopAll();
        return;
      }

      console.info('[MusicPlayer][YT] start track', {
        trackId: track.id,
        name: track.name,
        anchorPositionSec: Number(posSec.toFixed(2)),
        repeat,
      });

      ytIframe.src = embedUrl;
      setTimeout(kickYouTubePlayback, 700);
      setTimeout(kickYouTubePlayback, 1500);

      setTimeout(() => {
        if (runtimeKey !== rk) return;
        const noRuntimeYet = !ytLastRuntimeAt || (Date.now() - ytLastRuntimeAt > 3000);
        const noProgressYet = !ytLastProgressAt || (Date.now() - ytLastProgressAt > 3000);
        if ((noRuntimeYet || noProgressYet) && Date.now() - ytLastNoRuntimeWarnAt > 3000) {
          ytLastNoRuntimeWarnAt = Date.now();
          console.warn('[MusicPlayer][YT] No runtime/progress after start.', {
            trackId: track.id,
            ytPlayerReady,
            iframeHasSrc: Boolean(ytIframe.src),
            noRuntimeYet,
            noProgressYet,
          });
        }
      }, 3500);
    } else if (ytPlayerReady) {
      kickYouTubePlayback();
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
      bgAudio.loop = repeat;
      bgAudio.volume = effectiveVol();
      bgAudio.src = url;
      bgAudio.play().then(() => {
        const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
        if (drift > 2) {
          try { bgAudio.currentTime = posSec; } catch (_) {}
        }
      }).catch((e) => {
        console.warn('[MusicPlayer] play() blocked:', e?.message || e);
      });
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
  console.info('[MusicPlayer] OBR ready');

  const roomId = OBR.room?.id || '';
  currentRoomId = roomId;

  const playerName = await OBR.player.getName().catch(() => 'player');
  volKey = `${VOL_PREFIX}.${roomId}.${playerName}`;
  globalVol = 1;

  let metadata = {};
  try { metadata = await OBR.room.getMetadata(); } catch (_) {}

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
    try { applyMusic(await OBR.room.getMetadata()); } catch (_) {}
  }, 15000);
});
