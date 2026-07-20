use p2p_browser_platform::RtcEvent;
use p2p_transfer::TransferDirection;

use super::transition::NotificationEffect;
use crate::app_state::{AppModel, RoomRole, Screen, TextTransferState};

pub(super) fn is_text_event(event: &RtcEvent) -> bool {
    matches!(
        event,
        RtcEvent::TextOutgoingOffered { .. }
            | RtcEvent::TextIncomingOffered { .. }
            | RtcEvent::TextTransferAccepted { .. }
            | RtcEvent::TextTransferRejected { .. }
            | RtcEvent::TextTransferReceived { .. }
            | RtcEvent::TextTransferDelivered { .. }
            | RtcEvent::TextTransferCancelled { .. }
            | RtcEvent::TextTransferFailed { .. }
    )
}

pub(super) fn apply(
    model: &mut AppModel,
    peer_id: String,
    event: RtcEvent,
) -> Option<NotificationEffect> {
    let (next, notice, notification) = match event {
        RtcEvent::TextOutgoingOffered {
            transfer_id,
            character_count,
            byte_length,
        } => (
            TextTransferState::Offering {
                transfer_id,
                character_count,
                byte_length,
            },
            None,
            None,
        ),
        RtcEvent::TextIncomingOffered {
            transfer_id,
            character_count,
            byte_length,
        } => (
            TextTransferState::Incoming {
                transfer_id,
                character_count,
                byte_length,
            },
            None,
            None,
        ),
        RtcEvent::TextTransferAccepted {
            transfer_id,
            direction,
        } => {
            let (character_count, byte_length) =
                text_metadata_for(model.text_transfers_by_peer.get(&peer_id), &transfer_id)?;
            let next = if direction == TransferDirection::Send {
                TextTransferState::Sending {
                    transfer_id,
                    character_count,
                    byte_length,
                }
            } else {
                TextTransferState::Receiving {
                    transfer_id,
                    character_count,
                    byte_length,
                }
            };
            (next, None, None)
        }
        RtcEvent::TextTransferRejected { direction, .. } => (
            TextTransferState::Rejected { direction },
            Some(if direction == TransferDirection::Send {
                "接收方已拒绝文本"
            } else {
                "已拒绝接收文本"
            }),
            None,
        ),
        RtcEvent::TextTransferReceived { text, .. } => (
            TextTransferState::Received { text },
            Some("文本已通过加密通道接收"),
            Some(NotificationEffect {
                title: "文本接收完成".to_owned(),
                body: "文本已通过点对点加密通道送达".to_owned(),
                tag: format!("text-received-{peer_id}"),
            }),
        ),
        RtcEvent::TextTransferDelivered { transfer_id } => {
            let (character_count, byte_length) =
                text_metadata_for(model.text_transfers_by_peer.get(&peer_id), &transfer_id)?;
            (
                TextTransferState::Delivered {
                    character_count,
                    byte_length,
                },
                Some("文本已送达接收方"),
                None,
            )
        }
        RtcEvent::TextTransferCancelled { .. } => {
            (TextTransferState::Cancelled, Some("文本传输已取消"), None)
        }
        RtcEvent::TextTransferFailed { message, .. } => {
            let message = friendly_text_error(&message);
            (TextTransferState::Failed { message }, None, None)
        }
        _ => unreachable!("non-text RTC event reached text transition"),
    };
    if let Some(notice) = notice {
        model.notice = Some(notice.to_owned());
    }
    model.text_transfers_by_peer.insert(peer_id, next.clone());
    if receiver_role(model) {
        model.text_transfer = next;
    }
    notification
}

fn text_metadata_for(state: Option<&TextTransferState>, transfer_id: &str) -> Option<(u32, u32)> {
    match state? {
        TextTransferState::Offering {
            transfer_id: current,
            character_count,
            byte_length,
        }
        | TextTransferState::Incoming {
            transfer_id: current,
            character_count,
            byte_length,
        }
        | TextTransferState::Sending {
            transfer_id: current,
            character_count,
            byte_length,
        }
        | TextTransferState::Receiving {
            transfer_id: current,
            character_count,
            byte_length,
        } if current == transfer_id => Some((*character_count, *byte_length)),
        _ => None,
    }
}

fn receiver_role(model: &AppModel) -> bool {
    matches!(
        model.screen,
        Screen::Room {
            role: RoomRole::Receiver,
            ..
        }
    )
}

fn friendly_text_error(message: &str) -> String {
    if message.contains("timed out") {
        "文本送达超时，请重新发送".to_owned()
    } else if message.contains("metadata does not match")
        || message.contains("exceeds the supported limit")
    {
        "文本校验失败，正文未被接收".to_owned()
    } else if message.contains("DataChannel") || message.contains("channel") {
        "点对点连接已断开，请重新发送".to_owned()
    } else {
        "文本传输失败，请重试".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_content_is_only_present_after_the_received_event() {
        let mut model = AppModel::default();
        apply(
            &mut model,
            "peer-1".to_owned(),
            RtcEvent::TextIncomingOffered {
                transfer_id: "text-1".to_owned(),
                character_count: 4,
                byte_length: 6,
            },
        );
        assert_eq!(
            model.text_transfers_by_peer["peer-1"],
            TextTransferState::Incoming {
                transfer_id: "text-1".to_owned(),
                character_count: 4,
                byte_length: 6,
            }
        );

        apply(
            &mut model,
            "peer-1".to_owned(),
            RtcEvent::TextTransferAccepted {
                transfer_id: "text-1".to_owned(),
                direction: TransferDirection::Receive,
            },
        );
        assert!(matches!(
            model.text_transfers_by_peer["peer-1"],
            TextTransferState::Receiving { .. }
        ));

        apply(
            &mut model,
            "peer-1".to_owned(),
            RtcEvent::TextTransferReceived {
                transfer_id: "text-1".to_owned(),
                text: "你好\n".to_owned(),
            },
        );
        assert_eq!(
            model.text_transfers_by_peer["peer-1"],
            TextTransferState::Received {
                text: "你好\n".to_owned(),
            }
        );
    }

    #[test]
    fn text_transport_errors_are_presented_in_chinese() {
        assert_eq!(
            friendly_text_error("text transfer timed out"),
            "文本送达超时，请重新发送"
        );
        assert_eq!(
            friendly_text_error("text payload metadata does not match"),
            "文本校验失败，正文未被接收"
        );
    }
}
