import { createContext, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { DialogQueue } from './dialog-queue.js';

interface DialogActions {
  confirm: (message: string) => Promise<boolean>;
  prompt: (message: string) => Promise<string | null>;
}
const Context = createContext<DialogActions | null>(null);

/** 共用深海弹窗；Radix 管理焦点、Escape 关闭和键盘焦点限制。 */
export function DialogProvider({ children, confirmLabel, cancelLabel }: { children: ReactNode; confirmLabel: string; cancelLabel: string }) {
  const [queue] = useState(() => new DialogQueue());
  const request = useSyncExternalStore(queue.subscribe, queue.current, queue.current);
  const origin = useRef<HTMLElement | null>(null);
  const [actions] = useState<DialogActions>(() => {
    const ask = (kind: 'confirm' | 'prompt', message: string) => {
      if (!queue.current()) origin.current = document.activeElement as HTMLElement | null;
      return queue.ask(kind, message);
    };
    return { confirm: async (message) => (await ask('confirm', message)) !== null, prompt: (message) => ask('prompt', message) };
  });
  return <Context.Provider value={actions}>
    {children}
    <Dialog.Root open={request !== null} onOpenChange={(open) => { if (!open) queue.settle(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="jev-dialog-overlay" />
        <Dialog.Content className="jev-dialog" onCloseAutoFocus={(event) => { event.preventDefault(); origin.current?.focus(); }} onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLElement>(request?.kind === 'prompt' ? '.jev-dialog input' : '.jev-dialog-cancel')?.focus();
        }}>
          <Dialog.Title className="jev-dialog-title">{confirmLabel}</Dialog.Title>
          <Dialog.Description className="jev-dialog-description">{request?.message}</Dialog.Description>
          {request && <form key={request.id} onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            queue.settle(request.kind === 'prompt' ? String(data.get('value') ?? '') : 'confirmed');
          }}>
            {request.kind === 'prompt' && <input className="jev-dialog-input" name="value" aria-label={request.message} />}
            <div className="jev-dialog-actions">
              <button className="jev-dialog-cancel" type="button" onClick={() => queue.settle(null)}>{cancelLabel}</button>
              <button className="jev-dialog-confirm" type="submit">{confirmLabel}</button>
            </div>
          </form>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </Context.Provider>;
}

/** 所有调用点等待用户明确选择，取消时不执行后续写操作。 */
export function useDialog(): DialogActions {
  const actions = useContext(Context);
  if (!actions) throw new Error('useDialog 需要 DialogProvider');
  return actions;
}
