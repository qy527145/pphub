//! TURN over TCP 适配器（RFC 5766 §5.1）。
//!
//! `turn` crate 的 Server 只面向数据报式的 `Conn`（UDP 语义）。本模块把一个
//! TCP 监听器包装成同样的接口：按 STUN / ChannelData 的自带长度字段对字节流
//! 分帧，每帧等价于一个数据报交给 Server；回程按对端地址找到所属 TCP 连接写回。
//!
//! 有了它，浏览器可用 `turn:host:port?transport=tcp` 接入——客户端与服务器之间
//! 全程 TCP（可穿越禁 UDP 的网络），中继腿只发生在服务器内部。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use webrtc_util::conn::Conn;
use webrtc_util::{Error as UtilError, Result as UtilResult};

/// 与 turn Server 读缓冲一致；超过即视为非法帧丢弃。
const MAX_FRAME: usize = 1500;

type Writer = Arc<tokio::sync::Mutex<OwnedWriteHalf>>;

pub struct TcpTurn {
    local: SocketAddr,
    /// 各连接读任务解析出的完整帧 →（帧, 对端地址）。
    rx: tokio::sync::Mutex<mpsc::Receiver<(Vec<u8>, SocketAddr)>>,
    writers: Arc<Mutex<HashMap<SocketAddr, Writer>>>,
}

impl TcpTurn {
    pub async fn bind(addr: (&str, u16)) -> std::io::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        let local = listener.local_addr()?;
        let (tx, rx) = mpsc::channel::<(Vec<u8>, SocketAddr)>(256);
        let writers: Arc<Mutex<HashMap<SocketAddr, Writer>>> = Arc::new(Mutex::new(HashMap::new()));

        let writers_accept = Arc::clone(&writers);
        tokio::spawn(async move {
            loop {
                let Ok((stream, peer)) = listener.accept().await else {
                    break;
                };
                let _ = stream.set_nodelay(true);
                let (read_half, write_half) = stream.into_split();
                writers_accept
                    .lock()
                    .unwrap()
                    .insert(peer, Arc::new(tokio::sync::Mutex::new(write_half)));

                let tx = tx.clone();
                let writers = Arc::clone(&writers_accept);
                tokio::spawn(async move {
                    let mut r = read_half;
                    while let Some(frame) = read_frame(&mut r).await {
                        if tx.send((frame, peer)).await.is_err() {
                            break;
                        }
                    }
                    writers.lock().unwrap().remove(&peer);
                });
            }
        });

        Ok(TcpTurn {
            local,
            rx: tokio::sync::Mutex::new(rx),
            writers,
        })
    }

    /// 实际监听端口。
    pub fn port(&self) -> u16 {
        self.local.port()
    }
}

/// 从 TCP 流中读出一条完整的 STUN 或 ChannelData 消息（剥去 TCP 填充）。
/// 流损坏或到达 EOF 时返回 None，调用方结束该连接。
async fn read_frame(r: &mut (impl AsyncReadExt + Unpin)) -> Option<Vec<u8>> {
    let mut head = [0u8; 4];
    r.read_exact(&mut head).await.ok()?;

    let (total, pad) = match head[0] & 0xC0 {
        // STUN：20 字节头 + 长度字段（属性区，自带 4 字节对齐）。
        0x00 => (20 + u16::from_be_bytes([head[2], head[3]]) as usize, 0),
        // ChannelData：4 字节头 + 负载；TCP 上负载须补齐到 4 字节边界。
        0x40 => {
            let len = u16::from_be_bytes([head[2], head[3]]) as usize;
            (4 + len, (4 - len % 4) % 4)
        }
        _ => return None, // 非 TURN 流量，断开。
    };
    if total > MAX_FRAME {
        return None;
    }

    let mut frame = vec![0u8; total + pad];
    frame[..4].copy_from_slice(&head);
    r.read_exact(&mut frame[4..]).await.ok()?;
    frame.truncate(total); // 去掉 TCP 填充，交给 Server 的是与 UDP 一致的消息体。
    Some(frame)
}

#[async_trait]
impl Conn for TcpTurn {
    async fn connect(&self, _addr: SocketAddr) -> UtilResult<()> {
        Err(UtilError::from(std::io::Error::other("not supported")))
    }

    async fn recv(&self, _buf: &mut [u8]) -> UtilResult<usize> {
        Err(UtilError::from(std::io::Error::other("not supported")))
    }

    async fn recv_from(&self, buf: &mut [u8]) -> UtilResult<(usize, SocketAddr)> {
        let mut rx = self.rx.lock().await;
        let (frame, peer) = rx
            .recv()
            .await
            .ok_or_else(|| UtilError::from(std::io::Error::other("closed")))?;
        let n = frame.len().min(buf.len());
        buf[..n].copy_from_slice(&frame[..n]);
        Ok((n, peer))
    }

    async fn send(&self, _buf: &[u8]) -> UtilResult<usize> {
        Err(UtilError::from(std::io::Error::other("not supported")))
    }

    async fn send_to(&self, buf: &[u8], target: SocketAddr) -> UtilResult<usize> {
        let writer = self
            .writers
            .lock()
            .unwrap()
            .get(&target)
            .cloned()
            .ok_or_else(|| UtilError::from(std::io::Error::other("conn gone")))?;

        // ChannelData 在 TCP 上必须补齐到 4 字节边界（STUN 消息天然对齐）。
        let pad = if buf.first().map(|b| b & 0xC0) == Some(0x40) {
            (4 - buf.len() % 4) % 4
        } else {
            0
        };

        let mut w = writer.lock().await;
        w.write_all(buf).await?;
        if pad > 0 {
            w.write_all(&[0u8; 3][..pad]).await?;
        }
        Ok(buf.len())
    }

    fn local_addr(&self) -> UtilResult<SocketAddr> {
        Ok(self.local)
    }

    fn remote_addr(&self) -> Option<SocketAddr> {
        None
    }

    async fn close(&self) -> UtilResult<()> {
        Ok(())
    }

    fn as_any(&self) -> &(dyn std::any::Any + Send + Sync) {
        self
    }
}
