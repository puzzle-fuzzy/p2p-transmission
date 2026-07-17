use p2p_protocol::ControlMessage;

use super::{RtcEvent, RtcPeer, TransferDirection, summarize_transfer_files};

impl RtcPeer {
    pub(super) fn handle_control(&self, message: ControlMessage) {
        match message {
            ControlMessage::Manifest {
                transfer_id,
                mode,
                files,
                ..
            } => self.handle_manifest(transfer_id, mode, files),
            ControlMessage::Decision {
                transfer_id,
                accepted,
                ..
            } => self.handle_decision(transfer_id, accepted),
            ControlMessage::Start { transfer_id, .. } => {
                let (event, resumed_bytes, total_bytes) = {
                    let mut inner = self.inner.borrow_mut();
                    let Some(receive) = inner.receive.as_mut() else {
                        drop(inner);
                        self.fail(
                            Some(transfer_id),
                            "transfer started before acceptance".to_owned(),
                        );
                        return;
                    };
                    if receive.offer.transfer_id != transfer_id {
                        drop(inner);
                        self.fail(
                            Some(transfer_id),
                            "transfer start id does not match".to_owned(),
                        );
                        return;
                    }
                    receive.started = true;
                    let files = receive.offer.transfer_files();
                    let summary = summarize_transfer_files(&files);
                    (
                        RtcEvent::TransferStarted {
                            transfer_id: transfer_id.clone(),
                            direction: TransferDirection::Receive,
                            mode: receive.offer.mode,
                            file: summary,
                            files,
                        },
                        receive.received_bytes,
                        receive.offer.total_bytes(),
                    )
                };
                self.emit(event);
                if resumed_bytes > 0 {
                    self.emit(RtcEvent::TransferProgress {
                        transfer_id,
                        direction: TransferDirection::Receive,
                        completed_bytes: resumed_bytes,
                        total_bytes,
                    });
                }
            }
            ControlMessage::StreamReady {
                transfer_id,
                max_chunk_bytes,
                ack_window_bytes,
                resume,
                ..
            } => self.handle_stream_ready(transfer_id, max_chunk_bytes, ack_window_bytes, resume),
            ControlMessage::SegmentCommit {
                transfer_id,
                file_id,
                segment_index,
                offset,
                bytes,
                blake3,
                ..
            } => self.handle_segment_commit(
                transfer_id,
                file_id,
                segment_index,
                offset,
                bytes,
                blake3,
            ),
            ControlMessage::SegmentAck {
                transfer_id,
                file_id,
                segment_index,
                committed_bytes,
                blake3,
                ..
            } => self.handle_segment_ack(
                transfer_id,
                file_id,
                segment_index,
                committed_bytes,
                blake3,
            ),
            ControlMessage::StreamPaused {
                transfer_id,
                reason,
                ..
            } => self.handle_stream_paused(transfer_id, reason),
            ControlMessage::StreamComplete {
                transfer_id,
                total_bytes,
                files,
                ..
            } => self.handle_stream_complete(transfer_id, total_bytes, files),
            ControlMessage::Cancel {
                transfer_id,
                reason,
                ..
            } => {
                self.clear_transfer(&transfer_id);
                self.emit(RtcEvent::TransferCancelled {
                    transfer_id,
                    reason,
                });
            }
            ControlMessage::Complete {
                transfer_id,
                bytes,
                blake3,
                ..
            } => self.handle_complete(transfer_id, bytes, blake3),
            ControlMessage::Error {
                transfer_id,
                message,
                ..
            } => {
                self.clear_transfer(&transfer_id);
                self.fail(Some(transfer_id), message);
            }
        }
    }
}
