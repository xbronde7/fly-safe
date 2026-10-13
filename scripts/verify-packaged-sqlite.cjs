const assert = require('node:assert/strict')
const path = require('node:path')

const archive = path.join(path.dirname(process.execPath), 'resources', 'app.asar')
const { version } = require(path.join(archive, 'package.json'))
const Database = require(path.join(archive, 'node_modules', 'better-sqlite3'))
const db = new Database(':memory:')
try {
  assert.equal(version, '1.1.13')
  db.exec('CREATE TABLE smoke (value TEXT NOT NULL)')
  db.prepare('INSERT INTO smoke VALUES (?)').run('Fly Safe')
  assert.deepEqual(db.prepare('SELECT value FROM smoke').get(), { value: 'Fly Safe' })
  assert.deepEqual(db.pragma('quick_check'), [{ quick_check: 'ok' }])
  console.log(JSON.stringify({ version, electron: process.versions.electron, sqlite: 'ok' }))
} finally {
  db.close()
}
