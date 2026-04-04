import OBR, { buildImage, buildLabel } from '@owlbear-rodeo/sdk';
import { createClient } from '@supabase/supabase-js';

// === SUPABASE ===
const SUPABASE_URL =
  (import.meta.env?.VITE_SUPABASE_URL || 'https://yoaazfbttqfanxackrvv.supabase.co').trim();
const SUPABASE_ANON_KEY =
  (
    import.meta.env?.VITE_SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E'
  ).trim();

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[Supabase] Missing URL or anon key configuration.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  },
});

const TOKEN_PLACEHOLDER_URL = 'https://raw.githubusercontent.com/Darqie/Darqie-character-sheet/main/public/character-token-placeholder.png';
const TOKEN_UPLOAD_RESOLUTION = 512;
const TOKEN_ITEM_RESOLUTION = 128;
const SKILL_POPOVER_VERSION = '2026-03-21-2';
const SUPABASE_PHOTO_BUCKET = 'character-photos';
const CHARACTER_TYPE_PLAYER = 'player';
const CHARACTER_TYPE_NPC = 'npc';

/**
 * Генерує простий хеш для імені персонажа (ASCII-сумісний шлях у Storage)
 */
function hashCharacterName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Завантажує файл зображення в Supabase Storage.
 * Повертає публічний URL або null при помилці.
 */
async function uploadPhotoToSupabase(file, storagePath) {
  try {
    // Спочатку спробуємо залогіниться анонімно щоб мати auth context
    const { data: authData } = await supabase.auth.getSession();
    if (!authData?.session) {
      const { error: signInError } = await supabase.auth.signInAnonymously();
      if (signInError) {
        console.warn('[Supabase Auth] Не вдалося залогіниться анонімно, спробуємо завантажити без auth context:', signInError);
      }
    }

    const { error: uploadError } = await supabase.storage
      .from(SUPABASE_PHOTO_BUCKET)
      .upload(storagePath, file, { upsert: true, contentType: file.type || 'image/png' });

    if (uploadError) {
      console.error('[Supabase Storage] Помилка завантаження:', uploadError);
      return null;
    }

    const { data } = supabase.storage
      .from(SUPABASE_PHOTO_BUCKET)
      .getPublicUrl(storagePath);

    const publicUrl = data?.publicUrl || null;
    if (!publicUrl) return null;

    // Supabase public URL for the same storage path may be aggressively cached by clients/CDN.
    // Add a version query parameter to force fresh image fetch right after upload.
    const separator = publicUrl.includes('?') ? '&' : '?';
    return `${publicUrl}${separator}v=${Date.now()}`;
  } catch (e) {
    console.error('[Supabase Storage] Мережева помилка:', e);
    return null;
  }
}

function getTokenPlaceholderUrl() {
  return TOKEN_PLACEHOLDER_URL;
}

function getSafeTokenImageUrl(rawUrl) {
  const value = (rawUrl || '').trim();
  if (!value) return getTokenPlaceholderUrl();
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(value)) {
    return getTokenPlaceholderUrl();
  }
  return value;
}

function isUploadcareUrl(url) {
  return /^https:\/\/ucarecdn\.com\/.+/i.test((url || '').trim());
}

function resolveTokenImageUrlFromSheet(sheet) {
  if (!sheet) return getTokenPlaceholderUrl();
  const tokenUrl = (sheet.tokenPhoto || '').trim();
  if (!tokenUrl) return getTokenPlaceholderUrl();
  // Приймаємо будь-який HTTPS URL, крім localhost (який завжди заглушка)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(tokenUrl)) {
    return getTokenPlaceholderUrl();
  }

  // Backward-compat for old rows that stored plain Supabase public URL without version query.
  // If URL points to our photo bucket and has no query, append deterministic version from row update time.
  const isSupabaseBucketUrl =
    tokenUrl.includes('/storage/v1/object/public/') && tokenUrl.includes(`/${SUPABASE_PHOTO_BUCKET}/`);
  const hasQuery = tokenUrl.includes('?');
  if (isSupabaseBucketUrl && !hasQuery) {
    const version = encodeURIComponent(sheet?._updatedAt || Date.now());
    return `${tokenUrl}?v=${version}`;
  }

  return tokenUrl;
}

function areTokenStatsHiddenForSheet(sheet) {
  return Boolean(sheet?.hideTokenStats);
}

function updateTokenStatsToggleButtonState(sheet) {
  const button = document.getElementById('toggleTokenStatsButton');
  if (!button) return;

  const hidden = areTokenStatsHiddenForSheet(sheet);
  button.title = hidden ? 'Показати стати' : 'Приховати стати';
  button.innerHTML = hidden
    ? '<i class="fas fa-eye-slash"></i>'
    : '<i class="fas fa-eye"></i>';
}

async function normalizeLegacyTokenImageUrls() {
  try {
    const role = await OBR.player.getRole();
    if (role !== 'GM') return;

    const allItems = await OBR.scene.items.getItems();
    const tokenIdsToFix = allItems
      .filter((item) =>
        item.layer === 'CHARACTER' &&
        item.metadata?.characterSheet &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(item.image?.url || '')
      )
      .map((item) => item.id);

    if (tokenIdsToFix.length === 0) return;

    try {
      await OBR.scene.items.updateItems(tokenIdsToFix, (items) => {
        items.forEach((item) => {
          if (item.image) {
            item.image.url = getSafeTokenImageUrl(item.image.url);
          }
        });
      });
    } catch (_) {
      // Ігноруємо помилки прав доступу/стану сцени, щоб не шуміти гравцям в консолі.
    }
  } catch (error) {
    // Ігноруємо: це фоновий best-effort fix для legacy токенів.
  }
}

const MODAL_FIELDS = [
  'characterClassLevel',
  'characterRace',
  'background',
  'alignment',
  'appearance',
  'languages',
  'bonds',
  'personalityTraits',
  'features',
  'notes',
];

const MODAL_FIELD_TO_ID = {
  characterClassLevel: 'modalCharacterClass',
  characterRace: 'modalCharacterRace',
  background: 'modalBackground',
  alignment: 'modalAlignment',
  appearance: 'modalAppearance',
  languages: 'modalLanguages',
  bonds: 'modalBonds',
  personalityTraits: 'modalPersonalityTraits',
  features: 'modalFeatures',
  notes: 'modalNotes',
};

const MODAL_FIELD_TO_DB = {
  characterClassLevel: 'character_class_level',
  characterRace: 'character_race',
  background: 'background',
  alignment: 'alignment',
  appearance: 'appearance',
  languages: 'languages',
  bonds: 'bonds',
  personalityTraits: 'personality_traits',
  features: 'features',
  notes: 'notes',
};

const OFFLOADED_SHEET_FIELD_TO_DB = {
  strengthScore: 'strength_score',
  dexterityScore: 'dexterity_score',
  constitutionScore: 'constitution_score',
  proficiencyScore: 'intelligence_score',
  wisdomScore: 'wisdom_score',
  charismaScore: 'charisma_score',
  armorClass: 'armor_class',
  healthPoints: 'health_points',
  speed: 'speed',
  initiative: 'initiative',
  maxHealthPoints: 'max_health_points',
  healing: 'healing',
  maxWeight: 'max_weight',
  currentWeight: 'current_weight',
  weaponTitle: 'weapon_title',
  inventoryTitle: 'inventory_title',
  equipmentTitle: 'equipment_title',
};

const OFFLOADED_JSON_FIELD_TO_DB = {
  weapons: 'weapons_json',
  skills: 'skills_json',
  inventory: 'inventory_json',
  equipment: 'equipment_json',
};

function getModalInfoFromSheet(sheet) {
  const info = {};
  MODAL_FIELDS.forEach((key) => {
    info[key] = sheet?.[key] || '';
  });
  return info;
}

function applyModalInfoToSheet(sheet, modalInfo) {
  if (!sheet || !modalInfo) return;
  MODAL_FIELDS.forEach((key) => {
    if (typeof modalInfo[key] === 'string') {
      sheet[key] = modalInfo[key];
    }
  });
}

function applyModalInfoToInputs(modalInfo) {
  if (!modalInfo) return;
  MODAL_FIELDS.forEach((key) => {
    const inputId = MODAL_FIELD_TO_ID[key];
    const el = document.getElementById(inputId);
    if (el && typeof modalInfo[key] === 'string') {
      el.value = modalInfo[key];
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  });
}

function stripModalFieldsForRoomMetadata(sheet) {
  if (!sheet) return sheet;
  const roomSheet = { ...sheet };
  MODAL_FIELDS.forEach((key) => {
    delete roomSheet[key];
  });

  Object.keys(OFFLOADED_SHEET_FIELD_TO_DB).forEach((key) => {
    delete roomSheet[key];
  });

  Object.keys(OFFLOADED_JSON_FIELD_TO_DB).forEach((key) => {
    delete roomSheet[key];
  });

  delete roomSheet.coins;
  return roomSheet;
}

function normalizeSheetsForRoomComparison(sheets) {
  return (Array.isArray(sheets) ? sheets : []).map((sheet) => stripModalFieldsForRoomMetadata(sheet));
}

function areSheetsEqualForRoomComparison(leftSheets, rightSheets) {
  return JSON.stringify(normalizeSheetsForRoomComparison(leftSheets)) === JSON.stringify(normalizeSheetsForRoomComparison(rightSheets));
}

function isAnyEditingActive() {
  const modal = document.getElementById('characterInfoModal');
  const modalTextEditing = !!modal?.querySelector('textarea:not([readonly])');
  return weaponEditing || skillEditing || editingInv || editingEquip || isSaving || modalTextEditing;
}

function toSupabaseModalRow(modalInfo) {
  const row = {};
  MODAL_FIELDS.forEach((key) => {
    row[MODAL_FIELD_TO_DB[key]] = modalInfo?.[key] || '';
  });
  return row;
}

function fromSupabaseModalRow(row) {
  if (!row) return null;
  const modalInfo = {};
  MODAL_FIELDS.forEach((key) => {
    const dbCol = MODAL_FIELD_TO_DB[key];
    if (typeof row[dbCol] === 'string') {
      modalInfo[key] = row[dbCol];
    }
  });
  return modalInfo;
}

function getSheetCharacterType(sheet) {
  const explicit = String(sheet?.characterType || '').trim().toLowerCase();
  return explicit === CHARACTER_TYPE_NPC ? CHARACTER_TYPE_NPC : CHARACTER_TYPE_PLAYER;
}

function isPlayableSheet(sheet) {
  return getSheetCharacterType(sheet) === CHARACTER_TYPE_PLAYER;
}

// Формує повний рядок Supabase із УСІМа полями персонажа
function buildFullSupabaseRow(sheet, roomId) {
  const row = {
    room_id: roomId,
    character_name: sheet?.characterName || '',
    player_name: sheet?.playerName || '',
    updated_at: new Date().toISOString(),
  };

  // Поля модалки
  MODAL_FIELDS.forEach((key) => {
    if (sheet?.[key] !== undefined) {
      row[MODAL_FIELD_TO_DB[key]] = sheet[key];
    }
  });

  // Скалярні поля
  Object.entries(OFFLOADED_SHEET_FIELD_TO_DB).forEach(([sheetField, dbCol]) => {
    if (sheet?.[sheetField] !== undefined) row[dbCol] = sheet[sheetField];
  });

  // JSON-масиви
  Object.entries(OFFLOADED_JSON_FIELD_TO_DB).forEach(([sheetField, dbCol]) => {
    if (Array.isArray(sheet?.[sheetField])) {
      row[dbCol] = JSON.parse(JSON.stringify(sheet[sheetField]));
    }
  });

  // Монети
  if (sheet?.coins !== undefined) {
    const coins = sheet?.coins || { sen: 0, gin: 0, kin: 0 };
    row.coins_sen = parseInt(coins.sen, 10) || 0;
    row.coins_gin = parseInt(coins.gin, 10) || 0;
    row.coins_kin = parseInt(coins.kin, 10) || 0;
  }

  // Додаткові поля, які не мають своїх колонок (зберігаються в extra_data)
  const extra = {};
  if (sheet?.characterPhoto !== undefined) extra.characterPhoto = sheet.characterPhoto;
  if (sheet?.tokenPhoto !== undefined) extra.tokenPhoto = sheet.tokenPhoto;
  if (typeof sheet?.inspiration === 'boolean') extra.inspiration = sheet.inspiration;
  if (typeof sheet?.advantage === 'boolean') extra.advantage = sheet.advantage;
  if (typeof sheet?.disadvantage === 'boolean') extra.disadvantage = sheet.disadvantage;
  if (typeof sheet?.hideTokenStats === 'boolean') extra.hideTokenStats = sheet.hideTokenStats;
  if (Array.isArray(sheet?.deathSavesSuccess)) extra.deathSavesSuccess = sheet.deathSavesSuccess;
  if (Array.isArray(sheet?.deathSavesFailure)) extra.deathSavesFailure = sheet.deathSavesFailure;
  if (sheet?.proficienciesAndLanguages !== undefined) extra.proficienciesAndLanguages = sheet.proficienciesAndLanguages;
  if (sheet?.alliesAndOrganizations !== undefined) extra.alliesAndOrganizations = sheet.alliesAndOrganizations;
  if (sheet?.characterHistory !== undefined) extra.characterHistory = sheet.characterHistory;
  if (sheet?.additionalFeatures !== undefined) extra.additionalFeatures = sheet.additionalFeatures;
  if (sheet?.characterType !== undefined) {
    extra.characterType = getSheetCharacterType(sheet);
  }
  row.extra_data = extra;

  return row;
}

// Backward-compat alias
function buildOffloadedSupabaseRowFromSheet(sheet) {
  return buildFullSupabaseRow(sheet, OBR.room.id);
}

function mergeRoomSheetsWithLocalCache(roomSheets, localSheets) {
  const roomList = Array.isArray(roomSheets) ? roomSheets : [];
  const localList = Array.isArray(localSheets) ? localSheets : [];

  return roomList.map((roomSheet, index) => {
    const merged = roomSheet ? { ...roomSheet } : roomSheet;
    if (!merged || typeof merged !== 'object') return merged;

    const localByIndex = localList[index];
    const sameIdentity = Boolean(
      localByIndex &&
      merged.characterName &&
      localByIndex.characterName &&
      merged.characterName === localByIndex.characterName
    );
    const localSheet = sameIdentity ? localByIndex : null;
    if (!localSheet) return merged;

    // Room metadata зберігає урізану версію листа, тому відновлюємо offloaded-поля з локального кешу.
    MODAL_FIELDS.forEach((key) => {
      if (localSheet[key] !== undefined) merged[key] = localSheet[key];
    });

    Object.keys(OFFLOADED_SHEET_FIELD_TO_DB).forEach((key) => {
      if (localSheet[key] !== undefined) merged[key] = localSheet[key];
    });

    Object.keys(OFFLOADED_JSON_FIELD_TO_DB).forEach((key) => {
      if (localSheet[key] !== undefined) {
        merged[key] = Array.isArray(localSheet[key])
          ? JSON.parse(JSON.stringify(localSheet[key]))
          : [];
      }
    });

    if (localSheet.coins !== undefined) {
      merged.coins = JSON.parse(JSON.stringify(localSheet.coins || { sen: 0, gin: 0, kin: 0 }));
    }

    return merged;
  });
}

// Застосовує ВСІЙ Supabase рядок до об'єкта листа (включаючи extra_data)
function applyFullSupabaseRowToSheet(sheet, row) {
  if (!sheet || !row) return;

  if (row.character_name) sheet.characterName = row.character_name;
  if (row.player_name !== undefined) sheet.playerName = row.player_name;

  // Поля модалки
  MODAL_FIELDS.forEach((key) => {
    const dbCol = MODAL_FIELD_TO_DB[key];
    if (row[dbCol] !== null && row[dbCol] !== undefined) sheet[key] = row[dbCol];
  });

  // Скалярні поля
  Object.entries(OFFLOADED_SHEET_FIELD_TO_DB).forEach(([sheetField, dbCol]) => {
    if (row[dbCol] !== null && row[dbCol] !== undefined) sheet[sheetField] = String(row[dbCol]);
  });

  // JSON-масиви
  Object.entries(OFFLOADED_JSON_FIELD_TO_DB).forEach(([sheetField, dbCol]) => {
    if (Array.isArray(row[dbCol])) sheet[sheetField] = JSON.parse(JSON.stringify(row[dbCol]));
  });

  // Монети
  if (row.coins_sen !== null || row.coins_gin !== null || row.coins_kin !== null) {
    sheet.coins = {
      sen: parseInt(row.coins_sen, 10) || 0,
      gin: parseInt(row.coins_gin, 10) || 0,
      kin: parseInt(row.coins_kin, 10) || 0,
    };
  }

  // extra_data — поля без власних колонок
  const extra = row.extra_data || {};
  sheet.characterPhoto = extra.characterPhoto || '';
  sheet.tokenPhoto = extra.tokenPhoto || '';
  sheet.inspiration = extra.inspiration || false;
  sheet.advantage = extra.advantage || false;
  sheet.disadvantage = extra.disadvantage || false;
  sheet.hideTokenStats = Boolean(extra.hideTokenStats);
  sheet.deathSavesSuccess = Array.isArray(extra.deathSavesSuccess) ? extra.deathSavesSuccess : [false, false, false];
  sheet.deathSavesFailure = Array.isArray(extra.deathSavesFailure) ? extra.deathSavesFailure : [false, false, false];
  sheet.proficienciesAndLanguages = extra.proficienciesAndLanguages || '';
  sheet.alliesAndOrganizations = extra.alliesAndOrganizations || '';
  sheet.characterHistory = extra.characterHistory || '';
  sheet.additionalFeatures = extra.additionalFeatures || '';
  sheet.characterType = extra.characterType === CHARACTER_TYPE_NPC ? CHARACTER_TYPE_NPC : CHARACTER_TYPE_PLAYER;

  // Запам'ятовуємо оригінальне ім'я для детектування перейменувань
  sheet._originalCharacterName = sheet.characterName;
  sheet._updatedAt = row.updated_at || sheet._updatedAt || null;
}

// Backward-compat alias
function applyOffloadedSupabaseRowToSheet(sheet, row) {
  applyFullSupabaseRowToSheet(sheet, row);
}

// Зберегти всі поля модалки у Supabase (кожне поле у своїй колонці)
async function saveModalInfoToSupabase(roomId, playerName, characterName, modalInfo) {
  if (!roomId || !characterName) return;

  const modalRow = toSupabaseModalRow(modalInfo);

  try {
    const sheet = characterSheets[activeSheetIndex];
    const offloadedRow = buildOffloadedSupabaseRowFromSheet(sheet);
    const { error } = await supabase
      .from('character_sheets')
      .upsert(
        {
          room_id: roomId,
          player_name: playerName,
          character_name: characterName,
          ...modalRow,
          ...offloadedRow,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'room_id,character_name' }
      );
    if (error) console.error('[Supabase] Помилка збереження інформації модалки:', error);
  } catch (e) {
    console.error('[Supabase] CSP або мережева помилка:', e);
  }
}

// Отримати всі поля модалки із Supabase
async function loadModalInfoFromSupabase(roomId, characterName) {
  if (!roomId || !characterName) return null;

  try {
    const { data, error } = await supabase
      .from('character_sheets')
      .select('*')
      .eq('room_id', roomId)
      .eq('character_name', characterName)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1);

    if (error) {
      console.error('[Supabase] Помилка читання інформації модалки:', error);
      return null;
    }

    const row = Array.isArray(data) ? data[0] : null;

    if (!row) return null;

    // Застосовуємо всі поля до локального листа
    const sheetIdx = characterSheets.findIndex(s => s.characterName === characterName);
    if (sheetIdx !== -1) {
      applyFullSupabaseRowToSheet(characterSheets[sheetIdx], row);
    }

    const rowInfo = fromSupabaseModalRow(row);
    if (rowInfo && MODAL_FIELDS.some((key) => typeof rowInfo[key] === 'string' && rowInfo[key] !== '')) {
      return rowInfo;
    }

    // Backward compatibility: старий формат
    if (typeof row?.appearance === 'string' && row.appearance) {
      try {
        const parsed = JSON.parse(row.appearance);
        if (parsed && parsed.modalInfo && typeof parsed.modalInfo === 'object') {
          return parsed.modalInfo;
        }
      } catch (_) {
        return { appearance: row.appearance };
      }
    }

    return null;
  } catch (e) {
    console.error('[Supabase] CSP або мережева помилка:', e);
    return null;
  }
}

async function saveActiveCharacterModalInfoToSupabase() {
  const sheet = characterSheets[activeSheetIndex];
  if (!sheet) return;
  await saveSheetToSupabase(sheet);
}

async function hydrateActiveCharacterFromSupabase() {
  const sheet = characterSheets[activeSheetIndex];
  if (!sheet || !sheet.characterName) return;

  try {
    const { data, error } = await supabase
      .from('character_sheets')
      .select('*')
      .eq('room_id', OBR.room.id)
      .eq('character_name', sheet.characterName)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) {
      console.error('[Supabase] hydrateActiveCharacterFromSupabase помилка:', error);
      return;
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (row) applyFullSupabaseRowToSheet(sheet, row);
  } catch (e) {
    console.error('[Supabase] hydrateActiveCharacterFromSupabase помилка:', e);
  }
}

// === ПОВНЕ ЗБЕРЕЖЕННЯ / ЗАВАНТАЖЕННЯ / РЕАЛТАЙМ ЧЕРЕЗ SUPABASE ===

/** Створює об'єкт листа з рядка Supabase */
function sheetFromSupabaseRow(row) {
  const sheet = {};
  applyFullSupabaseRowToSheet(sheet, row);
  return sheet;
}

function dedupeRowsByCharacterName(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const byName = new Map();

  for (const row of rows) {
    if (!row?.character_name) continue;
    const existing = byName.get(row.character_name);
    if (!existing) {
      byName.set(row.character_name, row);
      continue;
    }

    const existingTs = Date.parse(existing.updated_at || '') || 0;
    const rowTs = Date.parse(row.updated_at || '') || 0;
    if (rowTs >= existingTs) {
      byName.set(row.character_name, row);
    }
  }

  return Array.from(byName.values());
}

function dedupeSheetsByCharacterName(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) return [];

  const byName = new Map();

  for (const sheet of sheets) {
    if (!sheet) continue;

    const name = (sheet.characterName || '').trim();
    if (!name) continue;

    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, sheet);
      continue;
    }

    const existingTs = Date.parse(existing._updatedAt || existing.updated_at || '') || 0;
    const sheetTs = Date.parse(sheet._updatedAt || sheet.updated_at || '') || 0;
    if (sheetTs >= existingTs) {
      byName.set(name, sheet);
    }
  }

  return Array.from(byName.values());
}

