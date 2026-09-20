import { createClient } from '@libsql/client'
import { OAuthStore } from '../../src/auth/store.ts'

// Child process for real cross-process SQLite write contention. IPC carries synthetic data only.
let db
process.on('message', async (message) => {
  try {
    if (message.operation === 'prepare') {
      if (!message.url.startsWith('file:/')) throw new Error('Only local files are permitted')
      db = createClient({ url: message.url })
      // Independent processes can wait on SQLite's write lock without blocking the lock holder.
      await db.execute('PRAGMA busy_timeout = 5000')
      process.send({ ready: true })
      return
    }
    const store = new OAuthStore(
      () => db,
      () => message.now,
    )
    const result =
      message.operation === 'code'
        ? await store.exchangeCode(...message.args)
        : await store.refresh(...message.args)
    process.send({ result })
  } catch (error) {
    process.send({ error: error.code ?? 'worker_failure' })
  }
  db?.close()
  process.disconnect()
})
