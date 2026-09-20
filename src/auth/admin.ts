// Operator-only CLI. Uses already-exported environment variables; never loads .env.
// node dist/auth/admin.js list
// node dist/auth/admin.js revoke <grant-id>
import { closeDb, getDb } from '../db/database.js'
import { OAuthStore } from './store.js'

async function main() {
  const [command, grantId, extra] = process.argv.slice(2)
  if (
    extra ||
    (command !== 'list' && command !== 'revoke') ||
    (command === 'list' && grantId) ||
    (command === 'revoke' && !/^[a-f0-9-]{36}$/.test(grantId ?? ''))
  ) {
    throw new Error('usage')
  }
  const store = new OAuthStore(getDb)
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(await store.listGrants(), null, 2)}\n`)
  } else {
    const found = await store.revokeGrant(grantId)
    process.stdout.write(`${JSON.stringify({ grant_id: grantId, revoked: found })}\n`)
    if (!found) process.exitCode = 1
  }
}

main()
  .catch(() => {
    console.error(
      'OAuth admin command failed. Usage: node dist/auth/admin.js list | revoke <grant-id>',
    )
    process.exitCode = 1
  })
  .finally(closeDb)
