/** TapTap 分享卡片通过场景参数打开同一个房间邀请页。 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { isTapH5 } from '../app-runtime.js';

type InviteKind = 'lobby' | 'room';
type Launch = { query?: { sceneParam?: string } };
type ShowListener = (launch: Launch) => void;

interface TapShareBridge {
  showShareboard?(options: { templateId: string; sceneParam: string; fail?: (error: { errMsg: string }) => void }): void;
  getLaunchOptionsSync?(): Launch;
  onShow?(listener: ShowListener): void;
  offShow?(listener: ShowListener): void;
}

const templateId = import.meta.env.VITE_TAPTAP_SHARE_TEMPLATE_ID;
const bridge = () => isTapH5 ? (window as { tap?: TapShareBridge }).tap : undefined;

export function canShareTapInvite(): boolean {
  return Boolean(templateId && typeof bridge()?.showShareboard === 'function');
}

export function shareTapInvite(kind: InviteKind, token: string, onError: () => void): void {
  const tap = bridge();
  if (!templateId || !tap?.showShareboard) { onError(); return; }
  tap.showShareboard({ templateId, sceneParam: `${kind}:${token}`, fail: onError });
}

/** 只接受约定的邀请格式，进入现有邀请页后由 API 校验令牌并处理登录回跳。 */
export function TapTapInviteListener() {
  const navigate = useNavigate();
  const readInitial = useRef(false);
  useEffect(() => {
    const tap = bridge();
    if (!tap) return;
    const open: ShowListener = (launch) => {
      const match = /^(room|lobby):([a-f0-9]{32})$/.exec(launch.query?.sceneParam ?? '');
      if (match) void navigate(`/${match[1]}/invite/${match[2]}`, { replace: true });
    };
    if (!readInitial.current) {
      readInitial.current = true;
      const initial = tap.getLaunchOptionsSync?.();
      if (initial) open(initial);
    }
    tap.onShow?.(open);
    return () => tap.offShow?.(open);
  }, [navigate]);
  return null;
}
