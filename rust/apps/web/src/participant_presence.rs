use dioxus::prelude::*;
use p2p_protocol::{ParticipantRoleWire, ParticipantSnapshot};

const MAX_VISIBLE_RECEIVER_AVATARS: usize = 3;

fn receiver_stack_counts(receiver_count: usize) -> (usize, usize) {
    let visible_count = receiver_count.min(MAX_VISIBLE_RECEIVER_AVATARS);
    (visible_count, receiver_count - visible_count)
}

#[component]
pub(super) fn PeerFlow(
    sender: Option<ParticipantSnapshot>,
    receivers: Vec<ParticipantSnapshot>,
    entering_receivers: Vec<String>,
    peer_connected: bool,
) -> Element {
    let (visible_receiver_count, hidden_receiver_count) = receiver_stack_counts(receivers.len());
    let accessible = if receivers.is_empty() {
        "暂无接收者，正在等待连接".to_owned()
    } else {
        format!("{} 位接收者已连接", receivers.len())
    };
    rsx! {
        div {
            class: if receivers.is_empty() { "peer-flow peer-flow-solo" } else { "peer-flow" },
            role: "status",
            aria_live: "polite",
            aria_label: "{accessible}",
            span { class: "peer-side sender-side", aria_hidden: "true",
                if let Some(sender) = sender {
                    Avatar { seed: sender.session_id, label: sender.display_name, entering: false, highlighted: false }
                }
            }
            if !receivers.is_empty() {
                span { class: if peer_connected { "peer-track connected" } else { "peer-track waiting" }, aria_hidden: "true",
                    if peer_connected {
                        span { class: "peer-line" }
                    } else {
                        span { class: "peer-dot" }
                        span { class: "peer-dot" }
                        span { class: "peer-dot" }
                    }
                }
                span { class: "peer-side receiver-side", aria_hidden: "true",
                    for (index, receiver) in receivers
                        .iter()
                        .take(visible_receiver_count)
                        .enumerate()
                    {
                        Avatar {
                            seed: receiver.session_id.clone(),
                            label: receiver.display_name.clone(),
                            entering: entering_receivers.contains(&receiver.session_id),
                            highlighted: false,
                            overlap: index > 0,
                        }
                    }
                    if hidden_receiver_count > 0 {
                        span {
                            class: "avatar avatar-overflow avatar-overlap",
                            title: "另有 {hidden_receiver_count} 位接收者",
                            "+{hidden_receiver_count}"
                        }
                    }
                }
            }
        }
    }
}

#[component]
pub(super) fn MemberRoster(
    participants: Vec<ParticipantSnapshot>,
    current_session_id: Option<String>,
    entering_receivers: Vec<String>,
    peer_connected: bool,
) -> Element {
    rsx! {
        div { class: "member-roster", role: "list", aria_label: "在线成员",
            for participant in participants.iter().filter(|participant| participant.online) {
                div {
                    key: "{participant.session_id}",
                    class: if entering_receivers.contains(&participant.session_id) {
                        "member-row member-row-entering"
                    } else {
                        "member-row"
                    },
                    role: "listitem",
                    span { class: "member-avatar",
                        Avatar {
                            seed: participant.session_id.clone(),
                            label: participant.display_name.clone(),
                            entering: false,
                            highlighted: false,
                        }
                    }
                    span { class: "member-copy",
                        strong {
                            title: "{participant.display_name}",
                            "{participant.display_name}"
                            if current_session_id.as_deref() == Some(participant.session_id.as_str()) {
                                em { "（你）" }
                            }
                        }
                        small {
                            if participant.role == ParticipantRoleWire::Owner || peer_connected {
                                "已连接"
                            } else {
                                "正在建立通道"
                            }
                        }
                    }
                    span {
                        class: if peer_connected || participant.role == ParticipantRoleWire::Owner {
                            "member-status ready"
                        } else {
                            "member-status pending"
                        },
                        aria_hidden: "true"
                    }
                }
            }
        }
    }
}

#[component]
pub(super) fn Avatar(
    seed: String,
    label: String,
    #[props(default = false)] entering: bool,
    #[props(default = false)] highlighted: bool,
    #[props(default = false)] overlap: bool,
) -> Element {
    let hash = hash_seed(&seed);
    let cells = avatar_cells(hash);
    let class = format!(
        "avatar{}{}{}",
        if entering { " avatar-entering" } else { "" },
        if highlighted {
            " avatar-highlighted"
        } else {
            ""
        },
        if overlap { " avatar-overlap" } else { "" },
    );
    rsx! {
        span {
            class: "{class}",
            role: "img",
            aria_label: "{label}",
            title: "{label}",
            for (index, active) in cells.into_iter().enumerate() {
                if active {
                    span {
                        class: if (index + hash as usize).is_multiple_of(4) {
                            "avatar-cell avatar-cell-strong"
                        } else {
                            "avatar-cell"
                        },
                        style: format!(
                            "grid-column:{};grid-row:{}",
                            index % 5 + 1,
                            index / 5 + 1,
                        )
                    }
                }
            }
        }
    }
}

fn hash_seed(value: &str) -> u32 {
    let mut hash = 2_166_136_261_u32;
    for byte in value.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

fn avatar_cells(seed: u32) -> [bool; 25] {
    let mut state = seed.max(1);
    let mut cells = [false; 25];
    for row in 0..5 {
        for column in 0..3 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let active = state & 3 < 2;
            cells[row * 5 + column] = active;
            cells[row * 5 + (4 - column)] = active;
        }
    }
    if !cells.iter().any(|active| *active) {
        cells[12] = true;
    }
    cells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avatar_cells_are_deterministic_non_empty_and_mirrored() {
        let seed = hash_seed("participant-1");
        let cells = avatar_cells(seed);

        assert_eq!(cells, avatar_cells(seed));
        assert!(cells.iter().any(|active| *active));
        for row in 0..5 {
            for column in 0..5 {
                assert_eq!(cells[row * 5 + column], cells[row * 5 + (4 - column)]);
            }
        }
    }

    #[test]
    fn receiver_stack_shows_three_avatars_before_overflowing() {
        for (receiver_count, expected_counts) in [
            (0, (0, 0)),
            (1, (1, 0)),
            (3, (3, 0)),
            (4, (3, 1)),
            (7, (3, 4)),
        ] {
            assert_eq!(receiver_stack_counts(receiver_count), expected_counts);
        }
    }
}
