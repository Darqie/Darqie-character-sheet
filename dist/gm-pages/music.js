const SUPABASE_URL = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_MUSIC_TABLE = 'room_music_state';

const DARQIE_MUSIC_PLAYLIST_KEY = 'darqie.v2.musicPlaylist';
const DARQIE_MUSIC_STATE_KEY = 'darqie.v2.musicState';
const GM_MUSIC_VOLUME_KEY = 'darqie.v2.musicVolume';

const TRACK_TYPE_YOUTUBE = 'youtube';
const TRACK_TYPE_SPOTIFY = 'spotify';
const TRACK_TYPE_DROPBOX = 'dropbox';
const TRACK_TYPE_AUDIO = 'audio';

const SEEK_FALLBACK_MAX_SEC = 7200;
const POSITION_DRIFT_SEC = 1.2;

let cachedObrClient = null;
let supabaseMusicTableExists = true;

function normalizeTrackName(name, fallback = 'Новий трек') {
  const clean = String(name || '').trim();
  return clean || fallback;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildTrackId() {
  return `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp01(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function normalizeTimestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return Math.floor(number);
}

function normalizePositionSec(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return number;
}

function normalizeState(value) {
  const now = Date.now();
  const updatedAt = normalizeTimestampMs(value?.updatedAt || now);
  const anchorPositionSec = normalizePositionSec(value?.anchorPositionSec ?? value?.positionSec ?? 0);
  const anchorTimestampMs = normalizeTimestampMs(value?.anchorTimestampMs || updatedAt);

  return {
    currentTrackId: String(value?.currentTrackId || ''),
    isPlaying: Boolean(value?.isPlaying),
    repeat: Boolean(value?.repeat),
    anchorPositionSec,
    anchorTimestampMs,
    globalVolume: clamp01(value?.globalVolume, 1),
    updatedAt,
  };
}

function getStatePositionSec(state, atMs = Date.now()) {
  const normalized = normalizeState(state);
  if (!normalized.isPlaying) return normalizePositionSec(normalized.anchorPositionSec);
  const deltaSec = Math.max(0, (normalizeTimestampMs(atMs) - normalized.anchorTimestampMs) / 1000);
  return normalizePositionSec(normalized.anchorPositionSec + deltaSec);
}

function buildTimelineState(baseState, patch = {}) {
  const merged = normalizeState({ ...normalizeState(baseState), ...patch });
  merged.updatedAt = Date.now();
  return merged;
}

function extractYouTubeVideoId(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    const host = url.hostname.toLowerCase();

    if (host === 'youtu.be') {
      return url.pathname.replace(/^\//, '').trim();
    }

    if (host.includes('youtube.com')) {
      const fromSearch = url.searchParams.get('v');
      if (fromSearch) return fromSearch.trim();

      const pathMatch = url.pathname.match(/\/embed\/([^/?]+)/i) || url.pathname.match(/\/shorts\/([^/?]+)/i);
      if (pathMatch?.[1]) return pathMatch[1].trim();
    }
  } catch (_) {}

  return '';
}

function detectTrackType(rawUrl) {
  const clean = String(rawUrl || '').trim().toLowerCase();
  if (!clean) return TRACK_TYPE_AUDIO;

  if (clean.includes('youtu.be/') || clean.includes('youtube.com/')) return TRACK_TYPE_YOUTUBE;
  if (clean.includes('open.spotify.com/')) return TRACK_TYPE_SPOTIFY;
  if (clean.includes('dropbox.com/')) return TRACK_TYPE_DROPBOX;
  return TRACK_TYPE_AUDIO;
}

function normalizeDropboxUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (!url.hostname.toLowerCase().includes('dropbox.com')) return rawUrl;

    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return url.toString();
  } catch (_) {
    return rawUrl;
  }
}

function toSpotifyEmbedUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    const path = url.pathname || '';
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return '';

    const type = segments[0];
    const id = segments[1];
    if (!id) return '';

    return `https://open.spotify.com/embed/${type}/${id}`;
  } catch (_) {
    return '';
  }
}

