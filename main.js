import OBR from '@owlbear-rodeo/sdk';

const DARQIE_SHEETS_KEY = 'darqie.characterSheets';
const MAX_SHEETS = 10;
const DEBOUNCE_DELAY = 300;
const UPLOADCARE_PUBLIC_KEY = '7d0fa9d84ac0680d6d83';

let characterSheets = [];
let activeSheetIndex = 0;
let saveTimer = null;
let currentPlayerName = '';
let isGM = false;

function debounce(func, delay) {
  return function (...args) {
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
function connectInputsToSave() {
  const elements = getSheetInputElements();
  Object.values(elements).forEach(el => {
    if (el) el.addEventListener('input', debouncedSaveSheetData);
  });

  ['deathSavesSuccess1', 'deathSavesSuccess2', 'deathSavesSuccess3',
   'deathSavesFailure1', 'deathSavesFailure2', 'deathSavesFailure3'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', debouncedSaveSheetData);
  });

  const characterSelect = document.getElementById('characterSelect');
  if (characterSelect) {
    characterSelect.addEventListener('change', () => {
      activeSheetIndex = parseInt(characterSelect.value, 10);
      loadSheetData();
      populatePlayerSelect();
    });
  }
}

async function populatePlayerSelect() {
  const select = document.getElementById('playerNameSelect');
  if (!select) return;

  const currentSheet = characterSheets[activeSheetIndex];
  const players = await OBR.party.getPlayers();

  select.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '—';
  select.appendChild(empty);

  players.forEach(player => {
    const option = document.createElement('option');
    option.value = player.name;
    option.textContent = player.name;
    select.appendChild(option);
  });

  const assignedName = currentSheet.playerName;

  if (!isGM) {
    select.value = assignedName || '';
    select.setAttribute('disabled', 'true');
  } else {
    select.value = assignedName || '';
    select.removeAttribute('disabled');
  }
}

async function saveSheetData() {
  if (characterSheets.length === 0) return;

  const sheet = characterSheets[activeSheetIndex];
  const elements = getSheetInputElements();
  const previousPlayerName = sheet.playerName;

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

  sheet.deathSavesSuccess = [
    document.getElementById('deathSavesSuccess1').checked,
    document.getElementById('deathSavesSuccess2').checked,
    document.getElementById('deathSavesSuccess3').checked
  ];
  sheet.deathSavesFailure = [
    document.getElementById('deathSavesFailure1').checked,
    document.getElementById('deathSavesFailure2').checked,
    document.getElementById('deathSavesFailure3').checked
  ];

  await OBR.room.setMetadata({ [DARQIE_SHEETS_KEY]: characterSheets });
  console.log(`Лист "${sheet.characterName || 'Без назви'}" збережено.`);

  if (isGM && sheet.playerName && sheet.playerName !== previousPlayerName) {
    await OBR.broadcast.sendMessage("character-assignment", {
      playerName: sheet.playerName,
      characterName: sheet.characterName || 'Без назви'
    });
  }

  updateCharacterDropdown();
}

const debouncedSaveSheetData = debounce(saveSheetData, DEBOUNCE_DELAY);
function loadSheetData() {
  const sheet = characterSheets[activeSheetIndex];
  const elements = getSheetInputElements();

  for (const key in elements) {
    if (elements[key]) {
      if (key === 'characterPhoto') {
        elements[key].src = sheet[key] || '/icon.svg';
      } else {
        elements[key].value = sheet[key] || '';
      }
    }
  }

  const success = sheet.deathSavesSuccess || [false, false, false];
  const failure = sheet.deathSavesFailure || [false, false, false];

  ['deathSavesSuccess1', 'deathSavesSuccess2', 'deathSavesSuccess3'].forEach((id, i) => {
    document.getElementById(id).checked = success[i];
  });

  ['deathSavesFailure1', 'deathSavesFailure2', 'deathSavesFailure3'].forEach((id, i) => {
    document.getElementById(id).checked = failure[i];
  });
}

function updateCharacterDropdown() {
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
  const noCharMsg = document.getElementById('noCharacterMessage');

  if (visibleSheets.length === 0) {
    if (sheetContainer) sheetContainer.style.display = 'none';
    if (noCharMsg) noCharMsg.style.display = 'block';
    return;
  }

  const isActiveVisible = visibleSheets.some(sheet => sheet.index === previousIndex);
  activeSheetIndex = isActiveVisible ? previousIndex : visibleSheets[0].index;

  characterSelect.value = activeSheetIndex;
  if (sheetContainer) sheetContainer.style.display = 'block';
  if (noCharMsg) noCharMsg.style.display = 'none';

  loadSheetData();
  populatePlayerSelect();
}

function setupCharacterButtons() {
  const addBtn = document.getElementById('addCharacterButton');
  const delBtn = document.getElementById('deleteCharacterButton');
  const photoBtn = document.getElementById('replacePhotoButton');
  const deletePhotoBtn = document.getElementById('deletePhotoButton');
  const photoInput = document.getElementById('photoFileInput');
  const photoImg = document.getElementById('characterPhotoImg');

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

  if (addBtn && isGM) {
    addBtn.addEventListener('click', async () => {
      if (characterSheets.length >= MAX_SHEETS) {
        alert(`Досягнуто максимум (${MAX_SHEETS}) персонажів`);
        return;
      }

      const newSheet = {
        characterName: '',
        playerName: '',
        characterClassLevel: '',
        background: '',
        characterRace: '',
        alignment: '',
        strengthScore: '',
        dexterityScore: '',
        constitutionScore: '',
        intelligenceScore: '',
        wisdomScore: '',
        charismaScore: '',
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
        characterPhoto: '/icon.svg',
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

  if (delBtn && isGM) {
    delBtn.addEventListener('click', async () => {
      if (!confirm('Ви дійсно хочете видалити цього персонажа?')) return;
      characterSheets.splice(activeSheetIndex, 1);
      activeSheetIndex = Math.max(0, activeSheetIndex - 1);
      await saveSheetData();
      updateCharacterDropdown();
      loadSheetData();
      populatePlayerSelect();
    });
  }

  if (photoBtn && photoInput && photoImg && deletePhotoBtn) {
    photoBtn.addEventListener('click', () => {
      photoInput.value = ''; // очищення для повторного вибору того ж файлу
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

        if (result && result.file) {
          const imageUrl = `https://ucarecdn.com/${result.file}/`;
          photoImg.src = imageUrl;

          const sheet = characterSheets[activeSheetIndex];
          sheet.characterPhoto = imageUrl;

          await saveSheetData();
        } else {
          alert('Помилка при завантаженні фото.');
        }
      } catch (err) {
        console.error(err);
        alert('Помилка з’єднання із Uploadcare.');
      }
    });

    deletePhotoBtn.addEventListener('click', async () => {
      if (!confirm('Ви дійсно хочете видалити фото персонажа?')) return;

      const sheet = characterSheets[activeSheetIndex];
      sheet.characterPhoto = '/icon.svg';

      if (photoImg) {
        photoImg.src = '/icon.svg';
      }

      await saveSheetData();
    });
  }
}

window.addEventListener('load', async () => {
  await OBR.onReady(async () => {
    currentPlayerName = await OBR.player.getName();
    isGM = (await OBR.player.getRole()) === 'GM';

    const metadata = await OBR.room.getMetadata();
    characterSheets = metadata[DARQIE_SHEETS_KEY] || [];

    setupCharacterButtons();
    updateCharacterDropdown();
    connectInputsToSave();

    OBR.room.onMetadataChange(async (metadata) => {
      const newSheets = metadata[DARQIE_SHEETS_KEY] || [];
      if (JSON.stringify(newSheets) !== JSON.stringify(characterSheets)) {
        characterSheets = newSheets;
        updateCharacterDropdown();
        connectInputsToSave();
      }
    });

    OBR.broadcast.onMessage("character-assignment", async (data) => {
      if (data.playerName === currentPlayerName) {
        const metadata = await OBR.room.getMetadata();
        characterSheets = metadata[DARQIE_SHEETS_KEY] || [];

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
