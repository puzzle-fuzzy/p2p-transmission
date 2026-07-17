(() => {
  const storageKey = 'p2p_room_session';

  try {
    const encoded = window.localStorage.getItem(storageKey);
    if (!encoded) return;

    const session = JSON.parse(encoded);
    const optionalIdentifier = value => value === null
      || (typeof value === 'string' && value.length > 0);
    const canRestore = session
      && typeof session === 'object'
      && !Array.isArray(session)
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