function toYouTubeEmbedUrl(rawUrl, repeat = false, startSec = 0, muted = true) {
  const videoId = extractYouTubeVideoId(rawUrl);
  if (!videoId) return '';

  const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
  const query = new URLSearchParams({
    autoplay: '1',
    controls: '1',
    rel: '0',
    playsinline: '1',
    modestbranding: '1',
  });
  if (muted) query.set('mute', '1');
  if (origin) query.set('origin', origin);

  const normalizedStart = Math.max(0, Math.floor(Number(startSec) || 0));
  if (normalizedStart > 0) query.set('start', String(normalizedStart));

  if (repeat) {
    query.set('loop', '1');
    query.set('playlist', videoId);
  }

  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${query.toString()}`;
}

function normalizeTrackUrlByType(url, type) {
  if (type === TRACK_TYPE_DROPBOX) return normalizeDropboxUrl(url);
  return String(url || '').trim();
}

function normalizePlaylist(list) {
  return toSafeArray(list).map((track) => {
    const rawUrl = String(track?.url || '').trim();
    const type = track?.type || detectTrackType(rawUrl);
    return {
      id: String(track?.id || buildTrackId()),
      name: normalizeTrackName(track?.name),
      url: normalizeTrackUrlByType(rawUrl, type),
      type,
      createdAt: Number(track?.createdAt || Date.now()),
    };
  }).filter((track) => !!track.url);
}

function formatTime(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function debounce(fn, waitMs) {
  let timeout = null;
  return (...args) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      fn(...args);
    }, waitMs);
  };
}

async function resolveOBRClient() {
  if (cachedObrClient) return cachedObrClient;
  if (window.OBR) {
    cachedObrClient = window.OBR;
    return cachedObrClient;
  }
  return null;
}

async function waitForObrReady(OBR, timeoutMs = 3000) {
  if (!OBR || typeof OBR.onReady !== 'function') return;

  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    try {
      OBR.onReady(() => {
        clearTimeout(timer);
        finish();
      });
    } catch (_) {
      clearTimeout(timer);
      finish();
    }
  });
}

async function upsertMusicToSupabase(roomId, playlist, state) {
  if (!roomId || !supabaseMusicTableExists) return;

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_MUSIC_TABLE}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      room_id: roomId,
      playlist_json: normalizePlaylist(playlist),
      state_json: normalizeState(state),
      updated_at: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    if (response.status === 404 || response.status === 400) {
      supabaseMusicTableExists = false;
      return;
    }
    const text = await response.text().catch(() => '');
    throw new Error(text || `Supabase music upsert failed: ${response.status}`);
  }
}

async function loadMusicFromSupabase(roomId) {
  if (!roomId || !supabaseMusicTableExists) return null;

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_MUSIC_TABLE}?select=playlist_json,state_json,updated_at&room_id=eq.${encodeURIComponent(roomId)}&limit=1`,
    {
      method: 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404 || response.status === 400) {
      supabaseMusicTableExists = false;
      return null;
    }
    const text = await response.text().catch(() => '');
    throw new Error(text || `Supabase music load failed: ${response.status}`);
  }

  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;

  return {
    playlist: normalizePlaylist(row.playlist_json),
    state: normalizeState(row.state_json),
    updatedAtMs: normalizeTimestampMs(Date.parse(row.updated_at || '') || row.state_json?.updatedAt || Date.now()),
  };
}

