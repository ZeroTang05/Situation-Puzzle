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
    const lang = (typeof window !== 'undefined' && (localStorage.getItem('jev.language') === 'en' || new URLSearchParams(location.search).get('lang') === 'en')) ? 'en' : 'zh';
    const localized = lang === 'zh' ? `请求失败：${response.status}` : `Request failed: ${response.status}`;
    throw new Error(payload?.error?.message ?? localized);
  }
  return payload?.data;
}

/**
 * 各资源的行主键字段。
 *
 * react-admin 要求每一行都有 `id`，缺了会直接抛 "data items do not have an 'id' key"
 * 并把整个列表渲染成空表。后端这些列表的行用的是各自的业务主键（userId / roomId / orderId …），
 * 所以这里补一个 id，而不是让前端猜。
 */
const ID_FIELD: Record<string, string> = {
  puzzles: 'versionId',
  users: 'userId',
  rooms: 'roomId',
  orders: 'orderId',
};

/** 泛型返回集中以 never 收窄：数据形状由 admin API 决定 */
const baseProvider: DataProvider = {
  getList: async (resource, params) => {
    const query = new URLSearchParams();
    // 服务端分页：传页码与每页条数，total 用 API 返回的真实总数，列表不再被固定 limit 截断
    query.set('page', String(params.pagination?.page ?? 1));
    query.set('perPage', String(params.pagination?.perPage ?? 25));
    // 点表头排序：列名交给后端白名单校验（未登记的列后端回落默认顺序）
    if (params.sort?.field) {
      query.set('sort', params.sort.field);
      query.set('order', params.sort.order ?? 'DESC');
    }
    if (params.filter && Object.keys(params.filter).length > 0) {
      for (const [key, value] of Object.entries(params.filter)) query.set(key, String(value));
    }
    const data = (await adminFetch(`/${resource}?${query.toString()}`)) as { items: Record<string, unknown>[]; total?: number } | Record<string, unknown>[];
    const rows = Array.isArray(data) ? data : data.items;
    const total = Array.isArray(data) ? rows.length : data.total ?? rows.length;
    const idField = ID_FIELD[resource];
    const items = idField
      ? rows.map((row) => ({ ...row, id: row[idField] }))
      : rows;
    return { data: items, total } as never;
  },
  getOne: async (resource, params) => {
    if (resource === 'puzzles') {
      const detail = await adminFetch(`/puzzle-versions/${String(params.id)}`) as { version: Record<string, unknown>; versions: Record<string, unknown>[]; rights: unknown; testCases: unknown; reviews: unknown };
      return { data: { ...detail.version, id: detail.version.id, versionId: detail.version.id, status: detail.version.moderationStatus, versions: detail.versions, rights: detail.rights, testCases: detail.testCases, reviews: detail.reviews } } as never;
    }
    const data = await adminFetch(`/${resource}/${String(params.id)}`);
    return { data } as never;
  },
  getMany: async (resource, params) => {
    const items = await Promise.all(params.ids.map((id) => adminFetch(`/${resource}/${String(id)}`)));
    return { data: items } as never;
  },
  getManyReference: async () => ({ data: [], total: 0 }),
  create: async () => {
    throw new Error('Admin does not create business records directly.');
  },
  update: async () => {
    throw new Error('Admin changes go through dedicated action endpoints.');
  },
  updateMany: async () => {
    throw new Error('Admin changes go through dedicated action endpoints.');
  },
  delete: async () => {
    throw new Error('Admin does not provide hard delete.');
  },
  deleteMany: async () => {
    throw new Error('Admin does not provide hard delete.');
  },
};

export { baseProvider as dataProvider };

/** 业务动作：审核、退款、封禁等专用端点。 */
export async function adminAction(path: string, body: Record<string, unknown>): Promise<unknown> {
  return adminFetch(path, { method: 'POST', body: JSON.stringify(body) });
}
