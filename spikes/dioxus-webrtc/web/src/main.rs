mod peer;

use std::{cell::RefCell, rc::Rc};

use dioxus::prelude::*;
use peer::{
    ClientCallbacks, DownloadCallback, ProgressCallback, SpikeClient, StringCallback,
    StringsCallback,
};
use wasm_bindgen::JsCast;
use web_sys::HtmlInputElement;

const STYLE: &str = include_str!("../assets/main.css");

fn main() {
    console_error_panic_hook::set_once();
    dioxus::launch(App);
}

#[allow(non_snake_case)]
fn App() -> Element {
    let mut room = use_signal(|| "rust-spike".to_owned());
    let mut status = use_signal(|| "尚未连接".to_owned());
    let mut peer_id = use_signal(String::new);
    let mut peers = use_signal(Vec::<String>::new);
    let received_text = use_signal(String::new);
    let mut text_to_send = use_signal(|| "Hello from Rust/WASM".to_owned());
    let progress = use_signal(|| 0.0_f64);
    let progress_label = use_signal(|| "等待传输".to_owned());
    let download = use_signal(|| None::<(String, String)>);
    let logs = use_signal(Vec::<String>::new);
    let mut client = use_signal(|| None::<SpikeClient>);

    let connected = client.read().is_some();
    let data_channel_ready = client
        .read()
        .as_ref()
        .is_some_and(SpikeClient::data_channel_ready);
    let peers_label = peers.read().join(", ");

    rsx! {
        style { {STYLE} }
        main { class: "shell",
            p { class: "eyebrow", "P2P Transmission 2.0 / M1" }
            h1 { "Rust WebRTC 技术验证" }
            p { class: "lede",
                "Dioxus/WASM 负责浏览器端，Axum 只转发 signaling。这个页面用于验证 WebRTC、文件分片、完整性和背压，不代表最终产品视觉。"
            }

            section { class: "card", aria_label: "连接设置",
                div { class: "grid",
                    input {
                        aria_label: "Spike room",
                        disabled: connected,
                        value: "{room}",
                        oninput: move |event| room.set(event.value()),
                    }
                    button {
                        disabled: connected || room.read().trim().is_empty(),
                        onclick: move |_| {
                            let status_callback: StringCallback = {
                                let mut status = status;
                                Rc::new(RefCell::new(Box::new(move |value: String| {
                                    status.set(value);
                                })))
                            };
                            let peers_callback: StringsCallback = {
                                let mut peers = peers;
                                Rc::new(RefCell::new(Box::new(move |value: Vec<String>| {
                                    peers.set(value);
                                })))
                            };
                            let text_callback: StringCallback = {
                                let mut received_text = received_text;
                                Rc::new(RefCell::new(Box::new(move |value: String| {
                                    received_text.set(value);
                                })))
                            };
                            let progress_callback: ProgressCallback = {
                                let mut progress = progress;
                                let mut progress_label = progress_label;
                                Rc::new(RefCell::new(Box::new(move |value: f64, label: String| {
                                    progress.set(value);
                                    progress_label.set(label);
                                })))
                            };
                            let download_callback: DownloadCallback = {
                                let mut download = download;
                                Rc::new(RefCell::new(Box::new(move |name: String, url: String| {
                                    download.set(Some((name, url)));
                                })))
                            };
                            let log_callback: StringCallback = {
                                let mut logs = logs;
                                Rc::new(RefCell::new(Box::new(move |entry: String| {
                                    logs.with_mut(|items| {
                                        items.push(entry);
                                        if items.len() > 30 {
                                            items.remove(0);
                                        }
                                    });
                                })))
                            };

                            match SpikeClient::connect(
                                room.read().trim(),
                                ClientCallbacks {
                                    on_status: status_callback,
                                    on_peers: peers_callback,
                                    on_text: text_callback,
                                    on_progress: progress_callback,
                                    on_download: download_callback,
                                    on_log: log_callback,
                                },
                            ) {
                                Ok(next_client) => {
                                    peer_id.set(next_client.peer_id().to_owned());
                                    client.set(Some(next_client));
                                }
                                Err(error) => status.set(format!("连接失败：{error}")),
                            }
                        },
                        "连接 signaling"
                    }
                }
                div { class: "status", role: "status",
                    span { "状态" }
                    strong { "{status}" }
                }
                div { class: "status",
                    span { "本地 peer" }
                    code { "{peer_id}" }
                }
                div { class: "status",
                    span { "房间内其他 peer" }
                    code { "{peers_label}" }
                }
            }

            section { class: "card", aria_label: "DataChannel 文本验证",
                h2 { "文本" }
                div { class: "grid",
                    input {
                        aria_label: "要通过 DataChannel 发送的文本",
                        value: "{text_to_send}",
                        oninput: move |event| text_to_send.set(event.value()),
                    }
                    button {
                        disabled: !data_channel_ready,
                        onclick: move |_| {
                            if let Some(active) = client.read().as_ref()
                                && let Err(error) = active.send_text(&text_to_send.read())
                            {
                                status.set(format!("文本发送失败：{error}"));
                            }
                        },
                        "发送文本"
                    }
                }
                p { "收到：{received_text}" }
            }

            section { class: "card", aria_label: "DataChannel 文件验证",
                h2 { "文件" }
                input { id: "spike-file", r#type: "file", disabled: !data_channel_ready }
                div { class: "row",
                    button {
                        disabled: !data_channel_ready,
                        onclick: move |_| {
                            let Some(window) = web_sys::window() else {
                                status.set("无法访问 window".to_owned());
                                return;
                            };
                            let Some(document) = window.document() else {
                                status.set("无法访问 document".to_owned());
                                return;
                            };
                            let Some(element) = document.get_element_by_id("spike-file") else {
                                status.set("找不到文件输入".to_owned());
                                return;
                            };
                            let Ok(input) = element.dyn_into::<HtmlInputElement>() else {
                                status.set("文件输入类型无效".to_owned());
                                return;
                            };
                            let Some(file) = input.files().and_then(|files| files.get(0)) else {
                                status.set("请先选择一个文件".to_owned());
                                return;
                            };
                            if let Some(active) = client.read().as_ref() {
                                active.send_file(file);
                            }
                        },
                        "发送文件"
                    }
                    button {
                        disabled: !connected,
                        onclick: move |_| {
                            if let Some(active) = client.write().take() {
                                active.close();
                            }
                            status.set("已关闭".to_owned());
                            peers.set(Vec::new());
                        },
                        "关闭连接"
                    }
                }
                div { class: "progress", aria_label: "文件传输进度",
                    span { style: "width: {progress}%" }
                }
                p { "{progress_label}" }
                if let Some((name, url)) = download.read().as_ref() {
                    a {
                        class: "download",
                        href: "{url}",
                        download: "{name}",
                        "下载 {name}"
                    }
                }
            }

            section { class: "card", aria_label: "诊断日志",
                h2 { "诊断" }
                ol { class: "log",
                    for entry in logs.read().iter() {
                        li { "{entry}" }
                    }
                }
            }
        }
    }
}
