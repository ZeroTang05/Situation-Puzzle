/** 官网账号设备授权：秘密只保存在内存中，后台暂停查询，回前台后继续等待。 */
import { useEffect, useEffectEvent, useState } from 'react';
import { deviceAuthorizationSchema, deviceTokenSchema, type DeviceAuthorization } from '@jev/contracts';
import { ApiError, authRequest, storeToken } from './api.js';
import { copyText, isForeground, useLanguage } from './runtime.js';
import { TaskStatus, useTask } from './state.js';
import { Button, Card, Text } from './ui/components.js';

export function DeviceLogin({ onSuccess, disabled, onActiveChange }: { onSuccess(): Promise<void>; disabled: boolean; onActiveChange(active: boolean): void }) {
  const { t } = useLanguage(); const task = useTask();
  const [flow, setFlow] = useState<(DeviceAuthorization & { expiresAt: number }) | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');
  const complete = useEffectEvent(onSuccess);
  useEffect(() => { onActiveChange(Boolean(flow) || task.busy); return () => onActiveChange(false); }, [flow, task.busy, onActiveChange]);
  useEffect(() => {
    if (!flow) return;
    let active = true; let interval = flow.interval * 1000; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active) return;
      if (Date.now() >= flow.expiresAt) { setFlow(null); setError(t('确认码已过期，请重新发起登录。', 'This code has expired. Start again.')); return; }
      if (!isForeground()) { timer = setTimeout(() => { void poll(); }, interval); return; }
      try {
        const result = await authRequest('/device/token', { anonymous: true, body: {
          client_id: __MINI_APP_ID__, device_code: flow.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        } }, deviceTokenSchema);
        if (!active) return;
        // 保留授权流程直到站内会话确认结束，确认失败时仍由当前流程显示错误。
        setFinishing(true); storeToken(result.access_token); await complete();
        if (active) setFlow(null);
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && ['authorization_pending', 'slow_down'].includes(error.code)) {
          if (error.code === 'slow_down') interval += 5000;
          timer = setTimeout(() => { void poll(); }, interval); return;
        }
        console.error('[device:login]', error instanceof ApiError ? error.code : error);
        setFlow(null); setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setFinishing(false);
      }
    };
    timer = setTimeout(() => { void poll(); }, interval);
    return () => { active = false; clearTimeout(timer); };
  }, [flow]);

  const start = () => task.run(async () => {
    setError('');
    const result = await authRequest('/device/code', { anonymous: true, body: { client_id: __MINI_APP_ID__ } }, deviceAuthorizationSchema);
    setFlow({ ...result, expiresAt: Date.now() + result.expires_in * 1000 });
  });
  return <Card><Text size={20}>{t('使用官网账号', 'Use website account')}</Text>
    {flow ? <>
      <Text>{t('确认码', 'Confirmation code')}：{flow.user_code}</Text>
      <Text>{t('复制链接到浏览器，用 Google、LINUX DO 或邮箱登录，核对确认码并允许登录，再返回小游戏。', 'Copy the link into your browser. Sign in with Google, LINUX DO or email, check the code and approve, then return here.')}</Text>
      <Button disabled={task.busy || finishing} onPress={() => { void task.run(() => copyText(flow.verification_uri_complete)); }}>{t('复制授权链接', 'Copy approval link')}</Button>
      <Text muted>{finishing ? t('正在确认登录…', 'Confirming sign-in…') : t('等待网页确认…确认码 10 分钟内有效。', 'Waiting for approval… The code expires in 10 minutes.')}</Text>
      <Button disabled={finishing} onPress={() => setFlow(null)}>{t('取消', 'Cancel')}</Button>
    </> : <Button disabled={disabled || task.busy} onPress={() => { void start(); }}>{t('Google / LINUX DO / 官网账号登录', 'Google / LINUX DO / website sign-in')}</Button>}
    <TaskStatus task={task} />{error && <Text>{error}</Text>}
  </Card>;
}
