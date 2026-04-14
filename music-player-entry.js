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

let volKey = `${VOL_PREFIX}.global.player`;
let globalVol = 1;
let runtimeKey = '';

let currentRoomId = '';
let ytAudioCache = new Map(); // videoId -> { url, expiresAt }

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

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
];

const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

async function fetchYouTubeAudioUrl(videoId) {
  const cached = ytAudioCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  for (const instance of PIPED_INSTANCES) {
    const directUrl = `${instance}/streams/${encodeURIComponent(videoId)}`;

    // Try each CORS proxy for this Piped instance
    for (const proxyFn of CORS_PROXIES) {
      try {
        const r = await fetch(proxyFn(directUrl));
        if (!r.ok) continue;
        const json = await r.json();
        const streams = Array.isArray(json.audioStreams) ? json.audioStreams : [];
        const best = streams
          .filter(s => s.url && s.mimeType?.startsWith('audio/'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (best?.url) {
          ytAudioCache.set(videoId, { url: best.url, expiresAt: Date.now() + 5 * 3600_000 });
          console.info('[MusicPlayer][YT] Got direct audio via proxy', { instance, bitrate: best.bitrate, codec: best.codec });
          return best.url;
        }
      } catch (e) {
        console.warn('[MusicPlayer][YT] Proxy failed:', instance, e?.message || e);
      }
    }
  }
  console.error('[MusicPlayer][YT] All Piped instances + proxies failed for videoId:', videoId);
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
  stopAudio();
  stopSpotify();
}

window.addEventListener('storage', (e) => {
  if (e.key === volKey && bgAudio.src) {
    bgAudio.volume = effectiveVol();
  }
});

// YouTube is now handled via direct audio stream (Piped API), no iframe needed

let currentYtTrackId = '';

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
    stopSpotify();

    const videoId = extractYtId(track.url);
    if (!videoId) { stopAll(); return; }

    const rk = `${track.id}|yt|${state.anchorTimestampMs}`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      currentYtTrackId = track.id;
      console.info('[MusicPlayer][YT] start track', {
        trackId: track.id, name: track.name,
        anchorPositionSec: Number(posSec.toFixed(2)), repeat,
      });

      fetchYouTubeAudioUrl(videoId).then(audioUrl => {
        if (runtimeKey !== rk) return; // stale
        if (!audioUrl) { console.error('[MusicPlayer][YT] No audio URL'); stopAll(); return; }

        bgAudio.loop = repeat;
        bgAudio.volume = effectiveVol();
        bgAudio.src = audioUrl;
        bgAudio.play().then(() => {
          const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
          if (drift > 2) {
            try { bgAudio.currentTime = posSec; } catch (_) {}
          }
        }).catch(e => console.warn('[MusicPlayer][YT] play() blocked:', e?.message || e));
      });
    } else {
      bgAudio.volume = effectiveVol();
    }
    return;
  }

  if (type === 'audio' || type === 'dropbox') {
    stopSpotify();
    currentYtTrackId = '';
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
