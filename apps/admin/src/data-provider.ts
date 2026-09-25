/** React-admin 数据适配：/api/v1/admin/* 的列表与动作。 */
import type { DataProvider } from 'react-admin';

async function adminFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`/api/v1/admin${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    credentials: 'include',
  });
  const payload = (await response.json().catch(() => null)) as { data?: unknown; error?: { message: string } } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：${response.status}`);
  }
  return payload?.data;
}

/** 泛型返回集中以 never 收窄：数据形状由 admin API 决定 */
const baseProvider: DataProvider = {
  getList: async (resource, params) => {
    const query = new URLSearchParams();
    if (params.filter && Object.keys(params.filter).length > 0) {
      for (const [key, value] of Object.entries(params.filter)) query.set(key, String(value));
    }
    const data = (await adminFetch(`/${resource}?${query.toString()}`)) as { items: Record<string, unknown>[] } | Record<string, unknown>[];
    const items = Array.isArray(data) ? data : data.items;
    return { data: items, total: items.length } as never;
  },
  getOne: async (resource, params) => {
    const data = await adminFetch(`/${resource}/${String(params.id)}`);
    return { data } as never;
  },
  getMany: async (resource, params) => {
    const items = await Promise.all(params.ids.map((id) => adminFetch(`/${resource}/${String(id)}`)));
    return { data: items } as never;
  },
  getManyReference: async () => ({ data: [], total: 0 }),
  create: async () => {
    throw new Error('后台不直接创建业务记录');
  },
  update: async () => {
    throw new Error('后台通过专门操作执行变更');
  },
  updateMany: async () => {
    throw new Error('后台通过专门操作执行变更');
  },
  delete: async () => {
    throw new Error('后台不提供物理删除');
  },
  deleteMany: async () => {
    throw new Error('后台不提供物理删除');
  },
};

export { baseProvider as dataProvider };

/** 业务动作：审核、退款、封禁等专用端点。 */
export async function adminAction(path: string, body: Record<string, unknown>): Promise<unknown> {
  return adminFetch(path, { method: 'POST', body: JSON.stringify(body) });
}
