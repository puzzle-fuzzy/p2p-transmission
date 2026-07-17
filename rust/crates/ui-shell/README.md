# p2p-ui-shell

`p2p-ui-shell` contains the platform-neutral anonymous lobby shared by the
Axum SSR response and the Dioxus Web client.

The crate intentionally depends only on Dioxus' minimal component APIs. It
must not import browser APIs, transport/protocol types, Axum, or application
state.

## Components

- `LobbyShell`: owns the stable `.app-shell > main.lobby > form.lobby-panel`
  structure and all durable lobby copy. Its optional `root_id` prop lets the
  server emit the mount root without an extra wrapper. The invitation status
  overlays the reserved guidance area so URL intent cannot shift the form.
- `InitializingLobby`: renders the useful but inert first response: six empty
  room-code cells, an initialization status, and two disabled actions.
- `LobbyFeedback`: supplies the reserved empty row, live status, or accessible
  validation error without changing layout height.

The client injects its interactive room-code component and footer actions as
slots. It supplies `EventHandler<FormEvent>` and `EventHandler<MouseEvent>`
callbacks for joining and creating a room. The SSR path uses
`InitializingLobby`, which has no focusable control.

The existing Web CSS class contract is reused intentionally. Keep changes to
the shared DOM synchronized with `rust/apps/web/assets/main.css`.

The Axum server passes `initializing_lobby_element()` to `dioxus-ssr`. The
rendered fragment already owns the unique `#boot-fallback` root and must not be
wrapped in another mount element. Keeping the renderer in the server prevents
SSR or browser features from leaking into this shared presentation crate.