export function initPage({ root }) {
  if (!root) return;

  const openAddModalButton = root.querySelector('#gmMusicOpenAddModalButton');
  const addModal = root.querySelector('#gmMusicAddModal');
  const cancelAddButton = root.querySelector('#gmMusicCancelAddButton');
  const urlInput = root.querySelector('#gmMusicUrlInput');
  const nameInput = root.querySelector('#gmMusicNameInput');
  const addButton = root.querySelector('#gmMusicAddButton');

  const tableBody = root.querySelector('#gmMusicTableBody');
  const prevButton = root.querySelector('#gmMusicPrevButton');
  const playPauseButton = root.querySelector('#gmMusicPlayPauseButton');
  const nextButton = root.querySelector('#gmMusicNextButton');
  const repeatButton = root.querySelector('#gmMusicRepeatButton');
  const youtubePlayerWrap = root.querySelector('#gmMusicYoutubeWrap');
  const youtubePlayerIframe = root.querySelector('#gmMusicYoutubeIframe');
  const youtubeUnlockButton = root.querySelector('#gmMusicYoutubeUnmuteBtn');

  const globalVolumeSlider = root.querySelector('#gmMusicGlobalVolumeSlider');
  const globalVolumeValue = root.querySelector('#gmMusicGlobalVolumeValue');
  const volumeSlider = root.querySelector('#gmMusicVolumeSlider');
  const volumeValue = root.querySelector('#gmMusicVolumeValue');

  const seekSlider = root.querySelector('#gmMusicSeekSlider');
  const seekValue = root.querySelector('#gmMusicSeekValue');

  const nowPlaying = root.querySelector('#gmMusicNowPlaying');
  const audioPlayer = root.querySelector('#gmMusicAudioPlayer');

  if (!openAddModalButton || !addModal || !cancelAddButton || !urlInput || !nameInput || !addButton || !tableBody || !prevButton || !playPauseButton || !nextButton || !repeatButton || !youtubePlayerWrap || !youtubePlayerIframe || !youtubeUnlockButton || !globalVolumeSlider || !globalVolumeValue || !volumeSlider || !volumeValue || !seekSlider || !seekValue || !nowPlaying || !audioPlayer) {
    return;
  }

  let OBR = null;
  let roomId = '';
  let playerName = '';
  let playlist = [];
  let playbackState = normalizeState({});
  let isDestroyed = false;
  let metadataBound = false;
  let currentRuntimeKey = '';
  let hiddenEmbed = null;
  let gmVolume = 0.7;
  let seekDragActive = false;
  let seekTimerId = null;

  function ensureActive() {
    const stillActive = root.isConnected && document.body.contains(root);
    if (stillActive) return true;
    isDestroyed = true;
    if (seekTimerId) {
      clearInterval(seekTimerId);
      seekTimerId = null;
    }
    return false;
  }

  function getVolumeStorageKey() {
    return `${GM_MUSIC_VOLUME_KEY}.${roomId || 'global'}.${playerName || 'gm'}`;
  }

  function loadGmVolume() {
    try {
      const raw = localStorage.getItem(getVolumeStorageKey());
      return clamp01(raw, 0.7);
    } catch (_) {
      return 0.7;
    }
  }

  function saveGmVolume(value) {
    try {
      localStorage.setItem(getVolumeStorageKey(), String(clamp01(value, 0.7)));
    } catch (_) {}
  }

  function getEffectiveVolume() {
    return clamp01(gmVolume, 0.7) * clamp01(playbackState.globalVolume, 1);
  }

  function setLocalVolumeUi(value) {
    const percent = Math.round(clamp01(value, 0.7) * 100);
    volumeSlider.value = String(percent);
    volumeValue.textContent = `${percent}%`;
  }

  function setGlobalVolumeUi(value) {
    const percent = Math.round(clamp01(value, 1) * 100);
    globalVolumeSlider.value = String(percent);
    globalVolumeValue.textContent = `${percent}%`;
  }

  function ensureHiddenEmbed() {
    if (hiddenEmbed) return hiddenEmbed;
    const iframe = document.createElement('iframe');
    // Position in-viewport but invisible (1x1px bottom-right).
    // Off-screen (-9999px) causes Chrome to block audio in cross-origin iframes.
    iframe.style.position = 'fixed';
    iframe.style.bottom = '0';
    iframe.style.right = '0';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.border = 'none';
    iframe.style.pointerEvents = 'none';
    iframe.style.zIndex = '-1';
    iframe.allow = 'autoplay *; encrypted-media *; fullscreen *';
    document.body.appendChild(iframe);
    hiddenEmbed = iframe;
    return hiddenEmbed;
  }

  function clearHiddenEmbed() {
    if (!hiddenEmbed) return;
    hiddenEmbed.remove();
    hiddenEmbed = null;
  }

  // true while a GM click handler has already loaded the YT iframe without mute
  let gmYoutubeGestureActive = false;

  function getCurrentTrack() {
    if (!playbackState.currentTrackId) return null;
    return playlist.find((track) => track.id === playbackState.currentTrackId) || null;
  }

  function stopAllPlayback() {
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
    clearHiddenEmbed();
    youtubePlayerIframe.src = '';
    youtubeUnlockButton.style.display = 'none';
    currentRuntimeKey = '';
  }

  function getKnownDurationSec() {
    if (Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
      return audioPlayer.duration;
    }
    return null;
  }

  function updateSeekUi() {
    if (!ensureActive()) return;
    if (seekDragActive) return;

    const track = getCurrentTrack();
    if (!track || !playbackState.currentTrackId) {
      seekSlider.disabled = true;
      seekSlider.max = '100';
      seekSlider.value = '0';
      seekValue.textContent = '0:00';
      return;
    }

    const currentPos = getStatePositionSec(playbackState);
    const durationSec = getKnownDurationSec();
    const maxSec = durationSec || SEEK_FALLBACK_MAX_SEC;

    seekSlider.disabled = false;
    seekSlider.max = String(Math.max(1, Math.floor(maxSec)));
    seekSlider.value = String(Math.max(0, Math.min(maxSec, currentPos)));

    if (durationSec) {
      seekValue.textContent = `${formatTime(currentPos)} / ${formatTime(durationSec)}`;
    } else {
      seekValue.textContent = formatTime(currentPos);
    }
  }

  async function syncPlaybackUi() {
    if (!ensureActive()) return;

    const track = getCurrentTrack();
    const isPlaying = playbackState.isPlaying && !!track;

    if (!isPlaying) {
      playPauseButton.innerHTML = '<i class="fas fa-play"></i>';
      nowPlaying.textContent = track ? `Пауза: ${track.name}` : 'Відтворення зупинено';
      youtubeUnlockButton.style.display = 'none';
      stopAllPlayback();
      updateSeekUi();
      return;
    }

    playPauseButton.innerHTML = '<i class="fas fa-pause"></i>';
    nowPlaying.textContent = `Зараз грає: ${track.name}`;

    const currentPos = getStatePositionSec(playbackState);
    const effectiveVolume = getEffectiveVolume();
    const directUrl = normalizeTrackUrlByType(track.url, track.type);

    if (track.type === TRACK_TYPE_AUDIO || track.type === TRACK_TYPE_DROPBOX) {
      youtubePlayerIframe.src = '';
      youtubeUnlockButton.style.display = 'none';
      clearHiddenEmbed();

      const nextKey = `${track.id}|${playbackState.repeat ? '1' : '0'}|audio`;
      if (currentRuntimeKey !== nextKey || audioPlayer.src !== directUrl) {
        currentRuntimeKey = nextKey;
        audioPlayer.src = directUrl;
        audioPlayer.loop = Boolean(playbackState.repeat);
      }

      const driftSec = Math.abs((audioPlayer.currentTime || 0) - currentPos);
      if (driftSec > POSITION_DRIFT_SEC) {
        try {
          audioPlayer.currentTime = currentPos;
        } catch (_) {}
      }

      audioPlayer.volume = effectiveVolume;
      try {
        await audioPlayer.play();
      } catch (_) {}

      updateSeekUi();
      return;
    }

    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();

    const nextKey = `${track.id}|${playbackState.repeat ? '1' : '0'}|${track.type}|${playbackState.anchorTimestampMs}`;

    if (track.type === TRACK_TYPE_YOUTUBE) {
      if (currentRuntimeKey !== nextKey) {
        if (gmYoutubeGestureActive) {
          // Click handler already loaded iframe without mute — don't override with muted src
          gmYoutubeGestureActive = false;
          youtubeUnlockButton.style.display = 'none';
        } else {
          const embedUrl = toYouTubeEmbedUrl(track.url, playbackState.repeat, currentPos, true);
          if (!embedUrl) {
            stopAllPlayback();
            nowPlaying.textContent = `Невідомий тип треку: ${track.name}`;
            updateSeekUi();
            return;
          }
          youtubePlayerIframe.src = embedUrl;
          youtubeUnlockButton.style.display = '';
        }
        currentRuntimeKey = nextKey;
      }
    } else if (track.type === TRACK_TYPE_SPOTIFY) {
      youtubePlayerIframe.src = '';
      youtubeUnlockButton.style.display = 'none';
      if (currentRuntimeKey !== nextKey) {
        const embedUrl = toSpotifyEmbedUrl(track.url);
        if (!embedUrl) {
          stopAllPlayback();
          nowPlaying.textContent = `Невідомий тип треку: ${track.name}`;
          updateSeekUi();
          return;
        }
        currentRuntimeKey = nextKey;
        const iframe = ensureHiddenEmbed();
        iframe.src = embedUrl;
      }
    } else {
      stopAllPlayback();
      nowPlaying.textContent = `Невідомий тип треку: ${track.name}`;
      updateSeekUi();
      return;
    }

    updateSeekUi();
  }

  function getNextTrackId(currentId, direction) {
    if (!playlist.length) return '';
    const index = playlist.findIndex((track) => track.id === currentId);
    if (index < 0) return playlist[0].id;

    const nextIndex = (index + direction + playlist.length) % playlist.length;
    return playlist[nextIndex]?.id || '';
  }

  async function persistMusicData({ nextPlaylist = null, nextState = null } = {}) {
    if (!OBR || !roomId) return;

    const playlistToPersist = nextPlaylist ? normalizePlaylist(nextPlaylist) : playlist;
    const stateToPersist = nextState ? normalizeState(nextState) : playbackState;

    const currentMetadata = await OBR.room.getMetadata();
    const metadataPatch = { ...currentMetadata };
    metadataPatch[DARQIE_MUSIC_PLAYLIST_KEY] = playlistToPersist;
    metadataPatch[DARQIE_MUSIC_STATE_KEY] = stateToPersist;

    await OBR.room.setMetadata(metadataPatch);
    await upsertMusicToSupabase(roomId, playlistToPersist, stateToPersist).catch((error) => {
      console.warn('[Music] Supabase sync warning:', error);
    });
  }

  async function loadFromSources() {
    if (!OBR || !roomId) return;

    const metadata = await OBR.room.getMetadata();
    const metadataPlaylist = normalizePlaylist(metadata?.[DARQIE_MUSIC_PLAYLIST_KEY]);
    const metadataState = normalizeState(metadata?.[DARQIE_MUSIC_STATE_KEY]);
    const metadataUpdatedAt = normalizeTimestampMs(metadataState.updatedAt);

    let finalPlaylist = metadataPlaylist;
    let finalState = metadataState;

    try {
      const supabaseSnapshot = await loadMusicFromSupabase(roomId);
      if (supabaseSnapshot && supabaseSnapshot.updatedAtMs > metadataUpdatedAt) {
        finalPlaylist = supabaseSnapshot.playlist;
        finalState = supabaseSnapshot.state;
        await persistMusicData({ nextPlaylist: finalPlaylist, nextState: finalState });
      }
    } catch (error) {
      console.warn('[Music] Supabase load warning:', error);
    }

    playlist = finalPlaylist;
    playbackState = finalState;
  }

  function renderPlaylist() {
    if (!ensureActive()) return;

    tableBody.innerHTML = '';

    if (!playlist.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4" style="opacity:0.75; text-align:center;">Список порожній. Натисніть "Додати трек".</td>';
      tableBody.appendChild(tr);
      return;
    }

    playlist.forEach((track) => {
      const tr = document.createElement('tr');
      const isCurrent = playbackState.currentTrackId === track.id;
      if (isCurrent) tr.style.background = 'rgba(120, 255, 165, 0.12)';

      tr.innerHTML = `
        <td>
          <input class="gm-cell-input" type="text" value="${escapeHtml(track.name)}" data-action="rename" data-id="${escapeHtml(track.id)}" />
        </td>
        <td title="${escapeHtml(track.url)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(track.url)}</td>
        <td style="text-transform:capitalize;">${escapeHtml(track.type)}</td>
        <td>
          <div class="gm-music-actions">
            <button class="gm-music-btn" type="button" data-action="play" data-id="${escapeHtml(track.id)}" title="Відтворити"><i class="fas fa-play"></i></button>
            <button class="gm-music-btn" type="button" data-action="delete" data-id="${escapeHtml(track.id)}" title="Видалити"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      `;

      tableBody.appendChild(tr);
    });

    repeatButton.classList.toggle('is-active', Boolean(playbackState.repeat));
  }

  async function addTrack() {
    const rawUrl = String(urlInput.value || '').trim();
    if (!rawUrl) return;

    const type = detectTrackType(rawUrl);
    const normalizedUrl = normalizeTrackUrlByType(rawUrl, type);

    const fallbackName = (() => {
      if (type === TRACK_TYPE_YOUTUBE) return 'YouTube трек';
      if (type === TRACK_TYPE_SPOTIFY) return 'Spotify трек';
      if (type === TRACK_TYPE_DROPBOX) return 'Dropbox трек';
      return 'Аудіо трек';
    })();

    const track = {
      id: buildTrackId(),
      name: normalizeTrackName(nameInput.value, fallbackName),
      url: normalizedUrl,
      type,
      createdAt: Date.now(),
    };

    const nextPlaylist = normalizePlaylist([...playlist, track]);
    const nextState = normalizeState({ ...playbackState });
    if (!nextState.currentTrackId) {
      nextState.currentTrackId = track.id;
      nextState.isPlaying = true;
      nextState.anchorPositionSec = 0;
      nextState.anchorTimestampMs = Date.now();
      nextState.updatedAt = Date.now();
    }

    await persistMusicData({ nextPlaylist, nextState });

    urlInput.value = '';
    nameInput.value = '';
    closeAddModal();
  }

  function stateWithCurrentPosition() {
    const currentPos = getStatePositionSec(playbackState);
    return buildTimelineState(playbackState, {
      anchorPositionSec: currentPos,
      anchorTimestampMs: Date.now(),
    });
  }

  async function playTrack(trackId, startAtSec = null) {
    if (!trackId) return;

    const nextState = stateWithCurrentPosition();
    nextState.currentTrackId = trackId;
    nextState.isPlaying = true;
    nextState.anchorPositionSec = normalizePositionSec(startAtSec ?? nextState.anchorPositionSec);
    nextState.anchorTimestampMs = Date.now();

    await persistMusicData({ nextState });
  }

  async function pauseTrack() {
    const currentPos = getStatePositionSec(playbackState);
    const nextState = buildTimelineState(playbackState, {
      isPlaying: false,
      anchorPositionSec: currentPos,
      anchorTimestampMs: Date.now(),
    });

    await persistMusicData({ nextState });
  }

  async function togglePlayPause() {
    if (!playlist.length) return;

    if (playbackState.isPlaying) {
      await pauseTrack();
      return;
    }

    const targetId = playbackState.currentTrackId || playlist[0].id;
    await playTrack(targetId);
  }

  async function goRelative(direction) {
    if (!playlist.length) return;

    const targetId = getNextTrackId(playbackState.currentTrackId, direction);
    if (!targetId) return;

    await playTrack(targetId, 0);
  }

  async function toggleRepeat() {
    const nextState = buildTimelineState(playbackState, {
      repeat: !playbackState.repeat,
    });

    await persistMusicData({ nextState });
  }

  async function renameTrack(trackId, newName) {
    if (!trackId) return;

    const nextPlaylist = playlist.map((track) => {
      if (track.id !== trackId) return track;
      return { ...track, name: normalizeTrackName(newName, track.name) };
    });

    await persistMusicData({ nextPlaylist });
  }

  async function deleteTrack(trackId) {
    if (!trackId) return;

    const nextPlaylist = playlist.filter((track) => track.id !== trackId);
    const nextState = buildTimelineState(playbackState, {});

    if (nextState.currentTrackId === trackId) {
      nextState.currentTrackId = nextPlaylist[0]?.id || '';
      nextState.anchorPositionSec = 0;
      nextState.anchorTimestampMs = Date.now();
      if (!nextState.currentTrackId) nextState.isPlaying = false;
    }

    await persistMusicData({ nextPlaylist, nextState });
  }

  async function seekTo(seconds) {
    const sec = normalizePositionSec(seconds);
    const nextState = buildTimelineState(playbackState, {
      anchorPositionSec: sec,
      anchorTimestampMs: Date.now(),
    });
    await persistMusicData({ nextState });
  }

  function openAddModal() {
    addModal.classList.add('is-open');
    addModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      urlInput.focus();
      urlInput.select();
    }, 0);
  }

  function closeAddModal() {
    addModal.classList.remove('is-open');
    addModal.setAttribute('aria-hidden', 'true');
  }

  const persistGlobalVolumeDebounced = debounce(async (value) => {
    const nextState = buildTimelineState(playbackState, {
      globalVolume: clamp01(value, 1),
    });
    await persistMusicData({ nextState });
  }, 120);

  function bindUi() {
    openAddModalButton.addEventListener('click', () => {
      openAddModal();
    });

    cancelAddButton.addEventListener('click', () => {
      closeAddModal();
    });

    addModal.addEventListener('click', (e) => {
      if (e.target === addModal) closeAddModal();
    });

    addButton.addEventListener('click', async () => {
      await addTrack();
    });

    urlInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await addTrack();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAddModal();
      }
    });

    nameInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await addTrack();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAddModal();
      }
    });

    playPauseButton.addEventListener('click', async () => {
      if (!playbackState.isPlaying && playlist.length) {
        const targetId = playbackState.currentTrackId || playlist[0]?.id;
        const targetTrack = playlist.find((t) => t.id === targetId);
        if (targetTrack?.type === TRACK_TYPE_YOUTUBE) {
          gmYoutubeGestureActive = true;
          youtubePlayerIframe.src = toYouTubeEmbedUrl(targetTrack.url, Boolean(playbackState.repeat), getStatePositionSec(playbackState), false);
          youtubeUnlockButton.style.display = 'none';
        }
      }
      await togglePlayPause();
    });

    prevButton.addEventListener('click', async () => {
      const targetId = getNextTrackId(playbackState.currentTrackId, -1);
      const targetTrack = playlist.find((t) => t.id === targetId);
      if (targetTrack?.type === TRACK_TYPE_YOUTUBE) {
        gmYoutubeGestureActive = true;
        youtubePlayerIframe.src = toYouTubeEmbedUrl(targetTrack.url, Boolean(playbackState.repeat), 0, false);
        youtubeUnlockButton.style.display = 'none';
      }
      await goRelative(-1);
    });

    nextButton.addEventListener('click', async () => {
      const targetId = getNextTrackId(playbackState.currentTrackId, 1);
      const targetTrack = playlist.find((t) => t.id === targetId);
      if (targetTrack?.type === TRACK_TYPE_YOUTUBE) {
        gmYoutubeGestureActive = true;
        youtubePlayerIframe.src = toYouTubeEmbedUrl(targetTrack.url, Boolean(playbackState.repeat), 0, false);
        youtubeUnlockButton.style.display = 'none';
      }
      await goRelative(1);
    });

    repeatButton.addEventListener('click', async () => {
      await toggleRepeat();
    });

    volumeSlider.addEventListener('input', () => {
      gmVolume = clamp01(Number(volumeSlider.value) / 100, 0.7);
      setLocalVolumeUi(gmVolume);
      saveGmVolume(gmVolume);
      audioPlayer.volume = getEffectiveVolume();
    });

    globalVolumeSlider.addEventListener('input', () => {
      const value = clamp01(Number(globalVolumeSlider.value) / 100, 1);
      setGlobalVolumeUi(value);
      playbackState = normalizeState({ ...playbackState, globalVolume: value });
      persistGlobalVolumeDebounced(value);
      audioPlayer.volume = getEffectiveVolume();
    });

    seekSlider.addEventListener('pointerdown', () => {
      seekDragActive = true;
    });

    seekSlider.addEventListener('input', () => {
      const sec = Number(seekSlider.value) || 0;
      const durationSec = getKnownDurationSec();
      if (durationSec) {
        seekValue.textContent = `${formatTime(sec)} / ${formatTime(durationSec)}`;
      } else {
        seekValue.textContent = formatTime(sec);
      }
    });

    seekSlider.addEventListener('change', async () => {
      seekDragActive = false;
      await seekTo(Number(seekSlider.value) || 0);
    });

    seekSlider.addEventListener('pointerup', async () => {
      if (!seekDragActive) return;
      seekDragActive = false;
      await seekTo(Number(seekSlider.value) || 0);
    });

    tableBody.addEventListener('click', async (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;

      const action = target.getAttribute('data-action');
      const id = target.getAttribute('data-id') || '';

      if (action === 'play') {
        const targetTrack = playlist.find((t) => t.id === id);
        if (targetTrack?.type === TRACK_TYPE_YOUTUBE) {
          gmYoutubeGestureActive = true;
          youtubePlayerIframe.src = toYouTubeEmbedUrl(targetTrack.url, Boolean(playbackState.repeat), 0, false);
          youtubeUnlockButton.style.display = 'none';
        }
        await playTrack(id, 0);
      }

      if (action === 'delete') {
        await deleteTrack(id);
      }
    });

    tableBody.addEventListener('change', async (e) => {
      const input = e.target.closest('input[data-action="rename"]');
      if (!input) return;

      const id = input.getAttribute('data-id') || '';
      await renameTrack(id, input.value);
    });

    youtubeUnlockButton.addEventListener('click', () => {
      const track = getCurrentTrack();
      if (!track || track.type !== TRACK_TYPE_YOUTUBE) return;
      const currentPos = getStatePositionSec(playbackState);
      const repeat = Boolean(playbackState.repeat);
      const nextKey = `${track.id}|${repeat ? '1' : '0'}|${track.type}|${playbackState.anchorTimestampMs}`;
      // Reload WITHOUT mute in user gesture context → Chrome allows autoplay with sound
      currentRuntimeKey = nextKey; // exact match → syncPlaybackUi won't override on next tick
      youtubePlayerIframe.src = toYouTubeEmbedUrl(track.url, repeat, currentPos, false);
      youtubeUnlockButton.style.display = 'none';
    });

    audioPlayer.addEventListener('ended', async () => {
      if (!ensureActive()) return;
      if (!playbackState.isPlaying) return;
      if (playbackState.repeat) return;

      await goRelative(1);
    });

    audioPlayer.addEventListener('loadedmetadata', () => {
      updateSeekUi();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && addModal.classList.contains('is-open')) {
        closeAddModal();
      }
    });
  }

  function bindMetadataListener() {
    if (!OBR || metadataBound) return;
    metadataBound = true;

    OBR.room.onMetadataChange((metadata) => {
      if (!ensureActive()) return;

      playlist = normalizePlaylist(metadata?.[DARQIE_MUSIC_PLAYLIST_KEY]);
      playbackState = normalizeState(metadata?.[DARQIE_MUSIC_STATE_KEY]);
      setGlobalVolumeUi(playbackState.globalVolume);
      renderPlaylist();
      syncPlaybackUi();
    });
  }

  (async () => {
    OBR = await resolveOBRClient();
    if (!OBR) {
      nowPlaying.textContent = 'OBR SDK недоступний';
      return;
    }

    await waitForObrReady(OBR);
    if (!ensureActive()) return;

    roomId = OBR.room?.id || '';
    playerName = await OBR.player.getName().catch(() => 'gm');

    gmVolume = loadGmVolume();
    setLocalVolumeUi(gmVolume);
    setGlobalVolumeUi(1);

    bindUi();
    bindMetadataListener();

    await loadFromSources();
    if (!ensureActive()) return;

    setGlobalVolumeUi(playbackState.globalVolume);
    renderPlaylist();
    await syncPlaybackUi();

    seekTimerId = setInterval(() => {
      if (!ensureActive()) return;
      updateSeekUi();
      if (playbackState.isPlaying) {
        const track = getCurrentTrack();
        if (track && (track.type === TRACK_TYPE_AUDIO || track.type === TRACK_TYPE_DROPBOX)) {
          const effectiveVolume = getEffectiveVolume();
          if (Math.abs((audioPlayer.volume || 0) - effectiveVolume) > 0.01) {
            audioPlayer.volume = effectiveVolume;
          }
        }
      }
    }, 1000);
  })();
}

