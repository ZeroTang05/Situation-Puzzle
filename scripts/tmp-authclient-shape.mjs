/**
 * 临时诊断：在 Node 里用与 taroFetch 同形状的 wrapped Response 喂 better-auth
 * vanilla 客户端，实测 getSession() 的返回形状（未登录 body null / 已登录完整体）。
 * 用后即删。
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
const appDir = resolve(repoRoot, 'apps', 'miniprogram')
const req = createRequire(resolve(appDir, 'noop.js'))

// better-auth/client 是 ESM 子路径，动态 import
const clientEntry = req.resolve('better-auth/client')
const mod = await import(pathToFileURL(clientEntry).href)
const { createAuthClient } = mod

// 与 fetch-adapter 的 wrapped 同款形状（ok/status/headers/json/text）
function wrappedResponse(status, header, text) {
  const lowerMap = new Map(Object.entries(header).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (n) => lowerMap.get(String(n).toLowerCase()) ?? null,
      has: (n) => lowerMap.has(String(n).toLowerCase()),
    },
    json: async () => JSON.parse(text),
    text: async () => text,
  }
}

const cases = [
  ['未登录（200 + body null）', 200, { 'content-type': 'application/json' }, 'null'],
  ['已登录（200 + 完整会话体）', 200, { 'content-type': 'application/json' },
    JSON.stringify({ session: { id: 's1', userId: 'u1', expiresAt: '2027-01-01' }, user: { id: 'u1', email: 'a@b.c', name: 'n', emailVerified: true } })],
  ['异常（500 + error 体）', 500, { 'content-type': 'application/json' },
    JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } })],
]

for (const [label, status, header, body] of cases) {
  const client = createAuthClient({
    basePath: '/api/v1/auth',
    baseURL: 'https://example.test',
    fetchOptions: {
      customFetchImpl: async () => wrappedResponse(status, header, body),
    },
  })
  try {
    const out = await client.getSession()
    console.log(`\n=== ${label}`)
    console.log('  顶层 keys:', Object.keys(out))
    console.log('  data:', JSON.stringify(out.data))
    console.log('  error:', JSON.stringify(out.error))
    console.log('  data?.user:', JSON.stringify(out.data?.user))
  } catch (err) {
    console.log(`\n=== ${label} => 抛异常:`, String(err.message).slice(0, 150))
  }
}
