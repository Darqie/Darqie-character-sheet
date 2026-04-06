const DARQIE_MUSIC_PLAYLIST_KEY = 'darqie.v2.musicPlaylist';
const DARQIE_MUSIC_STATE_KEY = 'darqie.v2.musicState';
const GM_MUSIC_VOLUME_KEY = 'darqie.v2.gmMusicVolume';

const TRACK_TYPE_YOUTUBE = 'youtube';
const TRACK_TYPE_SPOTIFY = 'spotify';
const TRACK_TYPE_DROPBOX = 'dropbox';
const TRACK_TYPE_AUDIO = 'audio';

let cachedObrClient = null;

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

function toYouTubeEmbedUrl(rawUrl, repeat = false) {
  const videoId = extractYouTubeVideoId(rawUrl);
  if (!videoId) return '';

  const query = new URLSearchParams({
    autoplay: '1',
    controls: '1',
    rel: '0',
    playsinline: '1',
    modestbranding: '1',
  });

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

function normalizeState(value) {
  return {
    currentTrackId: String(value?.currentTrackId || ''),
    isPlaying: Boolean(value?.isPlaying),
    repeat: Boolean(value?.repeat),
    positionSec: Number(value?.positionSec || 0),
    updatedAt: Number(value?.updatedAt || Date.now()),
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

export function initPage({ root }) {
  if (!root) return;

  const urlInput = root.querySelector('#gmMusicUrlInput');
  const nameInput = root.querySelector('#gmMusicNameInput');
  const addButton = root.querySelector('#gmMusicAddButton');
  const tableBody = root.querySelector('#gmMusicTableBody');
  const prevButton = root.querySelector('#gmMusicPrevButton');
  const playPauseButton = root.querySelector('#gmMusicPlayPauseButton');
  const nextButton = root.querySelector('#gmMusicNextButton');
  const repeatButton = root.querySelector('#gmMusicRepeatButton');
  const volumeSlider = root.querySelector('#gmMusicVolumeSlider');
  const volumeValue = root.querySelector('#gmMusicVolumeValue');
  const nowPlaying = root.querySelector('#gmMusicNowPlaying');
  const embedHost = root.querySelector('#gmMusicEmbedHost');
  const audioPlayer = root.querySelector('#gmMusicAudioPlayer');

  if (!urlInput || !nameInput || !addButton || !tableBody || !prevButton || !playPauseButton || !nextButton || !repeatButton || !volumeSlider || !volumeValue || !nowPlaying || !embedHost || !audioPlayer) {
    return;
  }

  let OBR = null;
  let roomId = '';
  let playlist = [];
  let playbackState = normalizeState({});
  let isDestroyed = false;
  let metadataBound = false;
  let currentEmbedKey = '';
  let gmVolume = 0.7;

  function ensureActive() {
    const stillActive = root.isConnected && document.body.contains(root);
    if (stillActive) return true;
    isDestroyed = true;
    return false;
  }

  function getVolumeStorageKey() {
    return `${GM_MUSIC_VOLUME_KEY}.${roomId || 'global'}`;
  }

  function loadGmVolume() {
    try {
      const raw = localStorage.getItem(getVolumeStorageKey());
      const num = Number(raw);
      if (!Number.isFinite(num)) return 0.7;
      return Math.max(0, Math.min(1, num));
    } catch (_) {
      return 0.7;
    }
  }

  function saveGmVolume(value) {
    try {
      localStorage.setItem(getVolumeStorageKey(), String(value));
    } catch (_) {}
  }

  function setVolumeUi(value) {
    const percent = Math.round(value * 100);
    volumeSlider.value = String(percent);
    volumeValue.textContent = `${percent}%`;
    audioPlayer.volume = value;
  }

  function getCurrentTrack() {
    if (!playbackState.currentTrackId) return null;
    return playlist.find((track) => track.id === playbackState.currentTrackId) || null;
  }

  function stopAllPlayback() {
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();

    currentEmbedKey = '';
    embedHost.innerHTML = '';
    embedHost.style.display = 'none';
  }

  function buildEmbedForTrack(track, repeat) {
    if (!track) return '';
    if (track.type === TRACK_TYPE_YOUTUBE) return toYouTubeEmbedUrl(track.url, repeat);
    if (track.type === TRACK_TYPE_SPOTIFY) return toSpotifyEmbedUrl(track.url);
    return '';
  }

  async function syncPlaybackUi() {
    if (!ensureActive()) return;

    const track = getCurrentTrack();
    const isPlaying = playbackState.isPlaying && !!track;

    if (!isPlaying) {
      playPauseButton.innerHTML = '<i class="fas fa-play"></i>';
      nowPlaying.textContent = 'Відтворення зупинено';
      stopAllPlayback();
      return;
    }

    playPauseButton.innerHTML = '<i class="fas fa-pause"></i>';
    nowPlaying.textContent = `Зараз грає: ${track.name}`;

    const directUrl = normalizeTrackUrlByType(track.url, track.type);
    if (track.type === TRACK_TYPE_AUDIO || track.type === TRACK_TYPE_DROPBOX) {
      embedHost.innerHTML = '';
      embedHost.style.display = 'none';

      const playbackUrl = directUrl;
      const nextKey = `${track.id}|${playbackState.repeat ? '1' : '0'}`;

      if (currentEmbedKey !== nextKey || audioPlayer.src !== playbackUrl) {
        currentEmbedKey = nextKey;
        audioPlayer.src = playbackUrl;
        audioPlayer.loop = Boolean(playbackState.repeat);
      }

      try {
        audioPlayer.volume = gmVolume;
        await audioPlayer.play();
      } catch (_) {}
      return;
    }

    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();

    const embedUrl = buildEmbedForTrack(track, playbackState.repeat);
    const nextKey = `${track.id}|${playbackState.repeat ? '1' : '0'}|${gmVolume <= 0 ? 'muted' : 'normal'}`;

    if (!embedUrl) {
      stopAllPlayback();
      nowPlaying.textContent = `Невідомий тип треку: ${track.name}`;
      return;
    }

    if (currentEmbedKey !== nextKey) {
      currentEmbedKey = nextKey;
      embedHost.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.allow = 'autoplay; encrypted-media; fullscreen';
      iframe.src = embedUrl;
      iframe.title = track.name || 'Music Track';
      embedHost.appendChild(iframe);
    }

    embedHost.style.display = 'flex';
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

    const currentMetadata = await OBR.room.getMetadata();
    const metadataPatch = { ...currentMetadata };

    if (nextPlaylist) metadataPatch[DARQIE_MUSIC_PLAYLIST_KEY] = normalizePlaylist(nextPlaylist);
    if (nextState) metadataPatch[DARQIE_MUSIC_STATE_KEY] = normalizeState(nextState);

    await OBR.room.setMetadata(metadataPatch);
  }

  async function loadFromMetadata() {
    if (!OBR || !roomId) return;

    const metadata = await OBR.room.getMetadata();
    playlist = normalizePlaylist(metadata?.[DARQIE_MUSIC_PLAYLIST_KEY]);
    playbackState = normalizeState(metadata?.[DARQIE_MUSIC_STATE_KEY]);
  }

  function renderPlaylist() {
    if (!ensureActive()) return;

    tableBody.innerHTML = '';

    if (!playlist.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4" style="opacity:0.75; text-align:center;">Список порожній. Додайте трек за посиланням вище.</td>';
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
    const nextState = { ...playbackState };
    if (!nextState.currentTrackId) {
      nextState.currentTrackId = track.id;
    }

    await persistMusicData({ nextPlaylist, nextState });

    urlInput.value = '';
    nameInput.value = '';
  }

  async function playTrack(trackId) {
    if (!trackId) return;

    const nextState = {
      ...playbackState,
      currentTrackId: trackId,
      isPlaying: true,
      updatedAt: Date.now(),
    };

    await persistMusicData({ nextState });
  }

  async function pauseTrack() {
    const nextState = {
      ...playbackState,
      isPlaying: false,
      updatedAt: Date.now(),
    };

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

    await playTrack(targetId);
  }

  async function toggleRepeat() {
    const nextState = {
      ...playbackState,
      repeat: !playbackState.repeat,
      updatedAt: Date.now(),
    };

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
    const nextState = { ...playbackState };

    if (nextState.currentTrackId === trackId) {
      nextState.currentTrackId = nextPlaylist[0]?.id || '';
      if (!nextState.currentTrackId) nextState.isPlaying = false;
    }

    await persistMusicData({ nextPlaylist, nextState });
  }

  function bindUi() {
    addButton.addEventListener('click', async () => {
      await addTrack();
    });

    urlInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await addTrack();
      }
    });

    nameInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await addTrack();
      }
    });

    playPauseButton.addEventListener('click', async () => {
      await togglePlayPause();
    });

    prevButton.addEventListener('click', async () => {
      await goRelative(-1);
    });

    nextButton.addEventListener('click', async () => {
      await goRelative(1);
    });

    repeatButton.addEventListener('click', async () => {
      await toggleRepeat();
    });

    volumeSlider.addEventListener('input', () => {
      gmVolume = Math.max(0, Math.min(1, Number(volumeSlider.value) / 100));
      setVolumeUi(gmVolume);
      saveGmVolume(gmVolume);
      syncPlaybackUi();
    });

    tableBody.addEventListener('click', async (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;

      const action = target.getAttribute('data-action');
      const id = target.getAttribute('data-id') || '';

      if (action === 'play') {
        await playTrack(id);
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

    audioPlayer.addEventListener('ended', async () => {
      if (!ensureActive()) return;
      if (!playbackState.isPlaying) return;
      if (playbackState.repeat) return;

      await goRelative(1);
    });
  }

  function bindMetadataListener() {
    if (!OBR || metadataBound) return;
    metadataBound = true;

    OBR.room.onMetadataChange((metadata) => {
      if (!ensureActive()) return;

      playlist = normalizePlaylist(metadata?.[DARQIE_MUSIC_PLAYLIST_KEY]);
      playbackState = normalizeState(metadata?.[DARQIE_MUSIC_STATE_KEY]);
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
    gmVolume = loadGmVolume();
    setVolumeUi(gmVolume);

    bindUi();
    bindMetadataListener();

    await loadFromMetadata();
    if (!ensureActive()) return;

    renderPlaylist();
    syncPlaybackUi();
  })();
}
