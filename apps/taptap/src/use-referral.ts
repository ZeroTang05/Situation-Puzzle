/** 未登录时本地记住邀请；登录后只自动提交一次，失败允许当前账号手动重试。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { inviteClaimRequestSchema } from '@jev/contracts';
import { api } from './api.js';
import { claimReferral } from './share-scene.js';
import { useSession } from './state.js';

const REF_KEY = 'jev.taptap.inviteRef';
type Failure = { userId: string; code: string; message: string };

export function useReferralClaim() {
  const { session } = useSession(); const userId = session?.user.id;
  const [pending, setPending] = useState<string | null>(() => {
    const saved = tap.getStorageSync(REF_KEY);
    return saved ? inviteClaimRequestSchema.parse({ code: saved }).code : null;
  });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false); const running = useRef(false);
  const lastSceneCode = useRef(pending);
  const remember = useCallback((code: string) => {
    const value = inviteClaimRequestSchema.parse({ code }).code;
    // 回前台可能再次携带同一启动参数；一次运行中只自动处理一次。
    if (lastSceneCode.current === value) return;
    lastSceneCode.current = value;
    tap.setStorageSync(REF_KEY, value); setPending(value); setFailure(null);
  }, []);
  useEffect(() => {
    if (!userId || !pending || running.current) return;
    const code = pending;
    // 发起时消费本地记录，避免退出后把同一邀请自动登记给另一个账号。
    tap.removeStorageSync(REF_KEY); setPending(null); running.current = true; setBusy(true);
    void claimReferral(api, code).then(() => setFailure(null)).catch((error: unknown) => {
      console.error('[taptap:referral]', error);
      setFailure({ userId, code, message: error instanceof Error ? error.message : String(error) });
    }).finally(() => { running.current = false; setBusy(false); });
  }, [userId, pending, busy]);
  const currentFailure = failure?.userId === userId ? failure : null;
  return { remember, error: currentFailure?.message ?? '', busy,
    retry: () => {
      if (!currentFailure || running.current) return;
      tap.setStorageSync(REF_KEY, currentFailure.code); setPending(currentFailure.code); setFailure(null);
    },
    dismiss: () => setFailure(null),
  };
}
