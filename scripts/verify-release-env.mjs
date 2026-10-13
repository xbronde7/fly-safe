const target = process.argv[2]

if (target !== 'mac' && target !== 'win') {
  fail('Usage: node scripts/verify-release-env.mjs <mac|win>')
}

const updateUrl = process.env.FLY_SAFE_UPDATE_URL
if (!updateUrl) fail('FLY_SAFE_UPDATE_URL is required')
try {
  const parsed = new URL(updateUrl)
  if (parsed.protocol !== 'https:') fail('FLY_SAFE_UPDATE_URL must use HTTPS')
} catch {
  fail('FLY_SAFE_UPDATE_URL must be a valid HTTPS URL')
}

const entitlementUrl = process.env.FLY_SAFE_ENTITLEMENT_API_URL
if (!entitlementUrl) fail('FLY_SAFE_ENTITLEMENT_API_URL is required')
try {
  const parsed = new URL(entitlementUrl)
  if (parsed.protocol !== 'https:') fail('FLY_SAFE_ENTITLEMENT_API_URL must use HTTPS')
} catch {
  fail('FLY_SAFE_ENTITLEMENT_API_URL must be a valid HTTPS URL')
}

required('CSC_LINK')
required('CSC_KEY_PASSWORD')

if (target === 'mac') {
  const hasAppleId = hasAll('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID')
  const hasApiKey = hasAll('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER')
  if (!hasAppleId && !hasApiKey) {
    fail(
      'Apple notarization requires APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, ' +
      'or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER'
    )
  }
}

process.stdout.write(`Release environment for ${target} is complete.\n`)

function required(name) {
  if (!process.env[name]) fail(`${name} is required`)
}

function hasAll(...names) {
  return names.every((name) => Boolean(process.env[name]))
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
