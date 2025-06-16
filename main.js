import OBR from '@owlbear-rodeo/sdk';

// === КОНСТАНТИ ===
const DARQIE_SHEETS_KEY = 'darqie.characterSheets';
const DEBOUNCE_DELAY = 300;
const UPLOADCARE_PUBLIC_KEY = '7d0fa9d84ac0680d6d83';

// === ГЛОБАЛЬНІ ЗМІННІ ===
let characterSheets = [];
let activeSheetIndex = 0;
let saveTimer = null;
let currentPlayerName = '';
let isGM = false;

// === УТИЛІТИ ===
function debounce(func, delay) {
  return function(...args) {
    const context = this;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => func.apply(context, args), delay);
  };
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
    intelligenceScore: document.getElementById('intelligenceScore'),
    wisdomScore: document.getElementById('wisdomScore'),
    charismaScore: document.getElementById('charismaScore'),
    healthPoints: document.getElementById('healthPoints'),
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
  };
}

function updateModifiers() {
  const stats = [
    ['strengthScore', 'strengthModifier'],
    ['dexterityScore', 'dexterityModifier'],
    ['constitutionScore', 'constitutionModifier'],
    ['intelligenceScore', 'intelligenceModifier'],
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
}

// === РОБОТА З ДАНИМИ ===
const debouncedSaveSheetData = debounce(saveSheetData, DEBOUNCE_DELAY);

async function saveSheetData() {
  if (characterSheets.length === 0) return;

  const sheet = characterSheets[activeSheetIndex];
  const elements = getSheetInputElements();
  const previousPlayerName = sheet.playerName;

  // Збереження основних полів
  for (const key in elements) {
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

  // Збереження в OBR
  const currentMetadata = await OBR.room.getMetadata();
  await OBR.room.setMetadata({ 
    ...currentMetadata, 
    [DARQIE_SHEETS_KEY]: characterSheets 
  });

  // Повідомлення про призначення персонажа
  if (isGM && sheet.playerName && sheet.playerName !== previousPlayerName) {
    await OBR.broadcast.sendMessage("character-assignment", {
      playerName: sheet.playerName,
      characterName: sheet.characterName || 'Без назви'
    });
  }

  updateCharacterDropdown();
  updateDeathOverlay();
}

function loadSheetData() {
  if (characterSheets.length === 0) return;
  
  const sheet = characterSheets[activeSheetIndex];
  const elements = getSheetInputElements();

  // Завантаження основних полів
  for (const key in elements) {
    if (elements[key]) {
      if (key === 'characterPhoto') {
        elements[key].src = sheet[key] || '/no-image-placeholder.svg';
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

  updateModifiers();
  updateDeathOverlay();
}

// === ІНТЕРФЕЙС ===
async function updateCharacterDropdown() {
  const characterSelect = document.getElementById('characterSelect');
  if (!characterSelect) return;

  const visibleSheets = characterSheets
    .map((sheet, index) => ({ ...sheet, index }))
    .filter(sheet => isGM || sheet.playerName === currentPlayerName);

  const previousIndex = activeSheetIndex;
  characterSelect.innerHTML = '';

  visibleSheets.forEach(sheet => {
    const option = document.createElement('option');
    option.value = sheet.index;
    option.textContent = sheet.characterName || `Персонаж ${sheet.index + 1}`;
    characterSelect.appendChild(option);
  });

  const sheetContainer = document.getElementById('characterSheetContainer');

  if (visibleSheets.length === 0) {
    if (sheetContainer) sheetContainer.style.display = 'none';
    await OBR.notification.show("У вас ще немає персонажів.", "info");
    return;
  }

  const isActiveVisible = visibleSheets.some(sheet => sheet.index === previousIndex);
  activeSheetIndex = isActiveVisible ? previousIndex : visibleSheets[0].index;

  characterSelect.value = activeSheetIndex;
  if (sheetContainer) sheetContainer.style.display = 'block';

  loadSheetData();
  populatePlayerSelect();
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
  
  // Підключення основних полів
  Object.values(elements).forEach(el => {
    if (el) el.addEventListener('input', debouncedSaveSheetData);
  });

  // Підключення чекбоксів
  ['deathSavesSuccess1', 'deathSavesSuccess2', 'deathSavesSuccess3',
   'deathSavesFailure1', 'deathSavesFailure2', 'deathSavesFailure3',
   'inspirationCheckbox', 'advantageCheckbox', 'disadvantageCheckbox'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', function() {
      debouncedSaveSheetData();
      if (id.startsWith('deathSavesFailure')) updateDeathOverlay();
    });
  });

  // Підключення вибору персонажа
  const characterSelect = document.getElementById('characterSelect');
  if (characterSelect) {
    characterSelect.addEventListener('change', () => {
      activeSheetIndex = parseInt(characterSelect.value, 10);
      loadSheetData();
      populatePlayerSelect();
    });
  }

  // Підключення модифікаторів до характеристик
  ['strengthScore', 'dexterityScore', 'constitutionScore', 
   'intelligenceScore', 'wisdomScore', 'charismaScore'].forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('input', updateModifiers);
    }
  });
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

  // Блокування кнопок для не-GM
  if (!isGM) {
    [addBtn, delBtn].forEach(btn => {
      if (btn) {
        btn.setAttribute('disabled', 'true');
        btn.style.opacity = '0.5';
        btn.style.pointerEvents = 'none';
        btn.title = 'Доступно лише для GM';
      }
    });
  }

  // Додавання персонажа
  if (addBtn && isGM) {
    addBtn.addEventListener('click', async () => {
      const newSheet = {
        characterName: '',
        playerName: '',
        characterClassLevel: '',
        background: '',
        characterRace: '',
        alignment: '',
        strengthScore: '10',
        dexterityScore: '10',
        constitutionScore: '10',
        intelligenceScore: '10',
        wisdomScore: '10',
        charismaScore: '10',
        healthPoints: '',
        armorClass: '',
        initiative: '',
        speed: '',
        proficienciesAndLanguages: '',
        equipment: '',
        alliesAndOrganizations: '',
        characterHistory: '',
        additionalFeatures: '',
        notes: '',
        characterPhoto: '/no-image-placeholder.svg',
        deathSavesSuccess: [false, false, false],
        deathSavesFailure: [false, false, false],
      };

      characterSheets.push(newSheet);
      activeSheetIndex = characterSheets.length - 1;

      updateCharacterDropdown();
      loadSheetData();
      populatePlayerSelect();
      await saveSheetData();
    });
  }

  // Видалення персонажа
  if (delBtn && isGM) {
    delBtn.addEventListener('click', async () => {
      if (!confirm('Ви дійсно хочете видалити цього персонажа?')) return;

      characterSheets.splice(activeSheetIndex, 1);

      if (characterSheets.length === 0) {
        activeSheetIndex = 0;
      } else {
        activeSheetIndex = Math.min(activeSheetIndex, characterSheets.length - 1);
      }

      updateCharacterDropdown();
      loadSheetData();
      populatePlayerSelect();
      await saveSheetData();
    });
  }
}

