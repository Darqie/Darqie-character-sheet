(() => {
  const content = document.querySelector('.gm-panel-content');
  if (!content) return;

  const playersBtn = document.getElementById('gmPanelPlayersButton');

  function goToCharactersPage() {
    const targetUrl = new URL('index.html', window.location.href);
    targetUrl.search = window.location.search;
    targetUrl.searchParams.set('gmView', 'characters');
    targetUrl.hash = window.location.hash;
    window.location.href = targetUrl.toString();
  }

  if (playersBtn) {
    playersBtn.addEventListener('click', goToCharactersPage);
  }

  const pages = {
    characters: {
      buttonId: 'gmPanelCharactersButton',
      htmlPath: './gm-pages/characters.html',
      scriptPath: './gm-pages/characters.js',
    },
    items: {
      buttonId: 'gmPanelItemsButton',
      htmlPath: './gm-pages/items.html',
      scriptPath: './gm-pages/items.js',
    },
    skills: {
      buttonId: 'gmPanelSkillsButton',
      htmlPath: './gm-pages/skills.html',
      scriptPath: './gm-pages/skills.js',
    },
    attacks: {
      buttonId: 'gmPanelAttacksButton',
      htmlPath: './gm-pages/attacks.html',
      scriptPath: './gm-pages/attacks.js',
    },
    equipment: {
      buttonId: 'gmPanelEquipmentButton',
      htmlPath: './gm-pages/equipment.html',
      scriptPath: './gm-pages/equipment.js',
    },
  };

  const pageKeys = Object.keys(pages);
  let loadToken = 0;
  let suppressNextHashChange = false;
  const MIN_LOADING_MS = 1000;
  let openSheetSignalBound = false;
  let openSheetSignalRetryId = null;

  function bindOpenCharacterSheetSignal() {
    const OBR = window.OBR;
    if (!OBR || openSheetSignalBound) return;
    openSheetSignalBound = true;

    if (openSheetSignalRetryId) {
      clearInterval(openSheetSignalRetryId);
      openSheetSignalRetryId = null;
    }

    OBR.room.onMetadataChange(async (metadata) => {
      const openSignal = metadata?.darqie?.openCharacterSheet;
      if (!openSignal) return;
      console.log('[GM Panel] Отримано сигнал openCharacterSheet');

      try {
        await OBR.action.open();

        const currentMetadata = await OBR.room.getMetadata();
        await OBR.room.setMetadata({
          ...currentMetadata,
          darqie: {
            ...(currentMetadata.darqie || {}),
            openCharacterSheet: null,
          },
        });
      } catch (error) {
        console.error('[GM Panel] Не вдалося відкрити лист персонажа після кидка:', error);
      }
    });
  }

  function ensureOpenSheetSignalBinding() {
    const OBR = window.OBR;
    if (!OBR) return false;

    if (typeof OBR.onReady === 'function') {
      OBR.onReady(() => {
        bindOpenCharacterSheetSignal();
        console.log('[GM Panel] Підписка на openCharacterSheet активна (onReady)');
      });
      return true;
    }

    bindOpenCharacterSheetSignal();
    if (openSheetSignalBound) {
      console.log('[GM Panel] Підписка на openCharacterSheet активна');
    }
    return openSheetSignalBound;
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function renderLoadingScreen() {
    content.classList.add('is-loading');
    content.innerHTML = `
      <div class="gm-waiting-block" aria-hidden="true">
        <div class="gm-waiting-container">
          <div class="gm-dice-spinner">
            <i class="fas fa-dice-d20"></i>
          </div>
          <h2 class="gm-waiting-title">Завантаження</h2>
        </div>
      </div>
    `;
  }

  function setActiveButton(activeKey) {
    pageKeys.forEach((key) => {
      const btn = document.getElementById(pages[key].buttonId);
      if (!btn) return;
      btn.classList.toggle('is-active', key === activeKey);
    });
  }

  async function loadPage(key, updateHash = true) {
    const page = pages[key];
    if (!page) return;

    const currentToken = ++loadToken;
    const startedAt = Date.now();
    setActiveButton(key);
    renderLoadingScreen();

    try {
      const htmlResponse = await fetch(page.htmlPath, { cache: 'no-store' });
      if (!htmlResponse.ok) throw new Error(`HTTP ${htmlResponse.status}`);
      const html = await htmlResponse.text();

      const elapsedBeforeRender = Date.now() - startedAt;
      const remaining = Math.max(0, MIN_LOADING_MS - elapsedBeforeRender);
      if (remaining > 0) await waitMs(remaining);

      if (currentToken !== loadToken) return;
      content.classList.remove('is-loading');
      content.innerHTML = html;

      const module = await import(page.scriptPath);
      if (currentToken !== loadToken) return;
      if (module && typeof module.initPage === 'function') {
        module.initPage({ root: content, pageKey: key });
      }

      if (updateHash && window.location.hash !== `#${key}`) {
        suppressNextHashChange = true;
        window.location.hash = key;
      }
    } catch (error) {
      const elapsedBeforeError = Date.now() - startedAt;
      const remaining = Math.max(0, MIN_LOADING_MS - elapsedBeforeError);
      if (remaining > 0) await waitMs(remaining);

      if (currentToken !== loadToken) return;
      content.classList.remove('is-loading');
      content.innerHTML = `<div class="gm-page"><h3>Помилка</h3><p>Не вдалося завантажити сторінку: ${key}</p></div>`;
      console.error('[GM Panel] Помилка завантаження сторінки:', key, error);
    }
  }

  pageKeys.forEach((key) => {
    const btn = document.getElementById(pages[key].buttonId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      loadPage(key, true);
    });
  });

  window.addEventListener('hashchange', () => {
    if (suppressNextHashChange) {
      suppressNextHashChange = false;
      return;
    }

    const key = window.location.hash.replace('#', '');
    if (pages[key]) {
      loadPage(key, false);
    }
  });

  if (!ensureOpenSheetSignalBinding()) {
    openSheetSignalRetryId = setInterval(() => {
      ensureOpenSheetSignalBinding();
    }, 300);
  }

  const initialKey = window.location.hash.replace('#', '');
  loadPage(pages[initialKey] ? initialKey : 'characters', false);
})();
