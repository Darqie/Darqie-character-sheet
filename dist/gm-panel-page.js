(() => {
  const content = document.querySelector('.gm-panel-content');
  if (!content) return;

  const pages = {
    players: {
      buttonId: 'gmPanelPlayersButton',
      htmlPath: './gm-pages/players.html',
      scriptPath: './gm-pages/players.js',
    },
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
  };

  const pageKeys = Object.keys(pages);
  let loadToken = 0;

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
    setActiveButton(key);
    content.innerHTML = '<div class="gm-page"><h3>Завантаження...</h3></div>';

    try {
      const htmlResponse = await fetch(page.htmlPath, { cache: 'no-store' });
      if (!htmlResponse.ok) throw new Error(`HTTP ${htmlResponse.status}`);
      const html = await htmlResponse.text();

      if (currentToken !== loadToken) return;
      content.innerHTML = html;

      const module = await import(page.scriptPath);
      if (currentToken !== loadToken) return;
      if (module && typeof module.initPage === 'function') {
        module.initPage({ root: content, pageKey: key });
      }

      if (updateHash) {
        window.location.hash = key;
      }
    } catch (error) {
      if (currentToken !== loadToken) return;
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
    const key = window.location.hash.replace('#', '');
    if (pages[key]) {
      loadPage(key, false);
    }
  });

  const initialKey = window.location.hash.replace('#', '');
  loadPage(pages[initialKey] ? initialKey : 'players', false);
})();