function setupPhotoButtons() {
  const photoBtn = document.getElementById('replacePhotoButton');
  const deletePhotoBtn = document.getElementById('deletePhotoButton');
  const photoInput = document.getElementById('photoFileInput');
  const photoImg = document.getElementById('characterPhotoImg');

  if (!photoBtn || !photoInput || !photoImg || !deletePhotoBtn) return;

  // Завантаження фото
  photoBtn.addEventListener('click', () => {
    photoInput.value = '';
    photoInput.click();
  });

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('UPLOADCARE_STORE', '1');
    formData.append('UPLOADCARE_PUB_KEY', UPLOADCARE_PUBLIC_KEY);
    formData.append('file', file);

    try {
      const response = await fetch('https://upload.uploadcare.com/base/', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (result?.file) {
        const imageUrl = `https://ucarecdn.com/${result.file}/`;
        photoImg.src = imageUrl;

        if (characterSheets[activeSheetIndex]) {
          characterSheets[activeSheetIndex].characterPhoto = imageUrl;
          await saveSheetData();
        }
      } else {
        alert('Помилка при завантаженні фото.');
      }
    } catch (err) {
      console.error('Photo upload error:', err);
      alert('Помилка з\'єднання із Uploadcare.');
    }
  });

  // Видалення фото
  deletePhotoBtn.addEventListener('click', async () => {
    if (!confirm('Ви дійсно хочете видалити фото персонажа?')) return;

    if (characterSheets[activeSheetIndex]) {
      characterSheets[activeSheetIndex].characterPhoto = '/no-image-placeholder.svg';
      photoImg.src = '/no-image-placeholder.svg';
      await saveSheetData();
    }
  });
}

function updateDeathOverlay() {
  const fail1 = document.getElementById('deathSavesFailure1')?.checked;
  const fail2 = document.getElementById('deathSavesFailure2')?.checked;
  const fail3 = document.getElementById('deathSavesFailure3')?.checked;
  const photoContainer = document.querySelector('.photo-container');
  let overlay = document.getElementById('deathOverlay');

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
      overlay.innerHTML = `<i class="fas fa-thumbs-down" style="font-size: 15em; color: red; opacity: 0.5;"></i>`;
      photoContainer.appendChild(overlay);
    }
  } else {
    if (overlay) overlay.remove();
  }
}

// === ІНІЦІАЛІЗАЦІЯ ===
window.addEventListener('load', async () => {
  await OBR.onReady(async () => {
    // Отримання інформації про гравця
    currentPlayerName = await OBR.player.getName();
    isGM = (await OBR.player.getRole()) === 'GM';

    // Завантаження даних
    const metadata = await OBR.room.getMetadata();
    const raw = metadata[DARQIE_SHEETS_KEY];
    characterSheets = Array.isArray(raw) ? raw : [];

    // Налаштування інтерфейсу
    setupCharacterButtons();
    setupPhotoButtons();
    setupStatButtons();
    updateCharacterDropdown();
    connectInputsToSave();

    // Підписка на зміни
    OBR.room.onMetadataChange(async (metadata) => {
      const newSheets = metadata[DARQIE_SHEETS_KEY] || [];
      if (JSON.stringify(newSheets) !== JSON.stringify(characterSheets)) {
        characterSheets = newSheets;
        updateCharacterDropdown();
        connectInputsToSave();
      }
    });

    OBR.party.onChange(() => {
      populatePlayerSelect();
    });

    // Обробка призначення персонажів
    OBR.broadcast.onMessage("character-assignment", async (data) => {
      if (data.playerName === currentPlayerName) {
        const metadata = await OBR.room.getMetadata();
        const raw = metadata[DARQIE_SHEETS_KEY];
        characterSheets = Array.isArray(raw) ? raw : [];

        const visibleSheets = characterSheets
          .map((sheet, index) => ({ ...sheet, index }))
          .filter(sheet => sheet.playerName === currentPlayerName);

        if (visibleSheets.length > 0) {
          activeSheetIndex = visibleSheets[0].index;
        }

        updateCharacterDropdown();
        connectInputsToSave();
      }
    });
  });
});
