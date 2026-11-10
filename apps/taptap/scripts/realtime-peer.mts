/** 真实 WebSocket 联调客户端：直接连实际 API，不替代 TapTap 宿主。 */
import { wsServerFrameSchema, type WsClientFrame, type WsServerFrame } from '@jev/contracts';

export class RealtimePeer {
  private readonly frames: WsServerFrame[] = [];
  private readonly listeners = new Set<() => void>();
  private failure: Error | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      try { this.frames.push(wsServerFrameSchema.parse(JSON.parse(String(event.data)))); }
      catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); }
      this.listeners.forEach((listener) => listener());
    });
    socket.addEventListener('error', () => { this.failure = new Error('真实 WebSocket 连接失败'); this.listeners.forEach((listener) => listener()); });
    socket.addEventListener('close', () => { this.failure = new Error('真实 WebSocket 已关闭'); this.listeners.forEach((listener) => listener()); });
  }

  /** 握手完成后再认证，所有消息使用正式帧契约。 */
  static async connect(origin: string, ticket: string): Promise<RealtimePeer> {
    const url = new URL('/ws', origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const peer = new RealtimePeer(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('真实 WebSocket 握手超时')), 10_000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('真实 WebSocket 握手失败')); }, { once: true });
      });
      peer.send({ type: 'auth', ticket });
      await peer.next((frame) => frame.type === 'ack' && Boolean(frame.userId));
      return peer;
    } catch (error) { socket.close(); throw error; }
  }

  send(frame: WsClientFrame): void { this.socket.send(JSON.stringify(frame)); }

  /** 消息先入队，等待者可以在实际业务操作之后读取，避免错过快速送达的帧。 */
  next(predicate: (frame: WsServerFrame) => boolean): Promise<WsServerFrame> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(check); };
      const check = () => {
        const index = this.frames.findIndex(predicate);
        if (index >= 0) { const frame = this.frames.splice(index, 1)[0]!; cleanup(); resolve(frame); }
        else if (this.failure) { cleanup(); reject(this.failure); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('真实 WebSocket 等待目标帧超时')); }, 10_000);
      this.listeners.add(check); check();
    });
  }

  close(): void { this.socket.close(); }
}
