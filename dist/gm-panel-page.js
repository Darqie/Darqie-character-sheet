(() => {
  const backBtn = document.getElementById('gmPanelBackButton');
  if (!backBtn) return;

  backBtn.addEventListener('click', () => {
    sessionStorage.setItem('darqie.returnFromGmPanel', '1');
    window.location.href = 'index.html';
  });
})();
