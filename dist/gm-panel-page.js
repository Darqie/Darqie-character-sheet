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
    music: {
      buttonId: 'gmPanelMusicButton',
      htmlPath: './gm-pages/music.html',
      scriptPath: './gm-pages/music.js',
    },
  };

  const pageKeys = Object.keys(pages);
  let loadToken = 0;
  let suppressNextHashChange = false;
  const MIN_LOADING_MS = 1000;
  let openSheetSignalBound = false;
  let openSheetSignalRetryId = null;
  let skillShareSignalBound = false;

  function showInlineSkillPopover(skillName, skillDescription, initiatorName) {
    const existing = document.getElementById('darqie-gm-inline-skill-popover-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'darqie-gm-inline-skill-popover-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0, 0, 0, 0.45)';
    overlay.style.zIndex = '99999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '16px';

    const card = document.createElement('div');
    card.style.width = 'min(560px, 100%)';
    card.style.maxHeight = '80vh';
    card.style.overflow = 'auto';
    card.style.background = '#1f1f24';
    card.style.color = '#f4f4f7';
    card.style.border = '1px solid rgba(255,255,255,0.12)';
    card.style.borderRadius = '12px';
    card.style.boxShadow = '0 20px 40px rgba(0,0,0,0.45)';
    card.style.padding = '16px';

    const title = document.createElement('h3');
    title.textContent = skillName || 'Навичка';
    title.style.margin = '0 0 8px';
    title.style.fontSize = '1.1rem';

    const from = document.createElement('div');
    from.textContent = initiatorName ? `Від: ${initiatorName}` : 'Поділився навичкою';
    from.style.opacity = '0.8';
    from.style.fontSize = '0.9rem';
    from.style.marginBottom = '10px';

    const desc = document.createElement('div');
    desc.textContent = skillDescription || 'Опис відсутній';
    desc.style.whiteSpace = 'pre-wrap';
    desc.style.lineHeight = '1.45';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Закрити';
    closeBtn.style.marginTop = '14px';
    closeBtn.style.padding = '8px 12px';
    closeBtn.style.borderRadius = '8px';
    closeBtn.style.border = '1px solid rgba(255,255,255,0.2)';
    closeBtn.style.background = '#2c2c33';
    closeBtn.style.color = '#f4f4f7';
    closeBtn.style.cursor = 'pointer';

    const close = () => {
      window.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    window.addEventListener('keydown', onKeyDown);

    card.appendChild(title);
    card.appendChild(from);
    card.appendChild(desc);
    card.appendChild(closeBtn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  async function openSkillPopoverForGm(skillName, skillDescription, initiatorName) {
    const query = new URLSearchParams({
      name: skillName || '',
      desc: skillDescription || '',
      player: initiatorName || '',
      v: '2',
    }).toString();

    try {
      await window.OBR.popover.open({
        id: 'darqie-skill-popover',
        url: `/skill-popover-v2.html?${query}`,
        height: 260,
        width: 420,
      });
    } catch (e1) {
      try {
        await window.OBR.popover.open({
          id: 'darqie-skill-popover',
          url: `skill-popover-v2.html?${query}`,
          height: 260,
          width: 420,
        });
      } catch (_) {
        showInlineSkillPopover(skillName, skillDescription, initiatorName);
      }
    }
  }

  function bindSkillShareSignal() {
    const OBR = window.OBR;
    if (!OBR || skillShareSignalBound) return;
    skillShareSignalBound = true;

    OBR.broadcast.onMessage('skill-popover', async (data) => {
      try {
        const msg = data?.data || data;
        if (!msg || msg.type !== 'open-skill-popover') return;
        const myId = await OBR.player.getConnectionId();
        if (msg.senderId && msg.senderId === myId) return;
        await openSkillPopoverForGm(msg.name || '', msg.desc || '', msg.initiatorName || msg.playerName || '');
      } catch (_) {}
    });

    // Backward compatibility for older clients that still send skill-message.
    OBR.broadcast.onMessage('skill-message', async (data) => {
      try {
        const msg = data?.data || data;
        if (!msg || msg.type !== 'skill-info') return;
        await openSkillPopoverForGm(msg.skillName || '', msg.skillDescription || '', msg.playerName || '');
      } catch (_) {}
    });
  }

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
        bindSkillShareSignal();
      });
      return true;
    }

    bindOpenCharacterSheetSignal();
    bindSkillShareSignal();
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
