import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { SettingsFs } from '../../src/main/settings'
import type { Encryptor } from '../../src/main/safe-storage'

/**
 * A10, end-to-end half: an entered API key survives restart, and appears in
 * **neither** `settings.json` plaintext **nor** any log file.
 *
 * ## Why this exists alongside `redact.test.ts`
 *
 * That file tests `redact` as a pure function — the right shape for covering
 * the pattern table exhaustively, and it cannot tell you whether the bytes that
 * reach the disk went through it. This file asserts on the file contents: a real
 * key, a real `settings.json`, and a real `electron-log` file, then greps what
 * actually landed. A wrapper that forgot to call `redact`, or a transport
 * configured to bypass it, passes every unit test and fails here.
 *
 * The criterion originally called for a manual smoke test. It does not need one:
 * `SettingsFs` and `Encryptor` are both injection points, so the whole path runs
 * headless.
 *
 * ## The scratch directory is inside the repo, deliberately
 *
 * Not `tmpdir()`. See `packages/shared/test/ipc-meta.test.ts` for the failure
 * mode when scratch space lands on a different drive from the repo.
 */

const SCRATCH_BASE = join(process.cwd(), 'node_modules', '.cache', 'gomentor-a10')

/**
 * A real-shaped key. `4eC39Hq…` is the string from Stripe's public API docs, so
 * a leak of this exact value into a log is not a leak of anything real — but it
 * is long, high-entropy, and `sk-`-prefixed, which is what the value-shape
 * patterns need in order to be exercised at all.
 */
const KEY = 'sk-live-4eC39HqLyjWDarjtT1zdp7dcQ8xKmN2vLONGENOUGH'

/**
 * Stands in for DPAPI/Keychain with the same contract: genuinely encrypts, and
 * hands back a Buffer that base64-encodes to something opaque. Not a no-op —
 * an identity "encryptor" would leave plaintext in the document and this file's
 * central assertion would be testing the stub rather than the code.
 */
function realEncryptor(): Encryptor {
  const secret = createHash('sha256').update('a10-fixture').digest()
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => {
      const iv = randomBytes(16)
      const cipher = createCipheriv('aes-256-cbc', secret, iv)
      return Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final()])
    },
    decryptString: (buf) => {
      const decipher = createDecipheriv('aes-256-cbc', secret, buf.subarray(0, 16))
      return Buffer.concat([
        decipher.update(buf.subarray(16)),
        decipher.final(),
      ]).toString('utf8')
    },
  }
}

function nodeFs(): SettingsFs {
  return {
    read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
    write: (p, contents) => {
      writeFileSync(p, contents, 'utf8')
    },
    preserve: (p, contents) => {
      writeFileSync(`${p}.corrupt`, contents, 'utf8')
    },
  }
}

describe('A10: an API key reaches neither the settings file nor a log', () => {
  let dir: string
  let settingsPath: string
  let logPath: string

  beforeEach(() => {
    mkdirSync(SCRATCH_BASE, { recursive: true })
    dir = mkdtempSync(join(SCRATCH_BASE, 'run-'))
    settingsPath = join(dir, 'settings.json')
    logPath = join(dir, 'main.log')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('survives a restart without ever being written as plaintext', async () => {
    const { createSettingsService } = await import('../../src/main/settings')
    const { createSecretsService } = await import('../../src/main/safe-storage')
    const encryptor = realEncryptor()
    const fs = nodeFs()

    // Session 1: store the key, then change an unrelated setting. The second
    // write is the interesting one — a read-modify-write that dropped the
    // ciphertext would still pass a test that only ever wrote the secret.
    const first = createSettingsService(fs, settingsPath)
    const firstSecrets = createSecretsService(first.secretStore, encryptor)
    firstSecrets.set('llmApiKey', KEY)
    first.update({ ui: { theme: 'light' } })

    // Session 2: fresh services over the same file. This is what a restart is.
    const second = createSettingsService(fs, settingsPath)
    const secondSecrets = createSecretsService(second.secretStore, encryptor)

    expect(secondSecrets.get('llmApiKey'), 'key did not survive restart').toBe(KEY)
    expect(secondSecrets.has('llmApiKey')).toBe(true)
    expect(second.get().ui.theme, 'unrelated setting was lost').toBe('light')

    // The document on disk must hold ciphertext and nothing recognisable. The
    // prefix assertion is separate because `logging-guidelines.md` forbids even
    // a redacted-looking prefix, and a truncating bug would satisfy the first
    // assertion while failing this one.
    const onDisk = readFileSync(settingsPath, 'utf8')
    expect(onDisk).not.toContain(KEY)
    expect(onDisk).not.toContain(KEY.slice(0, 16))
    expect(onDisk).not.toContain('sk-live')
  })

  it('keeps the key out of the log on the paths a field-name check would miss', async () => {
    const { scoped, initLogging } = await import('../../src/main/logger')
    const electronLog = (await import('electron-log/main')).default

    // `initLogging` resolves its path through `paths.logFile()`, which needs
    // Electron's `app`. Let it configure the transports — that is what installs
    // the redaction path — then repoint the file at scratch. Where the bytes
    // land is not what is under test; whether they are redacted is.
    try {
      initLogging({ debugEnabled: true })
    } catch {
      // No `app` outside Electron. The transports are still configured.
    }
    electronLog.transports.file.resolvePathFn = () => logPath
    electronLog.transports.file.level = 'debug'

    const logger = scoped('main:secrets')

    // Each of these is a way a real leak has happened in real programs, and
    // none is caught by redacting on field name alone.
    logger.info('key as a field', { llmApiKey: KEY, apiKey: KEY, token: KEY })
    logger.warn('nested, and inside a URL', {
      settings: {
        llm: {
          apiKey: KEY,
          baseUrl: `https://user:${KEY}@api.example.com/v1?key=${KEY}`,
        },
      },
    })
    logger.failure(
      'interpolated into an Error message',
      new Error(`upstream rejected key ${KEY}`),
      {
        llmApiKey: KEY,
      },
    )

    // electron-log's file transport writes asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const logFiles = readdirSync(dir).filter((name) => name.endsWith('.log'))
    expect(
      logFiles,
      'no log file was written, so nothing was actually checked',
    ).not.toHaveLength(0)

    for (const name of logFiles) {
      const body = readFileSync(join(dir, name), 'utf8')
      // Guards against the assertion passing because the file is empty.
      expect(body.length, `${name} is empty`).toBeGreaterThan(0)
      expect(body, `${name} contains the key`).not.toContain(KEY)
      expect(body, `${name} contains a usable prefix`).not.toContain(KEY.slice(0, 16))
      // The URL's userinfo and query must both be gone, not just the field.
      expect(body).not.toContain('user:sk-live')
      expect(body).not.toContain('key=sk-live')
    }
  })
})
