/** 返回导航：有应用内来路就回上一页，直达链接落到兜底页。 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router';

/**
 * 返回到跳转来源页。直接通过链接/书签打开当前页时，历史里没有应用内
 * 上一页，此时落到 fallback（replace，不堆叠历史），避免一按返回就退出站点。
 * 判断依据：react-router 会在浏览器 history.state 维护 idx（当前条目在本
 * 标签页历史中的序号），idx 为 0 说明当前就是进入应用的第一个页面。
 */
export function useBack(fallback: string = '/') {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof idx === 'number' && idx > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
