const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const UNUSED_PERMISSION_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
]

function plistBuddy(plistPath, command, tolerateMissing = false) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plistPath], {
      stdio: tolerateMissing ? 'ignore' : 'inherit'
    })
  } catch (error) {
    if (!tolerateMissing) throw error
  }
}

module.exports = async function hardenMacInfoPlist(context) {
  if (context.electronPlatformName !== 'darwin') return

  const plistPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist'
  )

  for (const key of UNUSED_PERMISSION_KEYS) {
    plistBuddy(plistPath, `Delete :${key}`, true)
  }

  plistBuddy(plistPath, 'Delete :NSAppTransportSecurity:NSAllowsArbitraryLoads', true)
  plistBuddy(plistPath, 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false')
}
