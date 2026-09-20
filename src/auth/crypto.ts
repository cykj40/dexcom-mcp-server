import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const randomCredential = () => randomBytes(32).toString('base64url')
export const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
export const challengeFor = (verifier: string) =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url')

export function secretEquals(candidate: unknown, expected: string | undefined): boolean {
  if (expected === undefined || expected.length === 0) return false
  const supplied = Buffer.from(typeof candidate === 'string' ? candidate : '', 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  const comparable = Buffer.alloc(expectedBytes.length)
  supplied.copy(comparable)
  const equal = timingSafeEqual(comparable, expectedBytes)
  return equal && supplied.length === expectedBytes.length
}

export const isCredential = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
export const isVerifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value)

export function isChallenge(value: unknown): value is string {
  return isCredential(value) && Buffer.from(value, 'base64url').toString('base64url') === value
}
