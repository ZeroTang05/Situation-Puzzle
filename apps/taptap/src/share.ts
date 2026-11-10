/** 原生分享使用后台审核通过的模板；场景参数在冷启动和热启动时原样读取。 */
import { shareSceneSchema, type ShareScene } from './share-scene.js';

export const canShare = () => __SHARE_TEMPLATE_ID__.length > 0;
function shareScene(scene: ShareScene): Promise<void> {
  if (!canShare()) throw new Error('尚未配置 TapTap 分享模板');
  return new Promise((resolve, reject) => tap.showShareboard({ templateId: __SHARE_TEMPLATE_ID__, sceneParam: JSON.stringify(shareSceneSchema.parse(scene)),
    success() { resolve(); }, fail(error) { console.error('[taptap:share]', error.errMsg); reject(new Error('无法打开分享面板')); },
  }));
}
export const shareInvite = (kind: 'room' | 'lobby', token: string) => shareScene({ kind, token });
export const shareReferral = (code: string) => shareScene({ kind: 'referral', code });
