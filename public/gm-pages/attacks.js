const SUPABASE_URL = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const CHARACTER_TYPE_NPC = 'npc';
const DARQIE_ROOM_ID_KEY = 'darqie.lastRoomId';
const UNASSIGNED_ATTACKS_KEY = 'darqie.v2.unassignedAttacks';
const FILTER_ALL = '__all__';
const FILTER_UNASSIGNED = '__unassigned__';
const DICE_ROLL_THROTTLE_MS = 500;

let cachedObrClient = null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAttackItem(item) {
  return {
    name: String(item?.name || ''),
    bonus: String(item?.bonus || ''),
    damage: String(item?.damage || ''),
  };
}

function normalizeCharacterRow(row) {
  return {
    ...(row || {}),
    character_name: String(row?.character_name || '').trim(),
    player_name: String(row?.player_name || '').trim(),
    extra_data: { ...(row?.extra_data || {}) },
    weapons_json: Array.isArray(row?.weapons_json) ? row.weapons_json.map(normalizeAttackItem) : [],
  };
}

function getCharacterType(row) {
  return row?.extra_data?.characterType === CHARACTER_TYPE_NPC ? CHARACTER_TYPE_NPC : 'player';
}

function dedupeCharacterRows(rows) {
  const byName = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const normalized = normalizeCharacterRow(row);
    if (!normalized.character_name) return;
    const existing = byName.get(normalized.character_name);
    const existingTs = Date.parse(existing?.updated_at || '') || 0;
    const nextTs = Date.parse(normalized.updated_at || '') || 0;
    if (!existing || nextTs >= existingTs) {
      byName.set(normalized.character_name, normalized);
    }
  });
  return Array.from(byName.values());
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

  const tbody = root.querySelector('#gmAttacksTableBody');
  const addButton = root.querySelector('#gmAddAttackButton');
  const filterSelect = root.querySelector('#gmAttacksFilterSelect');
  const createModal = root.querySelector('#gmAttackCreateModal');
  const modalNameInput = root.querySelector('#gmAttackModalNameInput');
  const modalBonusInput = root.querySelector('#gmAttackModalBonusInput');
  const modalDamageInput = root.querySelector('#gmAttackModalDamageInput');
  const modalOwnerSelect = root.querySelector('#gmAttackModalOwnerSelect');
  const modalSaveButton = root.querySelector('#gmAttackModalSaveButton');
  const modalCancelButton = root.querySelector('#gmAttackModalCancelButton');
  if (!tbody || !addButton || !filterSelect || !createModal || !modalNameInput || !modalBonusInput || !modalDamageInput || !modalOwnerSelect || !modalSaveButton || !modalCancelButton) return;

  let OBR = null;
  let roomId = '';
  let characterRows = [];
  let unassignedAttacks = [];
  let filterValue = FILTER_ALL;
  let isDestroyed = false;
  let metadataListenerBound = false;
  let lastRollRequestTime = 0;

  function ensureActive() {
    const stillActive = root.isConnected && document.body.contains(root);
    if (stillActive) return true;
    isDestroyed = true;
    return false;
  }

  function getModifierValueByEntry(entry, tokenName) {
    if (!entry || entry.ownerType !== 'character') return 0;

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return 0;

    const token = String(tokenName || '').toLowerCase();
    const fieldMap = {
      strengthmodifier: 'strength_score',
      dexteritymodifier: 'dexterity_score',
      constitutionmodifier: 'constitution_score',
      proficiencymodifier: 'intelligence_score',
      wisdommodifier: 'wisdom_score',
      charismamodifier: 'charisma_score',
    };

    const scoreField = fieldMap[token];
    if (!scoreField) return 0;

    const raw = parseInt(row?.[scoreField], 10);
    const value = Number.isNaN(raw) ? 0 : raw;
    return Math.floor((value - 10) / 2);
  }

  function resolveModifierTokensForDisplay(text, entry) {
    let resolved = String(text || '');
    const tokens = [
      'strengthModifier',
      'dexterityModifier',
      'constitutionModifier',
      'proficiencyModifier',
      'wisdomModifier',
      'charismaModifier',
    ];

    tokens.forEach((token) => {
      const value = getModifierValueByEntry(entry, token);
      const display = value >= 0 ? `(+${value})` : `(${value})`;
      const tokenRegex = new RegExp(`\\b${token}\\b`, 'gi');
      resolved = resolved.replace(tokenRegex, display);
    });

    return resolved;
  }

  function resolveModifierTokensForRoll(text, entry) {
    let resolved = String(text || '');
    const tokens = [
      'strengthModifier',
      'dexterityModifier',
      'constitutionModifier',
      'proficiencyModifier',
      'wisdomModifier',
      'charismaModifier',
    ];

    tokens.forEach((token) => {
      const value = getModifierValueByEntry(entry, token);
      const tokenRegex = new RegExp(`\\b${token}\\b`, 'gi');
      resolved = resolved.replace(tokenRegex, String(value));
    });

    return resolved
      .replace(/\(([+-]?\d+)\)/g, '$1')
      .replace(/\+\+/g, '+')
      .replace(/\+\-/g, '-')
      .replace(/\-\+/g, '-')
      .replace(/\-\-/g, '+')
      .trim();
  }

  function parseDiceExpression(rawExpression) {
    const clean = String(rawExpression || '').trim();
    const regex = /^(\d+)d(\d+)([+-]\d+)?$/i;
    const match = clean.match(regex);
    if (!match) return null;

    const count = parseInt(match[1], 10);
    const sides = parseInt(match[2], 10);
    const bonus = match[3] ? parseInt(match[3], 10) : 0;
    const diceType = `D${sides}`;
    const validDice = ['D4', 'D6', 'D8', 'D10', 'D12', 'D20', 'D100'];
    if (!validDice.includes(diceType)) return null;
    return { dice: diceType, count, bonus };
  }

  function parseHitBonusValue(rawExpression) {
    const cleaned = String(rawExpression || '')
      .trim()
      .replace(/^\(([+-]?\d+)\)$/, '$1');

    if (!/^[-+]?\d+$/.test(cleaned)) return 0;
    const value = parseInt(cleaned, 10);
    return Number.isNaN(value) ? 0 : value;
  }

  async function sendDiceRollRequest(type, style, bonus, count = 1) {
    if (!OBR) return;

    const now = Date.now();
    if (now - lastRollRequestTime < DICE_ROLL_THROTTLE_MS) return;
    lastRollRequestTime = now;

    try {
      const connectionId = await OBR.player.getConnectionId();
      const playerName = await OBR.player.getName();
      const rollRequest = {
        type,
        style,
        bonus,
        count,
        advantage: null,
        connectionId,
        playerName: playerName || '',
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
    } catch (_) {
      // Ignore roll send failures in GM panel.
    }
  }

  async function loadCharacterRows() {
    if (!roomId) {
      characterRows = [];
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
    characterRows = dedupeCharacterRows(data).filter((row) => getCharacterType(row) !== CHARACTER_TYPE_NPC);
  }

  async function loadUnassignedAttacks() {
    if (!OBR) {
      unassignedAttacks = [];
      return;
    }

    try {
      const metadata = await OBR.room.getMetadata();
      const raw = Array.isArray(metadata?.[UNASSIGNED_ATTACKS_KEY]) ? metadata[UNASSIGNED_ATTACKS_KEY] : [];
      unassignedAttacks = raw.map(normalizeAttackItem);
    } catch (_) {
      unassignedAttacks = [];
    }
  }

  async function saveUnassignedAttacks() {
    if (!OBR) return;

    const metadata = await OBR.room.getMetadata();
    await OBR.room.setMetadata({
      ...metadata,
      [UNASSIGNED_ATTACKS_KEY]: unassignedAttacks.map(normalizeAttackItem),
    });
  }

  async function patchCharacterAttacks(characterName, attacks) {
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
        body: JSON.stringify({
          weapons_json: attacks.map(normalizeAttackItem),
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `Supabase patch failed: ${response.status}`);
    }

    const updatedRows = await response.json();
    return Array.isArray(updatedRows) && updatedRows[0] ? normalizeCharacterRow(updatedRows[0]) : null;
  }

  function getCharacterOptions() {
    return characterRows
      .map((row) => ({ value: row.character_name, label: row.character_name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'uk'));
  }

  function getDefaultModalOwner() {
    if (filterValue !== FILTER_ALL) return filterValue;
    return FILTER_UNASSIGNED;
  }

  function renderModalOwnerOptions(selectedValue) {
    const options = [
      { value: FILTER_UNASSIGNED, label: 'Непризначені' },
      ...getCharacterOptions(),
    ];

    modalOwnerSelect.innerHTML = options
      .map((option) => {
        const selected = option.value === selectedValue ? ' selected' : '';
        return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
      })
      .join('');

    if (!options.some((option) => option.value === selectedValue)) {
      modalOwnerSelect.value = FILTER_UNASSIGNED;
    }
  }

  function openCreateModal() {
    const defaultOwner = getDefaultModalOwner();
    modalNameInput.value = '';
    modalBonusInput.value = '+0';
    modalDamageInput.value = '1d6';
    renderModalOwnerOptions(defaultOwner);
    createModal.hidden = false;
    modalNameInput.focus();
  }

  function closeCreateModal() {
    createModal.hidden = true;
  }

  function buildFlatAttacks() {
    const assigned = characterRows.flatMap((row) =>
      (Array.isArray(row.weapons_json) ? row.weapons_json : []).map((item, index) => ({
        ownerType: 'character',
        ownerName: row.character_name,
        ownerLabel: row.character_name,
        itemIndex: index,
        item: normalizeAttackItem(item),
      }))
    );

    const unassigned = unassignedAttacks.map((item, index) => ({
      ownerType: 'unassigned',
      ownerName: '',
      ownerLabel: 'Непризначені',
      itemIndex: index,
      item: normalizeAttackItem(item),
    }));

    const allItems = assigned.concat(unassigned);

    if (filterValue === FILTER_ALL) return allItems;
    if (filterValue === FILTER_UNASSIGNED) return allItems.filter((entry) => entry.ownerType === 'unassigned');
    return allItems.filter((entry) => entry.ownerType === 'character' && entry.ownerName === filterValue);
  }

  function renderFilterOptions() {
    const options = [
      { value: FILTER_ALL, label: 'Усі персонажі' },
      ...getCharacterOptions(),
      { value: FILTER_UNASSIGNED, label: 'Непризначені' },
    ];

    filterSelect.innerHTML = options
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');

    if (!options.some((option) => option.value === filterValue)) {
      filterValue = FILTER_ALL;
    }
    filterSelect.value = filterValue;
  }

  function buildOwnerSelect(entry) {
    const currentValue = entry.ownerType === 'character' ? entry.ownerName : FILTER_UNASSIGNED;
    const options = [
      { value: FILTER_UNASSIGNED, label: 'Непризначені' },
      ...getCharacterOptions(),
    ];

    return `<select class="gm-cell-select" data-field="owner">
      ${options.map((option) => {
        const selected = option.value === currentValue ? ' selected' : '';
        return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
      }).join('')}
    </select>`;
  }

  function renderTable() {
    const flatItems = buildFlatAttacks();
    if (flatItems.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="gm-characters-empty">Немає атак для цього фільтра</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = flatItems.map((entry) => {
      const rawBonus = String(entry.item.bonus || '');
      const rawDamage = String(entry.item.damage || '');
      const displayBonus = resolveModifierTokensForDisplay(rawBonus, entry);
      const displayDamage = resolveModifierTokensForDisplay(rawDamage, entry);

      return `
      <tr data-owner-type="${escapeHtml(entry.ownerType)}" data-owner-name="${escapeHtml(entry.ownerName)}" data-item-index="${entry.itemIndex}">
        <td>
          <input class="gm-cell-input" data-field="name" type="text" value="${escapeHtml(entry.item.name)}" />
        </td>
        <td>
          <div class="gm-cell-inline">
            <input class="gm-cell-input" data-field="bonus" data-raw-value="${escapeHtml(rawBonus)}" type="text" value="${escapeHtml(displayBonus)}" />
            <button type="button" class="gm-inline-roll-btn" data-action="rollHit" title="Кинути на попадання">
              <i class="fas fa-dice-d20"></i>
            </button>
          </div>
        </td>
        <td>
          <div class="gm-cell-inline">
            <input class="gm-cell-input" data-field="damage" data-raw-value="${escapeHtml(rawDamage)}" type="text" value="${escapeHtml(displayDamage)}" />
            <button type="button" class="gm-inline-roll-btn" data-action="rollDamage" title="Кинути шкоду">
              <i class="fas fa-dice"></i>
            </button>
          </div>
        </td>
        <td>${buildOwnerSelect(entry)}</td>
        <td>
          <div class="gm-row-actions">
            <button type="button" class="gm-row-btn gm-row-btn--danger" data-action="delete" title="Видалити">
              <i class="fas fa-trash-alt"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
    }).join('');
  }

  function getEntryFromElement(target) {
    const tr = target.closest('tr[data-owner-type][data-item-index]');
    if (!tr) return null;

    const ownerType = tr.getAttribute('data-owner-type') || 'unassigned';
    const ownerName = tr.getAttribute('data-owner-name') || '';
    const itemIndex = parseInt(tr.getAttribute('data-item-index') || '-1', 10);
    if (itemIndex < 0) return null;

    return { tr, ownerType, ownerName, itemIndex };
  }

  function replaceCharacterRow(updatedRow) {
    const idx = characterRows.findIndex((row) => row.character_name === updatedRow.character_name);
    if (idx !== -1) {
      characterRows[idx] = updatedRow;
    }
  }

  function getItemByEntry(entry) {
    if (entry.ownerType === 'unassigned') {
      return normalizeAttackItem(unassignedAttacks[entry.itemIndex]);
    }

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return null;
    const items = Array.isArray(row.weapons_json) ? row.weapons_json : [];
    return normalizeAttackItem(items[entry.itemIndex]);
  }

  async function updateItemField(entry, field, value) {
    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedAttacks];
      const nextItem = { ...normalizeAttackItem(nextItems[entry.itemIndex]) };
      nextItem[field] = value;
      nextItems[entry.itemIndex] = nextItem;
      unassignedAttacks = nextItems;
      await saveUnassignedAttacks();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return;
    const nextItems = [...(Array.isArray(row.weapons_json) ? row.weapons_json : [])].map(normalizeAttackItem);
    const nextItem = { ...normalizeAttackItem(nextItems[entry.itemIndex]) };
    nextItem[field] = value;
    nextItems[entry.itemIndex] = nextItem;
    const updated = await patchCharacterAttacks(row.character_name, nextItems);
    if (updated) replaceCharacterRow(updated);
  }

  async function moveItem(entry, targetOwner) {
    if (entry.ownerType === 'character' && entry.ownerName === targetOwner) return;
    if (entry.ownerType === 'unassigned' && targetOwner === FILTER_UNASSIGNED) return;

    let movedItem = null;

    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedAttacks];
      movedItem = normalizeAttackItem(nextItems.splice(entry.itemIndex, 1)[0]);
      unassignedAttacks = nextItems;
      await saveUnassignedAttacks();
    } else {
      const sourceRow = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
      if (!sourceRow) return;
      const sourceItems = [...(Array.isArray(sourceRow.weapons_json) ? sourceRow.weapons_json : [])].map(normalizeAttackItem);
      movedItem = normalizeAttackItem(sourceItems.splice(entry.itemIndex, 1)[0]);
      const updatedSource = await patchCharacterAttacks(sourceRow.character_name, sourceItems);
      if (updatedSource) replaceCharacterRow(updatedSource);
    }

    if (!movedItem) return;

    if (targetOwner === FILTER_UNASSIGNED) {
      unassignedAttacks = [...unassignedAttacks, movedItem];
      await saveUnassignedAttacks();
      return;
    }

    const targetRow = characterRows.find((candidate) => candidate.character_name === targetOwner);
    if (!targetRow) {
      unassignedAttacks = [...unassignedAttacks, movedItem];
      await saveUnassignedAttacks();
      return;
    }

    const targetItems = [...(Array.isArray(targetRow.weapons_json) ? targetRow.weapons_json : [])].map(normalizeAttackItem);
    targetItems.push(movedItem);
    const updatedTarget = await patchCharacterAttacks(targetRow.character_name, targetItems);
    if (updatedTarget) replaceCharacterRow(updatedTarget);
  }

  async function deleteItem(entry) {
    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedAttacks];
      nextItems.splice(entry.itemIndex, 1);
      unassignedAttacks = nextItems;
      await saveUnassignedAttacks();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return;
    const nextItems = [...(Array.isArray(row.weapons_json) ? row.weapons_json : [])].map(normalizeAttackItem);
    nextItems.splice(entry.itemIndex, 1);
    const updated = await patchCharacterAttacks(row.character_name, nextItems);
    if (updated) replaceCharacterRow(updated);
  }

  async function addItem(newItem, ownerValue) {
    if (ownerValue === FILTER_UNASSIGNED) {
      unassignedAttacks = [...unassignedAttacks, normalizeAttackItem(newItem)];
      await saveUnassignedAttacks();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === ownerValue);
    if (!row) {
      unassignedAttacks = [...unassignedAttacks, normalizeAttackItem(newItem)];
      await saveUnassignedAttacks();
      return;
    }

    const nextItems = [...(Array.isArray(row.weapons_json) ? row.weapons_json : [])].map(normalizeAttackItem);
    nextItems.push(normalizeAttackItem(newItem));
    const updated = await patchCharacterAttacks(row.character_name, nextItems);
    if (updated) replaceCharacterRow(updated);
  }

  async function submitCreateModal() {
    const nextItem = normalizeAttackItem({
      name: modalNameInput.value || '',
      bonus: modalBonusInput.value || '+0',
      damage: modalDamageInput.value || '1d6',
    });

    const ownerValue = modalOwnerSelect.value || FILTER_UNASSIGNED;
    await addItem(nextItem, ownerValue);
    closeCreateModal();
    await refreshAll();
  }

  async function refreshAll() {
    if (!ensureActive()) return;
    await loadCharacterRows();
    await loadUnassignedAttacks();
    renderFilterOptions();
    renderTable();
  }

  function bindMetadataListener() {
    if (!OBR || metadataListenerBound) return;
    metadataListenerBound = true;

    OBR.room.onMetadataChange(async (metadata) => {
      if (!ensureActive()) return;
      if (Array.isArray(metadata?.[UNASSIGNED_ATTACKS_KEY])) {
        unassignedAttacks = metadata[UNASSIGNED_ATTACKS_KEY].map(normalizeAttackItem);
        renderTable();
      }
    });
  }

  filterSelect.addEventListener('change', () => {
    filterValue = filterSelect.value || FILTER_ALL;
    renderTable();
  });

  addButton.addEventListener('click', async () => {
    openCreateModal();
  });

  modalSaveButton.addEventListener('click', async () => {
    try {
      await submitCreateModal();
    } catch (error) {
      console.error(error);
      window.alert('Не вдалося додати атаку');
    }
  });

  modalCancelButton.addEventListener('click', () => {
    closeCreateModal();
  });

  createModal.addEventListener('click', (event) => {
    const closeBtn = event.target.closest('[data-action="closeModal"]');
    if (closeBtn) {
      closeCreateModal();
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !createModal.hidden) {
      closeCreateModal();
    }
  });

  tbody.addEventListener('change', async (event) => {
    const target = event.target;
    if (!target.matches('[data-field="owner"]')) return;
    const entry = getEntryFromElement(target);
    if (!entry) return;

    try {
      await moveItem(entry, target.value || FILTER_UNASSIGNED);
      await refreshAll();
    } catch (error) {
      console.error(error);
      window.alert('Не вдалося перепризначити атаку');
    }
  });

  tbody.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!target.matches('[data-field="bonus"], [data-field="damage"]')) return;

    const rawValue = target.getAttribute('data-raw-value');
    if (rawValue === null) return;

    target.value = rawValue;
    target.setAttribute('data-editing-raw', '1');
  });

  tbody.addEventListener('blur', async (event) => {
    const target = event.target;
    if (!target.matches('[data-field="name"], [data-field="bonus"], [data-field="damage"]')) return;

    const entry = getEntryFromElement(target);
    if (!entry) return;

    try {
      const field = target.getAttribute('data-field');
      let valueToSave = target.value || '';

      if (field === 'bonus' || field === 'damage') {
        const rawValue = target.getAttribute('data-raw-value') || '';
        const isEditingRaw = target.getAttribute('data-editing-raw') === '1';
        const prevDisplay = resolveModifierTokensForDisplay(rawValue, entry);

        if (isEditingRaw) {
          target.removeAttribute('data-editing-raw');
        } else if (valueToSave.trim() === prevDisplay.trim()) {
          valueToSave = rawValue;
        }
      }

      await updateItemField(entry, field, valueToSave);

      if (field === 'bonus' || field === 'damage') {
        renderTable();
      }
    } catch (error) {
      console.error(error);
    }
  }, true);

  tbody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const entry = getEntryFromElement(button);
    if (!entry) return;

    try {
      const action = button.getAttribute('data-action');
      if (action === 'rollDamage') {
        const item = getItemByEntry(entry);
        if (!item) return;
        const parsed = parseDiceExpression(resolveModifierTokensForRoll(item.damage || '', entry));
        if (!parsed) return;
        await sendDiceRollRequest(parsed.dice, 'GALAXY', parsed.bonus, parsed.count);
        return;
      }

      if (action === 'rollHit') {
        const item = getItemByEntry(entry);
        if (!item) return;
        const bonus = parseHitBonusValue(resolveModifierTokensForRoll(item.bonus || '', entry));
        await sendDiceRollRequest('D20', 'NEBULA', bonus, 1);
        return;
      }

      if (action === 'delete') {
        const ok = window.confirm('Видалити цю атаку?');
        if (!ok) return;
        await deleteItem(entry);
        await refreshAll();
      }
    } catch (error) {
      console.error(error);
      window.alert('Не вдалося видалити атаку');
    }
  });

  (async () => {
    OBR = await resolveOBRClient();
    if (OBR) {
      await waitForObrReady(OBR, 3500);
      bindMetadataListener();
    }

    roomId = OBR?.room?.id || localStorage.getItem(DARQIE_ROOM_ID_KEY) || '';
    await refreshAll();
  })().catch((error) => {
    console.error(error);
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="gm-characters-empty">Не вдалося завантажити список атак</td>
      </tr>
    `;
  });
}
