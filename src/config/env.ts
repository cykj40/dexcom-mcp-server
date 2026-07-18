import { z } from 'zod'

/**
 * Environment variable schema validation
 * Crashes immediately if any required variables are missing
 * Never use fallback values for secrets
 */
const envSchema = z.object({
  // Dexcom Developer API (required)
  DEXCOM_CLIENT_ID: z.string().trim().min(1, 'DEXCOM_CLIENT_ID is required'),
  DEXCOM_CLIENT_SECRET: z.string().trim().min(1, 'DEXCOM_CLIENT_SECRET is required'),
  DEXCOM_REDIRECT_URI: z.string().trim().url('DEXCOM_REDIRECT_URI must be a valid URL'),
  DEXCOM_ACCESS_TOKEN: z.string().trim().min(1).optional(),
  DEXCOM_REFRESH_TOKEN: z.string().trim().min(1).optional(),

  // Dexcom Share API (optional fallback)
  DEXCOM_SHARE_USERNAME: z.string().optional(),
  DEXCOM_SHARE_PASSWORD: z.string().optional(),

  // Turso database (required)
  TURSO_DATABASE_URL: z.string().trim().min(1, 'TURSO_DATABASE_URL is required'),
  TURSO_AUTH_TOKEN: z.string().optional(),

  // HTTP transport auth (required when TRANSPORT=http)
  MCP_AUTH_TOKEN: z.string().optional(),

  // OAuth 2.0 credentials for Claude.ai MCP connector
  OAUTH_CLIENT_ID: z.string().optional(),
  OAUTH_CLIENT_SECRET: z.string().optional(),

  // Transport mode
  TRANSPORT: z.enum(['http', 'stdio']).optional(),
  PORT: z.string().optional(),

  // API environment
  DEXCOM_API_ENV: z.enum(['production', 'sandbox']).default('production'),

  // Local calendar day boundaries for daily summaries and charts
  SERVER_TIMEZONE: z
    .string()
    .trim()
    .default('UTC')
    .refine(
      (value) => {
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: value })
          return true
        } catch {
          return false
        }
      },
      { message: 'SERVER_TIMEZONE must be a valid IANA time zone' },
    ),
})

/**
 * Validate and parse environment variables
 * Exits process if validation fails
 */
function validateEnv() {
  try {
    return envSchema.parse(process.env)
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Environment validation failed:')
      error.issues.forEach((issue) => {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
      })
      console.error('\nPlease check your .env file or environment variables.')
      process.exit(1)
    }
    throw error
  }
}

/**
 * Validated environment configuration
 * All other files import from here — never access process.env directly
 */
export const env = validateEnv()

/**
 * Get the appropriate Dexcom API base URL based on environment
 */
export function getDexcomApiBaseUrl(): string {
  return env.DEXCOM_API_ENV === 'sandbox'
    ? 'https://sandbox-api.dexcom.com'
    : 'https://api.dexcom.com'
}

/**
 * Dexcom Share API base URL (always production)
 */
export const DEXCOM_SHARE_BASE_URL = 'https://share1.dexcom.com/ShareWebServices/Services'