function getNextCharacterName(sheets) {
  const usedNames = new Set(
    (Array.isArray(sheets) ? sheets : [])
      .map((sheet) => (sheet?.characterName || '').trim())
      .filter(Boolean)
  );

  let index = 1;
  while (usedNames.has(`Персонаж ${index}`)) {
    index += 1;
  }

  return `Персонаж ${index}`;
}

/** Завантажує всіх персонажів кімнати з Supabase */
async function loadAllCharactersFromSupabase(roomId) {
  if (!roomId) return null;
  try {
    const { data, error } = await supabase
      .from('character_sheets')
      .select('*')
      .eq('room_id', roomId)
      .order('updated_at', { ascending: false, nullsFirst: false });
    if (error) { console.error('[Supabase] Помилка завантаження персонажів:', error); return null; }
    return dedupeRowsByCharacterName(data || []);
  } catch (e) {
    console.error('[Supabase] Мережева помилка:', e);
    return null;
  }
}

/** Зберігає один лист у Supabase (з обробкою перейменування) */
async function saveSheetToSupabase(sheet) {
  if (!sheet || !sheet.characterName) return;
  const roomId = OBR.room.id;
  try {
    const oldName = sheet._originalCharacterName;
    // При перейменуванні — видаляємо старий рядок
    if (oldName && oldName !== sheet.characterName) {
      await supabase.from('character_sheets')
        .delete()
        .eq('room_id', roomId)
        .eq('character_name', oldName);
      sheet._originalCharacterName = sheet.characterName;
    }

    // Захист від "затирання": перед збереженням зливаємо локальний лист
    // з актуальним рядком у Supabase, якщо він існує.
    let sheetToSave = sheet;
    try {
      const { data: existingRow, error: existingError } = await supabase
        .from('character_sheets')
        .select('*')
        .eq('room_id', roomId)
        .eq('character_name', sheet.characterName)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(1);

      const existing = Array.isArray(existingRow) ? existingRow[0] : null;

      if (!existingError && existing) {
        const mergedSheet = {};
        applyFullSupabaseRowToSheet(mergedSheet, existing);
        Object.keys(sheet).forEach((key) => {
          if (sheet[key] !== undefined) mergedSheet[key] = sheet[key];
        });
        sheetToSave = mergedSheet;
      }
    } catch (_) {
      // Якщо merge не вдався, зберігаємо наявний локальний стан як fallback.
    }

    const row = buildFullSupabaseRow(sheetToSave, roomId);
    const { error } = await supabase
      .from('character_sheets')
      .upsert(row, { onConflict: 'room_id,character_name' });
    if (error) console.error('[Supabase] Помилка збереження:', error);
  } catch (e) {
    console.error('[Supabase] Мережева помилка при збереженні:', e);
  }
}

/** Записує мінімальний реєстр персонажів у OBR room metadata */
async function updateOBRRegistry() {
  try {
    characterSheets = dedupeSheetsByCharacterName(characterSheets);

    const registry = characterSheets.map((sheet) => ({
      characterName: sheet.characterName || '',
      playerName: sheet.playerName || '',
    }));
    const currentMetadata = await OBR.room.getMetadata();
    await OBR.room.setMetadata({ ...currentMetadata, [DARQIE_REGISTRY_KEY]: registry });
  } catch (e) {
    console.error('[OBR] Помилка оновлення реєстру:', e);
  }
}

/** Оновлює тільки dropdown і видимість, не перезавантажує дані */
async function refreshDropdownOnly() {
  const characterSelect = document.getElementById('characterSelect');
  const waitingBlock = document.getElementById('waitingBlock');
  const mainContent = document.getElementById('mainContent');
  if (!characterSelect) return;

  characterSheets = dedupeSheetsByCharacterName(characterSheets);

  const visibleSheets = characterSheets
    .map((sheet, index) => ({ ...sheet, index }))
    .filter(sheet => isPlayableSheet(sheet) && (isGM || sheet.playerName === currentPlayerName));

  characterSelect.innerHTML = '';
  visibleSheets.forEach(sheet => {
    const option = document.createElement('option');
    option.value = sheet.index;
    option.textContent = sheet.characterName || `Персонаж ${sheet.index + 1}`;
    characterSelect.appendChild(option);
  });

  if (visibleSheets.length === 0) {
    if (!isGM) { if (waitingBlock) waitingBlock.style.display = 'flex'; if (mainContent) mainContent.style.display = 'none'; }
    else { if (waitingBlock) waitingBlock.style.display = 'none'; if (mainContent) mainContent.style.display = 'flex'; }
    return;
  }
  if (waitingBlock) waitingBlock.style.display = 'none';
  if (mainContent) mainContent.style.display = 'flex';

  const isActiveVisible = visibleSheets.some(s => s.index === activeSheetIndex);
  if (!isActiveVisible) {
    activeSheetIndex = visibleSheets[0].index;
    loadSheetData();
  }
  characterSelect.value = activeSheetIndex;
}

