CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'expired')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX sessions_expires_at_idx
    ON sessions (state, expires_at_ms);

CREATE TABLE rooms (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL UNIQUE,
    owner_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    create_request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'expired')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE UNIQUE INDEX rooms_owner_create_request_idx
    ON rooms (owner_session_id, create_request_id);

CREATE INDEX rooms_expires_at_idx
    ON rooms (state, expires_at_ms);

CREATE TABLE room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'receiver')),
    state TEXT NOT NULL CHECK (state IN ('offline', 'online', 'left')),
    peer_id TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (room_id, session_id),
    CHECK (
        (state = 'online' AND peer_id IS NOT NULL)
        OR (state <> 'online' AND peer_id IS NULL)
    )
) STRICT;

CREATE INDEX room_members_session_idx
    ON room_members (session_id, state);

CREATE TABLE join_requests (
    id TEXT PRIMARY KEY NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX join_requests_room_state_idx
    ON join_requests (room_id, state, created_at_ms);

CREATE INDEX join_requests_expires_at_idx
    ON join_requests (state, expires_at_ms);

CREATE UNIQUE INDEX join_requests_one_pending_per_session_idx
    ON join_requests (room_id, session_id)
    WHERE state = 'pending';

CREATE TABLE invite_capabilities (
    id TEXT PRIMARY KEY NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    capability_hash BLOB NOT NULL UNIQUE CHECK (length(capability_hash) = 32),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
    consumed_at_ms INTEGER,
    CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
) STRICT;

CREATE UNIQUE INDEX invite_capabilities_room_request_idx
    ON invite_capabilities (room_id, request_id);

CREATE INDEX invite_capabilities_expires_at_idx
    ON invite_capabilities (expires_at_ms);
