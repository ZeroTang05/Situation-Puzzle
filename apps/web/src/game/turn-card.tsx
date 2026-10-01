/** 单人与预览共享的问答卡片：方向由 kind 决定，状态消息贴近文本。 */
import { displayVerdict, verdictDetail } from '@jev/i18n';
import { confidenceLabel } from './game-display.js';
import type { Language } from '@jev/i18n';

export interface PreviewTurn {
  localTurnId: string;
  localSessionId: string;
  order: number;
  kind: 'ask' | 'solve';
  text: string;
  status: 'sending' | 'succeeded' | 'failed';
  result: string | null;
  confidence?: number;
  createdAt: number;
  failNote?: string;
}

export function TurnCard({ turn, copy, language }: { turn: PreviewTurn; copy: { judging: string; failed: string }; language: Language }) {
  return (
    <div className={`turn turn-${turn.kind}`}>
      <p className="turn-text">{turn.text}</p>
      {turn.status === 'sending' && <p className="muted turn-status">{copy.judging}</p>}
      {turn.status === 'failed' && <p className="error-text turn-status">{turn.failNote ?? copy.failed}</p>}
      {turn.status === 'succeeded' && turn.kind === 'ask' && turn.result && (
        <p className="turn-result">
          <span className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</span>
          <small className="confidence">{confidenceLabel(turn.confidence, language)}</small>
        </p>
      )}
      {turn.status === 'succeeded' && turn.kind === 'solve' && turn.result && (
        <p className="turn-result">
          <span className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</span>
          <small className="confidence">{confidenceLabel(turn.confidence, language)}</small>
          <span className="muted">{verdictDetail(turn.result, language)}</span>
        </p>
      )}
    </div>
  );
}
