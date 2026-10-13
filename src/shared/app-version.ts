export function formatAppVersion(version: string | null | undefined): string {
  const normalized = version?.trim()
  if (!normalized) return 'v…'
  return normalized.toLowerCase().startsWith('v') ? normalized : `v${normalized}`
}
