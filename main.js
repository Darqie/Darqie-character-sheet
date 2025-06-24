import OBR from '@owlbear-rodeo/sdk';

// === КОНСТАНТИ ===
const DARQIE_SHEETS_KEY = 'darqie.characterSheets';
const DEBOUNCE_DELAY = 600;
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
    intelligenceScore: document.getElementById('intelligenceScore'),
    wisdomScore: document.getElementById('wisdomScore'),
    charismaScore: document.getElementById('charismaScore'),
    maxHealthPoints: document.getElementById('maxHealthPoints'),
    health: document.getElementById('health'),
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

  // Автоматичний розрахунок максимальної ваги на основі сили
  updateMaxWeight();
  // Автоматичний розрахунок швидкості на основі спритності
  updateSpeed();
  // Автоматичний розрахунок максимального здоров'я на основі статури
  updateMaxHealth();
  // Автоматичний розрахунок броні на основі спорядження
  updateArmorClass();
  updateCurrentWeight();
}

function updateMaxWeight() {
  const strengthInput = document.getElementById('strengthScore');
  const maxWeightInput = document.getElementById('maxWeight');
  
  if (strengthInput && maxWeightInput) {
    let strengthValue = parseInt(strengthInput.value);
    if (isNaN(strengthValue) || strengthValue < 0) {
      strengthValue = 0;
    }
    
    // Максимальна вага = 50 + значення сили, але не більше 999
    const maxWeight = Math.min(50 + strengthValue, 999);
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
    
    // Базова броня = 10 + броня зі спорядження
    const armorClass = Math.min(10 + totalArmor, 99);
    armorClassInput.value = armorClass;
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

async function saveSheetData() {
  if (characterSheets.length === 0) return;

  const sheet = characterSheets[activeSheetIndex];
  const elements = getSheetInputElements();
  const previousPlayerName = sheet.playerName;

  // Збереження основних полів
  for (const key in elements) {
    if (['characterClassLevel','characterRace','background','alignment'].includes(key)) {
      // Якщо є textarea модалки — беремо з неї
      const modalMap = {
        characterClassLevel: 'modalCharacterClass',
        characterRace: 'modalCharacterRace',
        background: 'modalBackground',
        alignment: 'modalAlignment',
      };
      const modalEl = document.getElementById(modalMap[key]);
      if (modalEl) {
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
    // Отримуємо поточні метадані
    const currentMetadata = await OBR.room.getMetadata();
    const currentSheets = currentMetadata[DARQIE_SHEETS_KEY] || [];
    
    // Оновлюємо лист персонажа в масиві
    currentSheets[activeSheetIndex] = { ...sheet };
    
    // Зберігаємо оновлені дані
    await OBR.room.setMetadata({ 
      ...currentMetadata, 
      [DARQIE_SHEETS_KEY]: currentSheets 
    });

    // Оновлюємо локальні дані
    characterSheets = currentSheets;

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
  }
}

function loadSheetData() {
  const sheet = characterSheets[activeSheetIndex];
  if (!sheet) return;
  
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

  characterSheets = await getMetadata();
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

  const isActiveVisible = visibleSheets.some(sheet => sheet.index === previousIndex);
  activeSheetIndex = isActiveVisible ? previousIndex : visibleSheets[0].index;

  characterSelect.value = activeSheetIndex;

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

  // Підключення основних полів з обробниками тільки на blur і Enter
  Object.values(elements).forEach(el => {
    if (el) {
      el.addEventListener('blur', () => {
        setTimeout(() => saveSheetData(), 50);
      });
      el.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
          saveSheetData();
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
    'strengthScore', 'dexterityScore', 'constitutionScore', 'intelligenceScore', 'wisdomScore', 'charismaScore'
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
      });
      input.addEventListener('blur', () => {
      });
      input.addEventListener('blur', () => {
        setTimeout(() => saveSheetData(), 50);
      });
      input.addEventListener('change', () => {
        saveSheetData();
      });
      input.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') saveSheetData();
      });
    }
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

  // Автоматичний перерахунок швидких характеристик при втраті фокусу
  const speedInput = document.getElementById('speed');
  const maxHealthInput = document.getElementById('maxHealthPoints');
  const armorClassInput = document.getElementById('armorClass');

  if (speedInput) {
    speedInput.addEventListener('blur', updateSpeed);
  }
  if (maxHealthInput) {
    maxHealthInput.addEventListener('blur', updateMaxHealth);
  }
  if (armorClassInput) {
    armorClassInput.addEventListener('blur', updateArmorClass);
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
      try {
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
          maxHealthPoints: '',
          healing: '',
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
          maxWeight: '',
          currentWeight: '',
          deathSavesSuccess: [false, false, false],
          deathSavesFailure: [false, false, false],
        };

        // Отримуємо поточні дані
        const currentMetadata = await OBR.room.getMetadata();
        const currentSheets = currentMetadata[DARQIE_SHEETS_KEY] || [];
        
        // Додаємо нового персонажа
        const updatedSheets = [...currentSheets, newSheet];
        
        // Зберігаємо оновлені дані
        await OBR.room.setMetadata({
          ...currentMetadata,
          [DARQIE_SHEETS_KEY]: updatedSheets
        });

        // Оновлюємо локальні дані
        characterSheets = updatedSheets;
        activeSheetIndex = characterSheets.length - 1;

        // Оновлюємо інтерфейс
        updateCharacterDropdown();
        loadSheetData();
        populatePlayerSelect();
        
        // console.log('Новий персонаж створено успішно');
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

        // Отримуємо поточні дані
        const currentMetadata = await OBR.room.getMetadata();
        const currentSheets = currentMetadata[DARQIE_SHEETS_KEY] || [];
        
        // Видаляємо персонажа
        const updatedSheets = currentSheets.filter((_, index) => index !== activeSheetIndex);
        
        // Зберігаємо оновлені дані
        await OBR.room.setMetadata({
          ...currentMetadata,
          [DARQIE_SHEETS_KEY]: updatedSheets
        });

        // Оновлюємо локальні дані
        characterSheets = updatedSheets;
        if (characterSheets.length === 0) {
          activeSheetIndex = 0;
        } else {
          activeSheetIndex = Math.min(activeSheetIndex, characterSheets.length - 1);
        }

        // Оновлюємо інтерфейс
        updateCharacterDropdown();
        loadSheetData();
        populatePlayerSelect();
        
        // console.log('Персонаж видалено успішно');
      } catch (error) {
        console.error('Помилка при видаленні персонажа:', error);
      }
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

// Модифікуємо функцію checkCharacterAndRedirect
async function checkCharacterAndRedirect() {
    try {
        const metadata = await OBR.room.getMetadata();
        const sheets = metadata[DARQIE_SHEETS_KEY] || [];
        const currentPlayerName = await OBR.player.getName();
        
        const hasCharacter = sheets.some(sheet => sheet.playerName === currentPlayerName);
        const waitingBlock = document.getElementById('waitingBlock');
        const mainContent = document.getElementById('mainContent');

        if (!isGM) {
            if (hasCharacter) {
                if (waitingBlock) waitingBlock.style.display = 'none';
                if (mainContent) mainContent.style.display = 'flex';
                // Оновлюємо дані тільки якщо вони змінились
                if (JSON.stringify(characterSheets) !== JSON.stringify(sheets)) {
                    characterSheets = sheets;
                    await updateCharacterDropdown();
                }
            } else {
                if (waitingBlock) waitingBlock.style.display = 'flex';
                if (mainContent) mainContent.style.display = 'none';
            }
        } else {
            if (waitingBlock) waitingBlock.style.display = 'none';
            if (mainContent) mainContent.style.display = 'flex';
            // Для ГМ також оновлюємо тільки при зміні
            if (JSON.stringify(characterSheets) !== JSON.stringify(sheets)) {
                characterSheets = sheets;
                await updateCharacterDropdown();
            }
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

    // Додаємо підписку на зміни метаданих
    OBR.room.onMetadataChange(async (metadata) => {
        if (weaponEditing || skillEditing) return;
        const sheets = metadata[DARQIE_SHEETS_KEY] || [];
        // Оновлюємо тільки якщо дані дійсно змінились
        if (JSON.stringify(characterSheets) !== JSON.stringify(sheets)) {
            await checkCharacterAndRedirect();
        }
        
        // Обробляємо модальне вікно навичок
        const skillModalData = metadata.darqie?.skillModal;
        if (skillModalData && skillModalData.timestamp) {
            // Перевіряємо, чи це нове повідомлення (не старіше 5 секунд)
            const now = Date.now();
            if (now - skillModalData.timestamp < 5000) {
                openSkillModal(
                    skillModalData.skillName,
                    skillModalData.skillDescription,
                    skillModalData.playerName
                );
            }
        }
        // Обробляємо popover навичок
        const skillPopoverData = metadata.darqie?.skillPopover;
        if (skillPopoverData && skillPopoverData.timestamp) {
            // Перевіряємо, чи це нове повідомлення (не старіше 5 секунд)
            const now = Date.now();
            if (now - skillPopoverData.timestamp < 5000) {
                openSkillPopover(
                    skillPopoverData.skillName,
                    skillPopoverData.skillDescription,
                    skillPopoverData.playerName,
                    skillPopoverData.senderConnectionId
                );
            }
        }
        // Обробка сигналу закриття popover навички
        if (metadata.darqie?.closeSkillPopover) {
            if (window.OBR && window.OBR.popover) {
                window.OBR.popover.close();
            }
        }
    });

    // Додаємо підписку на повідомлення про призначення персонажа
    OBR.broadcast.onMessage("character-assignment", async (data) => {
        if (data.playerName === currentPlayerName) {
            await checkCharacterAndRedirect();
        }
    });

    // Додаємо затримку для підключення обробників модифікаторів
    setTimeout(() => {
      setupModifierButtons();
    }, 100);
}

// === ІНІЦІАЛІЗАЦІЯ ===
OBR.onReady(async () => {
    // Очищаємо старий запит
    await clearOldRollRequest();
    
    // Отримання інформації про гравця
    currentPlayerName = await OBR.player.getName();
    isGM = (await OBR.player.getRole()) === 'GM';

    // Налаштування інтерфейсу
    setupInterface(); // Викликаємо setupInterface для ініціалізації

    // Підписка на зміни в партії
    OBR.party.onChange(() => {
        populatePlayerSelect();
    });

    // Періодична перевірка наявності персонажа
    setInterval(async () => {
        await checkCharacterAndRedirect();
    }, 1000);
});

// Функція для отримання поточного персонажа
async function getCurrentCharacter() {
  const metadata = await OBR.room.getMetadata();
  const sheets = metadata[DARQIE_SHEETS_KEY] || [];
  const selectedCharacterId = document.getElementById('characterSelect').value;
  if (selectedCharacterId === undefined || selectedCharacterId === null || selectedCharacterId === '') return null;
  return sheets[parseInt(selectedCharacterId, 10)] || null;
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
  setValue('modalCharacterClass', character.characterClassLevel || 'Не вказано');
  setValue('modalCharacterRace', character.characterRace || 'Не вказано');
  setValue('modalBackground', character.background || 'Не вказано');
  setValue('modalAlignment', character.alignment || 'Не вказано');
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
  // Додаю прокручування сторінки вгору при відкритті модалки
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (currentCharacter) {
    updateModalInfo(currentCharacter);
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
  } else {
    // Якщо персонаж не вибраний, показуємо повідомлення
    const modalBody = document.querySelector('.modal-body');
    modalBody.innerHTML = '<p style="text-align: center; font-size: 1.2em;">Будь ласка, виберіть персонажа</p>';
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
  }

  // Додаємо обробники для запобігання закриття модального вікна при роботі з textarea
  modal.addEventListener('click', (event) => {
    // Запобігаємо закриттю при кліку всередині модального вікна
    event.stopPropagation();
  });

  // Запобігаємо закриттю при фокусі на textarea
  modal.querySelectorAll('textarea').forEach(textarea => {
    textarea.addEventListener('focus', () => {
      clearTimeout(modalClickTimeout);
    });
    
    textarea.addEventListener('click', (event) => {
      event.stopPropagation();
    });
  });
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
  }
  if (typeof debouncedSaveSheetData === 'function') debouncedSaveSheetData();
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
  let modalClickTimeout;
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

  // Обробники для модального вікна навичок
  const skillModal = document.getElementById('skillModal');
  const closeSkillModalBtn = document.getElementById('closeSkillModal');
  
  if (closeSkillModalBtn) {
    closeSkillModalBtn.addEventListener('click', closeSkillModal);
  }
  
  // Закриття модального вікна навичок при кліку поза ним
  if (skillModal) {
    skillModal.addEventListener('click', (event) => {
      if (event.target === skillModal) {
        closeSkillModal();
      }
    });
  }
  
  // Закриття модального вікна навичок при натисканні Escape
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const skillModal = document.getElementById('skillModal');
      if (skillModal && skillModal.style.display === 'block') {
        closeSkillModal();
      }
    }
  });

  // === Логіка редагування блоків у модалці ===
  const modalBlocks = [
    { field: 'Class', textarea: 'modalCharacterClass', edit: 'editModalClass', accept: 'acceptModalClass', cancel: 'cancelModalClass', mainField: 'characterClassLevel' },
    { field: 'Race', textarea: 'modalCharacterRace', edit: 'editModalRace', accept: 'acceptModalRace', cancel: 'cancelModalRace', mainField: 'characterRace' },
    { field: 'Background', textarea: 'modalBackground', edit: 'editModalBackground', accept: 'acceptModalBackground', cancel: 'cancelModalBackground', mainField: 'background' },
    { field: 'Alignment', textarea: 'modalAlignment', edit: 'editModalAlignment', accept: 'acceptModalAlignment', cancel: 'cancelModalAlignment', mainField: 'alignment' },
    { field: 'Appearance', textarea: 'modalAppearance', edit: 'editModalAppearance', accept: 'acceptModalAppearance', cancel: 'cancelModalAppearance', mainField: 'appearance' },
    { field: 'Languages', textarea: 'modallanguages', edit: 'editModalLanguages', accept: 'acceptModalLanguages', cancel: 'cancelModalLanguages', mainField: 'languages' },
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
          saveSheetData();
        }
      });
    }
  });

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
    renderWeaponTable(editing);
    // Додаю керування contenteditable для заголовка
    const weaponLabel = document.querySelector('.weapon-block .weapon-label');
    if (weaponLabel) weaponLabel.contentEditable = !!on;
    if (editBtn) editBtn.style.display = on ? 'none' : '';
    if (acceptBtn) acceptBtn.style.display = on ? '' : 'none';
    if (cancelBtn) cancelBtn.style.display = on ? '' : 'none';
    if (addRowBtn) addRowBtn.style.display = on ? '' : 'none';
    if (!on) {
      // Перед збереженням повністю перебудовуємо масив weaponRows з DOM (як у навичках)
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
      // Зберігаємо заголовок
      const weaponLabel = document.querySelector('.weapon-block .weapon-label');
      if (weaponLabel) {
        characterSheets[activeSheetIndex].weaponTitle = weaponLabel.textContent;
      }
      if (characterSheets[activeSheetIndex]) {
        characterSheets[activeSheetIndex].weapons = JSON.parse(JSON.stringify(weaponRows));
        debouncedSaveSheetData();
        updateCurrentWeight();
      }
    }
  }

  if (editBtn && acceptBtn && cancelBtn && addRowBtn) {
    renderWeaponTable(false);
    editBtn.addEventListener('click', () => {
      prevRows = JSON.parse(JSON.stringify(weaponRows));
      setEditingMode(true);
    });
    acceptBtn.addEventListener('click', () => {
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
    renderSkillTable(editingSkill);
    // Додаю керування contenteditable для заголовка навичок
    const skillLabel = document.querySelector('.skill-block .skill-label');
    if (skillLabel) skillLabel.contentEditable = !!on;
    if (editBtnSkill) editBtnSkill.style.display = on ? 'none' : '';
    if (acceptBtnSkill) acceptBtnSkill.style.display = on ? '' : 'none';
    if (cancelBtnSkill) cancelBtnSkill.style.display = on ? '' : 'none';
    if (addRowBtnSkill) addRowBtnSkill.style.display = on ? '' : 'none';
    if (!on) {
      // Перед збереженням повністю перебудовуємо масив skillRows з DOM
      const tbody = document.getElementById('skillTableBody');
      if (tbody) {
        skillRows = Array.from(tbody.children).map(tr => {
          const nameWrap = tr.querySelector('.skill-name-wrap');
          const chatIcon = nameWrap.querySelector('.skill-chat-icon');
          const nameLabel = nameWrap.querySelector('.skill-name-label');
          const inputDesc = tr.querySelector('.skill-desc-textarea');
          return {
            name: nameLabel ? nameLabel.textContent : '',
            desc: inputDesc ? inputDesc.value : ''
          };
        });
      }
      if (characterSheets[activeSheetIndex]) {
        characterSheets[activeSheetIndex].skills = JSON.parse(JSON.stringify(skillRows));
        debouncedSaveSheetData();
        updateCurrentWeight();
      }
    }
  }

  if (editBtnSkill && acceptBtnSkill && cancelBtnSkill && addRowBtnSkill) {
    renderSkillTable(false);
    editBtnSkill.addEventListener('click', () => {
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
      prevRowsInv = JSON.parse(JSON.stringify(inventoryRows));
      setEditingModeInventory(true);
    });
    acceptBtnInv.addEventListener('click', () => {
      setEditingModeInventory(false);
      // Зберігаємо дані інвентаря
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
      // Зберігаємо заголовок
      const inventoryLabel = document.querySelector('.inventory-block .weapon-label');
      if (inventoryLabel) {
        characterSheets[activeSheetIndex].inventoryTitle = inventoryLabel.textContent;
      }
      // Зберігаємо в метадані
      characterSheets[activeSheetIndex].inventory = JSON.parse(JSON.stringify(inventoryRows));
      debouncedSaveSheetData();
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
      prevRowsEquip = JSON.parse(JSON.stringify(equipmentRows));
      setEditingModeEquipment(true);
    });
    acceptBtnEquip.addEventListener('click', () => {
      setEditingModeEquipment(false);
      // Зберігаємо дані спорядження
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
      // Зберігаємо заголовок
      const equipmentLabel = document.querySelector('.equipment-block .weapon-label');
      if (equipmentLabel) {
        characterSheets[activeSheetIndex].equipmentTitle = equipmentLabel.textContent;
      }
      // Зберігаємо в метадані
      characterSheets[activeSheetIndex].equipment = JSON.parse(JSON.stringify(equipmentRows));
      debouncedSaveSheetData();
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
    inputBonus.placeholder = '+0';
    inputBonus.value = row.bonus;
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
    // --- Додаю можливість натискати на поле "Бонус" лише у режимі перегляду ---
    if (!editing) {
      inputBonus.style.cursor = 'pointer';
      inputBonus.title = 'Кинути d20 з цим бонусом атаки';
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
        
        // Парсимо бонус
        let bonus = 0;
        const bonusValue = row.bonus.trim();
        if (bonusValue) {
          // Видаляємо + з початку, якщо є
          const cleanBonus = bonusValue.startsWith('+') ? bonusValue.slice(1) : bonusValue;
          bonus = parseInt(cleanBonus) || 0;
        }
        
        // Для атаки використовуємо стиль NEBULA
        sendDiceRollRequest('D20', 'NEBULA', bonus);
      });
    }
    tdBonus.appendChild(inputBonus);
    tr.appendChild(tdBonus); // Додаємо поле бонусу до рядка
    
    // Шкода
    const tdDamage = document.createElement('td');
    const inputDamage = document.createElement('input');
    inputDamage.type = 'text';
    inputDamage.className = 'weapon-damage';
    inputDamage.placeholder = '1d6';
    inputDamage.value = row.damage;
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
    // --- Додаю можливість натискати на поле "Шкода" лише у режимі перегляду ---
    if (!editing) {
      inputDamage.style.cursor = 'pointer';
      inputDamage.title = 'Кинути кубик шкоди';
      inputDamage.addEventListener('click', e => {
        // Перевіряємо, чи це справжній клік користувача
        if (e.detail !== 1 || !e.isTrusted) {
          return;
        }
        
        // Додаткова перевірка, що ми не в режимі редагування
        if (window.weaponEditing) {
          return;
        }
        
        // Кидок шкоди
        rollWeaponDamage(row.damage);
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
    chatIcon.title = 'Показати навичку всім гравцям';
    chatIcon.addEventListener('click', async (e) => {
      e.stopPropagation();
      await showSkillToAllPlayers(row.name, row.desc);
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
    // Опис (textarea)
    const inputDesc = document.createElement('textarea');
    inputDesc.className = 'skill-desc-textarea';
    inputDesc.value = row.desc;
    inputDesc.placeholder = 'Опис навички';
    if (editing) {
      inputDesc.disabled = false;
      inputDesc.readOnly = false;
    } else {
      inputDesc.disabled = false;
      inputDesc.readOnly = true;
    }
    inputDesc.addEventListener('input', e => {
      skillRows[idx].desc = e.target.value;
    });
    setTimeout(() => {
      inputDesc.style.height = 'auto';
      inputDesc.style.height = (inputDesc.scrollHeight) + 'px';
    }, 0);
    tr.appendChild(inputDesc);
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

// --- Popover API ---
async function showSkillToAllPlayers(skillName, skillDescription) {
  try {
    const playerName = await OBR.player.getName();
    const connectionId = await OBR.player.getConnectionId();
    const currentMetadata = await OBR.room.getMetadata();
    await OBR.room.setMetadata({
      ...currentMetadata,
      darqie: {
        ...(currentMetadata.darqie || {}),
        skillPopover: {
          skillName: skillName,
          skillDescription: skillDescription || '',
          playerName: playerName,
          senderConnectionId: connectionId,
          timestamp: Date.now()
        }
      }
    });
    // Сповіщення для ініціатора
    await OBR.notification.show('Опис навички розіслано учасникам', 'INFO');
  } catch (error) {
    console.error('Помилка при показі навички всім гравцям:', error);
  }
}

async function openSkillPopover(skillName, skillDescription, playerName, senderConnectionId) {
  try {
    const myConnectionId = await OBR.player.getConnectionId();
    if (myConnectionId === senderConnectionId) return; // Не відкриваємо popover для ініціатора
    await OBR.popover.open({
      id: 'skill-popover',
      url: `https://darqie-character-sheet.onrender.com/skill-popover.html?name=${encodeURIComponent(skillName)}&desc=${encodeURIComponent(skillDescription || '')}&player=${encodeURIComponent(playerName || '')}`,
      width: 400,
      height: 300,
      anchorOrigin: { horizontal: 'RIGHT', vertical: 'TOP' },
      transformOrigin: { horizontal: 'RIGHT', vertical: 'TOP' }
    });
  } catch (error) {
    console.error('Помилка при відкритті popover навички:', error);
  }
}

function syncSkillsToSheet() {
  if (characterSheets[activeSheetIndex]) {
    characterSheets[activeSheetIndex].skills = JSON.parse(JSON.stringify(skillRows));
    debouncedSaveSheetData();
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
        debouncedSaveSheetData();
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
        debouncedSaveSheetData();
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
        debouncedSaveSheetData();
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
        debouncedSaveSheetData();
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
        debouncedSaveSheetData();
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
        debouncedSaveSheetData();
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
      debouncedSaveSheetData();
    }
  });
}

if (inventoryLabel) {
  inventoryLabel.addEventListener('blur', () => {
    if (!editingInv) {
      characterSheets[activeSheetIndex].inventoryTitle = inventoryLabel.textContent;
      debouncedSaveSheetData();
    }
  });
}

if (equipmentLabel) {
  equipmentLabel.addEventListener('blur', () => {
    if (!editingEquip) {
      characterSheets[activeSheetIndex].equipmentTitle = equipmentLabel.textContent;
      debouncedSaveSheetData();
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
    saveSheetData();
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

async function sendDiceRollRequest(type, style, bonus) {
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
    clearAdvantageCheckboxes();
    
  } catch (error) {
    // Повністю ігноруємо помилки
  }
}

function setupStatEditButtons() {
  // Основні характеристики з олівцем
  const statIdsWithEdit = [
    'strengthScore', 'dexterityScore', 'constitutionScore',
    'intelligenceScore', 'wisdomScore', 'charismaScore'
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
      editBtn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Запобігаємо втраті фокусу
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
    { modId: 'intelligenceModifier', scoreId: 'intelligenceScore' },
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

// Функція для закриття модального вікна навички
function closeSkillModal() {
  const modal = document.getElementById('skillModal');
  if (modal) {
    modal.style.display = 'none';
    document.body.style.overflow = '';
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

// Функція для кидка шкоди зброї
async function rollWeaponDamage(damageString) {
  const parsed = parseWeaponDamage(damageString);
  if (!parsed) {
    return;
  }
  
  // Для шкоди використовуємо стиль GALAXY
  sendDiceRollRequest(parsed.dice, 'GALAXY', parsed.bonus);
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
  
  // Зберігаємо зміни в метаданих одразу без затримки
  if (characterSheets[activeSheetIndex]) {
    characterSheets[activeSheetIndex].advantage = false;
    characterSheets[activeSheetIndex].disadvantage = false;
    saveSheetData();
  }
}
