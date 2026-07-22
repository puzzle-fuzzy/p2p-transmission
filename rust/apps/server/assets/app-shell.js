(() => {
  const restoreFallback = document.querySelector('.boot-room-restore');
  if (restoreFallback && document.documentElement.hasAttribute('data-p2p-room-restore')) {
    restoreFallback.removeAttribute('hidden');
  }

  const ensureGeneratedCode = () => {
    const generatedCode = document.querySelector('.generated-code');
    if (generatedCode && !/^\d{6}$/.test(generatedCode.textContent.trim())) {
      generatedCode.textContent = String(Math.floor(100000 + Math.random() * 900000));
    }
  };
  ensureGeneratedCode();
  new MutationObserver(ensureGeneratedCode).observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  const showUpgradePrompt = () => {
    let dialog = document.getElementById('app-upgrade-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'app-upgrade-dialog';
      dialog.className = 'upgrade-dialog';
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'upgrade-dialog-title');
      dialog.setAttribute('aria-describedby', 'upgrade-dialog-description');
      dialog.innerHTML = '<p class="eyebrow">UPDATE REQUIRED</p><h2 id="upgrade-dialog-title">需要刷新页面</h2><p id="upgrade-dialog-description" class="upgrade-dialog-copy">应用已经更新。刷新后才能继续连接房间；正在进行的传输会中断，但支持恢复的文件可以从检查点继续。</p><button class="primary-button" type="button">刷新并升级</button>';
      dialog.querySelector('button').addEventListener('click', () => location.reload());
      document.body.append(dialog);
    }
    if (!dialog.open) {
      typeof dialog.showModal === 'function' ? dialog.showModal() : dialog.setAttribute('open', '');
    }
    dialog.querySelector('button').focus();
  };

  new MutationObserver(() => {
    if (document.documentElement.hasAttribute('data-p2p-upgrade')) showUpgradePrompt();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-p2p-upgrade'],
  });
  if (document.documentElement.hasAttribute('data-p2p-upgrade')) showUpgradePrompt();

  if (!('serviceWorker' in navigator)) return;

  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    window.__P2P_UPDATE_REQUIRED__ = true;
    showUpgradePrompt();
    window.dispatchEvent(new Event('p2p-app-update'));
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Offline support is optional; the transfer app remains usable without it.
    });
  }, { once: true });
})();
