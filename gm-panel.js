let gmPanelInitialized = false;
let gmPanelTemplateLoaded = false;

async function ensurePanelTemplate(mount) {
  if (!mount || gmPanelTemplateLoaded) return;

  try {
    const response = await fetch('/gm-panel.html', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    mount.innerHTML = await response.text();
  } catch (error) {
    // Fallback to a minimal inline shell if template fetch fails.
    mount.innerHTML = `
      <div class="gm-panel-shell">
        <div class="gm-panel-header"><h2>Панель GM</h2></div>
        <div class="gm-panel-content"></div>
        <div class="gm-panel-actions">
          <button id="gmPanelBackButton" type="button">
            <i class="fas fa-arrow-left"></i>
            <span>Повернутись назад</span>
          </button>
        </div>
      </div>
    `;
    console.error('[GM Panel] Не вдалося завантажити шаблон gm-panel.html:', error);
  }

  gmPanelTemplateLoaded = true;
}

function bindPanelActions(mainContent, gmPanelScreen) {
  const backBtn = document.getElementById('gmPanelBackButton');
  if (!backBtn) return;

  backBtn.addEventListener('click', () => {
    gmPanelScreen.style.display = 'none';
    mainContent.style.display = 'flex';
  });
}

export async function initGmPanel({ isGM }) {
  if (gmPanelInitialized) return;

  const openBtn = document.getElementById('openGmPanelButton');
  const mainContent = document.getElementById('mainContent');
  const gmPanelScreen = document.getElementById('gmPanelScreen');
  const gmPanelMount = document.getElementById('gmPanelMount');

  if (!openBtn || !mainContent || !gmPanelScreen || !gmPanelMount) return;

  if (!isGM) {
    openBtn.style.display = 'none';
    gmPanelInitialized = true;
    return;
  }

  await ensurePanelTemplate(gmPanelMount);
  bindPanelActions(mainContent, gmPanelScreen);

  openBtn.addEventListener('click', () => {
    mainContent.style.display = 'none';
    gmPanelScreen.style.display = 'flex';
  });

  gmPanelInitialized = true;
}
