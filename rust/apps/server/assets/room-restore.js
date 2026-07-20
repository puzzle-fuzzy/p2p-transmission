(() => {
  const storageKey = '__P2P_ROOM_SESSION_STORAGE_KEY__';
  const schemaVersion = 5;
  const appearance = [
    ['vault-theme', 'data-theme', ['mist', 'slate', 'dusk', 'sand'], 'mist'],
    ['vault-wallpaper', 'data-wallpaper', ['quiet', 'paper', 'plain'], 'quiet'],
    ['vault-language', 'data-language', ['zh', 'en'], 'zh'],
  ];
  for (const [key, attribute, allowed, fallback] of appearance) {
    try {
      const value = window.localStorage.getItem(key);
      document.documentElement.setAttribute(attribute, allowed.includes(value) ? value : fallback);
      if (attribute === 'data-language') {
        document.documentElement.lang = value === 'en' ? 'en' : 'zh-CN';
      }
    } catch {
      document.documentElement.setAttribute(attribute, fallback);
    }
  }
  const exactKeys = (value, expected) => {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every(key => keys.includes(key));
  };

  try {
    const encoded = window.localStorage.getItem(storageKey);
    if (!encoded) return;

    const stored = JSON.parse(encoded);
    if (!stored
      || typeof stored !== 'object'
      || Array.isArray(stored)
      || !exactKeys(stored, ['schema_version', 'session'])
      || stored.schema_version !== schemaVersion) return;

    const session = stored.session;
    const optionalIdentifier = value => value === null
      || (typeof value === 'string' && value.length > 0);
    const canRestore = session
      && typeof session === 'object'
      && !Array.isArray(session)
      && exactKeys(session, [
        'room_code',
        'role',
        'join_request_id',
        'invite_request_id',
        'peer_id',
      ])
      && typeof session.room_code === 'string'
      && /^[A-Z2-9]{6}$/u.test(session.room_code)
      && (session.role === 'owner' || session.role === 'receiver')
      && optionalIdentifier(session.join_request_id)
      && optionalIdentifier(session.invite_request_id)
      && typeof session.peer_id === 'string'
      && session.peer_id.length > 0;
    if (canRestore) {
      document.documentElement.setAttribute('data-p2p-room-restore', 'pending');
    }
  } catch {
    // Storage is only a presentation hint. The Rust bootstrap remains authoritative.
  }
})();
