const SUPABASE_URL = 'https://yoaazfbttqfanxackrvv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvYWF6ZmJ0dHFmYW54YWNrcnZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwOTYwMDIsImV4cCI6MjA4OTY3MjAwMn0.NnU7pE9CsVKduI6ZPUmoTql1Vxxw4YFcbXRvJiOUu8E';
const CHARACTER_TYPE_NPC = 'npc';
const DARQIE_ROOM_ID_KEY = 'darqie.lastRoomId';
const UNASSIGNED_SKILLS_KEY = 'darqie.v2.unassignedSkills';
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

function normalizeSkillItem(item) {
  return {
    name: String(item?.name || ''),
    bonus: String(item?.bonus || ''),
    desc: String(item?.desc || ''),
  };
}

function normalizeCharacterRow(row) {
  return {
    ...(row || {}),
    character_name: String(row?.character_name || '').trim(),
    player_name: String(row?.player_name || '').trim(),
    extra_data: { ...(row?.extra_data || {}) },
    skills_json: Array.isArray(row?.skills_json) ? row.skills_json.map(normalizeSkillItem) : [],
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

  const tbody = root.querySelector('#gmSkillsTableBody');
  const addButton = root.querySelector('#gmAddSkillButton');
  const filterSelect = root.querySelector('#gmSkillsFilterSelect');
  const createModal = root.querySelector('#gmSkillCreateModal');
  const modalNameInput = root.querySelector('#gmSkillModalNameInput');
  const modalDescInput = root.querySelector('#gmSkillModalDescInput');
  const modalOwnerSelect = root.querySelector('#gmSkillModalOwnerSelect');
  const modalSaveButton = root.querySelector('#gmSkillModalSaveButton');
  const modalCancelButton = root.querySelector('#gmSkillModalCancelButton');
  if (!tbody || !addButton || !filterSelect || !createModal || !modalNameInput || !modalDescInput || !modalOwnerSelect || !modalSaveButton || !modalCancelButton) return;

  let OBR = null;
  let roomId = '';
  let characterRows = [];
  let unassignedSkills = [];
  let filterValue = FILTER_ALL;
  let isDestroyed = false;
  let metadataListenerBound = false;

  function ensureActive() {
    const stillActive = root.isConnected && document.body.contains(root);
    if (stillActive) return true;
    isDestroyed = true;
    return false;
  }

  async function broadcastOpenSkillPopover(skillName, skillDescription) {
    if (!OBR) return;
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
    } catch (_) {
      // Ignore broadcast failures to keep table interactions responsive.
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

  async function loadUnassignedSkills() {
    if (!OBR) {
      unassignedSkills = [];
      return;
    }

    try {
      const metadata = await OBR.room.getMetadata();
      const raw = Array.isArray(metadata?.[UNASSIGNED_SKILLS_KEY]) ? metadata[UNASSIGNED_SKILLS_KEY] : [];
      unassignedSkills = raw.map(normalizeSkillItem);
    } catch (_) {
      unassignedSkills = [];
    }
  }

  async function saveUnassignedSkills() {
    if (!OBR) return;

    const metadata = await OBR.room.getMetadata();
    await OBR.room.setMetadata({
      ...metadata,
      [UNASSIGNED_SKILLS_KEY]: unassignedSkills.map(normalizeSkillItem),
    });
  }

  async function patchCharacterSkills(characterName, skills) {
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
          skills_json: skills.map(normalizeSkillItem),
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
    modalDescInput.value = '';
    renderModalOwnerOptions(defaultOwner);
    createModal.hidden = false;
    modalNameInput.focus();
  }

  function closeCreateModal() {
    createModal.hidden = true;
  }

  function buildFlatSkills() {
    const assigned = characterRows.flatMap((row) =>
      (Array.isArray(row.skills_json) ? row.skills_json : []).map((skill, index) => ({
        ownerType: 'character',
        ownerName: row.character_name,
        ownerLabel: row.character_name,
        itemIndex: index,
        item: normalizeSkillItem(skill),
      }))
    );

    const unassigned = unassignedSkills.map((skill, index) => ({
      ownerType: 'unassigned',
      ownerName: '',
      ownerLabel: 'Непризначені',
      itemIndex: index,
      item: normalizeSkillItem(skill),
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
    const flatSkills = buildFlatSkills();
    if (flatSkills.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" class="gm-characters-empty">Немає навичок для цього фільтра</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = flatSkills.map((entry) => `
      <tr data-owner-type="${escapeHtml(entry.ownerType)}" data-owner-name="${escapeHtml(entry.ownerName)}" data-item-index="${entry.itemIndex}">
        <td>
          <input class="gm-cell-input" data-field="name" type="text" value="${escapeHtml(entry.item.name)}" />
        </td>
        <td>
          <textarea class="gm-cell-input gm-skill-desc-input" data-field="desc" rows="1">${escapeHtml(entry.item.desc)}</textarea>
        </td>
        <td>${buildOwnerSelect(entry)}</td>
        <td>
          <div class="gm-row-actions">
            <button type="button" class="gm-row-btn" data-action="share" title="Поділитись">
              <i class="fas fa-comments"></i>
            </button>
            <button type="button" class="gm-row-btn gm-row-btn--danger" data-action="delete" title="Видалити">
              <i class="fas fa-trash-alt"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join('');

    resizeDescriptionCells();
    requestAnimationFrame(() => {
      resizeDescriptionCells();
    });
  }

  function resizeDescriptionCells() {
    const rows = tbody.querySelectorAll('tr[data-owner-type][data-item-index]');
    rows.forEach((tr) => {
      const textarea = tr.querySelector('textarea[data-field="desc"]');
      if (!textarea) return;

      textarea.style.height = 'auto';
      const descHeight = Math.max(textarea.scrollHeight, 24);
      const rowHeight = descHeight + 8;
      textarea.style.setProperty('height', `${descHeight}px`, 'important');

      tr.style.setProperty('height', `${rowHeight}px`, 'important');

      const cells = tr.querySelectorAll('td');
      cells.forEach((td) => {
        td.style.setProperty('height', `${rowHeight}px`, 'important');
      });

      const nameInput = tr.querySelector('input[data-field="name"]');
      if (nameInput) {
        nameInput.style.setProperty('height', `${rowHeight - 8}px`, 'important');
      }

      const ownerSelect = tr.querySelector('select[data-field="owner"]');
      if (ownerSelect) {
        ownerSelect.style.setProperty('height', `${rowHeight - 8}px`, 'important');
      }

      const actions = tr.querySelector('.gm-row-actions');
      if (actions) {
        actions.style.setProperty('height', `${rowHeight - 8}px`, 'important');
      }
    });
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
      return normalizeSkillItem(unassignedSkills[entry.itemIndex]);
    }

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return null;
    const items = Array.isArray(row.skills_json) ? row.skills_json : [];
    return normalizeSkillItem(items[entry.itemIndex]);
  }

  async function updateItemField(entry, field, value) {
    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedSkills];
      const nextItem = { ...normalizeSkillItem(nextItems[entry.itemIndex]) };
      nextItem[field] = value;
      nextItems[entry.itemIndex] = nextItem;
      unassignedSkills = nextItems;
      await saveUnassignedSkills();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return;
    const nextSkills = [...(Array.isArray(row.skills_json) ? row.skills_json : [])].map(normalizeSkillItem);
    const nextItem = { ...normalizeSkillItem(nextSkills[entry.itemIndex]) };
    nextItem[field] = value;
    nextSkills[entry.itemIndex] = nextItem;
    const updated = await patchCharacterSkills(row.character_name, nextSkills);
    if (updated) replaceCharacterRow(updated);
  }

  async function moveItem(entry, targetOwner) {
    if (entry.ownerType === 'character' && entry.ownerName === targetOwner) return;
    if (entry.ownerType === 'unassigned' && targetOwner === FILTER_UNASSIGNED) return;

    let movedItem = null;

    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedSkills];
      movedItem = normalizeSkillItem(nextItems.splice(entry.itemIndex, 1)[0]);
      unassignedSkills = nextItems;
      await saveUnassignedSkills();
    } else {
      const sourceRow = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
      if (!sourceRow) return;
      const sourceItems = [...(Array.isArray(sourceRow.skills_json) ? sourceRow.skills_json : [])].map(normalizeSkillItem);
      movedItem = normalizeSkillItem(sourceItems.splice(entry.itemIndex, 1)[0]);
      const updatedSource = await patchCharacterSkills(sourceRow.character_name, sourceItems);
      if (updatedSource) replaceCharacterRow(updatedSource);
    }

    if (!movedItem) return;

    if (targetOwner === FILTER_UNASSIGNED) {
      unassignedSkills = [...unassignedSkills, movedItem];
      await saveUnassignedSkills();
      return;
    }

    const targetRow = characterRows.find((candidate) => candidate.character_name === targetOwner);
    if (!targetRow) {
      unassignedSkills = [...unassignedSkills, movedItem];
      await saveUnassignedSkills();
      return;
    }

    const targetItems = [...(Array.isArray(targetRow.skills_json) ? targetRow.skills_json : [])].map(normalizeSkillItem);
    targetItems.push(movedItem);
    const updatedTarget = await patchCharacterSkills(targetRow.character_name, targetItems);
    if (updatedTarget) replaceCharacterRow(updatedTarget);
  }

  async function deleteItem(entry) {
    if (entry.ownerType === 'unassigned') {
      const nextItems = [...unassignedSkills];
      nextItems.splice(entry.itemIndex, 1);
      unassignedSkills = nextItems;
      await saveUnassignedSkills();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === entry.ownerName);
    if (!row) return;
    const nextItems = [...(Array.isArray(row.skills_json) ? row.skills_json : [])].map(normalizeSkillItem);
    nextItems.splice(entry.itemIndex, 1);
    const updated = await patchCharacterSkills(row.character_name, nextItems);
    if (updated) replaceCharacterRow(updated);
  }

  async function addItem(newItem, ownerValue) {
    if (ownerValue === FILTER_UNASSIGNED) {
      unassignedSkills = [...unassignedSkills, normalizeSkillItem(newItem)];
      await saveUnassignedSkills();
      return;
    }

    const row = characterRows.find((candidate) => candidate.character_name === ownerValue);
    if (!row) {
      unassignedSkills = [...unassignedSkills, normalizeSkillItem(newItem)];
      await saveUnassignedSkills();
      return;
    }

    const nextItems = [...(Array.isArray(row.skills_json) ? row.skills_json : [])].map(normalizeSkillItem);
    nextItems.push(normalizeSkillItem(newItem));
    const updated = await patchCharacterSkills(row.character_name, nextItems);
    if (updated) replaceCharacterRow(updated);
  }

  async function submitCreateModal() {
    const nextItem = normalizeSkillItem({
      name: modalNameInput.value || '',
      desc: modalDescInput.value || '',
    });

    const ownerValue = modalOwnerSelect.value || FILTER_UNASSIGNED;
    await addItem(nextItem, ownerValue);
    closeCreateModal();
    await refreshAll();
  }

  async function refreshAll() {
    if (!ensureActive()) return;
    await loadCharacterRows();
    await loadUnassignedSkills();
    renderFilterOptions();
    renderTable();
  }

  function bindMetadataListener() {
    if (!OBR || metadataListenerBound) return;
    metadataListenerBound = true;

    OBR.room.onMetadataChange(async (metadata) => {
      if (!ensureActive()) return;
      if (Array.isArray(metadata?.[UNASSIGNED_SKILLS_KEY])) {
        unassignedSkills = metadata[UNASSIGNED_SKILLS_KEY].map(normalizeSkillItem);
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
      window.alert('Не вдалося додати навичку');
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

  window.addEventListener('resize', () => {
    resizeDescriptionCells();
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
      window.alert('Не вдалося перепризначити навичку');
    }
  });

  tbody.addEventListener('blur', async (event) => {
    const target = event.target;
    if (!target.matches('[data-field="name"], [data-field="desc"]')) return;

    const entry = getEntryFromElement(target);
    if (!entry) return;

    try {
      await updateItemField(entry, target.getAttribute('data-field'), target.value || '');
    } catch (error) {
      console.error(error);
    }
  }, true);

  tbody.addEventListener('input', (event) => {
    const target = event.target;
    if (!target.matches('textarea[data-field="desc"]')) return;
    resizeDescriptionCells();
  });

  tbody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const entry = getEntryFromElement(button);
    if (!entry) return;

    try {
      const action = button.getAttribute('data-action');
      if (action === 'share') {
        const item = getItemByEntry(entry);
        if (!item) return;
        await broadcastOpenSkillPopover(item.name || '', item.desc || '');
        return;
      }

      if (action === 'delete') {
        const ok = window.confirm('Видалити цю навичку?');
        if (!ok) return;
        await deleteItem(entry);
        await refreshAll();
      }
    } catch (error) {
      console.error(error);
      window.alert('Не вдалося видалити навичку');
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
        <td colspan="4" class="gm-characters-empty">Не вдалося завантажити список навичок</td>
      </tr>
    `;
  });
}
