(() => {
  const hash = window.location.hash;
  const hasInvite = /(?:^|&)room=[A-Za-z2-9]{6}(?:&|$)/u.test(hash.slice(1))
    && /(?:^|&)capability=[^&]+(?:&|$)/u.test(hash.slice(1));
  const hasStoredRoom = window.localStorage.getItem('p2p_room_session') !== null;

  if (hasInvite || hasStoredRoom) {
    window.location.replace(`/app${hasInvite ? hash : ''}`);
    return;
  }

  const input = document.querySelector('#room-code');
  const primeNotifications = () => {
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        void Notification.requestPermission().catch(() => {});
      } catch {
        // Notification permission is optional and must never block navigation.
      }
    }
  };

  if (input instanceof HTMLInputElement) {
    input.addEventListener('input', () => {
      input.value = input.value
        .replace(/[^A-Za-z2-9]/gu, '')
        .slice(0, 6)
        .toUpperCase();
    });
  }

  document.querySelector('.join-form')?.addEventListener('submit', primeNotifications);
  document.querySelector('a[href="/app?intent=create"]')
    ?.addEventListener('click', primeNotifications);

  window.performance?.mark('landing-interactive');
})();
