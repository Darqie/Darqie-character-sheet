const SUPABASE_URL = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const SUPABASE_PHOTO_BUCKET = 'character-photos';
const TOKEN_PLACEHOLDER_URL = 'https://raw.githubusercontent.com/Darqie/Darqie-character-sheet/main/public/character-token-placeholder.png';
const CHARACTER_TYPE_PLAYER = 'player';
const CHARACTER_TYPE_NPC = 'npc';
const TOKEN_UPLOAD_RESOLUTION = 512;
const TOKEN_ITEM_RESOLUTION = 128;
const DARQIE_SHEETS_KEY = 'darqie.characterSheets';
const DARQIE_REGISTRY_KEY = 'darqie.v2.registry';
const DARQIE_ROOM_ID_KEY = 'darqie.lastRoomId';
const DICE_ROLL_THROTTLE_MS = 500;

let cachedSupabaseClient = null;
let cachedObrClient = null;

async function getSupabaseClient() {
  return cachedSupabaseClient;
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

function getTypeFromRow(row) {
  const type = row?.extra_data?.characterType;
  return type === CHARACTER_TYPE_NPC ? CHARACTER_TYPE_NPC : CHARACTER_TYPE_PLAYER;
}

function getWeaponInfo(row) {
  const weapons = Array.isArray(row?.weapons_json) ? row.weapons_json : [];
  const first = weapons[0] || {};
  return {
    bonus: first.bonus || '',
    damage: first.damage || '',
  };
}

function toSafeNumberString(value, fallback = '0') {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return String(parsed);
}

function parseHitBonus(rawValue) {
  const clean = String(rawValue || '').trim();
  if (!clean) return 0;
  const normalized = clean.startsWith('+') ? clean.slice(1) : clean;
  const parsed = parseInt(normalized, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseWeaponDamage(damageString) {
  if (!damageString || typeof damageString !== 'string') return null;
  const cleanString = damageString.trim();
  const regex = /^(\d+)d(\d+)([+-]\d+)?$/i;
  const match = cleanString.match(regex);
  if (!match) return null;

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const bonus = match[3] ? parseInt(match[3], 10) : 0;

  const diceType = `D${sides}`;
  const validDice = ['D4', 'D6', 'D8', 'D10', 'D12', 'D20', 'D100'];
  if (!validDice.includes(diceType)) return null;

  return { dice: diceType, count, bonus };
}

function getDefaultNpcWeapons() {
  return [{ name: '', bonus: '+0', damage: '1d6' }];
}

function hashCharacterName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash &= hash;
  }
  return Math.abs(hash).toString(36);
}

function appendCacheVersion(url, version) {
  const clean = String(url || '').trim();
  if (!clean) return '';
  if (clean.includes('?')) return clean;
  return `${clean}?v=${encodeURIComponent(String(version || Date.now()))}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getActionButtonsHtml(type) {
  const openBtn = type === CHARACTER_TYPE_PLAYER
    ? '<button type="button" class="gm-row-btn" data-action="open" title="До листа"><i class="fas fa-arrow-right"></i></button>'
    : '';

  return `
    <div class="gm-row-actions">
      <button type="button" class="gm-row-btn" data-action="token" title="Токен"><i class="fas fa-map-marker-alt"></i></button>
      <button type="button" class="gm-row-btn" data-action="tokenPhoto" title="Фото токена"><i class="fas fa-image"></i></button>
      ${openBtn}
      <button type="button" class="gm-row-btn gm-row-btn--danger" data-action="delete" title="Видалити"><i class="fas fa-trash-alt"></i></button>
    </div>
  `;
}

function normalizeRow(row) {
  const cloned = { ...(row || {}) };
  cloned.extra_data = { ...(row?.extra_data || {}) };
  cloned.character_name = String(cloned.character_name || '').trim();
  if (!Array.isArray(cloned.weapons_json)) {
    cloned.weapons_json = getTypeFromRow(cloned) === CHARACTER_TYPE_NPC ? getDefaultNpcWeapons() : [];
  }
  return cloned;
}

function normalizeCharacterNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function pickMostRecentRow(a, b) {
  if (!a) return b;
  if (!b) return a;

  const aTs = Date.parse(a.updated_at || '') || 0;
  const bTs = Date.parse(b.updated_at || '') || 0;
  return bTs >= aTs ? b : a;
}

function dedupeRowsByCharacterName(list) {
  const byName = new Map();

  (Array.isArray(list) ? list : []).forEach((row) => {
    const normalized = normalizeRow(row);
    const key = normalizeCharacterNameKey(normalized.character_name);
    if (!key) return;

    const existing = byName.get(key);
    byName.set(key, pickMostRecentRow(existing, normalized));
  });

  return Array.from(byName.values());
}

function inferTypeFromSheet(sheet) {
  const explicit = sheet?.extra_data?.characterType;
  if (explicit === CHARACTER_TYPE_NPC || explicit === CHARACTER_TYPE_PLAYER) return explicit;

  const hasNpcStats =
    String(sheet?.healthPoints || '').trim() !== '' ||
    String(sheet?.armorClass || '').trim() !== '' ||
    (Array.isArray(sheet?.weapons) && sheet.weapons.length > 0);
  return hasNpcStats ? CHARACTER_TYPE_NPC : CHARACTER_TYPE_PLAYER;
}

function rowFromLegacySheet(sheet, roomId) {
  const type = inferTypeFromSheet(sheet);
  const legacyWeapons = Array.isArray(sheet?.weapons) ? JSON.parse(JSON.stringify(sheet.weapons)) : [];
  return normalizeRow({
    room_id: roomId,
    character_name: sheet?.characterName || '',
    player_name: sheet?.playerName || '',
    health_points: sheet?.healthPoints || '',
    max_health_points: sheet?.maxHealthPoints || sheet?.healthPoints || '',
    armor_class: sheet?.armorClass || '',
    weapons_json: legacyWeapons,
    extra_data: {
      ...(sheet?.extra_data || {}),
      tokenPhoto: sheet?.tokenPhoto || '',
      characterPhoto: sheet?.characterPhoto || '',
      characterType: type,
    },
    updated_at: null,
  });
}

async function loadRowsFromMetadata(OBR, roomId) {
  if (!OBR) return [];
  try {
    const metadata = await OBR.room.getMetadata();
    const registry = Array.isArray(metadata?.[DARQIE_REGISTRY_KEY]) ? metadata[DARQIE_REGISTRY_KEY] : [];
    const legacySheets = Array.isArray(metadata?.[DARQIE_SHEETS_KEY]) ? metadata[DARQIE_SHEETS_KEY] : [];

    const rowsByName = new Map();

    legacySheets.forEach((sheet) => {
      const row = rowFromLegacySheet(sheet, roomId);
      if (row.character_name) rowsByName.set(row.character_name, row);
    });

    registry.forEach((entry) => {
      const name = entry?.characterName || '';
      if (!name) return;
      if (rowsByName.has(name)) {
        const merged = rowsByName.get(name);
        merged.player_name = entry?.playerName || merged.player_name || '';
        rowsByName.set(name, merged);
        return;
      }

      rowsByName.set(name, normalizeRow({
        room_id: roomId,
        character_name: name,
        player_name: entry?.playerName || '',
        health_points: '',
        max_health_points: '',
        armor_class: '',
        weapons_json: [],
        extra_data: { characterType: CHARACTER_TYPE_PLAYER },
        updated_at: null,
      }));
    });

    return Array.from(rowsByName.values());
  } catch (_) {
    return [];
  }
}

function buildRowsSignature(list) {
  return JSON.stringify(
    (Array.isArray(list) ? list : []).map((row) => ({
      room_id: row.room_id || '',
      character_name: row.character_name || '',
      player_name: row.player_name || '',
      health_points: row.health_points || '',
      max_health_points: row.max_health_points || '',
      armor_class: row.armor_class || '',
      weapons_json: Array.isArray(row.weapons_json) ? row.weapons_json : [],
      extra_data: row.extra_data || {},
      updated_at: row.updated_at || null,
    }))
  );
}

function buildCharacterRowHtml(row, players) {
  const type = getTypeFromRow(row);
  const weapon = getWeaponInfo(row);
  const isNpc = type === CHARACTER_TYPE_NPC;
  const safeCharacterName = escapeHtml(row.character_name || '');
  const safeHealth = escapeHtml(row.health_points || '');
  const safeArmor = escapeHtml(row.armor_class || '');
  const safeWeaponBonus = escapeHtml(isNpc ? (weapon.bonus || '+0') : '');
  const safeWeaponDamage = escapeHtml(isNpc ? (weapon.damage || '1d6') : '');

  const playerOptions = ['<option value="">-</option>']
    .concat(players.map((player) => {
      const selected = player.name === (row.player_name || '') ? ' selected' : '';
      const safePlayerName = escapeHtml(player.name || '');
      return `<option value="${safePlayerName}"${selected}>${safePlayerName}</option>`;
    }))
    .join('');

  return `
    <tr data-character-name="${safeCharacterName}">
      <td>
        <input class="gm-cell-input" data-field="character_name" type="text" value="${safeCharacterName}" />
      </td>
      <td>
        <input class="gm-cell-input" type="text" value="${type === CHARACTER_TYPE_NPC ? 'НПС' : 'Ігровий'}" disabled />
      </td>
      <td>
        <select class="gm-cell-select" data-field="player_name">${playerOptions}</select>
      </td>
      <td>
        <input class="gm-cell-input" data-field="health_points" type="number" value="${safeHealth}" ${isNpc ? '' : 'disabled'} />
      </td>
      <td>
        <input class="gm-cell-input" data-field="armor_class" type="number" value="${safeArmor}" ${isNpc ? '' : 'disabled'} />
      </td>
      <td>
        <div class="gm-cell-inline">
          <input class="gm-cell-input" data-field="weapon_bonus" type="text" value="${safeWeaponBonus}" ${isNpc ? '' : 'disabled'} />
          <button type="button" class="gm-inline-roll-btn" data-action="rollBonus" title="Кинути d20 з бонусом" ${isNpc ? '' : 'disabled'}>
            <i class="fas fa-dice-d20"></i>
          </button>
        </div>
      </td>
      <td>
        <div class="gm-cell-inline">
          <input class="gm-cell-input" data-field="weapon_damage" type="text" value="${safeWeaponDamage}" ${isNpc ? '' : 'disabled'} />
          <button type="button" class="gm-inline-roll-btn" data-action="rollDamage" title="Кинути кубики шкоди" ${isNpc ? '' : 'disabled'}>
            <i class="fas fa-dice"></i>
          </button>
        </div>
      </td>
      <td>${getActionButtonsHtml(type)}</td>
    </tr>
  `;
}

function ensureNpcDefaults(row) {
  if (!row.extra_data) row.extra_data = {};
  row.extra_data.characterType = CHARACTER_TYPE_NPC;
  row.health_points = row.health_points || '10';
  row.max_health_points = row.max_health_points || row.health_points || '10';
  row.armor_class = row.armor_class || '10';
  if (!Array.isArray(row.weapons_json) || row.weapons_json.length === 0) {
    row.weapons_json = getDefaultNpcWeapons();
  }
  const first = row.weapons_json[0] || {};
  first.name = first.name || '';
  first.bonus = first.bonus || '+0';
  first.damage = first.damage || '1d6';
  row.weapons_json[0] = first;
}

function ensurePlayerDefaults(row) {
  if (!row.extra_data) row.extra_data = {};
  row.extra_data.characterType = CHARACTER_TYPE_PLAYER;
}

export function initPage({ root }) {
  if (!root) return;

  const tbody = root.querySelector('#gmCharactersTableBody');
  const createPcButton = root.querySelector('#gmCreatePcButton');
  const createNpcButton = root.querySelector('#gmCreateNpcButton');
  const tokenPhotoInput = root.querySelector('#gmTokenPhotoFileInput');
  const npcCreateModal = root.querySelector('#gmNpcCreateModal');
  const npcModalNameInput = root.querySelector('#gmNpcModalNameInput');
  const npcModalPlayerSelect = root.querySelector('#gmNpcModalPlayerSelect');
  const npcModalHealthInput = root.querySelector('#gmNpcModalHealthInput');
  const npcModalArmorInput = root.querySelector('#gmNpcModalArmorInput');
  const npcModalBonusInput = root.querySelector('#gmNpcModalBonusInput');
  const npcModalDamageInput = root.querySelector('#gmNpcModalDamageInput');
  const npcModalSaveButton = root.querySelector('#gmNpcModalSaveButton');
  const npcModalCancelButton = root.querySelector('#gmNpcModalCancelButton');
  if (!tbody || !createPcButton || !createNpcButton || !tokenPhotoInput || !npcCreateModal || !npcModalNameInput || !npcModalPlayerSelect || !npcModalHealthInput || !npcModalArmorInput || !npcModalBonusInput || !npcModalDamageInput || !npcModalSaveButton || !npcModalCancelButton) return;

  let OBR = null;
  let roomId = '';
  let rows = [];
  let players = [];
  let pendingTokenPhotoRowName = '';
  let rowsSignature = '';
  let isDestroyed = false;
  let obrListenersBound = false;
  let lastRollRequestTime = 0;

  function ensureActiveOrCleanup() {
    const stillActive = root.isConnected && document.body.contains(root);
    if (stillActive) return true;
    if (isDestroyed) return false;
    isDestroyed = true;

    return false;
  }

  async function loadRows() {
    if (!roomId) {
      rows = [];
      return;
    }
    const response = await fetch(`${SUPABASE_URL}/rest/v1/character_sheets?select=*&room_id=eq.${encodeURIComponent(roomId)}&order=updated_at.desc.nullslast`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Supabase load failed: ${response.status}`);
    }

    const data = await response.json();
    const dbRows = dedupeRowsByCharacterName(Array.isArray(data) ? data : []);
    const metadataRows = OBR ? dedupeRowsByCharacterName(await loadRowsFromMetadata(OBR, roomId)) : [];

    if (dbRows.length === 0 && metadataRows.length > 0) {
      rows = metadataRows;
      return;
    }

    if (dbRows.length > 0 && metadataRows.length > 0) {
      const byName = new Map();
      dbRows.forEach((row) => byName.set(normalizeCharacterNameKey(row.character_name), row));
      metadataRows.forEach((row) => {
        const key = normalizeCharacterNameKey(row.character_name);
        if (!key || byName.has(key)) return;
        byName.set(key, row);
      });
      rows = Array.from(byName.values());
      return;
    }

    rows = dbRows;
  }

  async function syncRowsFromDb({ force = false } = {}) {
    if (!ensureActiveOrCleanup()) return;
    if (!force && tbody.contains(document.activeElement)) return;

    const prevSignature = rowsSignature;
    await loadRows();
    const nextSignature = buildRowsSignature(rows);

    if (force || nextSignature !== prevSignature) {
      rowsSignature = nextSignature;
      renderTable();
    }
  }

  async function loadPlayers() {
    if (!OBR) {
      players = [];
      return;
    }
    try {
      players = await OBR.party.getPlayers();
    } catch (_) {
      players = [];
    }
  }

  async function syncObrRegistryPlayerName(characterName, playerName) {
    if (!OBR) return;

    try {
      const metadata = await OBR.room.getMetadata();
      const registry = Array.isArray(metadata?.[DARQIE_REGISTRY_KEY]) ? metadata[DARQIE_REGISTRY_KEY] : [];
      const nextRegistry = registry.map((entry) => {
        if ((entry?.characterName || '') !== characterName) return entry;
        return {
          ...entry,
          playerName: playerName || '',
        };
      });

      await OBR.room.setMetadata({
        ...metadata,
        [DARQIE_REGISTRY_KEY]: nextRegistry,
      });
    } catch (_) {
      // ignore registry sync errors in GM panel
    }
  }

  async function syncTokenOwnership(row) {
    if (!OBR && window.OBR) { OBR = window.OBR; cachedObrClient = OBR; }
    if (!OBR || typeof OBR.scene?.isReady !== 'function') return;

    const sceneReady = await OBR.scene.isReady();
    if (!sceneReady) return;

    const ownerUserId = await getOwnerUserIdByPlayerName(row.player_name || '');
    const allItems = await OBR.scene.items.getItems();
    const matchingTokens = allItems.filter((item) =>
      item.layer === 'CHARACTER' &&
      item.metadata?.characterSheet?.characterName === row.character_name
    );

    const tokenIdsToUpdate = matchingTokens
      .filter((token) => {
        const tokenPlayerName = token.metadata?.characterSheet?.playerName || '';
        const tokenOwnerUserId = token.metadata?.characterSheet?.ownerUserId || null;
        const createdUserId = token.createdUserId || null;

        return tokenPlayerName !== (row.player_name || '') ||
          tokenOwnerUserId !== ownerUserId ||
          (ownerUserId && createdUserId !== ownerUserId);
      })
      .map((token) => token.id);

    if (tokenIdsToUpdate.length > 0) {
      await OBR.scene.items.updateItems(tokenIdsToUpdate, (items) => {
        items.forEach((item) => {
          if (item.metadata?.characterSheet) {
            item.metadata.characterSheet.playerName = row.player_name || '';
            item.metadata.characterSheet.ownerUserId = ownerUserId;
          }
          if (ownerUserId) {
            item.createdUserId = ownerUserId;
          }
        });
      });
    }

    const attachmentIdsToUpdate = allItems
      .filter((item) =>
        item.layer === 'ATTACHMENT' &&
        matchingTokens.some((token) => token.id === item.attachedTo) &&
        (item.metadata?.healthBadge === true || item.metadata?.acBadge === true)
      )
      .map((item) => item.id);

    if (attachmentIdsToUpdate.length > 0) {
      await OBR.scene.items.updateItems(attachmentIdsToUpdate, (items) => {
        items.forEach((item) => {
          if (item.metadata?.healthBadge === true || item.metadata?.acBadge === true) {
            item.metadata.playerName = row.player_name || '';
          }
          if (ownerUserId) {
            item.createdUserId = ownerUserId;
          }
        });
      });
    }
  }

  function renderTable() {
    if (rows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="gm-characters-empty">Немає персонажів у цій кімнаті</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = rows.map((row) => buildCharacterRowHtml(row, players)).join('');
  }

  function getRowByName(characterName) {
    return rows.find((row) => row.character_name === characterName) || null;
  }

  async function patchByName(characterName, payload) {
    if (!roomId) throw new Error('room_id is not available yet');
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/character_sheets?room_id=eq.${encodeURIComponent(roomId)}&character_name=eq.${encodeURIComponent(characterName)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `Supabase patch failed: ${response.status}`);
    }

    const updatedRows = await response.json();
    if (Array.isArray(updatedRows) && updatedRows[0]) {
      return normalizeRow(updatedRows[0]);
    }
    return null;
  }

  async function deleteByName(characterName) {
    if (!roomId) throw new Error('room_id is not available yet');
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/character_sheets?room_id=eq.${encodeURIComponent(roomId)}&character_name=eq.${encodeURIComponent(characterName)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `Supabase delete failed: ${response.status}`);
    }
  }

  function pickUniqueName(baseLabel) {
    const existing = new Set(rows.map((row) => row.character_name));
    if (!existing.has(baseLabel)) return baseLabel;
    let idx = 2;
    while (existing.has(`${baseLabel} ${idx}`)) idx += 1;
    return `${baseLabel} ${idx}`;
  }

  async function createCharacter(type, overrides = {}) {
    if (!roomId) throw new Error('room_id is not available yet');
    const isNpc = type === CHARACTER_TYPE_NPC;
    const requestedName = String(overrides.character_name || '').trim();
    const characterName = requestedName || pickUniqueName(isNpc ? 'Неігровий персонаж' : 'Ігровий персонаж');

    const requestedHealth = String(overrides.health_points || '').trim();
    const requestedArmor = String(overrides.armor_class || '').trim();
    const requestedPlayer = String(overrides.player_name || '').trim();
    const requestedBonus = String(overrides.weapon_bonus || '').trim();
    const requestedDamage = String(overrides.weapon_damage || '').trim();

    const healthValue = isNpc ? toSafeNumberString(requestedHealth || '10', '10') : '';
    const armorValue = isNpc ? toSafeNumberString(requestedArmor || '10', '10') : '';
    const weaponBonusValue = requestedBonus || '+0';
    const weaponDamageValue = requestedDamage || '1d6';

    const row = {
      room_id: roomId,
      character_name: characterName,
      player_name: requestedPlayer,
      health_points: isNpc ? healthValue : '',
      max_health_points: isNpc ? healthValue : '',
      armor_class: isNpc ? armorValue : '',
      weapons_json: isNpc ? [{ name: '', bonus: weaponBonusValue, damage: weaponDamageValue }] : [],
      extra_data: {
        characterType: type,
      },
      updated_at: new Date().toISOString(),
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/character_sheets?on_conflict=room_id,character_name`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(row),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `Supabase create failed: ${response.status}`);
    }

    const inserted = await response.json();
    if (Array.isArray(inserted) && inserted[0]) {
      const createdRow = normalizeRow(inserted[0]);
      rows.unshift(createdRow);
      rowsSignature = buildRowsSignature(rows);
      renderTable();
      return createdRow;
    }

    return null;
  }

  function openPlayerCreationPage() {
    const targetUrl = new URL('index.html', window.location.href);
    targetUrl.search = window.location.search;
    targetUrl.searchParams.set('gmView', 'characters');
    targetUrl.hash = window.location.hash;
    window.location.href = targetUrl.toString();
  }

  function renderNpcModalPlayerOptions() {
    const options = ['<option value="">-</option>']
      .concat(players.map((player) => `<option value="${escapeHtml(player.name || '')}">${escapeHtml(player.name || '')}</option>`))
      .join('');
    npcModalPlayerSelect.innerHTML = options;
  }

  function openNpcCreateModal() {
    npcModalNameInput.value = pickUniqueName('Неігровий персонаж');
    npcModalHealthInput.value = '10';
    npcModalArmorInput.value = '10';
    npcModalBonusInput.value = '+0';
    npcModalDamageInput.value = '1d6';
    renderNpcModalPlayerOptions();
    npcCreateModal.hidden = false;
    npcModalNameInput.focus();
  }

  function closeNpcCreateModal() {
    npcCreateModal.hidden = true;
  }

  async function submitNpcCreateModal() {
    await createCharacter(CHARACTER_TYPE_NPC, {
      character_name: npcModalNameInput.value,
      player_name: npcModalPlayerSelect.value,
      health_points: npcModalHealthInput.value,
      armor_class: npcModalArmorInput.value,
      weapon_bonus: npcModalBonusInput.value,
      weapon_damage: npcModalDamageInput.value,
    });
    closeNpcCreateModal();
  }

  async function getOwnerUserIdByPlayerName(playerName) {
    if (!OBR) return null;
    if (!playerName) return null;
    const partyPlayers = await OBR.party.getPlayers();
    const owner = partyPlayers.find((player) => player.name === playerName);
    return owner?.id || null;
  }

  function resolveTokenImageUrlFromRow(row) {
    const extra = row?.extra_data || {};
    const tokenUrl = String(extra.tokenPhoto || '').trim();
    if (!tokenUrl) return TOKEN_PLACEHOLDER_URL;

    const isSupabasePublicObject =
      tokenUrl.includes('/storage/v1/object/public/') && tokenUrl.includes(`/${SUPABASE_PHOTO_BUCKET}/`);
    if (isSupabasePublicObject) {
      return appendCacheVersion(tokenUrl, row?.updated_at || Date.now());
    }

    return tokenUrl;
  }

  async function findCharacterToken(characterName) {
    if (!OBR) return null;
    const allItems = await OBR.scene.items.getItems();
    return allItems.find((item) =>
      item.layer === 'CHARACTER' &&
      item.metadata?.characterSheet?.characterName === characterName
    ) || null;
  }

  async function focusToken(tokenId) {
    if (!OBR) throw new Error('OBR недоступний у цьому контексті');
    const bounds = await OBR.scene.items.getItemBounds([tokenId]);
    await OBR.viewport.animateToBounds(bounds);
  }

  async function syncTokenCombatStats(row, { syncHealth = false, syncArmor = false } = {}) {
    if (!syncHealth && !syncArmor) return;
    if (!OBR && window.OBR) { OBR = window.OBR; cachedObrClient = OBR; }
    if (!OBR || typeof OBR.scene?.isReady !== 'function') return;

    const sceneReady = await OBR.scene.isReady();
    if (!sceneReady) return;

    const health = parseInt(row?.health_points, 10) || 0;
    const maxHealth = parseInt(row?.max_health_points, 10) || health;
    const armor = parseInt(row?.armor_class, 10) || 10;
    const allItems = await OBR.scene.items.getItems();
    const matchingTokens = allItems
      .filter((item) =>
        item.layer === 'CHARACTER' &&
        item.metadata?.characterSheet?.characterName === row.character_name
      );

    const tokenIdsToUpdate = matchingTokens
      .filter((token) => {
        const tokenHp = parseInt(token.metadata?.['com.owlbear.token']?.hp, 10) || 0;
        const tokenMaxHp = parseInt(token.metadata?.['com.owlbear.token']?.maxHp, 10) || 0;
        const tokenAc = parseInt(token.metadata?.['com.owlbear.token']?.ac, 10) || 10;
        const sheetHp = parseInt(token.metadata?.characterSheet?.healthPoints, 10) || 0;
        const sheetMaxHp = parseInt(token.metadata?.characterSheet?.maxHealthPoints, 10) || 0;
        const sheetAc = parseInt(token.metadata?.characterSheet?.armorClass, 10) || 10;

        return (
          (syncHealth && (tokenHp !== health || tokenMaxHp !== maxHealth || sheetHp !== health || sheetMaxHp !== maxHealth)) ||
          (syncArmor && (tokenAc !== armor || sheetAc !== armor))
        );
      })
      .map((token) => token.id);

    if (tokenIdsToUpdate.length > 0) {
      await OBR.scene.items.updateItems(tokenIdsToUpdate, (items) => {
        items.forEach((item) => {
          if (syncHealth && item.metadata?.['com.owlbear.token']) {
            item.metadata['com.owlbear.token'].hp = health;
            item.metadata['com.owlbear.token'].maxHp = maxHealth;
          }
          if (syncArmor && item.metadata?.['com.owlbear.token']) {
            item.metadata['com.owlbear.token'].ac = armor;
          }

          if (item.metadata?.characterSheet) {
            if (syncHealth) {
              item.metadata.characterSheet.healthPoints = String(health);
              item.metadata.characterSheet.maxHealthPoints = String(maxHealth);
            }
            if (syncArmor) {
              item.metadata.characterSheet.armorClass = String(armor);
            }
          }
        });
      });
    }

    const badgeIdsToUpdate = [];
    const healthText = `♥${health}`;
    const acText = `🛡${armor}`;

    matchingTokens.forEach((token) => {
      if (syncHealth) {
        const healthBadge = allItems.find((item) =>
          item.layer === 'ATTACHMENT' &&
          item.metadata?.healthBadge === true &&
          item.attachedTo === token.id
        );
        if (healthBadge && healthBadge.text?.plainText !== healthText) {
          badgeIdsToUpdate.push({ id: healthBadge.id, text: healthText });
        }
      }

      if (syncArmor) {
        const acBadge = allItems.find((item) =>
          item.layer === 'ATTACHMENT' &&
          item.metadata?.acBadge === true &&
          item.attachedTo === token.id
        );
        if (acBadge && acBadge.text?.plainText !== acText) {
          badgeIdsToUpdate.push({ id: acBadge.id, text: acText });
        }
      }
    });

    if (badgeIdsToUpdate.length > 0) {
      await OBR.scene.items.updateItems(badgeIdsToUpdate.map((entry) => entry.id), (items) => {
        items.forEach((item) => {
          const next = badgeIdsToUpdate.find((entry) => entry.id === item.id);
          if (next && item.text) {
            item.text.plainText = next.text;
          }
        });
      });
    }
  }

  async function createOrFocusToken(row) {
    if (!OBR && window.OBR) { OBR = window.OBR; cachedObrClient = OBR; }
    if (!OBR) {
      throw new Error('Створення токена доступне лише коли OBR SDK готовий');
    }
    const existingToken = await findCharacterToken(row.character_name);
    if (existingToken) {
      await focusToken(existingToken.id);
      return;
    }

    const buildImage = OBR.buildImage || window.OBR?.buildImage;
    const buildLabel = OBR.buildLabel || window.OBR?.buildLabel;
    if (typeof buildImage !== 'function' || typeof buildLabel !== 'function') {
      throw new Error('OBR builders are unavailable in this context.');
    }

    const imageUrl = resolveTokenImageUrlFromRow(row);
    const ownerUserId = await getOwnerUserIdByPlayerName(row.player_name || '');

    let tokenBuilder = buildImage(
      {
        height: TOKEN_ITEM_RESOLUTION,
        width: TOKEN_ITEM_RESOLUTION,
        url: imageUrl,
        mime: 'image/png',
      },
      {
        dpi: TOKEN_ITEM_RESOLUTION,
        offset: { x: 0, y: 0 },
      }
    )
      .position({ x: 0, y: 0 })
      .layer('CHARACTER')
      .name(row.character_name || 'Персонаж')
      .plainText(row.character_name || 'Персонаж')
      .textItemType('LABEL')
      .metadata({
        'com.owlbear.token': {
          hp: parseInt(row.health_points, 10) || 0,
          maxHp: parseInt(row.max_health_points, 10) || 0,
          ac: parseInt(row.armor_class, 10) || 5,
        },
        characterSheet: {
          characterName: row.character_name,
          playerName: row.player_name || '',
          healthPoints: row.health_points || '0',
          maxHealthPoints: row.max_health_points || '0',
          healing: row.healing || '0',
          armorClass: row.armor_class || '5',
          ownerUserId: ownerUserId,
        },
      });

    if (ownerUserId) {
      tokenBuilder = tokenBuilder.createdUserId(ownerUserId);
    }

    const token = tokenBuilder.build();
    await OBR.scene.items.addItems([token]);

    const tokenBounds = await OBR.scene.items.getItemBounds([token.id]);

    let healthBadgeBuilder = buildLabel()
      .position({ x: tokenBounds.max.x - 10, y: tokenBounds.min.y + 10 })
      .layer('ATTACHMENT')
      .attachedTo(token.id)
      .plainText(`♥${row.health_points || 0}`)
      .locked(true)
      .metadata({ healthBadge: true, characterName: row.character_name, playerName: row.player_name || '' });

    let acBadgeBuilder = buildLabel()
      .position({ x: tokenBounds.min.x + 10, y: tokenBounds.min.y + 10 })
      .layer('ATTACHMENT')
      .attachedTo(token.id)
      .plainText(`🛡${row.armor_class || 5}`)
      .locked(true)
      .metadata({ acBadge: true, characterName: row.character_name, playerName: row.player_name || '' });

    if (ownerUserId) {
      healthBadgeBuilder = healthBadgeBuilder.createdUserId(ownerUserId);
      acBadgeBuilder = acBadgeBuilder.createdUserId(ownerUserId);
    }

    const healthBadge = healthBadgeBuilder.build();
    const acBadge = acBadgeBuilder.build();
    await OBR.scene.items.addItems([healthBadge, acBadge]);

    await focusToken(token.id);
  }

  function openCharacterSheet(row) {
    const targetUrl = new URL('index.html', window.location.href);
    targetUrl.search = window.location.search;
    targetUrl.searchParams.set('gmView', 'characters');
    targetUrl.searchParams.set('characterName', row.character_name);
    targetUrl.hash = window.location.hash;
    window.location.href = targetUrl.toString();
  }

  async function cropImageToCircle(file, width, height) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const highResSize = 512;
          const canvas = document.createElement('canvas');
          canvas.width = highResSize;
          canvas.height = highResSize;
          const ctx = canvas.getContext('2d', { alpha: true });
          if (!ctx) {
            reject(new Error('Canvas context unavailable'));
            return;
          }

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';

          const size = Math.min(img.width, img.height);
          const x = (img.width - size) / 2;
          const y = (img.height - size) / 2;

          ctx.beginPath();
          ctx.arc(highResSize / 2, highResSize / 2, highResSize / 2, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(img, x, y, size, size, 0, 0, highResSize, highResSize);

          const finalCanvas = document.createElement('canvas');
          finalCanvas.width = width;
          finalCanvas.height = height;
          const finalCtx = finalCanvas.getContext('2d', { alpha: true });
          if (!finalCtx) {
            reject(new Error('Final canvas context unavailable'));
            return;
          }

          finalCtx.imageSmoothingEnabled = true;
          finalCtx.imageSmoothingQuality = 'high';
          finalCtx.drawImage(canvas, 0, 0, width, height);

          finalCanvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error('Failed to convert image to blob'));
              return;
            }
            resolve(blob);
          }, 'image/png', 1);
        };

        img.onerror = () => reject(new Error('Image load failed'));
        img.src = event.target?.result || '';
      };

      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadTokenPhoto(characterName, blob) {
    if (!roomId) throw new Error('room_id is not available yet');
    const charHash = hashCharacterName(characterName || 'unknown');
    const storagePath = `${roomId}/${charHash}/token.png`;
    const encodedPath = storagePath.split('/').map((part) => encodeURIComponent(part)).join('/');

    const uploadResponse = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_PHOTO_BUCKET}/${encodedPath}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'image/png',
        'x-upsert': 'true',
      },
      body: blob,
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      throw new Error(errText || `Storage upload failed: ${uploadResponse.status}`);
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_PHOTO_BUCKET}/${encodedPath}`;
    return appendCacheVersion(publicUrl, Date.now());
  }

  async function onTokenPhotoSelected(file) {
    if (!file || !pendingTokenPhotoRowName) return;
    const row = getRowByName(pendingTokenPhotoRowName);
    pendingTokenPhotoRowName = '';
    if (!row) return;

    const blob = await cropImageToCircle(file, TOKEN_UPLOAD_RESOLUTION, TOKEN_UPLOAD_RESOLUTION);
    const tokenUrl = await uploadTokenPhoto(row.character_name, blob);
    if (!tokenUrl) throw new Error('Token image URL is empty');

    if (!OBR && window.OBR) { OBR = window.OBR; cachedObrClient = OBR; }
    if (!OBR) {
      throw new Error('Оновлення фото токена доступне лише коли OBR SDK готовий');
    }

    const token = await findCharacterToken(row.character_name);
    if (!token) {
      throw new Error('Токен персонажа не знайдено. Спочатку створіть токен.');
    }

    await OBR.scene.items.updateItems([token.id], (items) => {
      items.forEach((item) => {
        if (item.image) item.image.url = tokenUrl;
      });
    });

    const nextExtra = { ...(row.extra_data || {}), tokenPhoto: tokenUrl };
    const updated = await patchByName(row.character_name, { extra_data: nextExtra });
    if (updated) {
      const idx = rows.findIndex((entry) => entry.character_name === row.character_name);
      if (idx !== -1) rows[idx] = updated;
      rowsSignature = buildRowsSignature(rows);
      renderTable();
    }
  }

  async function updateNpcCombatColumn(row, field, value) {
    const payload = {};
    if (field === 'health_points') {
      payload.health_points = toSafeNumberString(value, '10');
      payload.max_health_points = payload.health_points;
    } else if (field === 'armor_class') {
      payload.armor_class = toSafeNumberString(value, '10');
    } else if (field === 'weapon_bonus' || field === 'weapon_damage') {
      const weapons = Array.isArray(row.weapons_json) && row.weapons_json.length > 0
        ? JSON.parse(JSON.stringify(row.weapons_json))
        : getDefaultNpcWeapons();
      const first = weapons[0] || { name: '', bonus: '+0', damage: '1d6' };
      if (field === 'weapon_bonus') first.bonus = value || '+0';
      if (field === 'weapon_damage') first.damage = value || '1d6';
      weapons[0] = first;
      payload.weapons_json = weapons;
    }

    const updated = await patchByName(row.character_name, payload);
    if (!updated) return;

    const idx = rows.findIndex((entry) => entry.character_name === row.character_name);
    if (idx !== -1) rows[idx] = updated;
    rowsSignature = buildRowsSignature(rows);

    await syncTokenCombatStats(updated, {
      syncHealth: field === 'health_points',
      syncArmor: field === 'armor_class',
    });
  }

  async function sendDiceRollRequest(type, style, bonus, count = 1) {
    if (!OBR && window.OBR) { OBR = window.OBR; cachedObrClient = OBR; }
    if (!OBR) throw new Error('Кидок кубика доступний лише коли OBR SDK готовий');

    const now = Date.now();
    if (now - lastRollRequestTime < DICE_ROLL_THROTTLE_MS) return;
    lastRollRequestTime = now;

    const connectionId = typeof OBR.player?.getConnectionId === 'function'
      ? await OBR.player.getConnectionId()
      : '';
    const playerName = typeof OBR.player?.getName === 'function'
      ? await OBR.player.getName()
      : '';

    const rollRequest = {
      type,
      style,
      bonus,
      count,
      advantage: null,
      connectionId,
      playerName,
      ts: Date.now(),
    };

    const currentMetadata = await OBR.room.getMetadata();
    await OBR.room.setMetadata({
      ...currentMetadata,
      darqie: {
        ...(currentMetadata.darqie || {}),
        activeRoll: rollRequest,
      },
    });
  }

  async function rollNpcAttackBonus(row) {
    const weapons = Array.isArray(row?.weapons_json) ? row.weapons_json : [];
    const first = weapons[0] || {};
    const bonus = parseHitBonus(first.bonus || '+0');
    await sendDiceRollRequest('D20', 'NEBULA', bonus);
  }

  async function rollNpcAttackDamage(row) {
    const weapons = Array.isArray(row?.weapons_json) ? row.weapons_json : [];
    const first = weapons[0] || {};
    const parsed = parseWeaponDamage(first.damage || '');
    if (!parsed) throw new Error('Некоректна формула шкоди. Приклад: 1d6+2');
    await sendDiceRollRequest(parsed.dice, 'GALAXY', parsed.bonus, parsed.count);
  }

  tbody.addEventListener('change', async (event) => {
    const target = event.target;
    const tr = target.closest('tr[data-character-name]');
    if (!tr) return;

    const oldName = tr.getAttribute('data-character-name') || '';
    const row = getRowByName(oldName);
    if (!row) return;

    try {
      if (target.matches('[data-field="player_name"]')) {
        const updated = await patchByName(oldName, { player_name: target.value || '' });
        if (updated) {
          const idx = rows.findIndex((entry) => entry.character_name === oldName);
          if (idx !== -1) rows[idx] = updated;
          rowsSignature = buildRowsSignature(rows);
          tr.setAttribute('data-character-name', updated.character_name);
          await syncTokenOwnership(updated);
          if (OBR) {
            await syncObrRegistryPlayerName(updated.character_name, updated.player_name || '');
          }
        }
      }

    } catch (error) {
      console.error(error);
    }
  });

  tbody.addEventListener('blur', async (event) => {
    const target = event.target;
    const tr = target.closest('tr[data-character-name]');
    if (!tr) return;

    const oldName = tr.getAttribute('data-character-name') || '';
    const row = getRowByName(oldName);
    if (!row) return;

    try {
      if (target.matches('[data-field="character_name"]')) {
        const newName = (target.value || '').trim();
        if (!newName || newName === oldName) return;
        const updated = await patchByName(oldName, { character_name: newName });
        if (updated) {
          const idx = rows.findIndex((entry) => entry.character_name === oldName);
          if (idx !== -1) rows[idx] = updated;
          rowsSignature = buildRowsSignature(rows);
          tr.setAttribute('data-character-name', updated.character_name);
        }
      }

      if (target.matches('[data-field="health_points"], [data-field="armor_class"]')) {
        if (getTypeFromRow(row) !== CHARACTER_TYPE_NPC) return;
        await updateNpcCombatColumn(row, target.getAttribute('data-field'), target.value);
      }

      if (target.matches('[data-field="weapon_bonus"], [data-field="weapon_damage"]')) {
        if (getTypeFromRow(row) !== CHARACTER_TYPE_NPC) return;
        await updateNpcCombatColumn(row, target.getAttribute('data-field'), target.value);
      }
    } catch (error) {
      console.error(error);
    }
  }, true);

  tbody.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;

    const tr = btn.closest('tr[data-character-name]');
    if (!tr) return;
    const characterName = tr.getAttribute('data-character-name') || '';
    const row = getRowByName(characterName);
    if (!row) return;

    const action = btn.getAttribute('data-action');

    try {
      if (action === 'open') {
        openCharacterSheet(row);
        return;
      }

      if (action === 'delete') {
        const ok = window.confirm(`Видалити персонажа "${row.character_name}"?`);
        if (!ok) return;
        await deleteByName(row.character_name);
        rows = rows.filter((entry) => entry.character_name !== row.character_name);
        rowsSignature = buildRowsSignature(rows);
        renderTable();
        return;
      }

      if (action === 'token') {
        await createOrFocusToken(row);
        return;
      }

      if (action === 'tokenPhoto') {
        pendingTokenPhotoRowName = row.character_name;
        tokenPhotoInput.value = '';
        tokenPhotoInput.click();
        return;
      }

      if (action === 'rollBonus') {
        await rollNpcAttackBonus(row);
        return;
      }

      if (action === 'rollDamage') {
        await rollNpcAttackDamage(row);
        return;
      }
    } catch (error) {
      console.error(error);
    }
  });

  tokenPhotoInput.addEventListener('change', async () => {
    const file = tokenPhotoInput.files?.[0];
    if (!file) return;

    try {
      await onTokenPhotoSelected(file);
    } catch (error) {
      console.error(error);
      window.alert(error?.message || 'Помилка при оновленні фото токена');
    }
  });

  createPcButton.addEventListener('click', async () => {
    try {
      const created = await createCharacter(CHARACTER_TYPE_PLAYER);
      if (!created) {
        window.alert('Не вдалося створити ігрового персонажа');
        return;
      }
      openCharacterSheet(created);
    } catch (error) {
      console.error(error);
      window.alert('Не вдалося створити ігрового персонажа');
    }
  });

  createNpcButton.addEventListener('click', async () => {
    if (!players.length) {
      try {
        await loadPlayers();
      } catch (_) {}
    }
    openNpcCreateModal();
  });

  npcModalSaveButton.addEventListener('click', async () => {
    try {
      await submitNpcCreateModal();
    } catch (error) {
      console.error(error);
      window.alert('Не вдалося створити неігрового персонажа');
    }
  });

  npcModalCancelButton.addEventListener('click', () => {
    closeNpcCreateModal();
  });

  npcCreateModal.addEventListener('click', (event) => {
    const closeBtn = event.target.closest('[data-action="closeNpcModal"]');
    if (closeBtn) {
      closeNpcCreateModal();
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !npcCreateModal.hidden) {
      closeNpcCreateModal();
    }
  });

  function bindObrListeners() {
    if (!OBR || obrListenersBound) return;
    obrListenersBound = true;

    try {
      OBR.party.onChange(async () => {
        if (!ensureActiveOrCleanup()) return;
        await loadPlayers();
        renderTable();
      });

      OBR.room.onMetadataChange(async () => {
        if (!ensureActiveOrCleanup()) return;
        try {
          try {
            await syncRowsFromDb();
          } catch (_) {}
        } catch (_) {}
      });
    } catch (_) {
      obrListenersBound = false;
    }
  }

  async function startPage() {
    OBR = await resolveOBRClient();
    if (OBR) {
      await waitForObrReady(OBR, 3500);
    }

    roomId = OBR?.room?.id || localStorage.getItem(DARQIE_ROOM_ID_KEY) || '';
    if (roomId) {
      try {
        localStorage.setItem(DARQIE_ROOM_ID_KEY, roomId);
      } catch (_) {}
    }

    let tries = 0;
    while (!roomId && OBR && tries < 12) {
      roomId = OBR.room?.id || localStorage.getItem(DARQIE_ROOM_ID_KEY) || '';
      if (roomId) break;
      tries += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!roomId) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="gm-characters-empty">Кімната ще не готова. Спробуйте за мить.</td>
        </tr>
      `;
      return false;
    }

    try {
      await Promise.all([syncRowsFromDb({ force: true }), loadPlayers()]);
      if (!rowsSignature) rowsSignature = buildRowsSignature(rows);
      renderTable();
      if (OBR) bindObrListeners();
      return true;
    } catch (error) {
      console.error(error);
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="gm-characters-empty">Не вдалося завантажити список персонажів</td>
        </tr>
      `;
      return false;
    }
  }

  let pageStarted = false;
  let pageBootInFlight = false;
  const bootPage = () => {
    if (pageStarted || pageBootInFlight) return;
    pageBootInFlight = true;

    startPage()
      .then((started) => {
        pageStarted = !!started;
      })
      .finally(() => {
        pageBootInFlight = false;
        if (!pageStarted && !isDestroyed) {
          setTimeout(bootPage, 1200);
        }
      });
  };

  bootPage();
  setTimeout(bootPage, 1200);
  setTimeout(bootPage, 2600);
}
