(() => {
  const backBtn = document.getElementById('gmPanelBackButton');
  if (!backBtn) return;

  backBtn.addEventListener('click', () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    const targetUrl = new URL('index.html', window.location.href);
    targetUrl.search = window.location.search;
    targetUrl.hash = window.location.hash;
    window.location.href = targetUrl.toString();
  });
})();
