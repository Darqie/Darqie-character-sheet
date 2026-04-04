const SUPABASE_URL = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const CHARACTER_TYPE_NPC = 'npc';
const DARQIE_ROOM_ID_KEY = 'darqie.lastRoomId';
const UNASSIGNED_EQUIPMENT_KEY = 'darqie.v2.unassignedEquipment';
const FILTER_ALL = '__all__';
const FILTER_UNASSIGNED = '__unassigned__';

let cachedObrClient = null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEquipmentItem(item) {
  return {
    name: String(item?.name || ''),
    armor: String(item?.armor || ''),
    weight: String(item?.weight || ''),
  };
}

function normalizeCharacterRow(row) {
  return {
    ...(row || {}),
    character_name: String(row?.character_name || '').trim(),
    player_name: String(row?.player_name || '').trim(),
    extra_data: { ...(row?.extra_data || {}) },
    equipment_json: Array.isArray(row?.equipment_json) ? row.equipment_json.map(normalizeEquipmentItem) : [],
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

  const tbody = root.querySelector('#gmEquipmentTableBody');
  const addButton = root.querySelector('#gmAddEquipmentButton');
  const filterSelect = root.querySelector('#gmEquipmentFilterSelect');
  const createModal = root.querySelector('#gmEquipmentCreateModal');
  const modalNameInput = root.querySelector('#gmEquipmentModalNameInput');
  const modalArmorInput = root.querySelector('#gmEquipmentModalArmorInput');
  const modalWeightInput = root.querySelector('#gmEquipmentModalWeightInput');
  const modalOwnerSelect = root.querySelector('#gmEquipmentModalOwnerSelect');
  const modalSaveButton = root.querySelector('#gmEquipmentModalSaveButton');
  const modalCancelButton = root.querySelector('#gmEquipmentModalCancelButton');
  if (!tbody || !addButton || !filterSelect || !createModal || !modalNameInput || !modalArmorInput || !modalWeightInput || !modalOwnerSelect || !modalSaveButton || !modalCancelButton) return;

  let OBR = null;
  let roomId = '';
  let characterRows = [];
  let unassignedEquipment = [];
  let filterValue = FILTER_ALL;
  let isDestroyed = false;
  let metadataListenerBound = false;

  function ensureActive() {
    const stillActive = root.isConnected && document.body.contains(root);
    if (stillActive) return true;
    isDestroyed = true;
    return false;
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

  async function loadUnassignedEquipment() {
    if (!OBR) {
      unassignedEquipment = [];
      return;
    }

    try {
      const metadata = await OBR.room.getMetadata();
      const raw = Array.isArray(metadata?.[UNASSIGNED_EQUIPMENT_KEY]) ? metadata[UNASSIGNED_EQUIPMENT_KEY] : [];
      unassignedEquipment = raw.map(normalizeEquipmentItem);
    } catch (_) {
      unassignedEquipment = [];
    }
  }

  async function saveUnassignedEquipment() {
    if (!OBR) return;

    const metadata = await OBR.room.getMetadata();
    await OBR.room.setMetadata({
      ...metadata,
      [UNASSIGNED_EQUIPMENT_KEY]: unassignedEquipment.map(normalizeEquipmentItem),
    });
  }

  async function patchCharacterEquipment(characterName, items) {
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
          equipment_json: items.map(normalizeEquipmentItem),
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
    modalArmorInput.value = '';
    modalWeightInput.value = '';
    renderModalOwnerOptions(defaultOwner);
    createModal.hidden = false;
    modalNameInput.focus();
  }

  function closeCreateModal() {
    createModal.hidden = true;
  }

  function buildFlatItems() {
    const assigned = characterRows.flatMap((row) =>
      (Array.isArray(row.equipment_json) ? row.equipment_json : []).map((item, index) => ({
        ownerType: 'character',
        ownerName: row.character_name,
        ownerLabel: row.character_name,
        itemIndex: index,
        item: normalizeEquipmentItem(item),
      }))
    );

    const unassigned = unassignedEquipment.map((item, index) => ({
      ownerType: 'unassigned',
      ownerName: '',
      ownerLabel: 'Непризначені',
      itemIndex: index,
      item: normalizeEquipmentItem(item),
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
    const flatItems = buildFlatItems();
    if (flatItems.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="gm-characters-empty">Немає спорядження для цього фільтра</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = flatItems.map((entry) => `
      <tr data-owner-type="${escapeHtml(entry.ownerType)}" data-owner-name="${escapeHtml(entry.ownerName)}" data-item-index="${entry.itemIndex}">
        <td>
          <input class="gm-cell-input" data-field="name" type="text" value="${escapeHtml(entry.item.name)}" />
        </td>
        <td>
          <input class="gm-cell-input" data-field="armor" type="text" value="${escapeHtml(entry.item.armor)}" />
        </td>
        <td>
          <input class="gm-cell-input" data-field="weight" type="text" value="${escapeHtml(entry.item.weight)}" />
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
    `).join('');
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

  async function updateItemField(entry, field, value) {
    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedEquipment];
      const nextItem = { ...normalizeEquipmentItem(nextItems[entry.itemIndex]) };
      nextItem[field] = value;
      nextItems[entry.itemIndex] = nextItem;
      unassignedEquipment = nextItems;
      await saveUnassignedEquipment();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return;
    const nextItems = [...(Array.isArray(row.equipment_json) ? row.equipment_json : [])].map(normalizeEquipmentItem);
    const nextItem = { ...normalizeEquipmentItem(nextItems[entry.itemIndex]) };
    nextItem[field] = value;
    nextItems[entry.itemIndex] = nextItem;
    const updated = await patchCharacterEquipment(row.character_name, nextItems);
    if (updated) replaceCharacterRow(updated);
  }

  async function moveItem(entry, targetOwner) {
    if (entry.ownerType === 'character' && entry.ownerName === targetOwner) return;
    if (entry.ownerType === 'unassigned' && targetOwner === FILTER_UNASSIGNED) return;

    let movedItem = null;

    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedEquipment];
      movedItem = normalizeEquipmentItem(nextItems.splice(entry.itemIndex, 1)[0]);
      unassignedEquipment = nextItems;
      await saveUnassignedEquipment();
    } else {
      const sourceRow = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
      if (!sourceRow) return;
      const sourceItems = [...(Array.isArray(sourceRow.equipment_json) ? sourceRow.equipment_json : [])].map(normalizeEquipmentItem);
      movedItem = normalizeEquipmentItem(sourceItems.splice(entry.itemIndex, 1)[0]);
      const updatedSource = await patchCharacterEquipment(sourceRow.character_name, sourceItems);
      if (updatedSource) replaceCharacterRow(updatedSource);
    }

    if (!movedItem) return;

    if (targetOwner === FILTER_UNASSIGNED) {
      unassignedEquipment = [...unassignedEquipment, movedItem];
      await saveUnassignedEquipment();
      return;
    }

    const targetRow = characterRows.find((candidate) => candidate.character_name === targetOwner);
    if (!targetRow) {
      unassignedEquipment = [...unassignedEquipment, movedItem];
      await saveUnassignedEquipment();
      return;
    }

    const targetItems = [...(Array.isArray(targetRow.equipment_json) ? targetRow.equipment_json : [])].map(normalizeEquipmentItem);
    targetItems.push(movedItem);
    const updatedTarget = await patchCharacterEquipment(targetRow.character_name, targetItems);
    if (updatedTarget) replaceCharacterRow(updatedTarget);
  }

  async function deleteItem(entry) {
    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedEquipment];
      nextItems.splice(entry.itemIndex, 1);
      unassignedEquipment = nextItems;
      await saveUnassignedEquipment();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return;
    const nextItems = [...(Array.isArray(row.equipment_json) ? row.equipment_json : [])].map(normalizeEquipmentItem);
    nextItems.splice(entry.itemIndex, 1);
    const updated = await patchCharacterEquipment(row.character_name, nextItems);
    if (updated) replaceCharacterRow(updated);
  }

  async function addItem(newItem, ownerValue) {
    if (ownerValue === FILTER_UNASSIGNED) {
      unassignedEquipment = [...unassignedEquipment, normalizeEquipmentItem(newItem)];
      await saveUnassignedEquipment();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === ownerValue);
    if (!row) {
      unassignedEquipment = [...unassignedEquipment, normalizeEquipmentItem(newItem)];
      await saveUnassignedEquipment();
      return;
    }

    const nextItems = [...(Array.isArray(row.equipment_json) ? row.equipment_json : [])].map(normalizeEquipmentItem);
    nextItems.push(normalizeEquipmentItem(newItem));
    const updated = await patchCharacterEquipment(row.character_name, nextItems);
    if (updated) replaceCharacterRow(updated);
  }

  async function submitCreateModal() {
    const nextItem = normalizeEquipmentItem({
      name: modalNameInput.value || '',
      armor: modalArmorInput.value || '',
      weight: modalWeightInput.value || '',
    });

    const ownerValue = modalOwnerSelect.value || FILTER_UNASSIGNED;
    await addItem(nextItem, ownerValue);
    closeCreateModal();
    await refreshAll();
  }

  async function refreshAll() {
    if (!ensureActive()) return;
    await loadCharacterRows();
    await loadUnassignedEquipment();
    renderFilterOptions();
    renderTable();
  }

  function bindMetadataListener() {
    if (!OBR || metadataListenerBound) return;
    metadataListenerBound = true;

    OBR.room.onMetadataChange(async (metadata) => {
      if (!ensureActive()) return;
      if (Array.isArray(metadata?.[UNASSIGNED_EQUIPMENT_KEY])) {
        unassignedEquipment = metadata[UNASSIGNED_EQUIPMENT_KEY].map(normalizeEquipmentItem);
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
      window.alert('Не вдалося додати спорядження');
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
      window.alert('Не вдалося перепризначити спорядження');
    }
  });

  tbody.addEventListener('blur', async (event) => {
    const target = event.target;
    if (!target.matches('[data-field="name"], [data-field="armor"], [data-field="weight"]')) return;

    const entry = getEntryFromElement(target);
    if (!entry) return;

    try {
      await updateItemField(entry, target.getAttribute('data-field'), target.value || '');
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
      if (button.getAttribute('data-action') === 'delete') {
        const ok = window.confirm('Видалити це спорядження?');
        if (!ok) return;
        await deleteItem(entry);
        await refreshAll();
      }
    } catch (error) {
      console.error(error);
      window.alert('Не вдалося видалити спорядження');
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
        <td colspan="5" class="gm-characters-empty">Не вдалося завантажити список спорядження</td>
      </tr>
    `;
  });
}
