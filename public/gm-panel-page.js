(() => {
  const backBtn = document.getElementById('gmPanelBackButton');
  if (!backBtn) return;

  backBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });
})();
