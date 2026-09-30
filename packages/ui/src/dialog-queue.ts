export interface DialogRequest {
  id: number;
  kind: 'confirm' | 'prompt';
  message: string;
  resolve: (value: string | null) => void;
}

/** 弹窗按请求顺序显示，取消返回 null，重复点击不会覆盖前一个确认。 */
export class DialogQueue {
  private requests: DialogRequest[] = [];
  private nextId = 0;
  private listeners = new Set<() => void>();
  current = () => this.requests[0] ?? null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  ask(kind: DialogRequest['kind'], message: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.requests.push({ id: ++this.nextId, kind, message, resolve });
      this.emit();
    });
  }
  settle(value: string | null) {
    const request = this.requests.shift();
    if (!request) return;
    request.resolve(value);
    this.emit();
  }
  private emit() { this.listeners.forEach((listener) => listener()); }
}
