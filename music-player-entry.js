import OBR from '@owlbear-rodeo/sdk';

/**
 * Music Player — runs inside OBR 1×1 popover (audio-player.html).
 * OBR grants allow="autoplay" to the popover → bgAudio.play() works.
 * All users (GM + players) hear audio here.
 *
 * YouTube  → Cobalt API (new → old format) → Piped fallback → bgAudio
 * Dropbox/audio → bgAudio directly
 * Spotify  → hidden <iframe>
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const PLAYLIST_KEY   = 'darqie.v2.musicPlaylist';
const STATE_KEY      = 'darqie.v2.musicState';
const VOL_PREFIX     = 'darqie.v2.musicVolume';
const DEFAULT_VOL    = 0.7;

const SUPABASE_URL   = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_TABLE = 'room_music_state';

// ── YouTube audio resolver: Cobalt → Piped ────────────────────────────────────

const ytAudioCache = new Map(); // url → { audioUrl, ts }
const YT_CACHE_TTL = 45 * 60 * 1000;

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

async function resolveYouTubeAudio(ytUrl) {
  const cached = ytAudioCache.get(ytUrl);
  if (cached && Date.now() - cached.ts < YT_CACHE_TTL) {
    console.log('[Music] YT cache hit');
    return cached.audioUrl;
  }

  // 1️⃣ Cobalt new API (v10+)
  try {
    const res = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: ytUrl, downloadMode: 'audio', audioFormat: 'best' }),
    });
    if (res.ok) {
      const d = await res.json().catch(() => null);
      if ((d?.status === 'tunnel' || d?.status === 'redirect') && d.url) {
        ytAudioCache.set(ytUrl, { audioUrl: d.url, ts: Date.now() });
        console.log('[Music] Cobalt v10 resolved ✓');
        return d.url;
      }
      console.warn('[Music] Cobalt v10 status:', d?.status, d?.error?.code);
    } else {
      console.warn('[Music] Cobalt v10 HTTP', res.status);
    }
  } catch (e) { console.warn('[Music] Cobalt v10 error:', e.message); }

  // 2️⃣ Cobalt old API (v1)
  try {
    const res = await fetch('https://api.cobalt.tools/api/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: ytUrl, isAudioOnly: true, aFormat: 'mp3' }),
    });
    if (res.ok) {
      const d = await res.json().catch(() => null);
      if ((d?.status === 'stream' || d?.status === 'redirect' || d?.status === 'tunnel') && d.url) {
        ytAudioCache.set(ytUrl, { audioUrl: d.url, ts: Date.now() });
        console.log('[Music] Cobalt v1 resolved ✓');
        return d.url;
      }
      console.warn('[Music] Cobalt v1 status:', d?.status);
    } else {
      console.warn('[Music] Cobalt v1 HTTP', res.status);
    }
  } catch (e) { console.warn('[Music] Cobalt v1 error:', e.message); }

  // 3️⃣ Piped fallback
  const videoId = extractYtId(ytUrl);
  if (videoId) {
    const pipedInstances = [
      'https://pipedapi.kavin.rocks',
      'https://piped-api.garudalinux.org',
      'https://api.piped.projectsegfau.lt',
    ];
    for (const base of pipedInstances) {
      try {
        const res = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`);
        if (!res.ok) continue;
        const d = await res.json().catch(() => null);
        const stream = d?.audioStreams?.find(s =>
          s.mimeType?.includes('audio') && (s.mimeType?.includes('mp4') || s.mimeType?.includes('webm'))
        ) || d?.audioStreams?.[0];
        if (stream?.url) {
          ytAudioCache.set(ytUrl, { audioUrl: stream.url, ts: Date.now() });
          console.log('[Music] Piped resolved via', base, '✓');
          return stream.url;
        }
      } catch (e) { console.warn('[Music] Piped error:', base, e.message); }
    }
  }

  console.error('[Music] All YouTube resolvers failed:', ytUrl.slice(-40));
  return null;
}

// ── DOM ───────────────────────────────────────────────────────────────────────

const bgAudio       = document.getElementById('bgAudio');
const spotifyIframe = document.getElementById('spotifyIframe');

// ── State ─────────────────────────────────────────────────────────────────────

let volKey     = `${VOL_PREFIX}.global.player`;
let globalVol  = 1;
let runtimeKey = '';

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

function effectiveVol() { return localVol() * globalVol; }

// ── Stop helpers ──────────────────────────────────────────────────────────────

function stopAudio()   { bgAudio.pause(); bgAudio.removeAttribute('src'); bgAudio.load(); }
function stopSpotify() { spotifyIframe.src = ''; }
function stopAll()     { console.log('[Music] stopAll'); runtimeKey = ''; stopAudio(); stopSpotify(); }

// ── Apply Music ───────────────────────────────────────────────────────────────

function applyMusic(metadata) {
  const playlist = Array.isArray(metadata?.[PLAYLIST_KEY]) ? metadata[PLAYLIST_KEY] : [];
  const state    = normalizeState(metadata?.[STATE_KEY]);
  const track    = playlist.find((t) => String(t?.id || '') === state.currentTrackId);

  console.log('[Music] applyMusic — isPlaying:', state.isPlaying, '| track:', track?.name || 'none');

  if (!track?.url || !state.isPlaying) { stopAll(); return; }

  const type   = track.type || detectType(track.url);
  const posSec = getPosSec(state);
  globalVol    = state.globalVolume;
  const repeat = state.repeat;

  // ── YouTube → Cobalt/Piped → bgAudio ──────────────────────────────────────
  if (type === 'youtube') {
    stopSpotify();
    const rk = `${track.id}|yt|${state.anchorTimestampMs}`;
    if (runtimeKey !== rk) {
      runtimeKey = rk;
      stopAudio();
      console.log('[Music] Resolving YouTube:', track.url.slice(-40));
      resolveYouTubeAudio(track.url).then((audioUrl) => {
        if (!audioUrl || runtimeKey !== rk) return;
        bgAudio.loop   = repeat;
        bgAudio.volume = effectiveVol();
        bgAudio.src    = audioUrl;
        bgAudio.play().then(() => {
          const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
          if (drift > 2) { try { bgAudio.currentTime = posSec; } catch (_) {} }
          console.log('[Music] YouTube audio playing ✓');
        }).catch((e) => console.warn('[Music] play() rejected:', e?.message || e));
      }).catch(() => {});
    } else {
      bgAudio.volume = effectiveVol();
    }
    return;
  }

  // ── Audio / Dropbox ───────────────────────────────────────────────────────
  if (type === 'audio' || type === 'dropbox') {
    stopSpotify();
    const url = type === 'dropbox' ? normalizeDropbox(track.url) : String(track.url).trim();
    const rk  = `${track.id}|${type}|${state.anchorTimestampMs}`;
    if (runtimeKey !== rk) {
      runtimeKey     = rk;
      bgAudio.loop   = repeat;
      bgAudio.volume = effectiveVol();
      bgAudio.src    = url;
      console.log('[Music] Loading audio:', url.slice(-60));
      bgAudio.play().then(() => {
        const drift = Math.abs((bgAudio.currentTime || 0) - posSec);
        if (drift > 2) { try { bgAudio.currentTime = posSec; } catch (_) {} }
        console.log('[Music] Audio playing ✓');
      }).catch((e) => console.warn('[Music] play() rejected:', e?.message || e));
    } else {
      bgAudio.volume = effectiveVol();
    }
    return;
  }

  // ── Spotify ───────────────────────────────────────────────────────────────
  if (type === 'spotify') {
    stopAudio();
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

// ── Volume sync ───────────────────────────────────────────────────────────────

window.addEventListener('storage', (e) => {
  if (e.key !== volKey) return;
  if (bgAudio.src) bgAudio.volume = effectiveVol();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

OBR.onReady(async () => {
  console.log('[Music] OBR ready — booting music player');

  const roomId     = OBR.room?.id || '';
  const playerName = await OBR.player.getName().catch(() => 'player');
  console.log('[Music] roomId:', roomId, '| player:', playerName);
  volKey    = `${VOL_PREFIX}.${roomId}.${playerName}`;
  globalVol = 1;

  let metadata = {};
  try { metadata = await OBR.room.getMetadata(); } catch (_) {}

  if (roomId) {
    const snap   = await loadFromSupabase(roomId);
    const metaTs = tsMs(metadata?.[STATE_KEY]?.updatedAt, 0);
    if (snap && snap.updatedAtMs > metaTs) {
      console.log('[Music] Using Supabase snapshot (newer)');
      metadata = { ...metadata, [PLAYLIST_KEY]: snap.playlist, [STATE_KEY]: snap.state };
    }
  }

  applyMusic(metadata);
  OBR.room.onMetadataChange(applyMusic);

  setInterval(async () => {
    try { applyMusic(await OBR.room.getMetadata()); } catch (_) {}
  }, 15000);
});