/** Налаштовує Supabase Realtime підписку для кімнати */
async function setupSupabaseRealtime(roomId) {
  if (realtimeChannel) {
    try { await supabase.removeChannel(realtimeChannel); } catch (_) {}
    realtimeChannel = null;
  }
  realtimeChannel = supabase
    .channel(`darqie-sheets-${roomId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'character_sheets', filter: `room_id=eq.${roomId}` }, (payload) => {
      handleRealtimeUpdate(payload.new);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'character_sheets', filter: `room_id=eq.${roomId}` }, (payload) => {
      handleRealtimeInsert(payload.new);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'character_sheets', filter: `room_id=eq.${roomId}` }, async (payload) => {
      await handleRealtimeDelete(payload.old);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[Supabase Realtime] Підписано на зміни character_sheets');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[Supabase Realtime] Канал нестабільний, увімкнено polling fallback');
      }
    });
}

/**
 * Fallback-синхронізація на випадок, коли realtime-подія пропущена/затримана.
 * Підтягує актуальні рядки з Supabase та застосовує зміни до локального кешу й DOM.
 */
async function syncAllCharactersFromSupabase(roomId) {
  const rows = await loadAllCharactersFromSupabase(roomId);
  if (!Array.isArray(rows)) return;

  for (const row of rows) {
    if (!row?.character_name) continue;
    const sheetIdx = characterSheets.findIndex(s => s.characterName === row.character_name);

    if (sheetIdx === -1) {
      await handleRealtimeInsert(row);
      continue;
    }

    const localUpdatedAt = characterSheets[sheetIdx]?._updatedAt || null;
    const incomingUpdatedAt = row.updated_at || null;
    if (localUpdatedAt && incomingUpdatedAt && localUpdatedAt === incomingUpdatedAt) {
      continue;
    }

    const updatedSheet = { ...characterSheets[sheetIdx] };
    applyFullSupabaseRowToSheet(updatedSheet, row);
    characterSheets[sheetIdx] = updatedSheet;

    if (sheetIdx === activeSheetIndex) {
      applyRealtimeUpdateToDOM(updatedSheet);
    }
  }
}

function setupSupabasePollingFallback(roomId) {
  if (fallbackSyncIntervalId) {
    clearInterval(fallbackSyncIntervalId);
    fallbackSyncIntervalId = null;
  }

  fallbackSyncIntervalId = setInterval(async () => {
    await syncAllCharactersFromSupabase(roomId);
  }, 1200);
}

/** Обробляє UPDATE від іншого клієнта */
function handleRealtimeUpdate(newRow) {
  if (!newRow?.character_name) return;
  const charName = newRow.character_name;
  const sheetIdx = characterSheets.findIndex(s => s.characterName === charName);
  if (sheetIdx === -1) return;

  // Оновлюємо локальний кеш
  const updatedSheet = { ...characterSheets[sheetIdx] };
  applyFullSupabaseRowToSheet(updatedSheet, newRow);
  characterSheets[sheetIdx] = updatedSheet;

  // Оновлюємо DOM для активного персонажа одразу.
  // Функція applyRealtimeUpdateToDOM сама не перезапише поле у фокусі.
  if (sheetIdx === activeSheetIndex) {
    applyRealtimeUpdateToDOM(updatedSheet);
  }
}

/** Обробляє INSERT від іншого клієнта (нового персонажа) */
async function handleRealtimeInsert(newRow) {
  if (!newRow?.character_name) return;
  if (characterSheets.some(s => s.characterName === newRow.character_name)) return;

  const newSheet = sheetFromSupabaseRow(newRow);
  characterSheets = dedupeSheetsByCharacterName([...characterSheets, newSheet]);
  await refreshDropdownOnly();

  if (!isGM && newSheet.playerName === currentPlayerName) {
    activeSheetIndex = characterSheets.length - 1;
    const sel = document.getElementById('characterSelect');
    if (sel) sel.value = activeSheetIndex;
    loadSheetData();
  }
}

/** Обробляє DELETE від іншого клієнта */
async function handleRealtimeDelete(oldRow) {
  if (!oldRow?.character_name) return;
  const sheetIdx = characterSheets.findIndex(s => s.characterName === oldRow.character_name);
  if (sheetIdx === -1) return;

  const wasActive = sheetIdx === activeSheetIndex;
  characterSheets = characterSheets.filter((_, i) => i !== sheetIdx);

  if (sheetIdx < activeSheetIndex) activeSheetIndex = Math.max(0, activeSheetIndex - 1);
  else if (wasActive) activeSheetIndex = Math.max(0, Math.min(activeSheetIndex, characterSheets.length - 1));

  await refreshDropdownOnly();
  if (wasActive && characterSheets.length > 0) loadSheetData();
}

/**
 * Застосовує оновлення від іншого гравця до DOM без перезаписування
 * поля, яке зараз в фокусі користувача.
 */
function applyRealtimeUpdateToDOM(updatedSheet) {
  const focusedId = document.activeElement?.id;
  const elements = getSheetInputElements();

  for (const [key, el] of Object.entries(elements)) {
    if (!el || el.id === focusedId) continue;
    if (key === 'characterPhoto') {
      const photoUrl = updatedSheet.characterPhoto || '';
      const placeholder = document.getElementById('photoPlaceholder');
      const isValid = photoUrl && photoUrl !== '' && photoUrl !== '/no-image-placeholder.svg'
        && !photoUrl.includes('index.html') && !photoUrl.includes('localhost') && !photoUrl.includes('127.0.0.1');
      if (isValid) {
        el.src = photoUrl; el.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
      } else {
        el.src = ''; el.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
      }
    } else {
      el.value = updatedSheet[key] || '';
    }
  }

  // Оновлюємо поля модалки (Class/Race/Background/Alignment тощо),
  // але не чіпаємо те textarea, яке зараз редагується/у фокусі.
  MODAL_FIELDS.forEach((key) => {
    const modalId = MODAL_FIELD_TO_ID[key];
    const modalEl = document.getElementById(modalId);
    if (!modalEl) return;
    if (modalEl.id === focusedId || !modalEl.readOnly) return;

    modalEl.value = updatedSheet[key] || '';
    modalEl.style.height = 'auto';
    modalEl.style.height = modalEl.scrollHeight + 'px';
  });

  const success = updatedSheet.deathSavesSuccess || [false, false, false];
  const failure = updatedSheet.deathSavesFailure || [false, false, false];
  ['deathSavesSuccess1','deathSavesSuccess2','deathSavesSuccess3'].forEach((id, i) => {
    const el = document.getElementById(id); if (el && el.id !== focusedId) el.checked = success[i];
  });
  ['deathSavesFailure1','deathSavesFailure2','deathSavesFailure3'].forEach((id, i) => {
    const el = document.getElementById(id); if (el && el.id !== focusedId) el.checked = failure[i];
  });
  const inEl = document.getElementById('inspirationCheckbox');
  if (inEl && inEl.id !== focusedId) inEl.checked = updatedSheet.inspiration || false;
  const adEl = document.getElementById('advantageCheckbox');
  if (adEl && adEl.id !== focusedId) adEl.checked = updatedSheet.advantage || false;
  const diEl = document.getElementById('disadvantageCheckbox');
  if (diEl && diEl.id !== focusedId) diEl.checked = updatedSheet.disadvantage || false;

  if (!weaponEditing && Array.isArray(updatedSheet.weapons)) {
    weaponRows = JSON.parse(JSON.stringify(updatedSheet.weapons)); renderWeaponTable(false);
  }
  if (!skillEditing && Array.isArray(updatedSheet.skills)) {
    skillRows = JSON.parse(JSON.stringify(updatedSheet.skills)); renderSkillTable(false);
  }
  if (!editingInv && Array.isArray(updatedSheet.inventory)) {
    inventoryRows = JSON.parse(JSON.stringify(updatedSheet.inventory)); renderInventoryTable(false);
  }
  if (!editingEquip && Array.isArray(updatedSheet.equipment)) {
    equipmentRows = JSON.parse(JSON.stringify(updatedSheet.equipment)); renderEquipmentTable(false);
  }

  coinsData = updatedSheet.coins ? JSON.parse(JSON.stringify(updatedSheet.coins)) : { sen: 0, gin: 0, kin: 0 };
  loadCoinsData();
  updateModifiers();
  updateDeathOverlay();
  updateCurrentWeight();
}

/** Мігрує старі дані з OBR room metadata до Supabase (одноразово) */
async function migrateOBRDataIfNeeded(roomId) {
  try {
    const metadata = await OBR.room.getMetadata();
    const oldSheets = metadata[DARQIE_SHEETS_KEY];
    const newRegistry = metadata[DARQIE_REGISTRY_KEY];

    if (!Array.isArray(oldSheets) || oldSheets.length === 0) return;
    if (Array.isArray(newRegistry) && newRegistry.length > 0) return; // вже мігровано

    console.log('[Migration] Мігруємо', oldSheets.length, 'персонажів з OBR до Supabase...');
    for (const sheet of oldSheets) {
      if (!sheet?.characterName) continue;
      const { data, error } = await supabase
        .from('character_sheets')
        .select('character_name')
        .eq('room_id', roomId)
        .eq('character_name', sheet.characterName)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(1);
      if (error) {
        console.warn('[Migration] Не вдалося перевірити існування персонажа:', sheet.characterName, error);
        continue;
      }
      const existing = Array.isArray(data) ? data[0] : null;
      if (!existing) {
        await saveSheetToSupabase(sheet);
        console.log('[Migration] Мігровано:', sheet.characterName);
      }
    }
    console.log('[Migration] Міграцію завершено.');
  } catch (e) {
    console.error('[Migration] Помилка міграції:', e);
  }
}

// === КОНСТАНТИ ===
const DARQIE_SHEETS_KEY = 'darqie.characterSheets'; // legacy — тепер лише для міграції
const DARQIE_REGISTRY_KEY = 'darqie.v2.registry';   // мінімальний реєстр персонажів в OBR
const DEBOUNCE_DELAY = 40;
const UPLOADCARE_PUBLIC_KEY = '7d0fa9d84ac0680d6d83';
const DICE_ROLL_KEY = "darqie.rollRequest";

// === ГЛОБАЛЬНІ ЗМІННІ ===
let characterSheets = [];
let activeSheetIndex = 0;
let saveTimer = null;
let currentPlayerName = '';
let isGM = false;
let isRedirecting = false;
let weaponEditing = false;
let skillEditing = false;
let editingInv = false;
let editingEquip = false;
let lastRollRequestTime = 0;
let isSaving = false;
let saveQueue = [];
let tokenHealthSyncInFlight = false;
let pendingTokenHealthSync = null;
let lastTokenHealthSyncKey = '';
let lastTokenHealthReconcileAt = 0;
const TOKEN_HEALTH_RECONCILE_INTERVAL_MS = 12000;
let lastTokenACSyncKey = '';
let lastTokenACReconcileAt = 0;
const TOKEN_AC_RECONCILE_INTERVAL_MS = 12000;
let realtimeChannel = null;
let fallbackSyncIntervalId = null;
let modalOpenRequestId = 0;

function isTokenForSheet(item, sheet) {
  if (!item || item.layer !== 'CHARACTER') return false;
  const tokenSheet = item.metadata?.characterSheet;
  if (!tokenSheet) return false;

  if (sheet?.characterName && tokenSheet.characterName) {
    return tokenSheet.characterName === sheet.characterName;
  }

  if (sheet?.playerName && tokenSheet.playerName) {
    return tokenSheet.playerName === sheet.playerName;
  }

  return false;
}

function getActiveSheetCombatValues() {
  const sheet = characterSheets[activeSheetIndex];
  if (!sheet) return null;

  const healthPointsInput = document.getElementById('healthPoints');
  const tempHealthInput = document.getElementById('health');
  const armorClassInput = document.getElementById('armorClass');

  const hp = parseInt(healthPointsInput?.value, 10);
  const tempHp = parseInt(tempHealthInput?.value, 10);
  const ac = parseInt(armorClassInput?.value, 10);

  const resolvedHp = Number.isNaN(hp) ? (parseInt(sheet.healthPoints, 10) || 0) : hp;
  const resolvedTempHp = Number.isNaN(tempHp) ? (parseInt(sheet.healing, 10) || 0) : tempHp;
  const resolvedAc = Number.isNaN(ac) ? (parseInt(sheet.armorClass, 10) || 5) : ac;

  // Тримаємо локальний кеш синхронним з тим, що зараз у листі на екрані.
  sheet.healthPoints = String(resolvedHp);
  sheet.healing = String(resolvedTempHp);
  sheet.armorClass = String(resolvedAc);

  return { sheet, hp: resolvedHp, tempHp: resolvedTempHp, ac: resolvedAc };
}
let modalClickTimeout;

// Ініціалізуємо глобальні змінні
window.weaponEditing = false;
window.skillEditing = false;

// === ДИНАМІЧНА ТАБЛИЦЯ ЗБРОЇ ===
let weaponRows = [
  { name: '', bonus: '', damage: '' }
];

// === ДИНАМІЧНА ТАБЛИЦЯ НАВИЧОК ===
let skillRows = [
  { name: '', bonus: '', desc: '' }
];

// === ДИНАМІЧНА ТАБЛИЦЯ ІНВЕНТАРЯ ===
let inventoryRows = [
  { name: '', count: '', weight: '' }
];

// === ДИНАМІЧНА ТАБЛИЦЯ СПОРЯДЖЕННЯ ===
let equipmentRows = [
  { name: '', armor: '', weight: '' }
];

// === ДАНІ МОНЕТ ===
let coinsData = {
  sen: 0,
  gin: 0,
  kin: 0
};

// === УТИЛІТИ ===
function debounce(func, delay) {
  let timeoutId;
  let lastArgs;
  let lastContext;
  
  return function(...args) {
    lastArgs = args;
    lastContext = this;
    
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      func.apply(lastContext, lastArgs);
    }, delay);
  };
}

async function getMetadata() {
  const metadata = await OBR.room.getMetadata();
  const raw = metadata[DARQIE_SHEETS_KEY];
  return Array.isArray(raw) ? raw : [];
}

function getSheetInputElements() {
  return {
    characterName: document.getElementById('characterName'),
    characterClassLevel: document.getElementById('characterClassLevel'),
    background: document.getElementById('background'),
    playerName: document.getElementById('playerNameSelect'),
    characterRace: document.getElementById('characterRace'),
    alignment: document.getElementById('alignment'),
    strengthScore: document.getElementById('strengthScore'),
    dexterityScore: document.getElementById('dexterityScore'),
    constitutionScore: document.getElementById('constitutionScore'),
    proficiencyScore: document.getElementById('proficiencyScore'),
    wisdomScore: document.getElementById('wisdomScore'),
    charismaScore: document.getElementById('charismaScore'),
    maxHealthPoints: document.getElementById('maxHealthPoints'),
    healing: document.getElementById('health'),
    armorClass: document.getElementById('armorClass'),
    initiative: document.getElementById('initiative'),
    speed: document.getElementById('speed'),
    proficienciesAndLanguages: document.getElementById('proficienciesAndLanguages'),
    equipment: document.getElementById('equipment'),
    alliesAndOrganizations: document.getElementById('alliesAndOrganizations'),
    characterHistory: document.getElementById('characterHistory'),
    additionalFeatures: document.getElementById('additionalFeatures'),
    notes: document.getElementById('notes'),
    characterPhoto: document.getElementById('characterPhotoImg'),
    maxWeight: document.getElementById('maxWeight'),
    currentWeight: document.getElementById('currentWeight'),
    healthPoints: document.getElementById('healthPoints'),
  };
}

function updateModifiers() {
  const stats = [
    ['strengthScore', 'strengthModifier'],
    ['dexterityScore', 'dexterityModifier'],
    ['constitutionScore', 'constitutionModifier'],
    ['proficiencyScore', 'proficiencyModifier'],
    ['wisdomScore', 'wisdomModifier'],
    ['charismaScore', 'charismaModifier'],
  ];

  stats.forEach(([inputId, outputId]) => {
    const input = document.getElementById(inputId);
    const output = document.getElementById(outputId);
    if (input && output) {
      let value = parseInt(input.value);
      if (isNaN(value) || value < 0) {
        value = 0;
        input.value = 0;
      }
      const mod = Math.floor((value - 10) / 2);
      output.textContent = (mod >= 0 ? '+' : '') + mod;
    }
  });

  // Автоматичний розрахунок максимальної ваги на основі сили
  updateMaxWeight();
  // Автоматичний розрахунок швидкості на основі спритності
  updateSpeed();
  // Автоматичний розрахунок максимального здоров'я на основі статури
  updateMaxHealth();
  // Автоматичний розрахунок броні на основі спорядження
  updateArmorClass();
  updateCurrentWeight();

  // Переобчислюємо відображення токенів типу dexterityModifier/wisdomModifier у перегляді.
  if (!weaponEditing) {
    renderWeaponTable(false);
  }
  if (!skillEditing) {
    renderSkillTable(false);
  }
}

function updateMaxWeight() {
  const strengthInput = document.getElementById('strengthScore');
  const maxWeightInput = document.getElementById('maxWeight');
  
  if (strengthInput && maxWeightInput) {
    let strengthValue = parseInt(strengthInput.value);
    if (isNaN(strengthValue) || strengthValue < 0) {
      strengthValue = 0;
    }
    
    // Максимальна вага = 20 + значення сили, але не більше 999
    const maxWeight = Math.min(20 + strengthValue, 999);
    maxWeightInput.value = maxWeight;
  }
}

function updateSpeed() {
  const dexterityInput = document.getElementById('dexterityScore');
  const speedInput = document.getElementById('speed');
  
  if (dexterityInput && speedInput) {
    let dexterityValue = parseInt(dexterityInput.value);
    if (isNaN(dexterityValue) || dexterityValue < 0) {
      dexterityValue = 0;
    }
    
    // Базова швидкість = 20
    let speed = 20;
    
    // Додаємо 5 за кожні 8 очків спритності, якщо спритність більше 10
    if (dexterityValue > 10) {
      const bonusPoints = Math.floor((dexterityValue - 10) / 8);
      speed += bonusPoints * 5;
    }
    
    // Обмежуємо до 99
    speed = Math.min(speed, 99);
    speedInput.value = speed;
  }
}

function updateMaxHealth() {
  const constitutionInput = document.getElementById('constitutionScore');
  const maxHealthInput = document.getElementById('maxHealthPoints');
  
  if (constitutionInput && maxHealthInput) {
    let constitutionValue = parseInt(constitutionInput.value);
    if (isNaN(constitutionValue) || constitutionValue < 0) {
      constitutionValue = 0;
    }
    
    // Максимальне здоров'я = 10 + значення статури
    const maxHealth = Math.min(10 + constitutionValue, 99);
    maxHealthInput.value = maxHealth;
  }
}

function updateArmorClass() {
  const armorClassInput = document.getElementById('armorClass');
  
  if (armorClassInput && equipmentRows) {
    let totalArmor = 0;
    
    // Розраховуємо загальну броню зі спорядження
    equipmentRows.forEach(row => {
      const armor = parseFloat(row.armor) || 0;
      totalArmor += armor;
    });
    
    // Базова броня = 5 + броня зі спорядження
    const armorClass = Math.min(5 + totalArmor, 99);
    armorClassInput.value = armorClass;
    
    // Оновлюємо клас броні на токені
    updateTokenAC(armorClass);
  }
}

function updateCurrentWeight() {
  const currentWeightInput = document.getElementById('currentWeight');
  const maxWeightInput = document.getElementById('maxWeight');
  const inventoryBlock = document.querySelector('.inventory-block');
  
  if (currentWeightInput && (inventoryRows || equipmentRows)) {
    let totalWeight = 0;
    
    // Розраховуємо загальну вагу всіх предметів в інвентарі
    if (inventoryRows) {
      inventoryRows.forEach(row => {
        const count = parseFloat(row.count) || 0;
        const weight = parseFloat(row.weight) || 0;
        totalWeight += count * weight;
      });
    }
    
    // Розраховуємо загальну вагу всіх предметів спорядження
    if (equipmentRows) {
      equipmentRows.forEach(row => {
        const weight = parseFloat(row.weight) || 0;
        totalWeight += weight; // Спорядження враховується як 1 штука
      });
    }
    
    // Обмежуємо до 999
    totalWeight = Math.min(totalWeight, 999);
    
    // Округляємо до 2 знаків після коми
    currentWeightInput.value = Math.round(totalWeight * 100) / 100;
    
    // Перевіряємо чи перевищена максимальна вага
    if (maxWeightInput && inventoryBlock) {
      const maxWeight = parseFloat(maxWeightInput.value) || 0;
      
      if (totalWeight > maxWeight && maxWeight > 0) {
        // Додаємо клас для червоного блимання
        inventoryBlock.classList.add('inventory-overloaded');
      } else {
        // Видаляємо клас якщо вага в нормі
        inventoryBlock.classList.remove('inventory-overloaded');
      }
    }
  }
}

// === РОБОТА З ДАНИМИ ===
const debouncedSaveSheetData = debounce(saveSheetData, DEBOUNCE_DELAY);

async function saveSheetData(targetSheetIndex = null) {
  const sheetIndexToSave = targetSheetIndex ?? activeSheetIndex;
  if (characterSheets.length === 0 || sheetIndexToSave < 0 || sheetIndexToSave >= characterSheets.length) return;
  
  // Якщо вже зберігаємо, додаємо в чергу
  if (isSaving) {
    if (!saveQueue.includes(sheetIndexToSave)) {
      saveQueue.push(sheetIndexToSave);
    }
    return;
  }
  
  isSaving = true;

  const sheet = characterSheets[sheetIndexToSave];
  const elements = getSheetInputElements();
  const previousCharacterName = sheet.characterName;
  const previousPlayerName = sheet.playerName;
  const modal = document.getElementById('characterInfoModal');
  const isModalOpen = modal && modal.style.display === 'block';

  // Збереження основних полів
  for (const key in elements) {
    if (['characterClassLevel','characterRace','background','alignment'].includes(key)) {
      // Беремо з модалки лише коли вона відкрита; інакше не перезаписуємо прихованими/застарілими значеннями.
      const modalMap = {
        characterClassLevel: 'modalCharacterClass',
        characterRace: 'modalCharacterRace',
        background: 'modalBackground',
        alignment: 'modalAlignment',
      };
      const modalEl = document.getElementById(modalMap[key]);
      if (isModalOpen && modalEl) {
        sheet[key] = modalEl.value;
        continue;
      }
    }
    if (elements[key]) {
      if (key === 'playerName') {
        if (!elements[key].disabled) {
          sheet[key] = elements[key].value;
        }
      } else if (key === 'characterPhoto') {
        sheet[key] = elements[key].src;
      } else {
        sheet[key] = elements[key].value;
      }
    }
  }

  // Збереження рятувальних кидків
  sheet.deathSavesSuccess = [
    document.getElementById('deathSavesSuccess1')?.checked || false,
    document.getElementById('deathSavesSuccess2')?.checked || false,
    document.getElementById('deathSavesSuccess3')?.checked || false
  ];
  
  sheet.deathSavesFailure = [
    document.getElementById('deathSavesFailure1')?.checked || false,
    document.getElementById('deathSavesFailure2')?.checked || false,
    document.getElementById('deathSavesFailure3')?.checked || false
  ];

  // Збереження натхнення, переваги, похибки
  sheet.inspiration = document.getElementById('inspirationCheckbox')?.checked || false;
  sheet.advantage = document.getElementById('advantageCheckbox')?.checked || false;
  sheet.disadvantage = document.getElementById('disadvantageCheckbox')?.checked || false;

  // Збереження інвентаря
  if (!editingInv) {
    const tbody = document.getElementById('inventoryTableBody');
    if (tbody) {
      inventoryRows = Array.from(tbody.children).map(tr => {
        const inputName = tr.querySelector('.inventory-name');
        const inputCount = tr.querySelector('.inventory-count');
        const inputWeight = tr.querySelector('.inventory-weight');
        return {
          name: inputName ? inputName.value : '',
          count: inputCount ? inputCount.value : '',
          weight: inputWeight ? inputWeight.value : ''
        };
      });
    }
    sheet.inventory = JSON.parse(JSON.stringify(inventoryRows));
  }

  // Збереження спорядження
  if (!editingEquip) {
    const equipmentTbody = document.getElementById('equipmentTableBody');
    if (equipmentTbody) {
      equipmentRows = Array.from(equipmentTbody.children).map(tr => {
        const inputName = tr.querySelector('.equipment-name');
        const inputArmor = tr.querySelector('.equipment-armor');
        const inputWeight = tr.querySelector('.equipment-weight');
        return {
          name: inputName ? inputName.value : '',
          armor: inputArmor ? inputArmor.value : '',
          weight: inputWeight ? inputWeight.value : ''
        };
      });
    }
    sheet.equipment = JSON.parse(JSON.stringify(equipmentRows));
  }

  // Збереження заголовків блоків
  const inventoryLabel = document.querySelector('.inventory-block .weapon-label');
  const equipmentLabel = document.querySelector('.equipment-block .weapon-label');
  if (inventoryLabel && sheet.inventoryTitle) inventoryLabel.textContent = sheet.inventoryTitle;
  if (equipmentLabel && sheet.equipmentTitle) equipmentLabel.textContent = sheet.equipmentTitle;

  try {
    // Зберігаємо ВСЕ в Supabase (єдине джерело правди)
    await saveSheetToSupabase(sheet);

    // Оновлюємо реєстр тільки коли змінилися ключові поля (щоб не гальмувати кожен input).
    const registryNeedsUpdate =
      sheet.characterName !== previousCharacterName ||
      sheet.playerName !== previousPlayerName;
    if (registryNeedsUpdate) {
      await updateOBRRegistry();
    }

    // Якщо власник листа змінився — передаємо токен новому власнику
    if (isGM && sheet.playerName !== previousPlayerName) {
      await syncCharacterTokenOwner(sheet, previousPlayerName);
    }

    // Повідомлення про призначення персонажа
    if (isGM && sheet.playerName && sheet.playerName !== previousPlayerName) {
      await OBR.broadcast.sendMessage("character-assignment", {
        playerName: sheet.playerName,
        characterName: sheet.characterName || 'Без назви'
      });
    }

    updateDeathOverlay();
    updateCurrentWeight();
  } catch (error) {
    console.error('Помилка при збереженні даних:', error);
  } finally {
    isSaving = false;
    
    // Обробляємо чергу збережень
    if (saveQueue.length > 0) {
      const nextIndex = saveQueue.shift();
      if (nextIndex >= 0 && nextIndex < characterSheets.length) {
        // Якщо в черзі той самий персонаж або інший, зберігаємо з правильним індексом
        setTimeout(() => saveSheetData(nextIndex), 100);
      }
    }
  }
}

function loadSheetData() {
  const sheet = characterSheets[activeSheetIndex];
  if (!sheet) return;

  updateTokenStatsToggleButtonState(sheet);
  
  const elements = getSheetInputElements();

  // Тримаємо модалку синхронізованою з активним листом, щоб уникнути міжперсонажного "протікання" значень.
  applyModalInfoToInputs(getModalInfoFromSheet(sheet));

  // Завантаження основних полів
  for (const key in elements) {
    if (elements[key]) {
      if (key === 'characterPhoto') {
        const photoUrl = sheet[key];
        const placeholder = document.getElementById('photoPlaceholder');
        const photoImg = elements[key];
        
        // Перевіряємо чи це дійсно URL фото, а не URL сторінки
        const isValidPhotoUrl = photoUrl && 
                                photoUrl !== '' && 
                                photoUrl !== '/no-image-placeholder.svg' &&
                                !photoUrl.includes('index.html') &&
                                !photoUrl.includes('obrref') &&
                                !photoUrl.includes('localhost') &&
                                !photoUrl.includes('127.0.0.1');
        
        if (isValidPhotoUrl) {
          // Є фото - показуємо його
          photoImg.src = photoUrl;
          photoImg.style.display = 'block';
          if (placeholder) placeholder.style.display = 'none';
        } else {
          // Немає фото - показуємо заглушку
          photoImg.src = '';
          photoImg.style.display = 'none';
          if (placeholder) {
            placeholder.style.display = 'flex';
          }
        }
      } else {
        elements[key].value = sheet[key] || '';
      }
    }
  }

  // Завантаження рятувальних кидків
  const success = sheet.deathSavesSuccess || [false, false, false];
  const failure = sheet.deathSavesFailure || [false, false, false];

  ['deathSavesSuccess1', 'deathSavesSuccess2', 'deathSavesSuccess3'].forEach((id, i) => {
    const element = document.getElementById(id);
    if (element) element.checked = success[i];
  });

  ['deathSavesFailure1', 'deathSavesFailure2', 'deathSavesFailure3'].forEach((id, i) => {
    const element = document.getElementById(id);
    if (element) element.checked = failure[i];
  });

  // Завантаження натхнення, переваги, похибки
  const inspiration = sheet.inspiration || false;
  const advantage = sheet.advantage || false;
  const disadvantage = sheet.disadvantage || false;
  const inspirationEl = document.getElementById('inspirationCheckbox');
  const advantageEl = document.getElementById('advantageCheckbox');
  const disadvantageEl = document.getElementById('disadvantageCheckbox');
  if (inspirationEl) inspirationEl.checked = inspiration;
  if (advantageEl) advantageEl.checked = advantage;
  if (disadvantageEl) disadvantageEl.checked = disadvantage;

  // --- Додаю завантаження зброї ---
  weaponRows = Array.isArray(sheet.weapons) && sheet.weapons.length > 0
    ? JSON.parse(JSON.stringify(sheet.weapons))
    : [{ name: '', bonus: '', damage: '' }];
  renderWeaponTable(false); // Завжди починаємо з режиму перегляду

  // --- Додаю завантаження навичок ---
  skillRows = Array.isArray(sheet.skills) && sheet.skills.length > 0
    ? JSON.parse(JSON.stringify(sheet.skills))
    : [{ name: '', bonus: '', desc: '' }];
  renderSkillTable(skillEditing);

  // --- Додаю завантаження інвентаря ---
  inventoryRows = Array.isArray(sheet.inventory) && sheet.inventory.length > 0
    ? JSON.parse(JSON.stringify(sheet.inventory))
    : [{ name: '', count: '', weight: '' }];
  renderInventoryTable(false);

  // --- Додаю завантаження спорядження ---
  equipmentRows = Array.isArray(sheet.equipment) && sheet.equipment.length > 0
    ? JSON.parse(JSON.stringify(sheet.equipment))
    : [{ name: '', armor: '', weight: '' }];
  renderEquipmentTable(false);

  // --- Додаю завантаження монет ---
  coinsData = sheet.coins ? JSON.parse(JSON.stringify(sheet.coins)) : { sen: 0, gin: 0, kin: 0 };
  loadCoinsData();

  // --- Додаю завантаження заголовків блоків ---
  const weaponLabel = document.querySelector('.weapon-block .weapon-label');
  const inventoryLabel = document.querySelector('.inventory-block .weapon-label');
  const equipmentLabel = document.querySelector('.equipment-block .weapon-label');
  if (weaponLabel && sheet.weaponTitle) weaponLabel.textContent = sheet.weaponTitle;
  if (inventoryLabel && sheet.inventoryTitle) inventoryLabel.textContent = sheet.inventoryTitle;
  if (equipmentLabel && sheet.equipmentTitle) equipmentLabel.textContent = sheet.equipmentTitle;

  updateModifiers();
  updateDeathOverlay();
  updateCurrentWeight();
}

// Ініціалізація при завантаженні
updateModifiers();
updateMaxWeight();
updateSpeed();
updateMaxHealth();
updateArmorClass();
updateCurrentWeight();
renderWeaponTable(false); // Додаю ініціалізацію таблиці зброї
renderInventoryTable(false);
renderEquipmentTable(false);

// === ІНТЕРФЕЙС ===
async function updateCharacterDropdown() {
  const characterSelect = document.getElementById('characterSelect');
  const waitingBlock = document.getElementById('waitingBlock');
  const mainContent = document.getElementById('mainContent');

  if (!characterSelect) return;

  const previousSheets = Array.isArray(characterSheets) ? characterSheets : [];
  const roomId = OBR.room.id;
  const rows = await loadAllCharactersFromSupabase(roomId);

  if (rows !== null) {
    // Зберігаємо порядок із OBR реєстру (якщо є)
    const metadata = await OBR.room.getMetadata();
    const registry = metadata[DARQIE_REGISTRY_KEY] || [];

    if (registry.length > 0) {
      const rowsByName = {};
      rows.forEach(r => { rowsByName[r.character_name] = r; });
      const localByName = {};
      previousSheets.forEach(s => {
        if (s?.characterName) localByName[s.characterName] = s;
      });

      const rebuilt = registry
        .map(entry => {
          const row = rowsByName[entry.characterName];
          if (row) return sheetFromSupabaseRow(row);
          // Якщо рядок тимчасово не повернувся з Supabase, зберігаємо повний локальний кеш,
          // щоб не втратити поля при наступному autosave.
          if (localByName[entry.characterName]) {
            return JSON.parse(JSON.stringify(localByName[entry.characterName]));
          }
          // Фолбек лише для справді нового персонажа, який ще не записався у БД.
          return { characterName: entry.characterName, playerName: entry.playerName };
        })
        .filter(Boolean);

      // Додаємо персонажів з Supabase, яких нема в реєстрі
      rows.forEach(row => {
        if (!rebuilt.some(s => s.characterName === row.character_name)) {
          rebuilt.push(sheetFromSupabaseRow(row));
        }
      });

      characterSheets = dedupeSheetsByCharacterName(rebuilt);
    } else {
      characterSheets = dedupeSheetsByCharacterName(rows.map(row => sheetFromSupabaseRow(row)));
    }
  }
  // Якщо Supabase недоступний — використовуємо наявний локальний кеш

  characterSheets = dedupeSheetsByCharacterName(characterSheets);

  const visibleSheets = characterSheets
    .map((sheet, index) => ({ ...sheet, index }))
    .filter(sheet => isPlayableSheet(sheet) && (isGM || sheet.playerName === currentPlayerName));

  const previousIndex = activeSheetIndex;
  const requestedCharacterName = new URL(window.location.href).searchParams.get('characterName');
  characterSelect.innerHTML = '';

  visibleSheets.forEach(sheet => {
    const option = document.createElement('option');
    option.value = sheet.index;
    option.textContent = sheet.characterName || `Персонаж ${sheet.index + 1}`;
    characterSelect.appendChild(option);
  });

  if (visibleSheets.length === 0) {
    if (!isGM) {
      if (waitingBlock) waitingBlock.style.display = 'flex';
      if (mainContent) mainContent.style.display = 'none';
    } else {
      if (waitingBlock) waitingBlock.style.display = 'none';
      if (mainContent) mainContent.style.display = 'flex';
    }
    return;
  }

  if (waitingBlock) waitingBlock.style.display = 'none';
  if (mainContent) mainContent.style.display = 'flex';

  const requestedVisible = requestedCharacterName
    ? visibleSheets.find((sheet) => sheet.characterName === requestedCharacterName)
    : null;
  const isActiveVisible = visibleSheets.some(sheet => sheet.index === previousIndex);
  activeSheetIndex = requestedVisible
    ? requestedVisible.index
    : (isActiveVisible ? previousIndex : visibleSheets[0].index);

  characterSelect.value = activeSheetIndex;

  loadSheetData();
  populatePlayerSelect();

  if (requestedVisible) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('characterName');
    window.history.replaceState({}, '', cleanUrl.toString());
  }
}

async function populatePlayerSelect() {
  const select = document.getElementById('playerNameSelect');
  if (!select) return;

  const currentSheet = characterSheets[activeSheetIndex];
  const players = await OBR.party.getPlayers();

  select.innerHTML = '';
  
  // Порожня опція
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '—';
  select.appendChild(empty);

  // Додавання гравців
  players.forEach(player => {
    const option = document.createElement('option');
    option.value = player.name;
    option.textContent = player.name;
    select.appendChild(option);
  });

  const assignedName = currentSheet?.playerName;

  if (!isGM) {
    // Для гравців - показати лише власне ім'я
    const ownOption = [...select.options].find(o => o.value === currentPlayerName);
    if (!ownOption) {
      const option = document.createElement('option');
      option.value = currentPlayerName;
      option.textContent = currentPlayerName;
      select.appendChild(option);
    }

    select.value = assignedName || currentPlayerName || '';
    select.setAttribute('disabled', 'true');
  } else {
    // Для GM - повний доступ
    select.value = assignedName || '';
    select.removeAttribute('disabled');
  }
}

// === НАЛАШТУВАННЯ ПОДІЙ ===
function connectInputsToSave() {
  const elements = getSheetInputElements();
  const numberInputIds = new Set([
    'armorClass', 'healthPoints', 'speed', 'initiative', 'health', 'maxHealthPoints',
    'strengthScore', 'dexterityScore', 'constitutionScore', 'proficiencyScore', 'wisdomScore', 'charismaScore',
    'maxWeight', 'currentWeight'
  ]);

  // Підключення основних полів з обробниками тільки на blur і Enter
  Object.entries(elements).forEach(([key, el]) => {
    if (el) {
      // Для текстових/селект полів зберігаємо також під час введення (через debounce)
      // щоб інші гравці бачили оновлення без довгої затримки до blur.
      if (key !== 'characterPhoto' && !numberInputIds.has(el.id)) {
        el.addEventListener('input', () => {
          const sheetIdx = activeSheetIndex;
          debouncedSaveSheetData(sheetIdx);
        });
      }
      el.addEventListener('blur', () => {
        const sheetIdx = activeSheetIndex;
        setTimeout(() => saveSheetData(sheetIdx), 50);
      });
      el.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
          const sheetIdx = activeSheetIndex;
          saveSheetData(sheetIdx);
        }
      });
    }
  });

  // Виключаємо textarea модальних вікон з автоматичного збереження
  const modalTextareas = [
    'modalCharacterClass', 'modalCharacterRace', 'modalBackground', 'modalAlignment',
    'modalAppearance', 'modalPersonalityTraits', 'modalFeatures', 'modalNotes',
    'modalBonds', 'modalLanguages'
  ];
  modalTextareas.forEach(textareaId => {
    const textarea = document.getElementById(textareaId);
    if (textarea) {
      textarea.removeEventListener('blur', () => setTimeout(() => saveSheetData(), 50));
      textarea.removeEventListener('keyup', (e) => {
        if (e.key === 'Enter') saveSheetData();
      });
    }
  });

  // Валідація для всіх числових полів
  const numberInputs = [
    'armorClass', 'healthPoints', 'speed', 'initiative', 'health', 'maxHealthPoints',
    'strengthScore', 'dexterityScore', 'constitutionScore', 'proficiencyScore', 'wisdomScore', 'charismaScore'
  ];
  numberInputs.forEach(inputId => {
    const input = document.getElementById(inputId);
    if (input) {
      input.addEventListener('input', function() {
        let value = parseInt(this.value);
        if (isNaN(value)) {
          this.value = '';
        } else if (value < 0) {
          this.value = 0;
        } else if (value > 99) {
          this.value = 99;
        }
        // Спеціальна обробка для maxHealthPoints - коригування health
        if (this.id === 'maxHealthPoints') {
          const healthInput = document.getElementById('health');
          if (healthInput && healthInput.value) {
            const currentHealth = parseInt(healthInput.value);
            const newMaxHealth = parseInt(this.value);
            if (!isNaN(currentHealth) && !isNaN(newMaxHealth) && currentHealth > newMaxHealth) {
              healthInput.value = newMaxHealth;
            }
          }
        }
      
        // Додаю перевірку для healthPoints
        if (this.id === 'healthPoints') {
          const maxHealthInput = document.getElementById('maxHealthPoints');
          if (maxHealthInput && maxHealthInput.value) {
            const maxHealth = parseInt(maxHealthInput.value);
            if (!isNaN(maxHealth) && value > maxHealth) {
              this.value = maxHealth;
            }
          }
        }

        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
      });
      input.addEventListener('blur', () => {
        const sheetIdx = activeSheetIndex;
        setTimeout(() => saveSheetData(sheetIdx), 50);
      });
      input.addEventListener('change', () => {
        const sheetIdx = activeSheetIndex;
        saveSheetData(sheetIdx);
      });
      input.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
          const sheetIdx = activeSheetIndex;
          saveSheetData(sheetIdx);
        }
      });
    }
  });

  // Підключення чекбоксів
  ['deathSavesSuccess1', 'deathSavesSuccess2', 'deathSavesSuccess3',
   'deathSavesFailure1', 'deathSavesFailure2', 'deathSavesFailure3',
   'inspirationCheckbox', 'advantageCheckbox', 'disadvantageCheckbox'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', function() {
      const sheetIdx = activeSheetIndex;
      debouncedSaveSheetData(sheetIdx);
      if (id.startsWith('deathSavesFailure')) updateDeathOverlay();
    });
  });

  // Підключення вибору персонажа
  const characterSelect = document.getElementById('characterSelect');
  if (characterSelect) {
    characterSelect.addEventListener('change', async () => {
      // Зберігаємо попередній персонаж перед переключенням
      const previousIndex = activeSheetIndex;
      if (previousIndex >= 0 && previousIndex < characterSheets.length) {
        await saveSheetData(previousIndex);
      }

      activeSheetIndex = parseInt(characterSelect.value, 10);

      // Завантажуємо свіжі дані з Supabase для вибраного персонажа
      const sheet = characterSheets[activeSheetIndex];
      if (sheet?.characterName) {
        try {
          const { data, error } = await supabase
            .from('character_sheets')
            .select('*')
            .eq('room_id', OBR.room.id)
            .eq('character_name', sheet.characterName)
            .order('updated_at', { ascending: false, nullsFirst: false })
            .limit(1);
          if (!error) {
            const row = Array.isArray(data) ? data[0] : null;
            if (row) applyFullSupabaseRowToSheet(characterSheets[activeSheetIndex], row);
          }
        } catch (_) {}
      }

      loadSheetData();
      populatePlayerSelect();
    });
  }

  // Підключення модифікаторів до характеристик
  ['strengthScore', 'dexterityScore', 'constitutionScore', 
  'proficiencyScore', 'wisdomScore', 'charismaScore'].forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('input', updateModifiers);
    }
  });

  // Автоматичний перерахунок швидких характеристик при втраті фокусу
  const speedInput = document.getElementById('speed');
  const maxHealthInput = document.getElementById('maxHealthPoints');
  const armorClassInput = document.getElementById('armorClass');

  if (speedInput) {
    speedInput.addEventListener('blur', () => {
      const sheetIdx = activeSheetIndex;
      updateSpeed();
      setTimeout(() => saveSheetData(sheetIdx), 50);
    });
  }
  if (maxHealthInput) {
    maxHealthInput.addEventListener('blur', () => {
      const sheetIdx = activeSheetIndex;
      updateMaxHealth();
      setTimeout(() => saveSheetData(sheetIdx), 50);
    });
  }
  if (armorClassInput) {
    armorClassInput.addEventListener('blur', () => {
      const sheetIdx = activeSheetIndex;
      updateArmorClass();
      setTimeout(() => saveSheetData(sheetIdx), 50);
    });
    // Також додаємо оновлення іконки AC на токені
    armorClassInput.addEventListener('input', () => {
      const newAC = parseInt(armorClassInput.value) || 10;
      updateTokenAC(newAC);
    });
  }

  // Оновлення імені персонажа в dropdown при зміні
  const characterNameInput = document.getElementById('characterName');
  if (characterNameInput) {
    characterNameInput.addEventListener('input', () => {
      updateCharacterNameInDropdown();
    });
    characterNameInput.addEventListener('blur', () => {
      updateCharacterNameInDropdown();
    });
  }
  
  // Оновлення здоров'я на токені та у базі при зміні
  const healthPointsInput = document.getElementById('healthPoints');
  if (healthPointsInput) {
    healthPointsInput.addEventListener('input', () => {
      const newHealth = parseInt(healthPointsInput.value) || 0;
      const healthInput = document.getElementById('health');
      const tempHealth = parseInt(healthInput?.value) || 0;
      updateTokenHealth(newHealth, tempHealth);
    });
    healthPointsInput.addEventListener('blur', () => {
      const sheetIdx = activeSheetIndex;
      setTimeout(() => saveSheetData(sheetIdx), 50);
    });
  }
  
  // Оновлення тимчасового здоров'я (поле "лікування") на токені та у базі при зміні
  const healthInput = document.getElementById('health');
  if (healthInput) {
    healthInput.addEventListener('input', () => {
      const healthPointsInput = document.getElementById('healthPoints');
      const newHealth = parseInt(healthPointsInput?.value) || 0;
      const tempHealth = parseInt(healthInput.value) || 0;
      updateTokenHealth(newHealth, tempHealth);
    });
    healthInput.addEventListener('blur', () => {
      const sheetIdx = activeSheetIndex;
      setTimeout(() => saveSheetData(sheetIdx), 50);
    });
  }
  
  // Оновлення ініціативи
  const initiativeInput = document.getElementById('initiative');
  if (initiativeInput) {
    initiativeInput.addEventListener('blur', () => {
      const sheetIdx = activeSheetIndex;
      setTimeout(() => saveSheetData(sheetIdx), 50);
    });
  }

  // Швидкі характеристики під фото повинні зберігатися одразу при зміні,
  // включно зі змінами через кнопки +/- які генерують лише input event.
  [
    'armorClass',
    'speed',
    'health',
    'initiative',
    'healthPoints',
    'maxHealthPoints',
  ].forEach((inputId) => {
    const input = document.getElementById(inputId);
    if (input) {
      input.addEventListener('input', () => {
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
      });
    }
  });
}

// Функція для оновлення імені персонажа в dropdown
async function updateCharacterNameInDropdown() {
  const characterSelect = document.getElementById('characterSelect');
  const characterNameInput = document.getElementById('characterName');
  
  if (characterSelect && characterNameInput) {
    const selectedOption = characterSelect.querySelector(`option[value="${activeSheetIndex}"]`);
    if (selectedOption) {
      const newName = characterNameInput.value.trim() || `Персонаж ${activeSheetIndex + 1}`;
      selectedOption.textContent = newName;
      
      // Оновлюємо підпис токена на карті, якщо він існує
      await updateTokenLabel(newName);
    }
  }
}

// Функція для оновлення підпису токена
async function updateTokenLabel(newName) {
  try {
    const currentSheet = characterSheets[activeSheetIndex];
    if (!currentSheet) return;
    
    // Шукаємо токен поточного персонажа за старим ім'ям або по playerName
    const allItems = await OBR.scene.items.getItems();
    const characterToken = allItems.find(item => 
      item.metadata?.characterSheet?.playerName === currentSheet.playerName &&
      item.layer === 'CHARACTER' &&
      item.metadata?.characterSheet
    );
    
    if (characterToken) {
      // Оновлюємо ім'я та підпис токена
      await OBR.scene.items.updateItems([characterToken.id], (items) => {
        items.forEach(item => {
          item.name = newName;
          item.text.plainText = newName;
          if (item.metadata?.characterSheet) {
            item.metadata.characterSheet.characterName = newName;
          }
        });
      });
      
      console.log('Підпис токена оновлено:', newName);
    }
  } catch (error) {
    console.error('Помилка при оновленні підпису токена:', error);
  }
}

// Функція для оновлення іконки здоров'я на токені
async function performTokenHealthSync(newHealth, tempHealth = null, forceReconcile = false) {
  try {
    const currentSheet = characterSheets[activeSheetIndex];
    if (!currentSheet) return;

    const sceneReady = await OBR.scene.isReady();
    if (!sceneReady) return;
    
    // Якщо tempHealth не передано, беремо з поточного персонажа (поле healing)
    if (tempHealth === null) {
      tempHealth = currentSheet.healing || 0;
    }

    newHealth = parseInt(newHealth, 10) || 0;
    tempHealth = parseInt(tempHealth, 10) || 0;

    const identity = `${currentSheet.characterName || ''}|${currentSheet.playerName || ''}`;
    const syncKey = `${identity}|${newHealth}|${tempHealth}`;
    const now = Date.now();
    const shouldReconcile = forceReconcile || (now - lastTokenHealthReconcileAt >= TOKEN_HEALTH_RECONCILE_INTERVAL_MS);

    // Якщо значення HP не змінювались і ще не час reconcile — пропускаємо звернення до API.
    if (!shouldReconcile && syncKey === lastTokenHealthSyncKey) {
      return;
    }
    
    // Формуємо текст з урахуванням тимчасового здоров'я
    const healthText = tempHealth > 0 
      ? `♥${newHealth}(${tempHealth})` 
      : `♥${newHealth}`;
    
    // Шукаємо токени поточного персонажа на активній сцені
    const allItems = await OBR.scene.items.getItems();
    const characterTokens = allItems.filter((item) => isTokenForSheet(item, currentSheet));

    if (characterTokens.length > 0) {
      const tokenIdsToUpdate = characterTokens
        .filter((token) => {
          const tokenHp = parseInt(token.metadata?.['com.owlbear.token']?.hp, 10) || 0;
          const sheetHp = parseInt(token.metadata?.characterSheet?.healthPoints, 10) || 0;
          const sheetTempHp = parseInt(token.metadata?.characterSheet?.healing, 10) || 0;
          return tokenHp !== newHealth || sheetHp !== newHealth || sheetTempHp !== tempHealth;
        })
        .map((token) => token.id);

      // Оновлюємо здоров'я в метаданих токенів персонажа лише коли є розбіжність.
      if (tokenIdsToUpdate.length > 0) {
        await OBR.scene.items.updateItems(tokenIdsToUpdate, (items) => {
        items.forEach(item => {
          if (item.metadata?.['com.owlbear.token']) {
            item.metadata['com.owlbear.token'].hp = newHealth;
          }
          if (item.metadata?.characterSheet) {
            item.metadata.characterSheet.healthPoints = newHealth;
            item.metadata.characterSheet.healing = tempHealth;
          }
        });
        });
      }

      const badgeIdsToUpdate = [];
      const badgesToCreate = [];

      characterTokens.forEach((token) => {
        const healthBadge = allItems.find((item) =>
          item.layer === 'ATTACHMENT' &&
          item.metadata?.healthBadge === true &&
          item.attachedTo === token.id
        );

        if (healthBadge) {
          if (healthBadge.text?.plainText !== healthText) {
            badgeIdsToUpdate.push(healthBadge.id);
          }
          return;
        }

        badgesToCreate.push(token);
      });

      if (badgeIdsToUpdate.length > 0) {
        await OBR.scene.items.updateItems(badgeIdsToUpdate, (items) => {
          items.forEach((item) => {
            item.text.plainText = healthText;
          });
        });
      }

      if (badgesToCreate.length > 0) {
        const newHealthBadges = [];

        for (const token of badgesToCreate) {
          const tokenBounds = await OBR.scene.items.getItemBounds([token.id]);
          let badgeBuilder = buildLabel()
            .position({
              x: tokenBounds.max.x - 10,
              y: tokenBounds.min.y + 10,
            })
            .layer('ATTACHMENT')
            .attachedTo(token.id)
            .plainText(healthText)
            .locked(true)
            .metadata({
              healthBadge: true,
              characterName: currentSheet.characterName,
              playerName: currentSheet.playerName,
            });

          if (token.createdUserId) {
            badgeBuilder = badgeBuilder.createdUserId(token.createdUserId);
          }

          newHealthBadges.push(badgeBuilder.build());
        }

        await OBR.scene.items.addItems(newHealthBadges);
        await OBR.scene.items.updateItems(newHealthBadges.map((b) => b.id), (items) => {
          items.forEach((item) => {
            item.scale = { x: 1, y: 1 };
            item.style.pointerWidth = 0;
            item.style.pointerHeight = 0;
            item.style.backgroundColor = '#000000';
            item.style.backgroundOpacity = 0.5;
            item.style.cornerRadius = 8;
            item.locked = true;
            item.disableHit = true;
            item.zIndex = 1000;
          });
        });
      }

      lastTokenHealthSyncKey = syncKey;
      if (shouldReconcile) {
        lastTokenHealthReconcileAt = now;
      }
    }
  } catch (error) {
    console.error('Помилка при оновленні іконки здоров\'я:', error);
  }
}

async function updateTokenHealth(newHealth, tempHealth = null, options = {}) {
  pendingTokenHealthSync = {
    newHealth: parseInt(newHealth, 10) || 0,
    tempHealth: tempHealth === null ? null : (parseInt(tempHealth, 10) || 0),
    forceReconcile: options?.forceReconcile === true,
  };

  if (tokenHealthSyncInFlight) return;

  tokenHealthSyncInFlight = true;
  try {
    while (pendingTokenHealthSync) {
      const request = pendingTokenHealthSync;
      pendingTokenHealthSync = null;
      await performTokenHealthSync(request.newHealth, request.tempHealth, request.forceReconcile);
    }
  } finally {
    tokenHealthSyncInFlight = false;
  }
}

// Функція для оновлення іконки класу броні на токені
async function updateTokenAC(newAC) {
  try {
    const currentSheet = characterSheets[activeSheetIndex];
    if (!currentSheet) return;

    const sceneReady = await OBR.scene.isReady();
    if (!sceneReady) return;

    newAC = parseInt(newAC, 10) || 10;
    const identity = `${currentSheet.characterName || ''}|${currentSheet.playerName || ''}`;
    const syncKey = `${identity}|${newAC}`;
    const now = Date.now();
    const shouldReconcile = (now - lastTokenACReconcileAt >= TOKEN_AC_RECONCILE_INTERVAL_MS);

    if (!shouldReconcile && syncKey === lastTokenACSyncKey) {
      return;
    }

    // Шукаємо токени поточного персонажа на активній сцені
    const allItems = await OBR.scene.items.getItems();
    const characterTokens = allItems.filter((item) => isTokenForSheet(item, currentSheet));

    if (characterTokens.length > 0) {
      const tokenIdsToUpdate = characterTokens
        .filter((token) => {
          const tokenAc = parseInt(token.metadata?.['com.owlbear.token']?.ac, 10) || 10;
          const sheetAc = parseInt(token.metadata?.characterSheet?.armorClass, 10) || 10;
          return tokenAc !== newAC || sheetAc !== newAC;
        })
        .map((token) => token.id);

      if (tokenIdsToUpdate.length > 0) {
        await OBR.scene.items.updateItems(tokenIdsToUpdate, (items) => {
        items.forEach(item => {
          if (item.metadata?.['com.owlbear.token']) {
            item.metadata['com.owlbear.token'].ac = newAC;
          }
          if (item.metadata?.characterSheet) {
            item.metadata.characterSheet.armorClass = newAC;
          }
        });
        });
      }

      const badgeIdsToUpdate = [];

      characterTokens.forEach((token) => {
        const acBadge = allItems.find((item) =>
          item.layer === 'ATTACHMENT' &&
          item.metadata?.acBadge === true &&
          item.attachedTo === token.id
        );

        if (acBadge && acBadge.text?.plainText !== `🛡${newAC}`) {
          badgeIdsToUpdate.push(acBadge.id);
        }
      });

      if (badgeIdsToUpdate.length > 0) {
        await OBR.scene.items.updateItems(badgeIdsToUpdate, (items) => {
          items.forEach((item) => {
            item.text.plainText = `🛡${newAC}`;
          });
        });
      }

      lastTokenACSyncKey = syncKey;
      if (shouldReconcile) {
        lastTokenACReconcileAt = now;
      }
    }
  } catch (error) {
    console.error('Помилка при оновленні іконки класу броні:', error);
  }
}

async function getOwnerUserIdByPlayerName(playerName) {
  const players = await OBR.party.getPlayers();

  if (playerName) {
    const owner = players.find((p) => p.name === playerName);
    if (owner) return owner.id;
  }

  // Якщо власник не заданий/не знайдений — fallback до GM.
  // У деяких кімнатах GM може не потрапляти в OBR.party.getPlayers(),
  // тому додатково перевіряємо поточного користувача.
  const gmFromParty = players.find((p) => p.role === 'GM');
  if (gmFromParty) return gmFromParty.id;

  const myRole = await OBR.player.getRole();
  if (myRole === 'GM') {
    const myId = await OBR.player.getId();
    return myId;
  }

  return null;
}

async function syncCharacterTokenOwner(sheet, previousPlayerName = null) {
  try {
    if (!sheet?.characterName) return;

    const ownerUserId = await getOwnerUserIdByPlayerName(sheet.playerName);
    if (!ownerUserId) return;

    const allItems = await OBR.scene.items.getItems();
    const characterToken = allItems.find((item) =>
      item.layer === 'CHARACTER' &&
      item.metadata?.characterSheet?.characterName === sheet.characterName &&
      item.metadata?.characterSheet
    );

    if (!characterToken) return;

    const normalizedImageUrl = resolveTokenImageUrlFromSheet(sheet);

    await OBR.scene.items.updateItems([characterToken.id], (items) => {
      items.forEach((item) => {
        item.createdUserId = ownerUserId;
        if (item.image) {
          item.image.url = normalizedImageUrl;
        }
        if (item.metadata?.characterSheet) {
          item.metadata.characterSheet.playerName = sheet.playerName || '';
          item.metadata.characterSheet.ownerUserId = ownerUserId;
          item.metadata.characterSheet.hideTokenStats = areTokenStatsHiddenForSheet(sheet);
        }
      });
    });

    // Перевіряємо, чи платформа реально прийняла зміну власника.
    // Якщо ні — виконуємо перевипуск токена з новим createdUserId.
    const refreshedItems = await OBR.scene.items.getItems();
    const updatedToken = refreshedItems.find((i) => i.id === characterToken.id);
    if (updatedToken && updatedToken.createdUserId !== ownerUserId) {
      await recreateCharacterTokenWithOwner(characterToken, sheet, ownerUserId);
      return;
    }

    const attachments = await OBR.scene.items.getItemAttachments([characterToken.id]);
    const badgeIds = attachments
      .filter((item) => item.metadata?.healthBadge === true || item.metadata?.acBadge === true)
      .map((item) => item.id);

    if (badgeIds.length > 0) {
      await OBR.scene.items.updateItems(badgeIds, (items) => {
        items.forEach((item) => {
          item.createdUserId = ownerUserId;
          if (item.metadata) {
            item.metadata.playerName = sheet.playerName || '';
          }
        });
      });
    }
  } catch (error) {
    console.error('Помилка при синхронізації власника токена:', error);
  }
}

async function recreateCharacterTokenWithOwner(characterToken, sheet, ownerUserId) {
  const attachments = await OBR.scene.items.getItemAttachments([characterToken.id]);
  const badgeItems = attachments.filter((item) => item.metadata?.healthBadge === true || item.metadata?.acBadge === true);
  const hideTokenStats = areTokenStatsHiddenForSheet(sheet);

  // Отримуємо актуальне зображення токена з таблиці персонажа замість зі сцени
  const actualTokenImageUrl = resolveTokenImageUrlFromSheet(sheet);
  const newImageData = {
    height: TOKEN_UPLOAD_RESOLUTION,
    width: TOKEN_UPLOAD_RESOLUTION,
    url: actualTokenImageUrl,
    mime: characterToken.image?.mime || 'image/png'
  };

  const tokenGrid = {
    ...(characterToken.grid || {}),
    dpi: TOKEN_UPLOAD_RESOLUTION,
    offset: characterToken.grid?.offset || { x: 0, y: 0 },
  };

  let tokenBuilder = buildImage(newImageData, tokenGrid)
    .position(characterToken.position)
    .rotation(characterToken.rotation)
    .scale({ x: 1, y: 1 })
    .visible(characterToken.visible)
    .locked(characterToken.locked)
    .zIndex(characterToken.zIndex)
    .layer(characterToken.layer)
    .name(characterToken.name)
    .text(characterToken.text)
    .textItemType(characterToken.textItemType)
    .metadata({
      ...characterToken.metadata,
      characterSheet: {
        ...(characterToken.metadata?.characterSheet || {}),
        playerName: sheet.playerName || '',
        hideTokenStats,
        ownerUserId: ownerUserId,
      },
    })
    .createdUserId(ownerUserId);

  if (characterToken.disableHit) tokenBuilder = tokenBuilder.disableHit(true);
  if (characterToken.disableAutoZIndex) tokenBuilder = tokenBuilder.disableAutoZIndex(true);

  const newToken = tokenBuilder.build();
  await OBR.scene.items.addItems([newToken]);

  const newBadges = badgeItems.map((badge) => {
    let badgeBuilder = buildLabel()
      .position(badge.position)
      .rotation(badge.rotation)
      .scale(badge.scale)
      .visible(!hideTokenStats)
      .locked(badge.locked)
      .zIndex(badge.zIndex)
      .layer('ATTACHMENT')
      .attachedTo(newToken.id)
      .name(badge.name)
      .text(badge.text)
      .style(badge.style)
      .metadata({
        ...badge.metadata,
        playerName: sheet.playerName || '',
      })
      .createdUserId(ownerUserId);

    if (badge.disableHit) badgeBuilder = badgeBuilder.disableHit(true);
    return badgeBuilder.build();
  });

  if (newBadges.length > 0) {
    await OBR.scene.items.addItems(newBadges);
  }

  await OBR.scene.items.deleteItems([characterToken.id, ...badgeItems.map((i) => i.id)]);
}

async function applyTokenStatsVisibilityForCharacter(characterName, hideTokenStats) {
  if (!characterName) return;

  const allItems = await OBR.scene.items.getItems();
  const tokenIds = allItems
    .filter((item) =>
      item.layer === 'CHARACTER' &&
      item.metadata?.characterSheet?.characterName === characterName
    )
    .map((item) => item.id);

  if (tokenIds.length > 0) {
    await OBR.scene.items.updateItems(tokenIds, (items) => {
      items.forEach((item) => {
        if (item.metadata?.characterSheet) {
          item.metadata.characterSheet.hideTokenStats = hideTokenStats;
        }
      });
    });
  }

  const badgeIds = allItems
    .filter((item) =>
      item.layer === 'ATTACHMENT' &&
      tokenIds.includes(item.attachedTo) &&
      (item.metadata?.healthBadge === true || item.metadata?.acBadge === true)
    )
    .map((item) => item.id);

  if (badgeIds.length > 0) {
    await OBR.scene.items.updateItems(badgeIds, (items) => {
      items.forEach((item) => {
        item.visible = !hideTokenStats;
      });
    });
  }
}


function setupStatButtons() {
  document.querySelectorAll('.stat-input-wrapper').forEach(wrapper => {
    const input = wrapper.querySelector('input');
    const minus = wrapper.querySelector('.stat-btn.minus');
    const plus = wrapper.querySelector('.stat-btn.plus');

    minus?.addEventListener('click', () => {
      input.stepDown();
      input.dispatchEvent(new Event('input'));
    });

    plus?.addEventListener('click', () => {
      input.stepUp();
      input.dispatchEvent(new Event('input'));
    });
  });
}

function setupCharacterButtons() {
  const addBtn = document.getElementById('addCharacterButton');
  const delBtn = document.getElementById('deleteCharacterButton');
  const createTokenBtn = document.getElementById('createTokenButton');
  const toggleTokenStatsBtn = document.getElementById('toggleTokenStatsButton');
  const gmPanelBtn = document.getElementById('openGmPanelButton');

  // Приховування кнопок для не-GM
  if (!isGM) {
    [addBtn, delBtn, gmPanelBtn].forEach(btn => {
      if (btn) {
        btn.style.display = 'none';
      }
    });
    // Кнопка створення токена доступна всім
    if (createTokenBtn) {
      createTokenBtn.style.display = 'flex';
    }
    if (toggleTokenStatsBtn) {
      toggleTokenStatsBtn.style.display = 'flex';
    }
  } else {
    // Показуємо всі кнопки для GM
    [addBtn, delBtn, createTokenBtn, toggleTokenStatsBtn, gmPanelBtn].forEach(btn => {
      if (btn) {
        btn.style.display = 'flex';
      }
    });
  }

  if (toggleTokenStatsBtn) {
    updateTokenStatsToggleButtonState(characterSheets[activeSheetIndex]);
    toggleTokenStatsBtn.addEventListener('click', async () => {
      try {
        const currentSheet = characterSheets[activeSheetIndex];
        if (!currentSheet) return;

        const nextHiddenState = !areTokenStatsHiddenForSheet(currentSheet);
        currentSheet.hideTokenStats = nextHiddenState;

        await applyTokenStatsVisibilityForCharacter(currentSheet.characterName, nextHiddenState);
        await saveSheetData(activeSheetIndex);
        updateTokenStatsToggleButtonState(currentSheet);
      } catch (error) {
        console.error('Помилка при перемиканні видимості статів токена:', error);
      }
    });
  }

  if (gmPanelBtn && isGM) {
    gmPanelBtn.addEventListener('click', () => {
      const targetUrl = new URL('gm-panel.html', window.location.href);
      targetUrl.search = window.location.search;
      targetUrl.hash = window.location.hash;
      window.location.href = targetUrl.toString();
    });
  }

  // Додавання персонажа
  if (addBtn && isGM) {
    addBtn.addEventListener('click', async () => {
      try {
        const characterName = getNextCharacterName(characterSheets);
        const newSheet = {
          characterName,
          playerName: '',
          characterClassLevel: '',
          background: '',
          characterRace: '',
          alignment: '',
          strengthScore: '10',
          dexterityScore: '10',
          constitutionScore: '10',
          proficiencyScore: '10',
          wisdomScore: '10',
          charismaScore: '10',
          healthPoints: '',
          maxHealthPoints: '',
          healing: '',
          armorClass: '',
          initiative: '',
          speed: '',
          proficienciesAndLanguages: '',
          alliesAndOrganizations: '',
          characterHistory: '',
          additionalFeatures: '',
          characterPhoto: '',
          tokenPhoto: '',
          maxWeight: '',
          currentWeight: '',
          deathSavesSuccess: [false, false, false],
          deathSavesFailure: [false, false, false],
          inspiration: false,
          advantage: false,
          disadvantage: false,
          hideTokenStats: false,
        };

        // Зберігаємо в Supabase
        await saveSheetToSupabase(newSheet);

        // Додаємо до локального списку
        characterSheets = dedupeSheetsByCharacterName([...characterSheets, newSheet]);
        activeSheetIndex = Math.max(0, characterSheets.findIndex((sheet) => sheet.characterName === characterName));

        // Оновлюємо OBR реєстр
        await updateOBRRegistry();

        // Оновлюємо UI
        await refreshDropdownOnly();
        loadSheetData();
        populatePlayerSelect();
      } catch (error) {
        console.error('Помилка при створенні персонажа:', error);
      }
    });
  }

  // Видалення персонажа
  if (delBtn && isGM) {
    delBtn.addEventListener('click', async () => {
      try {
        if (!confirm('Ви дійсно хочете видалити цього персонажа?')) return;

        const sheetToDelete = characterSheets[activeSheetIndex];
        if (!sheetToDelete) return;

        // Видаляємо з Supabase
        if (sheetToDelete.characterName) {
          const { error } = await supabase
            .from('character_sheets')
            .delete()
            .eq('room_id', OBR.room.id)
            .eq('character_name', sheetToDelete.characterName);
          if (error) console.error('[Supabase] Помилка видалення:', error);
        }

        // Видаляємо з локального списку
        characterSheets = characterSheets.filter((_, index) => index !== activeSheetIndex);
        if (characterSheets.length === 0) {
          activeSheetIndex = 0;
        } else {
          activeSheetIndex = Math.min(activeSheetIndex, characterSheets.length - 1);
        }

        // Оновлюємо OBR реєстр
        await updateOBRRegistry();

        // Оновлюємо UI
        await refreshDropdownOnly();
        loadSheetData();
        populatePlayerSelect();
      } catch (error) {
        console.error('Помилка при видаленні персонажа:', error);
      }
    });
  }

  // Створення токена персонажа на карті (доступно всім гравцям)
  if (createTokenBtn) {
    createTokenBtn.addEventListener('click', async () => {
      try {
        let currentSheet = characterSheets[activeSheetIndex];
        if (!currentSheet) {
          alert('Немає активного персонажа для створення токена');
          return;
        }

        // Перезавантажуємо актуальні дані персонажа з бази даних перед створенням токена
        // Це забезпечує що токен матиме свіжу URL зображення при перекидді на нову сцену
        try {
          const roomId = OBR.room.id;
          const refreshedRows = await loadAllCharactersFromSupabase(roomId);
          const refreshedRow = refreshedRows?.find(row => row.character_name === currentSheet.characterName);
          if (refreshedRow) {
            currentSheet = sheetFromSupabaseRow(refreshedRow);
          }
        } catch (e) {
          console.warn('[Token Create] Не вдалося перезавантажити персонажа з Supabase:', e);
          // Продовжуємо з локальним листом якщо Supabase недоступна
        }

        // Перевіряємо чи вже існує токен для цього персонажа
        const allItems = await OBR.scene.items.getItems();
        const existingToken = allItems.find(item => 
          item.layer === 'CHARACTER' && 
          item.metadata?.characterSheet?.characterName === currentSheet.characterName
        );

        if (existingToken) {
          // Якщо токен вже існує, синхронізуємо його власника з поточним листом
          await syncCharacterTokenOwner(currentSheet);
          // Якщо токен вже існує, фокусуємо камеру на ньому
          const bounds = await OBR.scene.items.getItemBounds([existingToken.id]);
          await OBR.viewport.animateToBounds(bounds);
          alert(`Токен персонажа "${currentSheet.characterName}" вже існує на карті.`);
          return;
        }

        // Отримуємо ID власника персонажа (якщо не задано — буде GM)
        const ownerUserId = await getOwnerUserIdByPlayerName(currentSheet.playerName);

        // Отримуємо центр поточного viewport
        const width = await OBR.viewport.getWidth();
        const height = await OBR.viewport.getHeight();
        const scale = await OBR.viewport.getScale();
        
        // Створюємо токен в центрі екрану (0, 0 - це центр viewport)
        const center = { x: 0, y: 0 };

        // Використовуємо фото токена/персонажа з Uploadcare, якщо воно є.
        const imageUrl = resolveTokenImageUrlFromSheet(currentSheet);
        const hideTokenStats = areTokenStatsHiddenForSheet(currentSheet);

        // Створюємо токен персонажа (займає 1 клітинку на карті)
        let tokenBuilder = buildImage(
          {
            height: TOKEN_UPLOAD_RESOLUTION,
            width: TOKEN_UPLOAD_RESOLUTION,
            url: imageUrl,
            mime: 'image/png'
          },
          {
            dpi: TOKEN_UPLOAD_RESOLUTION,
            offset: { x: 0, y: 0 }
          }
        )
          .position(center)
          .layer('CHARACTER')
          .name(currentSheet.characterName || 'Персонаж')
          .plainText(currentSheet.characterName || 'Персонаж')  // Додаємо текст з іменем
          .textItemType('LABEL')  // Текст як лейбл знизу токена
          .metadata({
            'com.owlbear.token': {
              hp: parseInt(currentSheet.healthPoints) || 0,
              maxHp: parseInt(currentSheet.maxHealthPoints) || 0,
              ac: parseInt(currentSheet.armorClass) || 5
            },
            characterSheet: {
              characterName: currentSheet.characterName,
              playerName: currentSheet.playerName,
              healthPoints: currentSheet.healthPoints,
              maxHealthPoints: currentSheet.maxHealthPoints,
              healing: currentSheet.healing,
              armorClass: currentSheet.armorClass,
              hideTokenStats,
              ownerUserId: ownerUserId
            }
          });

        if (ownerUserId) {
          tokenBuilder = tokenBuilder.createdUserId(ownerUserId);
        }

        const tokenItem = tokenBuilder.build();
        
        // Додаємо токен на сцену спочатку, щоб отримати його bounds
        await OBR.scene.items.addItems([tokenItem]);
        
        // Отримуємо bounds токена для точного позиціонування
        const tokenBounds = await OBR.scene.items.getItemBounds([tokenItem.id]);
        
        // Створюємо іконку здоров'я (attachment) - справа зверху токена
        const tempHP = currentSheet.healing || 0;
        console.log('Тимчасове здоров\'я при створенні токена:', tempHP, 'currentSheet.healing:', currentSheet.healing);
        console.log('Основне здоров\'я при створенні токена:', currentSheet.healthPoints);
        const healthText = tempHP > 0 
          ? `♥${currentSheet.healthPoints || 0}(${tempHP})` 
          : `♥${currentSheet.healthPoints || 0}`;
        console.log('Текст на токені:', healthText);
        
        let healthBadgeBuilder = buildLabel()
          .position({ 
            x: tokenBounds.max.x - 10,  // Справа, трохи зміщено вліво від краю
            y: tokenBounds.min.y + 10   // Зверху, трохи зміщено вниз від краю
          })
          .layer('ATTACHMENT')
          .attachedTo(tokenItem.id)
          .visible(!hideTokenStats)
          .plainText(healthText)
          .locked(true)  // Блокуємо переміщення та редагування
          .metadata({
            healthBadge: true,
            characterName: currentSheet.characterName,
            playerName: currentSheet.playerName
          });

        // Створюємо іконку класу броні (attachment) - зліва зверху токена
        let acBadgeBuilder = buildLabel()
          .position({ 
            x: tokenBounds.min.x + 10,  // Зліва, трохи зміщено вправо від краю
            y: tokenBounds.min.y + 10   // Зверху, трохи зміщено вниз від краю
          })
          .layer('ATTACHMENT')
          .attachedTo(tokenItem.id)
          .visible(!hideTokenStats)
          .plainText(`🛡${currentSheet.armorClass || 5}`)
          .locked(true)  // Блокуємо переміщення та редагування
          .metadata({
            acBadge: true,
            characterName: currentSheet.characterName,
            playerName: currentSheet.playerName
          });

        if (ownerUserId) {
          healthBadgeBuilder = healthBadgeBuilder.createdUserId(ownerUserId);
          acBadgeBuilder = acBadgeBuilder.createdUserId(ownerUserId);
        }

        const healthBadge = healthBadgeBuilder.build();
        const acBadge = acBadgeBuilder.build();

        // Додаємо іконки здоров'я та класу броні на сцену
        await OBR.scene.items.addItems([healthBadge, acBadge]);
        
        // Застосовуємо стилі до іконки здоров'я
        await OBR.scene.items.updateItems([healthBadge.id], (items) => {
          items.forEach(item => {
            item.scale = { x: 1, y: 1 };  // Фіксований масштаб
            item.style.pointerWidth = 0;
            item.style.pointerHeight = 0;
            item.style.backgroundColor = '#000000';  // Чорний фон
            item.style.backgroundOpacity = 0.5;  // Напівпрозорий (скляний ефект)
            item.style.cornerRadius = 8;  // Закруглені кути як в листі
            item.locked = true;  // Блокуємо
            item.disableHit = true;  // Вимикаємо взаємодію
            item.zIndex = 1000;  // Високий z-index щоб бути поверх
          });
        });
        
        // Застосовуємо стилі до іконки класу броні
        await OBR.scene.items.updateItems([acBadge.id], (items) => {
          items.forEach(item => {
            item.scale = { x: 1, y: 1 };  // Фіксований масштаб
            item.style.pointerWidth = 0;
            item.style.pointerHeight = 0;
            item.style.backgroundColor = '#000000';  // Чорний фон
            item.style.backgroundOpacity = 0.5;  // Напівпрозорий (скляний ефект)
            item.style.cornerRadius = 8;  // Закруглені кути як в листі
            item.locked = true;  // Блокуємо
            item.disableHit = true;  // Вимикаємо взаємодію
            item.zIndex = 1000;  // Високий z-index щоб бути поверх
          });
        });
        
        console.log('Токен персонажа створено:', currentSheet.characterName);
        
        // Фокусуємо камеру на новостворений токен
        const bounds = await OBR.scene.items.getItemBounds([tokenItem.id]);
        await OBR.viewport.animateToBounds(bounds);
        
        // Показуємо повідомлення користувачу
        if (currentSheet.characterName) {
          alert(`Токен персонажа "${currentSheet.characterName}" створено на карті!`);
        } else {
          alert('Токен персонажа створено на карті!');
        }
        
      } catch (error) {
        console.error('Помилка при створенні токена персонажа:', error);
        console.error('Детальна інформація:', JSON.stringify(error, null, 2));
        alert('Помилка при створенні токена. Перевірте консоль для деталей.');
      }
    });
  }
}

function setupPhotoButtons() {
  const photoBtn = document.getElementById('replacePhotoButton');
  const deletePhotoBtn = document.getElementById('deletePhotoButton');
  const photoInput = document.getElementById('photoFileInput');
  const photoImg = document.getElementById('characterPhotoImg');
  const placeholder = document.getElementById('photoPlaceholder');

  if (!photoBtn || !photoInput || !photoImg || !deletePhotoBtn) return;

  // Завантаження фото через кнопку
  photoBtn.addEventListener('click', () => {
    photoInput.value = '';
    photoInput.click();
  });

  // Завантаження фото через клік на заглушку
  if (placeholder) {
    placeholder.addEventListener('click', () => {
      photoInput.value = '';
      photoInput.click();
    });
  }

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) return;

    try {
      const sheet = characterSheets[activeSheetIndex];
      const charName = sheet?.characterName || 'unknown';
      const charHash = hashCharacterName(charName);
      const roomId = OBR.room.id;
      const ext = file.name.split('.').pop() || 'jpg';
      const storagePath = `${roomId}/${charHash}/character.${ext}`;

      const imageUrl = await uploadPhotoToSupabase(file, storagePath);

      if (imageUrl) {
        photoImg.src = imageUrl;
        photoImg.style.display = 'block';
        const placeholder = document.getElementById('photoPlaceholder');
        if (placeholder) placeholder.style.display = 'none';

        if (characterSheets[activeSheetIndex]) {
          characterSheets[activeSheetIndex].characterPhoto = imageUrl;
          const sheetIdx = activeSheetIndex;
          await saveSheetData(sheetIdx);
        }
      } else {
        alert('Помилка при завантаженні фото.');
      }
    } catch (err) {
      console.error('Photo upload error:', err);
      alert('Помилка завантаження фото.');
    }
  });

  // Видалення фото
  deletePhotoBtn.addEventListener('click', async () => {
    if (!confirm('Ви дійсно хочете видалити фото персонажа?')) return;

    if (characterSheets[activeSheetIndex]) {
      characterSheets[activeSheetIndex].characterPhoto = '';
      photoImg.src = '';
      photoImg.style.display = 'none';
      const placeholder = document.getElementById('photoPlaceholder');
      if (placeholder) placeholder.style.display = 'flex';
      const sheetIdx = activeSheetIndex;
      await saveSheetData(sheetIdx);
    }
  });

  // Оновлення фото токена
  const updateTokenPhotoBtn = document.getElementById('updateTokenPhotoButton');
  const tokenPhotoInput = document.getElementById('tokenPhotoFileInput');
  
  if (updateTokenPhotoBtn && tokenPhotoInput) {
    // Відкриваємо провідник при натисканні на кнопку
    updateTokenPhotoBtn.addEventListener('click', () => {
      tokenPhotoInput.value = '';
      tokenPhotoInput.click();
    });

    // Обробка вибору файлу
    tokenPhotoInput.addEventListener('change', async () => {
      const file = tokenPhotoInput.files[0];
      if (!file) return;

      try {
        const currentSheet = characterSheets[activeSheetIndex];
        if (!currentSheet) {
          alert('Немає активного персонажа');
          return;
        }

        // Обрізаємо фото до кругу 128x128
        const croppedBlob = await cropImageToCircle(file, TOKEN_UPLOAD_RESOLUTION, TOKEN_UPLOAD_RESOLUTION);
        if (!croppedBlob) {
          alert('Помилка при обробці зображення');
          return;
        }

        // Завантажуємо обрізане фото в Supabase Storage
        const charName = currentSheet.characterName || 'unknown';
        const charHash = hashCharacterName(charName);
        const roomId = OBR.room.id;
        const tokenFile = new File([croppedBlob], 'token.png', { type: 'image/png' });
        const storagePath = `${roomId}/${charHash}/token.png`;

        const tokenImageUrl = await uploadPhotoToSupabase(tokenFile, storagePath);

        if (!tokenImageUrl) {
          alert('Помилка при завантаженні фото токена.');
          return;
        }

        // Шукаємо токен цього персонажа
        const allItems = await OBR.scene.items.getItems();
        const tokenToUpdate = allItems.find(item => 
          item.layer === 'CHARACTER' && 
          item.metadata?.characterSheet?.characterName === currentSheet.characterName &&
          item.metadata?.characterSheet?.playerName === currentSheet.playerName
        );

        if (!tokenToUpdate) {
          alert('Токен персонажа не знайдено на карті. Спочатку створіть токен.');
          return;
        }

        // Оновлюємо URL зображення токена
        await OBR.scene.items.updateItems([tokenToUpdate.id], items => {
          items.forEach(item => {
            if (item.image) {
              item.image.url = tokenImageUrl;
            }
          });
        });

        // Зберігаємо URL фото токена в метаданих персонажа
        if (characterSheets[activeSheetIndex]) {
          characterSheets[activeSheetIndex].tokenPhoto = tokenImageUrl;
          const sheetIdx = activeSheetIndex;
          await saveSheetData(sheetIdx);
        }

        alert('Фото токена оновлено!');
      } catch (error) {
        console.error('Помилка при оновленні фото токена:', error);
        alert('Помилка при оновленні фото токена');
      }
    });
  }
}

// Функція для обрізки зображення до кругу
async function cropImageToCircle(file, width, height) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const img = new Image();
      
      img.onload = () => {
        // Використовуємо вищу роздільність для кращої якості (512x512, потім зменшимо до 128x128)
        const highResSize = 512;
        const canvas = document.createElement('canvas');
        canvas.width = highResSize;
        canvas.height = highResSize;
        const ctx = canvas.getContext('2d', { alpha: true });
        
        // Покращені налаштування рендерингу
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        // Визначаємо розміри для обрізки (квадрат по меншій стороні)
        const size = Math.min(img.width, img.height);
        const x = (img.width - size) / 2;
        const y = (img.height - size) / 2;
        
        // Малюємо круглу маску
        ctx.beginPath();
        ctx.arc(highResSize / 2, highResSize / 2, highResSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        
        // Малюємо зображення в маску з високою якістю
        ctx.drawImage(
          img,
          x, y, size, size,  // Вихідна область (квадрат по центру)
          0, 0, highResSize, highResSize // Цільова область (512x512)
        );
        
        // Тепер зменшуємо до потрібного розміру для кращої якості
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = width;
        finalCanvas.height = height;
        const finalCtx = finalCanvas.getContext('2d', { alpha: true });
        
        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = 'high';
        
        finalCtx.drawImage(canvas, 0, 0, highResSize, highResSize, 0, 0, width, height);
        
        // Конвертуємо canvas в Blob з максимальною якістю
        finalCanvas.toBlob((blob) => {
          resolve(blob);
        }, 'image/png', 1.0);
      };
      
      img.onerror = () => reject(new Error('Не вдалося завантажити зображення'));
      img.src = e.target.result;
    };
    
    reader.onerror = () => reject(new Error('Не вдалося прочитати файл'));
    reader.readAsDataURL(file);
  });
}

function updateDeathOverlay() {
  const success1 = document.getElementById('deathSavesSuccess1')?.checked;
  const success2 = document.getElementById('deathSavesSuccess2')?.checked;
  const success3 = document.getElementById('deathSavesSuccess3')?.checked;
  const fail1 = document.getElementById('deathSavesFailure1')?.checked;
  const fail2 = document.getElementById('deathSavesFailure2')?.checked;
  const fail3 = document.getElementById('deathSavesFailure3')?.checked;
  const photoContainer = document.querySelector('.photo-container');
  let overlay = document.getElementById('deathOverlay');

  // Перевіряємо на три успіхи
  if (success1 && success2 && success3) {
    // Створюємо ефект лікування
    const healingOverlay = document.createElement('div');
    healingOverlay.id = 'healingOverlay';
    healingOverlay.style.position = 'absolute';
    healingOverlay.style.top = '0';
    healingOverlay.style.left = '0';
    healingOverlay.style.width = '100%';
    healingOverlay.style.height = '100%';
    healingOverlay.style.display = 'flex';
    healingOverlay.style.alignItems = 'center';
    healingOverlay.style.justifyContent = 'center';
    healingOverlay.style.pointerEvents = 'none';
    healingOverlay.style.backgroundColor = 'rgba(0, 255, 0, 0.2)';
    healingOverlay.style.animation = 'healingPulse 5s ease-out';
    healingOverlay.innerHTML = `<i class="fas fa-heart" style="font-size: 15em; color: #00ff00; opacity: 0.5;"></i>`;
    photoContainer.appendChild(healingOverlay);

    // Видаляємо ефект через 5 секунд
    setTimeout(() => {
      healingOverlay.remove();
    }, 5000);
  }

  // Перевіряємо на три невдачі
  if (fail1 && fail2 && fail3) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'deathOverlay';
      overlay.style.position = 'absolute';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.pointerEvents = 'none';
      overlay.style.backgroundColor = 'rgba(255, 0, 0, 0.2)';
      overlay.innerHTML = `<i class="fas fa-ghost" style="font-size: 15em; color: red; opacity: 0.5;"></i>`;
      photoContainer.appendChild(overlay);
    }
  } else {
    if (overlay) overlay.remove();
  }
}

// Перевіряє чи гравець має персонажа і показує/приховує UI
async function checkCharacterAndRedirect() {
  try {
    const visibleSheets = characterSheets
      .filter(sheet => isPlayableSheet(sheet) && (isGM || sheet.playerName === currentPlayerName));

    const waitingBlock = document.getElementById('waitingBlock');
    const mainContent = document.getElementById('mainContent');

    if (!isGM && visibleSheets.length === 0) {
      if (waitingBlock) waitingBlock.style.display = 'flex';
      if (mainContent) mainContent.style.display = 'none';
    } else {
      if (waitingBlock) waitingBlock.style.display = 'none';
      if (mainContent) mainContent.style.display = 'flex';
    }
  } catch (error) {
    console.error('Помилка при перевірці стану персонажа:', error);
  }
}

// Модифікуємо функцію setupInterface
function setupInterface() {
    // Захист від повторного виклику
    if (window.interfaceSetup) {
        return;
    }
    window.interfaceSetup = true;
    
    setupCharacterButtons();
    
    setupPhotoButtons();
    
    // Ініціалізуємо заглушку фото
    const photoImg = document.getElementById('characterPhotoImg');
    const placeholder = document.getElementById('photoPlaceholder');
    if (photoImg && placeholder) {
        photoImg.style.display = 'none';
        placeholder.style.display = 'flex';
    }
    
    setupStatButtons();
    
    setupStatEditButtons();
    
    // setupModifierButtons(); // Видаляємо цей виклик
    
    updateCharacterDropdown();
    
    connectInputsToSave();

    // Спеціальне налаштування для поля maxHealthPoints
    const maxHealthPointsInput = document.getElementById('maxHealthPoints');
    if (maxHealthPointsInput) {
        maxHealthPointsInput.style.pointerEvents = 'auto';
        maxHealthPointsInput.style.position = 'relative';
        maxHealthPointsInput.style.zIndex = '10';
    }

    // Підписка на зміни реєстру в OBR (додавання/видалення персонажів ДМ-ом)
    OBR.room.onMetadataChange(async (metadata) => {
      const registry = metadata[DARQIE_REGISTRY_KEY] || [];

      if (isAnyEditingActive()) return;

      // Змінилась кількість персонажів — перезавантажуємо список із Supabase
      if (registry.length !== characterSheets.length) {
        await updateCharacterDropdown();
        return;
      }

      // Перевіряємо чи змінились призначення гравців
      const assignmentChanged = registry.some((entry, i) => {
        const local = characterSheets[i];
        return local && local.playerName !== entry.playerName;
      });

      if (assignmentChanged) {
        registry.forEach((entry, i) => {
          if (characterSheets[i]) characterSheets[i].playerName = entry.playerName;
        });
        await refreshDropdownOnly();
      }

      await checkCharacterAndRedirect();
    });

    // Додаємо підписку на повідомлення про призначення персонажа
    OBR.broadcast.onMessage("character-assignment", async (data) => {
        if (data.playerName === currentPlayerName) {
            await checkCharacterAndRedirect();
        }
    });

    // Додаємо підписку на повідомлення про навички
    if (!window.__skillMessageHandler) {
      window.__skillMessageHandler = true;
    OBR.broadcast.onMessage("skill-message", async (data) => {
        const skillData = data.data || data;
        if (skillData && skillData.type === 'skill-info') {
              // Додаємо невелику затримку для уникнення конфліктів
              setTimeout(async () => {
            await showSkillNotification(skillData.skillName, skillData.skillDescription, skillData.playerName);
              }, 500);
        }
    });
    }
    
    // Додаємо затримку для підключення обробників модифікаторів
    setTimeout(() => {
      setupModifierButtons();
    }, 100);
}

// === ІНІЦІАЛІЗАЦІЯ HELP-БЛОКУ ===
document.addEventListener('DOMContentLoaded', function() {
  const helpIcon = document.querySelector('.help-block i');
  const mainContent = document.getElementById('mainContent');
  const closeModal = document.querySelector('.close-modal');
  function closeHelp() {
    if (mainContent) mainContent.classList.remove('darken-bg');
  }
  if (helpIcon && mainContent) {
    helpIcon.addEventListener('click', function() {
      mainContent.classList.add('darken-bg');
    });
  }
  if (closeModal) {
    closeModal.addEventListener('click', closeHelp);
  }
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeHelp();
  });
});

// === ІНІЦІАЛІЗАЦІЯ ===
OBR.onReady(async () => {
    // Очищаємо старий запит
    await clearOldRollRequest();

    // Зберігаємо roomId локально, щоб GM-панель могла працювати навіть без OBR SDK.
    try {
      if (OBR.room?.id) {
        localStorage.setItem('darqie.lastRoomId', OBR.room.id);
      }
    } catch (_) {}
    
    // Отримання інформації про гравця
    currentPlayerName = await OBR.player.getName();
    isGM = (await OBR.player.getRole()) === 'GM';

    // Для GM стартовим екраном має бути Панель GM.
    // Дозволяємо залишитися на сторінці персонажів лише при явному прапорці gmView=characters.
    const currentUrl = new URL(window.location.href);
    const requestedCharactersView = currentUrl.searchParams.get('gmView') === 'characters';
    if (isGM && !requestedCharactersView) {
      const targetUrl = new URL('gm-panel.html', currentUrl.href);
      targetUrl.search = currentUrl.search;
      targetUrl.hash = currentUrl.hash;
      window.location.href = targetUrl.toString();
      return;
    }

    // Якщо GM відкрив сторінку персонажів через кнопку "Гравці", прибираємо технічний прапорець з URL.
    if (requestedCharactersView) {
      currentUrl.searchParams.delete('gmView');
      window.history.replaceState({}, '', currentUrl.toString());
    }

    // Виправляємо старі токени, які посилаються на localhost і ламаються у гравців.
    await normalizeLegacyTokenImageUrls();

    // Мігруємо старі дані з OBR room metadata до Supabase (якщо потрібно)
    await migrateOBRDataIfNeeded(OBR.room.id);

    // Налаштування інтерфейсу
    setupInterface();

    // Підписка на Supabase Realtime (синхронізація між гравцями)
    await setupSupabaseRealtime(OBR.room.id);
    setupSupabasePollingFallback(OBR.room.id);

    // Перезавантаження даних при зміні сцени
    OBR.scene.onReadyChange(async (isReady) => {
      if (isReady) {
        // Сцена змінилась — перезавантажуємо список персонажів із Supabase
        await updateCharacterDropdown();
      }
    });

    // Підписка на зміни в партії
    OBR.party.onChange(() => {
        populatePlayerSelect();
    });

    // Періодична перевірка видимості (без перезавантаження даних)
    setInterval(async () => {
        await checkCharacterAndRedirect();

        const combatValues = getActiveSheetCombatValues();
        if (combatValues) {
          await updateTokenHealth(combatValues.hp, combatValues.tempHp);
          await updateTokenAC(combatValues.ac);
        }
    }, 4000);

    // Глобальний обробник показу поповера навичок від інших гравців
    if (!window.__skillPopoverBroadcastHandler) {
      window.__skillPopoverBroadcastHandler = true;
      OBR.broadcast.onMessage('skill-popover', async (data) => {
        try {
          const msg = data?.data || data;
          if (!msg || msg.type !== 'open-skill-popover') return;
          const myId = await OBR.player.getConnectionId();
          if (msg.senderId === myId) return; // не показуємо відправнику
          await openSkillPopoverFromBroadcast(msg.name, msg.desc, msg.initiatorName || msg.playerName || '');
        } catch (_) {}
      });
    }
});

// Функція для отримання поточного персонажа (використовує локальний кеш)
async function getCurrentCharacter() {
  const selectedValue = document.getElementById('characterSelect')?.value;
  if (selectedValue === undefined || selectedValue === null || selectedValue === '') return null;
  return characterSheets[parseInt(selectedValue, 10)] || null;
}

// Функція для оновлення інформації в модальному вікні
function updateModalInfo(character) {
  if (!character) return;
  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) {
      el.value = value;
      el.style.height = 'auto';
      el.style.height = (el.scrollHeight) + 'px';
    }
  };
  setValue('modalCharacterClass', character.characterClassLevel || '');
  setValue('modalCharacterRace', character.characterRace || '');
  setValue('modalBackground', character.background || '');
  setValue('modalAlignment', character.alignment || '');
  setValue('modalAppearance', character.appearance || '');
  setValue('modalLanguages', character.languages || '');
  setValue('modalBonds', character.bonds || '');
  setValue('modalPersonalityTraits', character.personalityTraits || '');
  setValue('modalFeatures', character.features || '');
  setValue('modalNotes', character.notes || '');

  // Додаю автозміну висоти для всіх textarea модалки
  setTimeout(() => {
    document.querySelectorAll('.modal-body .skill-desc-textarea').forEach(ta => {
      ta.style.height = 'auto';
      ta.style.height = (ta.scrollHeight) + 'px';
    });
  }, 0);
}

// Функція для відкриття модального вікна
async function openCharacterInfoModal() {
  const modal = document.getElementById('characterInfoModal');
  const currentCharacter = await getCurrentCharacter();
  const openRequestId = ++modalOpenRequestId;
  const openSheetIndex = activeSheetIndex;
  // Додаю прокручування сторінки вгору при відкритті модалки
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (currentCharacter) {
    updateModalInfo(currentCharacter);
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
    // Завантажуємо всі поля модалки із Supabase (може бути новіша версія)
    const modalInfoFromDb = await loadModalInfoFromSupabase(
      OBR.room.id,
      currentCharacter.characterName || ''
    );
    const stillSameOpen = modalOpenRequestId === openRequestId;
    const modalStillOpen = modal.style.display === 'block';
    const stillSameCharacter = activeSheetIndex === openSheetIndex;
    const isEditingNow = !!modal.querySelector('textarea:not([readonly])');

    if (modalInfoFromDb && stillSameOpen && modalStillOpen && stillSameCharacter && !isEditingNow) {
      if (characterSheets[activeSheetIndex]) {
        applyModalInfoToSheet(characterSheets[activeSheetIndex], modalInfoFromDb);
      }
      applyModalInfoToInputs(modalInfoFromDb);
    }
  } else {
    // Якщо персонаж не вибраний, показуємо повідомлення
    const modalBody = document.querySelector('.modal-body');
    modalBody.innerHTML = '<p style="text-align: center; font-size: 1.2em;">Будь ласка, виберіть персонажа</p>';
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
  }

}

// Функція для закриття модального вікна
function closeCharacterInfoModal() {
  const modal = document.getElementById('characterInfoModal');
  modal.style.display = 'none';
  document.body.style.overflow = '';
  if (characterSheets[activeSheetIndex]) {
    characterSheets[activeSheetIndex].characterClassLevel = document.getElementById('modalCharacterClass')?.value || '';
    characterSheets[activeSheetIndex].characterRace = document.getElementById('modalCharacterRace')?.value || '';
    characterSheets[activeSheetIndex].background = document.getElementById('modalBackground')?.value || '';
    characterSheets[activeSheetIndex].alignment = document.getElementById('modalAlignment')?.value || '';
    characterSheets[activeSheetIndex].appearance = document.getElementById('modalAppearance')?.value || '';
    characterSheets[activeSheetIndex].languages = document.getElementById('modalLanguages')?.value || '';
    characterSheets[activeSheetIndex].bonds = document.getElementById('modalBonds')?.value || '';
    characterSheets[activeSheetIndex].personalityTraits = document.getElementById('modalPersonalityTraits')?.value || '';
    characterSheets[activeSheetIndex].features = document.getElementById('modalFeatures')?.value || '';
    characterSheets[activeSheetIndex].notes = document.getElementById('modalNotes')?.value || '';
    saveActiveCharacterModalInfoToSupabase();
  }
  if (typeof debouncedSaveSheetData === 'function') {
    const sheetIdx = activeSheetIndex;
    debouncedSaveSheetData(sheetIdx);
  }
}

// Додаємо обробники подій для модального вікна
document.addEventListener('DOMContentLoaded', () => {
  const helpIcon = document.querySelector('.help-block i');
  const closeButton = document.querySelector('.close-modal');
  const modal = document.getElementById('characterInfoModal');

  helpIcon.addEventListener('click', openCharacterInfoModal);
  closeButton.addEventListener('click', closeCharacterInfoModal);

  // Налаштовуємо обробники для модифікаторів
  // Прибираємо дублюючий виклик - setupModifierButtons вже викликається в setupInterface
  // console.log("📋 [CHARACTER] DOMContentLoaded: Setting up modifier buttons...");
  // setupModifierButtons();
  // console.log("📋 [CHARACTER] DOMContentLoaded: Modifier buttons setup completed");

  // Закриття модального вікна при кліку поза ним
  window.addEventListener('click', (event) => {
    if (event.target === modal) {
      // Перевіряємо, чи не відбувається редагування в модальному вікні
      const isEditing = modal.querySelector('textarea:not([readonly])');
      if (isEditing) {
        return; // Не закриваємо, якщо відбувається редагування
      }
      
      // Додаємо затримку для запобігання випадкового закриття
      clearTimeout(modalClickTimeout);
      modalClickTimeout = setTimeout(() => {
        closeCharacterInfoModal();
      }, 100);
    }
  });

  // Закриття модального вікна при натисканні Escape
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.style.display === 'block') {
      closeCharacterInfoModal();
    }
  });

  // === Логіка редагування блоків у модалці ===
  const modalBlocks = [
    { field: 'Class', textarea: 'modalCharacterClass', edit: 'editModalClass', accept: 'acceptModalClass', cancel: 'cancelModalClass', mainField: 'characterClassLevel' },
    { field: 'Race', textarea: 'modalCharacterRace', edit: 'editModalRace', accept: 'acceptModalRace', cancel: 'cancelModalRace', mainField: 'characterRace' },
    { field: 'Background', textarea: 'modalBackground', edit: 'editModalBackground', accept: 'acceptModalBackground', cancel: 'cancelModalBackground', mainField: 'background' },
    { field: 'Alignment', textarea: 'modalAlignment', edit: 'editModalAlignment', accept: 'acceptModalAlignment', cancel: 'cancelModalAlignment', mainField: 'alignment' },
    { field: 'Appearance', textarea: 'modalAppearance', edit: 'editModalAppearance', accept: 'acceptModalAppearance', cancel: 'cancelModalAppearance', mainField: 'appearance' },
    { field: 'Languages', textarea: 'modalLanguages', edit: 'editModalLanguages', accept: 'acceptModalLanguages', cancel: 'cancelModalLanguages', mainField: 'languages' },
    { field: 'Bonds', textarea: 'modalBonds', edit: 'editModalBonds', accept: 'acceptModalBonds', cancel: 'cancelModalBonds', mainField: 'bonds' },
    { field: 'PersonalityTraits', textarea: 'modalPersonalityTraits', edit: 'editModalPersonalityTraits', accept: 'acceptModalPersonalityTraits', cancel: 'cancelModalPersonalityTraits', mainField: 'personalityTraits' },
    { field: 'Features', textarea: 'modalFeatures', edit: 'editModalFeatures', accept: 'acceptModalFeatures', cancel: 'cancelModalFeatures', mainField: 'features' },
    { field: 'Notes', textarea: 'modalNotes', edit: 'editModalNotes', accept: 'acceptModalNotes', cancel: 'cancelModalNotes', mainField: 'notes' },
  ];
  modalBlocks.forEach(({textarea, edit, accept, cancel, mainField}) => {
    const ta = document.getElementById(textarea);
    const btnEdit = document.getElementById(edit);
    const btnAccept = document.getElementById(accept);
    const btnCancel = document.getElementById(cancel);
    let prevValue = '';
    if (btnEdit && btnAccept && btnCancel && ta) {
      ta.addEventListener('input', () => {
        if (!ta.readOnly && characterSheets[activeSheetIndex]) {
          characterSheets[activeSheetIndex][mainField] = ta.value;
          const sheetIdx = activeSheetIndex;
          debouncedSaveSheetData(sheetIdx);
        }
      });

      btnEdit.addEventListener('click', () => {
        prevValue = ta.value;
        ta.readOnly = false;
        ta.focus();
        btnEdit.style.display = 'none';
        btnAccept.style.display = '';
        btnCancel.style.display = '';
      });
      btnCancel.addEventListener('click', () => {
        ta.value = prevValue;
        ta.readOnly = true;
        btnEdit.style.display = '';
        btnAccept.style.display = 'none';
        btnCancel.style.display = 'none';
        ta.style.height = 'auto';
        ta.style.height = (ta.scrollHeight) + 'px';
      });
      btnAccept.addEventListener('click', () => {
        ta.readOnly = true;
        btnEdit.style.display = '';
        btnAccept.style.display = 'none';
        btnCancel.style.display = 'none';
        ta.style.height = 'auto';
        ta.style.height = (ta.scrollHeight) + 'px';
        if (characterSheets[activeSheetIndex]) {
          characterSheets[activeSheetIndex][mainField] = ta.value;
          // Зберігаємо тільки при натисканні кнопки підтвердження
          const sheetIdx = activeSheetIndex;
          saveSheetData(sheetIdx);
          saveActiveCharacterModalInfoToSupabase();
        }
      });
    }
  });

  // === ФУНКЦІЯ АВТОМАТИЧНОГО ЗБЕРЕЖЕННЯ АКТИВНОГО БЛОКУ ===
  function finishCurrentEditing() {
    // Зберігаємо зброю якщо редагується
    if (weaponEditing) {
      const acceptBtn = document.getElementById('weaponAcceptBtn');
      if (acceptBtn) acceptBtn.click();
    }
    
    // Зберігаємо навички якщо редагуються
    if (skillEditing) {
      const skillAcceptBtn = document.getElementById('skillAcceptBtn');
      if (skillAcceptBtn) skillAcceptBtn.click();
    }
    
    // Зберігаємо інвентар якщо редагується
    if (editingInv) {
      const invAcceptBtn = document.getElementById('inventoryAcceptBtn');
      if (invAcceptBtn) invAcceptBtn.click();
    }
    
    // Зберігаємо спорядження якщо редагується
    if (editingEquip) {
      const equipAcceptBtn = document.getElementById('equipmentAcceptBtn');
      if (equipAcceptBtn) equipAcceptBtn.click();
    }
  }

  // --- Weapon block edit logic ---
  const editBtn = document.getElementById('weaponEditBtn');
  const acceptBtn = document.getElementById('weaponAcceptBtn');
  const cancelBtn = document.getElementById('weaponCancelBtn');
  const addRowBtn = document.getElementById('weaponAddRowBtn');

  let prevRows = [];
  let editing = false;

  function setEditingMode(on) {
    editing = on;
    weaponEditing = on;
    window.weaponEditing = on; // Додаємо глобальну змінну
    // Додаю керування contenteditable для заголовка
    const weaponLabel = document.querySelector('.weapon-block .weapon-label');
    if (weaponLabel) weaponLabel.contentEditable = !!on;
    if (editBtn) editBtn.style.display = on ? 'none' : '';
    if (acceptBtn) acceptBtn.style.display = on ? '' : 'none';
    if (cancelBtn) cancelBtn.style.display = on ? '' : 'none';
    if (addRowBtn) addRowBtn.style.display = on ? '' : 'none';
    if (!on) {
      // Зберігаємо заголовок
      const weaponLabel = document.querySelector('.weapon-block .weapon-label');
      if (weaponLabel) {
        characterSheets[activeSheetIndex].weaponTitle = weaponLabel.textContent;
      }
      if (characterSheets[activeSheetIndex]) {
        characterSheets[activeSheetIndex].weapons = JSON.parse(JSON.stringify(weaponRows));
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
        updateCurrentWeight();
      }
    }
    renderWeaponTable(editing);
  }

  if (editBtn && acceptBtn && cancelBtn && addRowBtn) {
    renderWeaponTable(false);
    editBtn.addEventListener('click', () => {
      finishCurrentEditing(); // Зберігаємо інші блоки перед редагуванням
      prevRows = JSON.parse(JSON.stringify(weaponRows));
      setEditingMode(true);
    });
    acceptBtn.addEventListener('click', () => {
      // ОНОВЛЮЄМО weaponRows з DOM перед збереженням!
      const tbody = document.getElementById('weaponTableBody');
      if (tbody) {
        weaponRows = Array.from(tbody.children).map(tr => {
          const inputName = tr.querySelector('.weapon-name');
          const inputBonus = tr.querySelector('.weapon-bonus');
          const inputDamage = tr.querySelector('.weapon-damage');
          return {
            name: inputName ? inputName.value : '',
            bonus: inputBonus ? inputBonus.value : '',
            damage: inputDamage ? inputDamage.value : ''
          };
        });
      }
      setEditingMode(false);
    });
    cancelBtn.addEventListener('click', () => {
      weaponRows = JSON.parse(JSON.stringify(prevRows));
      setEditingMode(false);
    });
    addRowBtn.addEventListener('click', () => {
      weaponRows.push({ name: '', bonus: '', damage: '' });
      renderWeaponTable(true);
    });
  } else {
    renderWeaponTable(false);
  }

  // Додаю перевірку, що подія ініційована користувачем
  const abilityScoresBlock = document.querySelector('.ability-scores');
  if (abilityScoresBlock) {
    abilityScoresBlock.addEventListener('click', function(event) {
      const box = event.target.closest('.modifier-box');
      if (!box || !abilityScoresBlock.contains(box)) return;
      if (weaponEditing || skillEditing) return;
      if (event.target !== box) return;
      if (!event.isTrusted) return;
      event.stopPropagation();
    });
  }

  // Додаю stopPropagation для блоків, щоб не було випадкових сповіщень
  document.querySelectorAll('.skill-block, .weapon-block, .skill-edit-btn, .weapon-edit-btn').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation());
  });

  // --- Skill block edit logic ---
  const editBtnSkill = document.getElementById('skillEditBtn');
  const acceptBtnSkill = document.getElementById('skillAcceptBtn');
  const cancelBtnSkill = document.getElementById('skillCancelBtn');
  const addRowBtnSkill = document.getElementById('skillAddRowBtn');

  let prevRowsSkill = [];
  let editingSkill = false;

  function setEditingModeSkill(on) {
    editingSkill = on;
    skillEditing = on;
    window.skillEditing = on; // Додаємо глобальну змінну
    // Додаю керування contenteditable для заголовка навичок
    const skillLabel = document.querySelector('.skill-block .skill-label');
    if (skillLabel) skillLabel.contentEditable = !!on;
    if (editBtnSkill) editBtnSkill.style.display = on ? 'none' : '';
    if (acceptBtnSkill) acceptBtnSkill.style.display = on ? '' : 'none';
    if (cancelBtnSkill) cancelBtnSkill.style.display = on ? '' : 'none';
    if (addRowBtnSkill) addRowBtnSkill.style.display = on ? '' : 'none';
    if (!on) {
      if (characterSheets[activeSheetIndex]) {
        characterSheets[activeSheetIndex].skills = JSON.parse(JSON.stringify(skillRows));
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
        updateCurrentWeight();
      }
    }
    renderSkillTable(editingSkill);
  }

  if (editBtnSkill && acceptBtnSkill && cancelBtnSkill && addRowBtnSkill) {
    renderSkillTable(false);
    editBtnSkill.addEventListener('click', () => {
      finishCurrentEditing(); // Зберігаємо інші блоки перед редагуванням
      prevRowsSkill = JSON.parse(JSON.stringify(skillRows));
      setEditingModeSkill(true);
    });
    acceptBtnSkill.addEventListener('click', () => {
      setEditingModeSkill(false);
    });
    cancelBtnSkill.addEventListener('click', () => {
      skillRows = JSON.parse(JSON.stringify(prevRowsSkill));
      setEditingModeSkill(false);
    });
    addRowBtnSkill.addEventListener('click', () => {
      skillRows.push({ name: '', bonus: '', desc: '' });
      renderSkillTable(true);
    });
  } else {
    renderSkillTable(false);
  }

  // --- Inventory block edit logic ---
  let prevRowsInv = [];

  const editBtnInv = document.getElementById('inventoryEditBtn');
  const acceptBtnInv = document.getElementById('inventoryAcceptBtn');
  const cancelBtnInv = document.getElementById('inventoryCancelBtn');
  const addRowBtnInv = document.getElementById('inventoryAddRowBtn');

  function setEditingModeInventory(on) {
    editingInv = on;
    renderInventoryTable(editingInv);
    // Додаю керування contenteditable для заголовка інвентаря
    const inventoryLabel = document.querySelector('.inventory-block .weapon-label');
    if (inventoryLabel) inventoryLabel.contentEditable = !!on;
    
    editBtnInv.style.display = on ? 'none' : 'inline-flex';
    acceptBtnInv.style.display = on ? 'inline-flex' : 'none';
    cancelBtnInv.style.display = on ? 'inline-flex' : 'none';
    addRowBtnInv.style.display = on ? 'inline-flex' : 'none';
  }

  if (editBtnInv && acceptBtnInv && cancelBtnInv && addRowBtnInv) {
    renderInventoryTable(false);
    editBtnInv.addEventListener('click', () => {
      finishCurrentEditing(); // Зберігаємо інші блоки перед редагуванням
      prevRowsInv = JSON.parse(JSON.stringify(inventoryRows));
      setEditingModeInventory(true);
    });
    acceptBtnInv.addEventListener('click', () => {
      // ОНОВЛЮЄМО inventoryRows з DOM перед збереженням!
      const tbody = document.getElementById('inventoryTableBody');
      if (tbody) {
        inventoryRows = Array.from(tbody.children).map(tr => {
          const inputName = tr.querySelector('.inventory-name');
          const inputCount = tr.querySelector('.inventory-count');
          const inputWeight = tr.querySelector('.inventory-weight');
          return {
            name: inputName ? inputName.value : '',
            count: inputCount ? inputCount.value : '',
            weight: inputWeight ? inputWeight.value : ''
          };
        });
      }
      setEditingModeInventory(false);
      // Збереження інвентаря в базу даних
      const sheetIdx = activeSheetIndex;
      saveSheetData(sheetIdx);
    });
    cancelBtnInv.addEventListener('click', () => {
      inventoryRows = JSON.parse(JSON.stringify(prevRowsInv));
      setEditingModeInventory(false);
    });
    addRowBtnInv.addEventListener('click', () => {
      inventoryRows.push({ name: '', count: '', weight: '' });
      renderInventoryTable(true);
      updateCurrentWeight();
    });
  } else {
    renderInventoryTable(false);
  }

  // --- Equipment block edit logic ---
  let prevRowsEquip = [];

  const editBtnEquip = document.getElementById('equipmentEditBtn');
  const acceptBtnEquip = document.getElementById('equipmentAcceptBtn');
  const cancelBtnEquip = document.getElementById('equipmentCancelBtn');
  const addRowBtnEquip = document.getElementById('equipmentAddRowBtn');

  function setEditingModeEquipment(on) {
    editingEquip = on;
    renderEquipmentTable(editingEquip);
    // Додаю керування contenteditable для заголовка спорядження
    const equipmentLabel = document.querySelector('.equipment-block .weapon-label');
    if (equipmentLabel) equipmentLabel.contentEditable = !!on;
    
    editBtnEquip.style.display = on ? 'none' : 'inline-flex';
    acceptBtnEquip.style.display = on ? 'inline-flex' : 'none';
    cancelBtnEquip.style.display = on ? 'inline-flex' : 'none';
    addRowBtnEquip.style.display = on ? 'inline-flex' : 'none';
  }

  if (editBtnEquip && acceptBtnEquip && cancelBtnEquip && addRowBtnEquip) {
    renderEquipmentTable(false);
    editBtnEquip.addEventListener('click', () => {
      finishCurrentEditing(); // Зберігаємо інші блоки перед редагуванням
      prevRowsEquip = JSON.parse(JSON.stringify(equipmentRows));
      setEditingModeEquipment(true);
    });
    acceptBtnEquip.addEventListener('click', () => {
      // ОНОВЛЮЄМО equipmentRows з DOM перед збереженням!
      const equipmentTbody = document.getElementById('equipmentTableBody');
      if (equipmentTbody) {
        equipmentRows = Array.from(equipmentTbody.children).map(tr => {
          const inputName = tr.querySelector('.equipment-name');
          const inputArmor = tr.querySelector('.equipment-armor');
          const inputWeight = tr.querySelector('.equipment-weight');
          return {
            name: inputName ? inputName.value : '',
            armor: inputArmor ? inputArmor.value : '',
            weight: inputWeight ? inputWeight.value : ''
          };
        });
      }
      setEditingModeEquipment(false);
      // Збереження спорядження в базу даних (також оновлює AC)
      const sheetIdx = activeSheetIndex;
      saveSheetData(sheetIdx);
    });
    cancelBtnEquip.addEventListener('click', () => {
      equipmentRows = JSON.parse(JSON.stringify(prevRowsEquip));
      setEditingModeEquipment(false);
    });
    addRowBtnEquip.addEventListener('click', () => {
      equipmentRows.push({ name: '', armor: '', weight: '' });
      renderEquipmentTable(true);
      updateCurrentWeight();
      updateArmorClass();
    });
  } else {
    renderEquipmentTable(false);
  }
});

// === ДИНАМІЧНА ТАБЛИЦЯ ЗБРОЇ ===
function renderWeaponTable(editing = false) {
  const tbody = document.getElementById('weaponTableBody');
  if (!tbody) {
    return;
  }

  // --- ЗБЕРЕЖЕННЯ ФОКУСУ ---
  let focusInfo = null;
  const active = document.activeElement;
  if (active && active.tagName === 'INPUT' && active.className.startsWith('weapon-')) {
    // Визначаємо тип поля та індекс рядка
    const parentTd = active.parentElement;
    const parentTr = parentTd?.parentElement;
    if (parentTr && parentTr.parentElement === tbody) {
      const idx = Array.from(tbody.children).indexOf(parentTr);
      focusInfo = {
        idx,
        className: active.className,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd
      };
    }
  }

  tbody.innerHTML = '';
  weaponRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    // Назва
    const tdName = document.createElement('td');
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.className = 'weapon-name';
    inputName.placeholder = 'Назва';
    inputName.value = row.name;
    inputName.disabled = !editing;
    inputName.addEventListener('input', e => {
      weaponRows[idx].name = e.target.value;
    });
    tdName.appendChild(inputName);
    tr.appendChild(tdName);
    
    // Бонус
    const tdBonus = document.createElement('td');
    const inputBonus = document.createElement('input');
    inputBonus.type = 'text';
    inputBonus.className = 'weapon-bonus';
    inputBonus.placeholder = '1d6+2';
    inputBonus.value = editing
      ? row.bonus
      : resolveSkillModifierTokensForDisplay(row.bonus || '');
    if (editing) {
      inputBonus.disabled = false;
      inputBonus.readOnly = false;
    } else {
      inputBonus.disabled = false;
      inputBonus.readOnly = true;
    }
    inputBonus.addEventListener('input', e => {
      weaponRows[idx].bonus = e.target.value;
    });
    // --- Додаю можливість натискати на поле "Бонус" (тепер це Шкода) лише у режимі перегляду ---
    if (!editing) {
      inputBonus.style.cursor = 'pointer';
      inputBonus.title = 'Кинути кубики шкоди';
      inputBonus.addEventListener('click', e => {
        // Перевіряємо, чи це справжній клік користувача
        if (e.detail !== 1 || !e.isTrusted) {
          return;
        }
        
        // Додаткова перевірка, що ми не в режимі редагування
        if (window.weaponEditing) {
          return;
        }
        
        // Перевіряємо, чи поле не заблоковане
        if (inputBonus.disabled) {
          return;
        }
        
        // Кидок кубиків шкоди (використовуємо значення з поля bonus)
        rollWeaponDamage(row.bonus);
      });
    }
    tdBonus.appendChild(inputBonus);
    tr.appendChild(tdBonus); // Додаємо поле бонусу до рядка
    
    // Шкода (тепер це Попадання - d20 з бонусом)
    const tdDamage = document.createElement('td');
    const inputDamage = document.createElement('input');
    inputDamage.type = 'text';
    inputDamage.className = 'weapon-damage';
    inputDamage.placeholder = '+0';
    inputDamage.value = editing
      ? row.damage
      : resolveSkillModifierTokensForDisplay(row.damage || '');
    if (editing) {
      inputDamage.disabled = false;
      inputDamage.readOnly = false;
    } else {
      inputDamage.disabled = false;
      inputDamage.readOnly = true;
    }
    inputDamage.addEventListener('input', e => {
      weaponRows[idx].damage = e.target.value;
    });
    // --- Додаю можливість натискати на поле "Шкода" (тепер це Попадання) лише у режимі перегляду ---
    if (!editing) {
      inputDamage.style.cursor = 'pointer';
      inputDamage.title = 'Кинути з бонусом на попадання';
      inputDamage.addEventListener('click', e => {
        // Перевіряємо, чи це справжній клік користувача
        if (e.detail !== 1 || !e.isTrusted) {
          return;
        }
        
        // Додаткова перевірка, що ми не в режимі редагування
        if (window.weaponEditing) {
          return;
        }
        
        // Парсимо бонус з поля damage
        const bonus = parseHitBonusValue(row.damage);
        
        // Для попадання використовуємо стиль NEBULA
        sendDiceRollRequest('D20', 'NEBULA', bonus);
      });
    }
    tdDamage.appendChild(inputDamage);
    tr.appendChild(tdDamage);
    
    // Кнопка видалення
    const tdDel = document.createElement('td');
    if (editing) {
      const delBtn = document.createElement('button');
      delBtn.className = 'weapon-delete-row-btn';
      delBtn.title = 'Видалити рядок';
      delBtn.innerHTML = '<i class="fas fa-trash"></i>';
      delBtn.addEventListener('click', () => {
        weaponRows.splice(idx, 1);
        renderWeaponTable(true);
      });
      delBtn.style.marginLeft = '2px';
      tdDel.appendChild(delBtn);
    }
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });

  // --- ВІДНОВЛЕННЯ ФОКУСУ ---
  if (focusInfo && editing) {
    const tr = tbody.children[focusInfo.idx];
    if (tr) {
      const input = tr.querySelector('.' + focusInfo.className);
      if (input) {
        input.focus();
        if (typeof focusInfo.selectionStart === 'number' && typeof focusInfo.selectionEnd === 'number') {
          input.setSelectionRange(focusInfo.selectionStart, focusInfo.selectionEnd);
        }
      }
    }
  }
}

// === ДИНАМІЧНА ТАБЛИЦЯ НАВИЧОК ===
function normalizeFazeStatesMap(rawStates) {
  const map = {};
  if (!rawStates || typeof rawStates !== 'object') return map;

  Object.entries(rawStates).forEach(([key, value]) => {
    if (!Array.isArray(value)) return;
    map[key] = value.map((flag) => !!flag);
  });

  return map;
}

function getSkillModifierDisplayMap() {
  const modifierIds = [
    'strengthModifier',
    'dexterityModifier',
    'constitutionModifier',
    'proficiencyModifier',
    'wisdomModifier',
    'charismaModifier',
  ];

  const map = {};
  modifierIds.forEach((modifierId) => {
    const modifierEl = document.getElementById(modifierId);
    const rawText = String(modifierEl?.textContent || '').trim();
    const parsed = parseInt(rawText, 10);
    const value = Number.isNaN(parsed) ? 0 : parsed;
    map[modifierId.toLowerCase()] = value >= 0 ? `(+${value})` : `(${value})`;
  });

  return map;
}

function resolveSkillModifierTokensForDisplay(text) {
  let resolved = String(text || '');
  const modifierDisplayMap = getSkillModifierDisplayMap();

  Object.entries(modifierDisplayMap).forEach(([token, value]) => {
    const tokenRegex = new RegExp(`\\b${token}\\b`, 'gi');
    resolved = resolved.replace(tokenRegex, value);
  });

  return resolved;
}

function resolveSkillDiceExpression(expression) {
  const source = String(expression || '').trim();
  if (!source) return '';

  const modifierIds = [
    'strengthModifier',
    'dexterityModifier',
    'constitutionModifier',
    'proficiencyModifier',
    'wisdomModifier',
    'charismaModifier',
  ];

  let resolved = source;
  modifierIds.forEach((modifierId) => {
    const modifierEl = document.getElementById(modifierId);
    const rawText = String(modifierEl?.textContent || '0').trim();
    const numeric = parseInt(rawText, 10);
    const value = Number.isNaN(numeric) ? 0 : numeric;
    const tokenRegex = new RegExp(`\\b${modifierId}\\b`, 'gi');
    resolved = resolved.replace(tokenRegex, String(value));
  });

  // Normalization after variable substitution (e.g. 1d4+-1 -> 1d4-1)
  resolved = resolved.replace(/\+\+/g, '+').replace(/\+\-/g, '-').replace(/\-\+/g, '-').replace(/\-\-/g, '+');
  return resolved;
}

function rollSkillInlineDice(diceExpression) {
  const resolvedExpression = resolveSkillDiceExpression(diceExpression);
  const parsed = parseWeaponDamage(resolvedExpression);
  if (!parsed) return;
  sendDiceRollRequest(parsed.dice, 'GALAXY', parsed.bonus, parsed.count);
}

function createSkillDescriptionView(row, idx) {
  const container = document.createElement('div');
  container.className = 'skill-desc-view';

  const source = String(row?.desc || '');
  const tokenRegex = /(dice|faze)\(([^)]+)\)/gi;
  let lastIndex = 0;
  let match = null;
  let fazeTokenIndex = 0;

  row.fazeStates = normalizeFazeStatesMap(row.fazeStates);

  while ((match = tokenRegex.exec(source)) !== null) {
    const [fullMatch, tokenTypeRaw, tokenArgRaw] = match;
    const tokenType = String(tokenTypeRaw || '').toLowerCase();
    const tokenArg = String(tokenArgRaw || '').trim();

    if (match.index > lastIndex) {
      const plainChunk = source.slice(lastIndex, match.index);
      container.appendChild(document.createTextNode(resolveSkillModifierTokensForDisplay(plainChunk)));
    }

    if (tokenType === 'dice') {
      const diceBtn = document.createElement('button');
      diceBtn.type = 'button';
      diceBtn.className = 'skill-inline-dice';
      diceBtn.textContent = resolveSkillModifierTokensForDisplay(tokenArg);
      diceBtn.title = 'Кинути кубики';
      diceBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!event.isTrusted) return;
        rollSkillInlineDice(tokenArg);
      });
      container.appendChild(diceBtn);
    } else if (tokenType === 'faze') {
      const count = parseInt(tokenArg, 10);
      if (!Number.isFinite(count) || count <= 0 || count > 20) {
        container.appendChild(document.createTextNode(fullMatch));
      } else {
        const stateKey = `${match.index}:${fazeTokenIndex}`;
        fazeTokenIndex += 1;
        const currentStates = Array.isArray(row.fazeStates[stateKey]) ? [...row.fazeStates[stateKey]] : [];
        const normalizedStates = Array.from({ length: count }, (_, i) => !!currentStates[i]);
        row.fazeStates[stateKey] = normalizedStates;

        const fazeWrap = document.createElement('span');
        fazeWrap.className = 'skill-inline-faze';

        normalizedStates.forEach((used, flagIndex) => {
          const flagBtn = document.createElement('button');
          flagBtn.type = 'button';
          flagBtn.className = `skill-faze-flag${used ? ' is-used' : ''}`;
          flagBtn.title = used ? 'Позначено як використане' : 'Позначити як використане';
          flagBtn.innerHTML = '<i class="fas fa-flag"></i>';
          flagBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!event.isTrusted) return;
            normalizedStates[flagIndex] = !normalizedStates[flagIndex];
            row.fazeStates[stateKey] = [...normalizedStates];
            syncSkillsToSheet();
            renderSkillTable(false);
          });
          fazeWrap.appendChild(flagBtn);
        });

        container.appendChild(fazeWrap);
      }
    } else {
      container.appendChild(document.createTextNode(fullMatch));
    }

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < source.length) {
    const trailingChunk = source.slice(lastIndex);
    container.appendChild(document.createTextNode(resolveSkillModifierTokensForDisplay(trailingChunk)));
  }

  return container;
}

function renderSkillTable(editing = false) {
  const tbody = document.getElementById('skillTableBody');
  if (!tbody) return;

  // --- ЗБЕРЕЖЕННЯ ФОКУСУ ---
  let focusInfo = null;
  const active = document.activeElement;
  if (active && (active.classList.contains('skill-name-label') || active.classList.contains('skill-desc-textarea'))) {
    const parentTr = active.closest('.skill-row');
    if (parentTr && parentTr.parentElement === tbody) {
      const idx = Array.from(tbody.children).indexOf(parentTr);
      focusInfo = {
        idx,
        className: active.className,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd
      };
    }
  }

  tbody.innerHTML = '';
  skillRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'skill-row';
    // --- Контейнер для назви ---
    const nameWrap = document.createElement('div');
    nameWrap.className = 'skill-name-wrap';
    nameWrap.style.display = 'flex';
    nameWrap.style.alignItems = 'center';
    nameWrap.style.gap = '6px';
    
    // Іконка чату
    const chatIcon = document.createElement('i');
    chatIcon.className = 'fas fa-comments skill-chat-icon';
    chatIcon.style.cursor = 'pointer';
    chatIcon.style.color = '#b0b0b0';
    chatIcon.style.fontSize = '0.9em';
    chatIcon.style.transition = 'color 0.15s';
    chatIcon.title = 'Поділитись';
    chatIcon.addEventListener('click', async (e) => {
      e.stopPropagation();
      await broadcastOpenSkillPopover(row.name || '', row.desc || '');
    });
    chatIcon.addEventListener('mouseenter', () => {
      chatIcon.style.color = '#fff';
    });
    chatIcon.addEventListener('mouseleave', () => {
      chatIcon.style.color = '#b0b0b0';
    });
    nameWrap.appendChild(chatIcon);
    
    // Назва (contenteditable span)
    const nameLabel = document.createElement('span');
    nameLabel.className = 'skill-name-label';
    nameLabel.contentEditable = editing ? 'true' : 'false';
    nameLabel.spellcheck = false;
    nameLabel.textContent = row.name || 'Назва';
    nameLabel.setAttribute('data-placeholder', 'Назва');
    if (editing) {
      nameLabel.addEventListener('input', e => {
        skillRows[idx].name = nameLabel.textContent;
      });
    }
    nameWrap.appendChild(nameLabel);
    tr.appendChild(nameWrap);
    if (editing) {
      // Опис у режимі редагування
      const inputDesc = document.createElement('textarea');
      inputDesc.className = 'skill-desc-textarea';
      inputDesc.value = row.desc;
      inputDesc.placeholder = 'Опис навички';
      inputDesc.disabled = false;
      inputDesc.readOnly = false;
      inputDesc.addEventListener('input', e => {
        skillRows[idx].desc = e.target.value;
      });
      setTimeout(() => {
        inputDesc.style.height = 'auto';
        inputDesc.style.height = (inputDesc.scrollHeight) + 'px';
      }, 0);
      tr.appendChild(inputDesc);
    } else {
      // Опис у режимі перегляду з підтримкою dice(...) і faze(...)
      tr.appendChild(createSkillDescriptionView(row, idx));
    }
    // Кнопка видалення
    if (editing) {
      const delBtn = document.createElement('button');
      delBtn.className = 'skill-delete-row-btn';
      delBtn.title = 'Видалити навичку';
      delBtn.innerHTML = '<i class="fas fa-trash"></i>';
      delBtn.addEventListener('click', () => {
        skillRows.splice(idx, 1);
        renderSkillTable(true);
      });
      tr.appendChild(delBtn);
    }
    tbody.appendChild(tr);
  });

  // --- ВІДНОВЛЕННЯ ФОКУСУ ---
  if (focusInfo && editing) {
    const tr = tbody.children[focusInfo.idx];
    if (tr) {
      let input = null;
      if (focusInfo.className.includes('skill-name-label')) {
        input = tr.querySelector('.skill-name-label');
      } else if (focusInfo.className.includes('skill-desc-textarea')) {
        input = tr.querySelector('.skill-desc-textarea');
      }
      if (input) {
        input.focus();
        if (typeof focusInfo.selectionStart === 'number' && typeof focusInfo.selectionEnd === 'number') {
          input.setSelectionRange(focusInfo.selectionStart, focusInfo.selectionEnd);
        }
      }
    }
  }
}

function syncSkillsToSheet() {
  if (characterSheets[activeSheetIndex]) {
    characterSheets[activeSheetIndex].skills = JSON.parse(JSON.stringify(skillRows));
    const sheetIdx = activeSheetIndex;
    debouncedSaveSheetData(sheetIdx);
  }
}

// --- ДИНАМІЧНЕ АВТО-РОЗТЯГУВАННЯ textarea для skill-desc-textarea ---
document.addEventListener('input', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('skill-desc-textarea')) {
    e.target.style.height = 'auto';
    e.target.style.height = (e.target.scrollHeight) + 'px';
  }
});

// === ДИНАМІЧНА ТАБЛИЦЯ ІНВЕНТАРЯ ===
function renderInventoryTable(editing = false) {
  const tbody = document.getElementById('inventoryTableBody');
  if (!tbody) return;

  // Зберігаємо фокус на активному елементі
  const active = document.activeElement;
  let activeIndex = -1;
  let activeField = '';

  if (active && active.tagName === 'INPUT' && active.className.startsWith('inventory-')) {
    const tr = active.closest('tr');
    if (tr) {
      activeIndex = Array.from(tbody.children).indexOf(tr);
      if (active.className.includes('name')) activeField = 'name';
      else if (active.className.includes('count')) activeField = 'count';
      else if (active.className.includes('weight')) activeField = 'weight';
    }
  }

  tbody.innerHTML = '';

  inventoryRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    // Назва
    const tdName = document.createElement('td');
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.value = row.name;
    inputName.className = 'inventory-name';
    inputName.readOnly = !editing;
    inputName.addEventListener('input', (e) => {
      inventoryRows[idx].name = e.target.value;
      if (!editingInv) {
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
      }
      updateCurrentWeight();
    });
    tdName.appendChild(inputName);
    tr.appendChild(tdName);
    // Кількість
    const tdCount = document.createElement('td');
    const inputCount = document.createElement('input');
    inputCount.type = 'text';
    inputCount.value = row.count;
    inputCount.className = 'inventory-count';
    inputCount.readOnly = !editing;
    inputCount.addEventListener('input', (e) => {
      inventoryRows[idx].count = e.target.value;
      if (!editingInv) {
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
      }
      updateCurrentWeight();
    });
    tdCount.appendChild(inputCount);
    tr.appendChild(tdCount);
    // Вага
    const tdWeight = document.createElement('td');
    const inputWeight = document.createElement('input');
    inputWeight.type = 'text';
    inputWeight.value = row.weight;
    inputWeight.className = 'inventory-weight';
    inputWeight.readOnly = !editing;
    inputWeight.addEventListener('input', (e) => {
      inventoryRows[idx].weight = e.target.value;
      if (!editingInv) {
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
      }
      updateCurrentWeight();
    });
    tdWeight.appendChild(inputWeight);
    tr.appendChild(tdWeight);
    // Кнопка видалення
    const tdDelete = document.createElement('td');
    if (editing) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'weapon-delete-row-btn';
      deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
      deleteBtn.onclick = () => {
        inventoryRows.splice(idx, 1);
        renderInventoryTable(true);
        updateCurrentWeight();
      };
      tdDelete.appendChild(deleteBtn);
    }
    tr.appendChild(tdDelete);
    tbody.appendChild(tr);
    // Відновлюємо фокус
    if (idx === activeIndex) {
      let targetInput;
      if (activeField === 'name') targetInput = inputName;
      else if (activeField === 'count') targetInput = inputCount;
      else if (activeField === 'weight') targetInput = inputWeight;
      if (targetInput) {
        setTimeout(() => targetInput.focus(), 0);
        targetInput.setSelectionRange(targetInput.value.length, targetInput.value.length);
      }
    }
  });
}

// === ДИНАМІЧНА ТАБЛИЦЯ СПОРЯДЖЕННЯ ===
function renderEquipmentTable(editing = false) {
  const tbody = document.getElementById('equipmentTableBody');
  if (!tbody) return;

  // Зберігаємо фокус на активному елементі
  const active = document.activeElement;
  let activeIndex = -1;
  let activeField = '';

  if (active && active.tagName === 'INPUT' && active.className.startsWith('equipment-')) {
    const tr = active.closest('tr');
    if (tr) {
      activeIndex = Array.from(tbody.children).indexOf(tr);
      if (active.className.includes('name')) activeField = 'name';
      else if (active.className.includes('armor')) activeField = 'armor';
      else if (active.className.includes('weight')) activeField = 'weight';
    }
  }

  tbody.innerHTML = '';

  equipmentRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    // Назва
    const tdName = document.createElement('td');
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.value = row.name;
    inputName.className = 'equipment-name';
    inputName.readOnly = !editing;
    inputName.addEventListener('input', (e) => {
      equipmentRows[idx].name = e.target.value;
      if (!editingEquip) {
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
      }
      updateCurrentWeight();
      updateArmorClass();
    });
    tdName.appendChild(inputName);
    tr.appendChild(tdName);
    // Броня
    const tdArmor = document.createElement('td');
    const inputArmor = document.createElement('input');
    inputArmor.type = 'text';
    inputArmor.value = row.armor;
    inputArmor.className = 'equipment-armor';
    inputArmor.readOnly = !editing;
    inputArmor.addEventListener('input', (e) => {
      equipmentRows[idx].armor = e.target.value;
      if (!editingEquip) {
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
      }
      updateCurrentWeight();
      updateArmorClass();
    });
    tdArmor.appendChild(inputArmor);
    tr.appendChild(tdArmor);
    // Вага
    const tdWeight = document.createElement('td');
    const inputWeight = document.createElement('input');
    inputWeight.type = 'text';
    inputWeight.value = row.weight;
    inputWeight.className = 'equipment-weight';
    inputWeight.readOnly = !editing;
    inputWeight.addEventListener('input', (e) => {
      equipmentRows[idx].weight = e.target.value;
      if (!editingEquip) {
        const sheetIdx = activeSheetIndex;
        debouncedSaveSheetData(sheetIdx);
      }
      updateCurrentWeight();
      updateArmorClass();
    });
    tdWeight.appendChild(inputWeight);
    tr.appendChild(tdWeight);
    // Кнопка видалення
    const tdDelete = document.createElement('td');
    if (editing) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'weapon-delete-row-btn';
      deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
      deleteBtn.onclick = () => {
        equipmentRows.splice(idx, 1);
        renderEquipmentTable(true);
        updateCurrentWeight();
        updateArmorClass();
      };
      tdDelete.appendChild(deleteBtn);
    }
    tr.appendChild(tdDelete);
    tbody.appendChild(tr);
    // Відновлюємо фокус
    if (idx === activeIndex) {
      let targetInput;
      if (activeField === 'name') targetInput = inputName;
      else if (activeField === 'armor') targetInput = inputArmor;
      else if (activeField === 'weight') targetInput = inputWeight;
      if (targetInput) {
        setTimeout(() => targetInput.focus(), 0);
        targetInput.setSelectionRange(targetInput.value.length, targetInput.value.length);
      }
    }
  });
}

// Додаємо обробники подій для полів ваги
const maxWeightInput = document.getElementById('maxWeight');
const currentWeightInput = document.getElementById('currentWeight');

if (maxWeightInput) {
  maxWeightInput.addEventListener('input', updateCurrentWeight);
}

if (currentWeightInput) {
  currentWeightInput.addEventListener('input', updateCurrentWeight);
}

// Додаємо обробник події для поля спритності
const dexterityInput = document.getElementById('dexterityScore');
if (dexterityInput) {
  dexterityInput.addEventListener('input', updateSpeed);
}

// Додаємо обробник події для поля статури
const constitutionInput = document.getElementById('constitutionScore');
if (constitutionInput) {
  constitutionInput.addEventListener('input', updateMaxHealth);
}

// Додаємо обробники для заголовків блоків
const weaponLabel = document.querySelector('.weapon-block .weapon-label');
const inventoryLabel = document.querySelector('.inventory-block .weapon-label');
const equipmentLabel = document.querySelector('.equipment-block .weapon-label');

if (weaponLabel) {
  weaponLabel.addEventListener('blur', () => {
    if (!weaponEditing) {
      characterSheets[activeSheetIndex].weaponTitle = weaponLabel.textContent;
      const sheetIdx = activeSheetIndex;
      debouncedSaveSheetData(sheetIdx);
    }
  });
}

if (inventoryLabel) {
  inventoryLabel.addEventListener('blur', () => {
    if (!editingInv) {
      characterSheets[activeSheetIndex].inventoryTitle = inventoryLabel.textContent;
      const sheetIdx = activeSheetIndex;
      debouncedSaveSheetData(sheetIdx);
    }
  });
}

if (equipmentLabel) {
  equipmentLabel.addEventListener('blur', () => {
    if (!editingEquip) {
      characterSheets[activeSheetIndex].equipmentTitle = equipmentLabel.textContent;
      const sheetIdx = activeSheetIndex;
      debouncedSaveSheetData(sheetIdx);
    }
  });
}

// === РЕДАГУВАННЯ МОНЕТ ===
document.addEventListener('DOMContentLoaded', function() {
  const senInput = document.getElementById('senCoins');
  const ginInput = document.getElementById('ginCoins');
  const kinInput = document.getElementById('kinCoins');

  function saveCoinsImmediate() {
    coinsData.sen = parseInt(senInput.value) || 0;
    coinsData.gin = parseInt(ginInput.value) || 0;
    coinsData.kin = parseInt(kinInput.value) || 0;
    characterSheets[activeSheetIndex].coins = JSON.parse(JSON.stringify(coinsData));
    const sheetIdx = activeSheetIndex;
    saveSheetData(sheetIdx);
  }

  [senInput, ginInput, kinInput].forEach(input => {
    if (!input) return;
    input.addEventListener('blur', saveCoinsImmediate);
    input.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') saveCoinsImmediate();
    });
  });

  loadCoinsData();
});

function loadCoinsData() {
  const senInput = document.getElementById('senCoins');
  const ginInput = document.getElementById('ginCoins');
  const kinInput = document.getElementById('kinCoins');
  
  if (senInput) senInput.value = coinsData.sen || 0;
  if (ginInput) ginInput.value = coinsData.gin || 0;
  if (kinInput) kinInput.value = coinsData.kin || 0;
}

async function sendDiceRollRequest(type, style, bonus, count = 1) {
  try {
    // Захист від повторної відправки запиту протягом 500мс
    const now = Date.now();
    if (now - lastRollRequestTime < 500) {
      return;
    }
    lastRollRequestTime = now;
    
    // Перевіряємо стан чекбоксів переваги/похибки
    const advantageCheckbox = document.getElementById('advantageCheckbox');
    const disadvantageCheckbox = document.getElementById('disadvantageCheckbox');
    const advantage = advantageCheckbox?.checked || false;
    const disadvantage = disadvantageCheckbox?.checked || false;
    
    // Визначаємо тип переваги
    let advantageType = null;
    if (advantage && !disadvantage) {
      advantageType = 'advantage';
    } else if (disadvantage && !advantage) {
      advantageType = 'disadvantage';
    }
    
    const connectionId = await OBR.player.getConnectionId();
    const playerName = currentPlayerName || '';
    
    const rollRequest = { 
      type, 
      style, 
      bonus, 
      count,
      advantage: advantageType,
      connectionId, 
      playerName, 
      ts: Date.now() 
    };
    
    // Отримуємо поточні метадані кімнати
    const currentMetadata = await OBR.room.getMetadata();
    
    // Додаємо наш запит
    const updatedMetadata = { 
      ...currentMetadata, 
      darqie: { 
        ...(currentMetadata.darqie || {}), 
        activeRoll: rollRequest 
      } 
    };
    
    // Відправляємо оновлені метадані
    await OBR.room.setMetadata(updatedMetadata);
    
    // Знімаємо чекбокси переваги/похибки одразу після відправки запиту
    if (advantageType) {
      clearAdvantageCheckboxes();
    }
    
  } catch (error) {
    // Повністю ігноруємо помилки
  }
}

function setupStatEditButtons() {
  // Основні характеристики з олівцем
  const statIdsWithEdit = [
    'strengthScore', 'dexterityScore', 'constitutionScore',
    'proficiencyScore', 'wisdomScore', 'charismaScore'
  ];
  statIdsWithEdit.forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    const abilityScoreItem = input.closest('.ability-score-item');
    if (!abilityScoreItem) return;
    const minus = abilityScoreItem.querySelector('.stat-btn.minus');
    const plus = abilityScoreItem.querySelector('.stat-btn.plus');
    const editBtn = abilityScoreItem.querySelector('.stat-edit-btn');
    // Початково заблоковано
    input.readOnly = true;
    if (minus) minus.disabled = true;
    if (plus) plus.disabled = true;
    // Клік на олівець — розблокувати
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        input.readOnly = false;
        if (minus) minus.disabled = false;
        if (plus) plus.disabled = false;
        input.focus();
      });
    }
    // Втрата фокусу — знову заблокувати (але не при натисканні на + або -)
    input.addEventListener('blur', (e) => {
      // Перевіряємо, чи не натиснули на кнопки + або -
      const relatedTarget = e.relatedTarget;
      if (relatedTarget && (relatedTarget === minus || relatedTarget === plus)) {
        return; // Не завершуємо редагування
      }
      setTimeout(() => {
        input.readOnly = true;
        if (minus) minus.disabled = true;
        if (plus) plus.disabled = true;
      }, 100);
    });
    // Enter — заблокувати
    input.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      }
    });
    // Додаємо обробник для кнопок + та -, щоб вони не завершували редагування
    if (minus) {
      minus.addEventListener('click', () => {
        // Зберігаємо фокус на input після натискання
        setTimeout(() => input.focus(), 10);
      });
    }
    if (plus) {
      plus.addEventListener('click', () => {
        // Зберігаємо фокус на input після натискання
        setTimeout(() => input.focus(), 10);
      });
    }
  });
  // Швидкі характеристики — завжди активні
  const statIdsAlwaysActive = [
    'armorClass', 'healthPoints', 'speed', 'initiative', 'health', 'maxHealthPoints',
  ];
  statIdsAlwaysActive.forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    const wrapper = input.closest('.stat-input-wrapper');
    if (!wrapper) return;
    const minus = wrapper.querySelector('.stat-btn.minus');
    const plus = wrapper.querySelector('.stat-btn.plus');
    input.readOnly = false;
    if (minus) minus.disabled = false;
    if (plus) plus.disabled = false;
  });
}

// Функція для налаштування обробників подій на модифікатори
function setupModifierButtons() {
  // Глобальна перевірка щоб не підключати обробники двічі
  if (window.modifierButtonsSetup) {
    return;
  }
  window.modifierButtonsSetup = true;
  
  const abilities = [
    { modId: 'strengthModifier', scoreId: 'strengthScore' },
    { modId: 'dexterityModifier', scoreId: 'dexterityScore' },
    { modId: 'constitutionModifier', scoreId: 'constitutionScore' },
    { modId: 'proficiencyModifier', scoreId: 'proficiencyScore' },
    { modId: 'wisdomModifier', scoreId: 'wisdomScore' },
    { modId: 'charismaModifier', scoreId: 'charismaScore' },
  ];

  abilities.forEach(({ modId, scoreId }) => {
    const modBox = document.getElementById(modId);
    const scoreInput = document.getElementById(scoreId);
    
    if (modBox && scoreInput) {
      // Перевіряємо, чи знаходиться modifier-box в правильному контексті (ability-score-mod-col)
      const abilityScoreModCol = modBox.closest('.ability-score-mod-col');
      if (!abilityScoreModCol) {
        return;
      }
      
      // Додаткова перевірка, що елемент знаходиться в ability-scores
      const abilityScores = modBox.closest('.ability-scores');
      if (!abilityScores) {
        return;
      }
      
      // Перевіряємо чи вже є обробник
      if (modBox.dataset.rollHandlerAttached) {
        return;
      }
      
      // Позначаємо що обробник підключений
      modBox.dataset.rollHandlerAttached = "true";
      modBox.style.cursor = 'pointer';
      modBox.title = 'Кинути d20 з цим модифікатором';
      
      modBox.addEventListener('click', function (e) {
        // Перевіряємо, чи це справжній клік користувача
        if (e.detail !== 1 || !e.isTrusted) {
          return;
        }
        
        // Кидок лише якщо клік саме по цьому елементу, а не по вкладеному
        if (e.currentTarget !== e.target) {
          return;
        }
        // Перевірка, що це саме .modifier-box у .ability-score-mod-col
        if (!modBox.classList.contains('modifier-box') || !modBox.closest('.ability-score-mod-col')) {
          return;
        }
        
        let value = parseInt(scoreInput.value);
        if (isNaN(value)) value = 10;
        const mod = Math.floor((value - 10) / 2);
        
        sendDiceRollRequest('D20', 'NEBULA', mod);
      });
    }
  });
}

async function sendSkillMessage(skillName, skillDescription) {
  try {
    const playerName = await OBR.player.getName();
    const message = {
      type: 'skill-info',
      skillName: skillName,
      skillDescription: skillDescription,
      playerName: playerName,
      timestamp: Date.now()
    };
    
    await OBR.broadcast.sendMessage('skill-message', message);
  } catch (error) {
    console.error('Помилка при відправці повідомлення про навичку:', error);
  }
}

// Відправник повідомляє іншим: відкрийте поповер з моїм ім'ям як ініціатора
async function broadcastOpenSkillPopover(skillName, skillDescription) {
  try {
    const senderId = await OBR.player.getConnectionId();
    const initiatorName = await OBR.player.getName();
    const payload = {
      type: 'open-skill-popover',
      name: skillName || '',
      desc: skillDescription || '',
      initiatorName: initiatorName || '',
      senderId,
      ts: Date.now(),
    };
    await OBR.broadcast.sendMessage('skill-popover', payload);
  } catch (_) {}
}

async function showSkillNotification(skillName, skillDescription, playerName) {
  try {
    const notificationText = skillDescription ? `${skillName}:\n\n${skillDescription}` : skillName;
    
    await OBR.notification.show(notificationText, 'SUCCESS');
  } catch (error) {
    console.error('Помилка при показі сповіщення про навичку:', error);
  }
}

// Відкриття поповера з навичкою (з іменем ініціатора)
async function openSkillPopoverFromBroadcast(skillName, skillDescription, initiatorName) {
  try {
    const role = await OBR.player.getRole();
    if (role !== 'GM') {
      await showSkillNotification(skillName, skillDescription, initiatorName || '');
      return;
    }

    const query = new URLSearchParams({
      name: skillName || '',
      desc: skillDescription || '',
      player: initiatorName || '',
      v: SKILL_POPOVER_VERSION,
    }).toString();
    try {
      await OBR.popover.open({
        id: 'darqie-skill-popover',
        url: `/skill-popover-v2.html?${query}`,
        height: 260,
        width: 420,
      });
    } catch (e1) {
      await OBR.popover.open({
        id: 'darqie-skill-popover',
        url: `skill-popover-v2.html?${query}`,
        height: 260,
        width: 420,
      });
    }
  } catch (_) {
  }
}

// Функція для очищення старого запиту кидка з метаданів
async function clearOldRollRequest() {
  try {
    const currentMetadata = await OBR.room.getMetadata();
    if (currentMetadata.darqie?.activeRoll) {
      const updatedMetadata = { 
        ...currentMetadata, 
        darqie: { 
          ...(currentMetadata.darqie || {}), 
          activeRoll: null 
        } 
      };
      await OBR.room.setMetadata(updatedMetadata);
    }
  } catch (error) {
    // Повністю ігноруємо помилки
  }
}

// --- Додаємо обробник метаданих для відкриття листа персонажа ---

async function handleMetadataChange(metadata) {
  const openSignal = metadata.darqie?.openCharacterSheet;
  if (openSignal) {
    try {
      // Відкриваємо розширення листа персонажа
      await OBR.action.open();
      // Очищаємо сигнал
      const currentMetadata = await OBR.room.getMetadata();
      await OBR.room.setMetadata({
        ...currentMetadata,
        darqie: {
          ...(currentMetadata.darqie || {}),
          openCharacterSheet: null
        }
      });
    } catch (error) {
      console.error(`📋 [CHARACTER] Помилка при відкритті розширення:`, error);
    }
  }
}

if (!window.__darqieCharacterSheetMetaHandler) {
  window.__darqieCharacterSheetMetaHandler = true;
  OBR.onReady(() => {
    OBR.room.onMetadataChange(handleMetadataChange);
  });
}

// Функція для парсингу шкоди зброї (наприклад: "1d6+2" -> { dice: "D6", count: 1, bonus: 2 })
function parseWeaponDamage(damageString) {
  if (!damageString || typeof damageString !== 'string') {
    return null;
  }
  
  // Видаляємо пробіли
  const cleanString = damageString.trim();
  
  // Регулярний вираз для парсингу: (кількість)d(сторінки)[+/-](бонус)
  const regex = /^(\d+)d(\d+)([+-]\d+)?$/i;
  const match = cleanString.match(regex);
  
  if (!match) {
    return null;
  }
  
  const count = parseInt(match[1]);
  const sides = parseInt(match[2]);
  const bonus = match[3] ? parseInt(match[3]) : 0;
  
  // Перевіряємо, чи це стандартний кубик
  const validDice = ['D4', 'D6', 'D8', 'D10', 'D12', 'D20', 'D100'];
  const diceType = `D${sides}`;
  
  if (!validDice.includes(diceType)) {
    return null;
  }
  
  return {
    dice: diceType,
    count: count,
    bonus: bonus
  };
}

function parseHitBonusValue(rawValue) {
  const resolved = resolveSkillDiceExpression(rawValue || '0');
  const cleaned = String(resolved)
    .trim()
    .replace(/^\(([-+]?\d+)\)$/i, '$1');

  const match = cleaned.match(/^[-+]?\d+$/);
  if (!match) return 0;

  const value = parseInt(cleaned, 10);
  return Number.isNaN(value) ? 0 : value;
}

// Функція для кидка шкоди зброї
async function rollWeaponDamage(damageString) {
  const resolvedExpression = resolveSkillDiceExpression(damageString);
  const parsed = parseWeaponDamage(resolvedExpression);
  if (!parsed) {
    return;
  }
  
  // Для шкоди використовуємо стиль GALAXY
  sendDiceRollRequest(parsed.dice, 'GALAXY', parsed.bonus, parsed.count);
}

// Функція для автоматичного зняття чекбоксів переваги/похибки після кидка
function clearAdvantageCheckboxes() {
  const advantageCheckbox = document.getElementById('advantageCheckbox');
  const disadvantageCheckbox = document.getElementById('disadvantageCheckbox');
  
  if (advantageCheckbox) {
    advantageCheckbox.checked = false;
  }
  if (disadvantageCheckbox) {
    disadvantageCheckbox.checked = false;
  }
}
