use p2p_browser_platform::{BrowserPlatformError, BrowserStorageErrorKind};

use crate::app_transition::AppEvent;

pub(super) fn platform_error_event(error: &BrowserPlatformError) -> AppEvent {
    if error.requires_upgrade() {
        AppEvent::UpgradeRequired
    } else {
        AppEvent::SetError(Some(friendly_error(error)))
    }
}

pub(super) fn transfer_error_event(error: &BrowserPlatformError) -> AppEvent {
    if error.requires_upgrade() {
        AppEvent::UpgradeRequired
    } else {
        AppEvent::SetError(Some(friendly_transfer_error(error)))
    }
}

pub(super) fn friendly_error(error: &BrowserPlatformError) -> String {
    match error {
        BrowserPlatformError::Api { status: 401, .. } => {
            "安全会话已失效，请刷新页面后重试".to_owned()
        }
        BrowserPlatformError::Api { status: 403, .. } => {
            "邀请链接无效、已过期，或当前操作没有权限".to_owned()
        }
        BrowserPlatformError::Api { status: 404, .. } => {
            "没有找到这个房间，请检查房间码".to_owned()
        }
        BrowserPlatformError::Api { status: 409, .. } => "房间状态刚刚发生变化，请重试".to_owned(),
        BrowserPlatformError::Api { status: 429, .. } => "操作过于频繁，请稍后再试".to_owned(),
        BrowserPlatformError::UpgradeRequired { .. }
        | BrowserPlatformError::MissingCapabilities => "应用已经更新，请刷新页面后继续".to_owned(),
        BrowserPlatformError::Request(_) => "网络连接失败，请检查网络后重试".to_owned(),
        BrowserPlatformError::RtcConfigExpired => "点对点连接配置已过期，正在重新获取".to_owned(),
        _ => "暂时无法完成操作，请稍后重试".to_owned(),
    }
}

pub(super) fn friendly_transfer_error(error: &BrowserPlatformError) -> String {
    match error {
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::QuotaExceeded,
            ..
        } => "磁盘空间不足，请释放空间后重试".to_owned(),
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::PermissionDenied,
            ..
        } => "文件访问权限已失效，请重新授权".to_owned(),
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::NotFound,
            ..
        } => "所选文件或保存位置已不可用，请重新选择".to_owned(),
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::InvalidState,
            ..
        } => "文件当前无法读写，请关闭占用程序后重试".to_owned(),
        BrowserPlatformError::Storage { .. } => {
            "无法读写所选文件，请检查文件和保存位置后重试".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("between 1 and") || message.contains("file list is empty") =>
        {
            "一次最多选择 10 个文件".to_owned()
        }
        BrowserPlatformError::Browser(message) if message.contains("files exceed") => {
            "本次文件总大小不能超过 5 GiB".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("transfer limit") || message.contains("exceeds") =>
        {
            "单个文件不能超过 5 GiB".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("streaming file saving is unavailable") =>
        {
            "当前浏览器不支持大文件直接保存，请使用桌面版 Chrome 或 Edge".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("streaming") || message.contains("storage") =>
        {
            "无法写入所选位置，请检查磁盘空间后重试".to_owned()
        }
        BrowserPlatformError::Browser(message) if message.contains("already active") => {
            "已有内容正在传输，请等待完成后再试".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("DataChannel") || message.contains("PeerConnection") =>
        {
            "点对点连接尚未就绪，请稍后再试".to_owned()
        }
        BrowserPlatformError::Browser(message) if message.contains("incoming transfer") => {
            "这次文件接收申请已经失效".to_owned()
        }
        BrowserPlatformError::Browser(message) if message.contains("incoming text") => {
            "这次文本接收申请已经失效".to_owned()
        }
        BrowserPlatformError::Browser(_) => "文件传输暂时失败，请重试".to_owned(),
        BrowserPlatformError::UserCancelled => "已取消选择保存位置".to_owned(),
        _ => friendly_error(error),
    }
}

#[cfg(test)]
mod tests {
    use p2p_browser_platform::BrowserStorageOperation;

    use super::*;

    #[test]
    fn storage_failures_keep_specific_recovery_copy() {
        let storage_error = |kind| BrowserPlatformError::Storage {
            operation: BrowserStorageOperation::WriteDestination,
            kind,
            message: "injected failure".to_owned(),
        };

        assert_eq!(
            friendly_transfer_error(&storage_error(BrowserStorageErrorKind::QuotaExceeded)),
            "磁盘空间不足，请释放空间后重试"
        );
        assert_eq!(
            friendly_transfer_error(&storage_error(BrowserStorageErrorKind::PermissionDenied)),
            "文件访问权限已失效，请重新授权"
        );
        assert_eq!(
            friendly_transfer_error(&storage_error(BrowserStorageErrorKind::NotFound)),
            "所选文件或保存位置已不可用，请重新选择"
        );
        assert_eq!(
            friendly_transfer_error(&storage_error(BrowserStorageErrorKind::InvalidState)),
            "文件当前无法读写，请关闭占用程序后重试"
        );
    }

    #[test]
    fn expired_rtc_config_has_actionable_recovery_copy() {
        assert_eq!(
            friendly_transfer_error(&BrowserPlatformError::RtcConfigExpired),
            "点对点连接配置已过期，正在重新获取"
        );
    }
}
