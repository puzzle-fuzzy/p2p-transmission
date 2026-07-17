use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserPlatformError, RtcPeer, browser_files_from_input, choose_persistent_source_files,
    choose_stream_files,
};
use p2p_protocol::CancelReason;

use crate::rtc_orchestration::reconnect_paused_transfer;
use crate::transfer_presentation::transfer_is_active;

use super::{AppModel, RoomRole, TransferLinkState, TransferState, friendly_transfer_error};

#[derive(Clone, Copy)]
pub(super) struct TransferActions {
    model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
}

impl TransferActions {
    pub(super) fn new(
        model: Signal<AppModel>,
        rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    ) -> Self {
        Self { model, rtc_peers }
    }

    pub(super) fn submit_selected_files(self, peer_ids: Vec<String>) -> Vec<String> {
        let mut model = self.model;
        let files = match browser_files_from_input("transfer-file-input") {
            Ok(files) if !files.is_empty() => files,
            Ok(_) => return Vec::new(),
            Err(error) => {
                model.write().error = Some(friendly_transfer_error(&error));
                return Vec::new();
            }
        };
        let peers = self.rtc_peers.read();
        let mut offered = Vec::new();
        let mut last_error = None;
        for peer_id in peer_ids {
            let Some(peer) = peers.get(&peer_id) else {
                last_error = Some("有接收者的点对点连接已经断开".to_owned());
                continue;
            };
            match peer.offer_files(files.clone()) {
                Ok(_) => offered.push(peer_id),
                Err(error) => last_error = Some(friendly_transfer_error(&error)),
            }
        }
        drop(peers);
        model.write().error = last_error;
        offered
    }

    pub(super) async fn submit_persistent_source_files(self, peer_ids: Vec<String>) -> Vec<String> {
        let mut model = self.model;
        let files = match choose_persistent_source_files().await {
            Ok(files) if !files.is_empty() => files,
            Ok(_) | Err(BrowserPlatformError::UserCancelled) => return Vec::new(),
            Err(error) => {
                model.write().error = Some(friendly_transfer_error(&error));
                return Vec::new();
            }
        };
        let peers = {
            let peers = self.rtc_peers.read();
            peer_ids
                .into_iter()
                .map(|peer_id| (peer_id.clone(), peers.get(&peer_id).cloned()))
                .collect::<Vec<_>>()
        };
        let mut offered = Vec::new();
        let mut last_error = None;
        for (peer_id, peer) in peers {
            let Some(peer) = peer else {
                last_error = Some("有接收者的点对点连接已经断开".to_owned());
                continue;
            };
            match peer.offer_persistent_files(files.clone()).await {
                Ok(_) => offered.push(peer_id),
                Err(error) => last_error = Some(friendly_transfer_error(&error)),
            }
        }
        model.write().error = last_error;
        offered
    }

    pub(super) fn resume_outgoing_transfers(self, peer_ids: Vec<String>) {
        let mut model = self.model;
        let peers = {
            let peers = self.rtc_peers.read();
            peer_ids
                .into_iter()
                .filter_map(|peer_id| peers.get(&peer_id).cloned())
                .collect::<Vec<_>>()
        };
        spawn(async move {
            let mut last_error = None;
            for peer in peers {
                if let Err(error) = peer.resume_outgoing_transfer().await {
                    last_error = Some(friendly_transfer_error(&error));
                }
            }
            model.write().error = last_error;
        });
    }

    pub(super) fn decide_incoming_transfer(self, peer_id: &str, transfer_id: &str, accepted: bool) {
        let mut model = self.model;
        let Some(peer) = self.rtc_peers.read().get(peer_id).cloned() else {
            model.write().error = Some("点对点连接已经断开".to_owned());
            return;
        };
        if let Err(error) = peer.decide_transfer(transfer_id, accepted) {
            model.write().error = Some(friendly_transfer_error(&error));
        } else {
            model.write().error = None;
        }
    }

    pub(super) async fn accept_streaming_transfer(
        self,
        peer_id: String,
        transfer_id: String,
        file_names: Vec<String>,
    ) {
        let mut model = self.model;
        let Some(peer) = self.rtc_peers.read().get(&peer_id).cloned() else {
            model.write().error = Some("点对点连接已经断开".to_owned());
            return;
        };
        let writers = match choose_stream_files(&file_names).await {
            Ok(writers) => writers,
            Err(BrowserPlatformError::UserCancelled) => return,
            Err(error) => {
                model.write().error = Some(friendly_transfer_error(&error));
                return;
            }
        };
        if let Err(error) = peer.accept_stream_transfer(&transfer_id, writers).await {
            model.write().error = Some(friendly_transfer_error(&error));
        } else {
            let mut state = model.write();
            state.error = None;
            state.notice = Some(if file_names.len() > 1 {
                "已选择保存文件夹，开始按顺序接收".to_owned()
            } else {
                "已选择保存位置，开始接收文件".to_owned()
            });
        }
    }

    pub(super) async fn resume_streaming_transfer(self, peer_id: String, transfer_id: String) {
        let mut model = self.model;
        let Some(peer) = self.rtc_peers.read().get(&peer_id).cloned() else {
            model.write().error = Some("点对点连接已经断开".to_owned());
            return;
        };
        if let Err(error) = peer.resume_stream_transfer(&transfer_id).await {
            model.write().error = Some(friendly_transfer_error(&error));
        } else {
            let mut state = model.write();
            state.error = None;
            state.notice = Some("已校验原保存位置，继续接收".to_owned());
        }
    }

    pub(super) fn cancel_current_transfers(self, role: RoomRole, batch_peer_ids: Vec<String>) {
        let mut model = self.model;
        let reason = if role == RoomRole::Owner {
            CancelReason::SenderCancelled
        } else {
            CancelReason::ReceiverCancelled
        };
        let peer_ids = if role == RoomRole::Owner {
            batch_peer_ids
        } else {
            model
                .read()
                .transfers_by_peer
                .iter()
                .filter(|(_, transfer)| transfer_is_active(transfer))
                .map(|(peer_id, _)| peer_id.clone())
                .collect()
        };
        let peers = {
            let peers = self.rtc_peers.read();
            peer_ids
                .into_iter()
                .filter_map(|peer_id| peers.get(&peer_id).cloned())
                .collect::<Vec<_>>()
        };
        spawn(async move {
            let mut last_error = None;
            for peer in peers {
                if let Err(error) = peer.cancel_transfer(reason).await {
                    last_error = Some(friendly_transfer_error(&error));
                }
            }
            model.write().error = last_error;
        });
    }

    pub(super) fn retry_paused_transfers(self, peer_ids: Vec<String>) {
        let model = self.model;
        let peers = {
            let peers = self.rtc_peers.read();
            peer_ids
                .into_iter()
                .filter_map(|peer_id| peers.get(&peer_id).cloned().map(|peer| (peer_id, peer)))
                .collect::<Vec<_>>()
        };
        for (peer_id, peer) in peers {
            let paused = matches!(
                model.read().transfers_by_peer.get(&peer_id),
                Some(TransferState::Active {
                    link_state: TransferLinkState::Paused,
                    ..
                })
            );
            if !paused {
                continue;
            }
            reconnect_paused_transfer(model, self.rtc_peers, peer, peer_id);
        }
    }
}
