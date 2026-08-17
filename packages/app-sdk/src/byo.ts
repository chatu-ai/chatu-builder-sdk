import type { ByoConfig } from './config.js'
import { optionalImport } from './config.js'
import { AppSdkError } from './errors.js'
import type { KvClient } from './kv.js'
import type { StorageClient } from './storage.js'

/**
 * 模式 A（自带云资源）驱动：
 * - KV：ioredis（`npm i ioredis`），REDIS_URL；键前缀 CHATU_KV_PREFIX（默认 app:）
 * - 对象存储：@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner（`npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`），
 *   S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY / S3_PREFIX / S3_FORCE_PATH_STYLE（腾讯云 COS：endpoint https://cos.<region>.myqcloud.com）
 */
export function byoKv(cfg: ByoConfig, fallback: KvClient): KvClient {
  if (!cfg.redisUrl) return fallback
  let clientPromise: Promise<any> | null = null
  const client = () => (clientPromise ??= optionalImport<any>('ioredis', 'run `npm i ioredis`').then(m => new (m.default ?? m.Redis ?? m)(cfg.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 })))
  const k = (key: string) => cfg.kvPrefix + key
  const parse = (v: string | null) => { if (v === null) return null; try { return JSON.parse(v) } catch { return v } }
  return {
    async get(key) { return parse(await (await client()).get(k(key))) },
    async set(key, value, opts) { const c = await client(); const v = JSON.stringify(value); if (opts?.ex) await c.set(k(key), v, 'EX', opts.ex); else await c.set(k(key), v) },
    async del(key) { return (await (await client()).del(k(key))) > 0 },
    async incr(key, by = 1) { try { return Number(await (await client()).incrby(k(key), by)) } catch (e: any) { throw new AppSdkError('NOT_AN_INTEGER', e?.message ?? 'incr failed') } },
    async expire(key, seconds) { return (await (await client()).expire(k(key), seconds)) === 1 },
    async mget(keys) { const vals: (string | null)[] = await (await client()).mget(keys.map(k)); return vals.map(parse) },
    async list(prefix = '', opts) {
      const c = await client()
      const [next, keys]: [string, string[]] = await c.scan(opts?.cursor ?? '0', 'MATCH', escapeGlob(k(prefix)) + '*', 'COUNT', opts?.limit ?? 100)
      return { keys: keys.map((x: string) => x.slice(cfg.kvPrefix.length)), nextCursor: next === '0' ? null : next }
    },
  }
}

export function byoStorage(cfg: ByoConfig, fallback: StorageClient): StorageClient {
  const s3cfg = cfg.s3
  if (!s3cfg) return fallback
  let mods: Promise<{ s3: any; presign: any }> | null = null
  const load = () => (mods ??= Promise.all([
    optionalImport<any>('@aws-sdk/client-s3', 'run `npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`'),
    optionalImport<any>('@aws-sdk/s3-request-presigner', 'run `npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`'),
  ]).then(([s3, presign]) => ({ s3, presign })))
  let clientInst: any = null
  const client = async () => {
    const { s3 } = await load()
    return (clientInst ??= new s3.S3Client({
      region: s3cfg.region,
      endpoint: s3cfg.endpoint,
      forcePathStyle: s3cfg.forcePathStyle,
      credentials: { accessKeyId: s3cfg.accessKey, secretAccessKey: s3cfg.secretKey },
    }))
  }
  const K = (key: string) => s3cfg.prefix + key
  return {
    async put(key, data, opts) {
      const { s3 } = await load()
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data instanceof ArrayBuffer ? new Uint8Array(data) : data
      await (await client()).send(new s3.PutObjectCommand({ Bucket: s3cfg.bucket, Key: K(key), Body: bytes, ContentType: opts?.contentType }))
      return { key, size: bytes.byteLength }
    },
    async uploadUrl(key, opts) {
      const { s3, presign } = await load()
      const url = await presign.getSignedUrl(await client(), new s3.PutObjectCommand({ Bucket: s3cfg.bucket, Key: K(key), ContentType: opts?.contentType }), { expiresIn: 600 })
      return { url, method: 'PUT', expiresIn: 600, headers: opts?.contentType ? { 'content-type': opts.contentType } : undefined }
    },
    async get(key) {
      const { s3 } = await load()
      try {
        const res = await (await client()).send(new s3.GetObjectCommand({ Bucket: s3cfg.bucket, Key: K(key) }))
        return new Uint8Array(await res.Body.transformToByteArray())
      } catch (e: any) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null
        throw e
      }
    },
    async url(key, opts) {
      const { s3, presign } = await load()
      return presign.getSignedUrl(await client(), new s3.GetObjectCommand({ Bucket: s3cfg.bucket, Key: K(key), ResponseContentDisposition: opts?.downloadName ? `attachment; filename="${encodeURIComponent(opts.downloadName)}"` : undefined }), { expiresIn: opts?.expiresIn ?? 600 })
    },
    async head(key) {
      const { s3 } = await load()
      try {
        const res = await (await client()).send(new s3.HeadObjectCommand({ Bucket: s3cfg.bucket, Key: K(key) }))
        return { key, size: Number(res.ContentLength ?? 0), lastModified: res.LastModified ? new Date(res.LastModified).toISOString() : null }
      } catch (e: any) {
        if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null
        throw e
      }
    },
    async delete(key) { const { s3 } = await load(); await (await client()).send(new s3.DeleteObjectCommand({ Bucket: s3cfg.bucket, Key: K(key) })) },
    async list(prefix = '', opts) {
      const { s3 } = await load()
      const res = await (await client()).send(new s3.ListObjectsV2Command({ Bucket: s3cfg.bucket, Prefix: K(prefix), MaxKeys: opts?.limit ?? 100, ContinuationToken: opts?.cursor ?? undefined }))
      return {
        items: (res.Contents ?? []).map((o: any) => ({ key: String(o.Key).slice(s3cfg.prefix.length), size: Number(o.Size ?? 0), lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null })),
        nextCursor: res.IsTruncated ? (res.NextContinuationToken ?? null) : null,
      }
    },
  }
}

function escapeGlob(s: string): string {
  return s.replace(/[\\*?[\]]/g, m => '\\' + m)
}
