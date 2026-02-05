import { z } from 'zod';

/**
 * Environment variable schema validation
 * Crashes immediately if any required variables are missing
 * Never use fallback values for secrets
 */
const envSchema = z.object({
  // Dexcom Developer API (required)
  DEXCOM_CLIENT_ID: z.string().min(1, 'DEXCOM_CLIENT_ID is required'),
  DEXCOM_CLIENT_SECRET: z.string().min(1, 'DEXCOM_CLIENT_SECRET is required'),
  DEXCOM_REDIRECT_URI: z.string().url('DEXCOM_REDIRECT_URI must be a valid URL'),
  DEXCOM_ACCESS_TOKEN: z.string().min(1, 'DEXCOM_ACCESS_TOKEN is required'),
  DEXCOM_REFRESH_TOKEN: z.string().min(1, 'DEXCOM_REFRESH_TOKEN is required'),

  // Dexcom Share API (optional fallback)
  DEXCOM_SHARE_USERNAME: z.string().optional(),
  DEXCOM_SHARE_PASSWORD: z.string().optional(),

  // Database
  DB_PATH: z.string().default('./data/dexcom.db'),

  // API environment
  DEXCOM_API_ENV: z.enum(['production', 'sandbox']).default('production'),
});

/**
 * Validate and parse environment variables
 * Exits process if validation fails
 */
function validateEnv() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Environment validation failed:');
      error.issues.forEach((issue) => {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      });
      console.error('\nPlease check your .env file or environment variables.');
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Validated environment configuration
 * All other files import from here - never access process.env directly
 */
export const env = validateEnv();

/**
 * Get the appropriate Dexcom API base URL based on environment
 */
export function getDexcomApiBaseUrl(): string {
  return env.DEXCOM_API_ENV === 'sandbox'
    ? 'https://sandbox-api.dexcom.com'
    : 'https://api.dexcom.com';
}

/**
 * Dexcom Share API base URL (always production)
 */
export const DEXCOM_SHARE_BASE_URL = 'https://share1.dexcom.com/ShareWebServices/Services';
