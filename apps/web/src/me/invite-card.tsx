/**
 * 「我的」页的邀请卡：展示邀请链接 + 复制 + 已邀请人数。
 *
 * 奖励规则（docs/rebuild/21-MONETIZATION-REVISION.md）：好友通过链接注册并登录后
 * 自动领取，邀请人 +5 次开房次数（入账在服务端，前端只展示）。
 * 邀请码由 /me 返回（首次读取懒生成），链接形态 `${origin}/?ref=CODE`。
 */
import { useState } from 'react';
import { useLanguage } from '../state/language.js';
import { format } from '@jev/i18n';
import { siteOrigin } from '../app-runtime.js';

export function InviteCard({ invite }: { invite: { code: string; invitedCount: number } }) {
  const { copy } = useLanguage();
  const [copied, setCopied] = useState(false);
  const link = `${siteOrigin()}/?ref=${invite.code}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板权限被拒时退化为选中提示：链接文本本身就在卡片上，可手动复制
      setCopied(false);
    }
  };

  return (
    <section className="me-section invite-card">
      <div className="me-section-head">
        <h3 className="me-section-title">{copy.inviteTitle}</h3>
        <span className="invite-count muted">{format(copy.invitedCount, { n: invite.invitedCount })}</span>
      </div>
      <p className="muted invite-hint">{copy.inviteHint}</p>
      <div className="invite-link-row">
        <span className="invite-link" title={link}>{link}</span>
        <button className="btn btn-sm" type="button" onClick={() => void copyLink()}>
          {copied ? copy.inviteCopied : copy.inviteCopy}
        </button>
      </div>
    </section>
  );
}
