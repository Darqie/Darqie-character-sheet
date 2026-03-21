(function () {
  function parseValue(params, key, fallback) {
    const value = params.get(key);
    if (!value) return fallback;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  const urlParams = new URLSearchParams(window.location.search);
  const skillName = parseValue(urlParams, 'name', 'Назва навички');
  const skillDescription = parseValue(urlParams, 'desc', 'Опис навички');
  const playerName = parseValue(urlParams, 'player', 'Гравець');

  const skillNameEl = document.getElementById('skillName');
  const skillDescriptionEl = document.getElementById('skillDescription');
  const playerNameEl = document.getElementById('playerNameTop');

  if (skillNameEl) skillNameEl.textContent = skillName;
  if (skillDescriptionEl) skillDescriptionEl.innerText = skillDescription;
  if (playerNameEl) playerNameEl.textContent = playerName;

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && window.OBR?.popover) {
      window.OBR.popover.close();
    }
  });

  if (window.OBR?.onReady) {
    window.OBR.onReady(() => {
      setTimeout(async () => {
        const meta = await window.OBR.room.getMetadata();
        await window.OBR.room.setMetadata({
          ...meta,
          darqie: {
            ...(meta.darqie || {}),
            closeSkillPopover: Date.now(),
          },
        });
      }, 5000);
    });
  }
})();
