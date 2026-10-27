/**
 * 对象存储（项目备份）的环境配置校验回归测试。
 *
 * 起因：S3_BUCKET 被填成「桶名 + 桶内路径」（other/backup/海龟汤/），
 * 桶名含 / 被 S3 SDK 判成非法桶名，接口在请求期才炸成 500，
 * 而真实原因只留在服务端日志里（InvalidBucketName）。
 *
 * 这条测试把校验钉在启动期：配置错就在启动时失败，不拖到请求期。
 * 备份接入参数一律来自环境变量，代码里不留默认值——
 * 所以「配了桶就必须配齐其余参数」是硬约束，缺一项即失败。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

/** 一份能通过全部基础校验的环境变量；对象存储相关的字段按用例覆盖。 */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://jev:jev@localhost:5432/jev',
    AUTH_SECRET: 'a'.repeat(32),
    SOLO_TOKEN_SECRET: 'b'.repeat(32),
    MAIL_TRANSPORT: 'resend',
    RESEND_API_KEY: 're_test',
    MAIL_FROM: 'noreply@example.com',
    MINIMAX_API_KEY: 'test-key',
  };
}

/** 一份配齐的对象存储配置。 */
function s3Env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    S3_BUCKET: 'other',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'ak',
    S3_SECRET_ACCESS_KEY: 'sk',
    S3_FORCE_PATH_STYLE: 'true',
    S3_BACKUP_PREFIX: 'backup/海龟汤/',
    ...overrides,
  };
}

/**
 * 把一份环境变量写进 process.env。
 * 值为 undefined 的键表示「删掉这个变量」——Object.assign 会把它写成字符串 "undefined"，
 * 那样测的就不是「没配」而是「配了个叫 undefined 的值」了。
 */
function applyEnv(values: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    process.env[key] = value;
  }
}

const original = { ...process.env };

beforeEach(() => {
  // 每个用例从干净的环境变量开始：只保留跑测试本身要用的
  applyEnv(baseEnv());
});

afterEach(() => {
  applyEnv(original);
});

describe('对象存储环境配置', () => {
  it('不配 S3_BUCKET：备份功能整体关闭，不报错', () => {
    const env = loadEnv();
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it('配置齐了：原样读进来，不掺代码默认值', () => {
    applyEnv(s3Env());
    const env = loadEnv();
    expect(env.S3_BUCKET).toBe('other');
    expect(env.S3_REGION).toBe('auto');
    expect(env.S3_BACKUP_PREFIX).toBe('backup/海龟汤/');
    expect(env.S3_FORCE_PATH_STYLE).toBe('true');
  });

  it('桶名含路径：启动即失败，而不是拖到请求期报 500', () => {
    applyEnv(s3Env({ S3_BUCKET: 'other/backup/海龟汤/' }));
    expect(() => loadEnv()).toThrow(/S3_BUCKET 不是合法的桶名/);
  });

  it('桶名有大写 / 下划线 / 太短：启动即失败（服务端才回的非法名也要挡住）', () => {
    applyEnv(s3Env({ S3_BUCKET: 'Other' }));
    expect(() => loadEnv()).toThrow(/S3_BUCKET 不是合法的桶名/);
    applyEnv(s3Env({ S3_BUCKET: 'other_backup' }));
    expect(() => loadEnv()).toThrow(/S3_BUCKET 不是合法的桶名/);
    applyEnv(s3Env({ S3_BUCKET: 'ab' }));
    expect(() => loadEnv()).toThrow(/S3_BUCKET 不是合法的桶名/);
  });

  it('桶名配了但是空的：当误配置失败，不静默关掉备份功能', () => {
    applyEnv(s3Env({ S3_BUCKET: '' }));
    expect(() => loadEnv()).toThrow(/S3_BUCKET 配了但是空的/);
  });

  it('配了桶但缺区域：启动即失败，并点名缺哪个', () => {
    applyEnv(s3Env({ S3_REGION: undefined }));
    expect(() => loadEnv()).toThrow(/S3_REGION/);
  });

  it('配了桶但缺凭据：启动即失败', () => {
    applyEnv(s3Env({ S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined }));
    expect(() => loadEnv()).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('前缀不以 / 结尾：启动即失败', () => {
    applyEnv(s3Env({ S3_BACKUP_PREFIX: 'backup/海龟汤' }));
    expect(() => loadEnv()).toThrow(/S3_BACKUP_PREFIX 必须以 \/ 结尾/);
  });

  it('寻址方式必须显式给：没有「有 endpoint 就默认 true」的隐式规则', () => {
    applyEnv(s3Env({ S3_FORCE_PATH_STYLE: undefined }));
    expect(() => loadEnv()).toThrow(/S3_FORCE_PATH_STYLE/);
  });
});
