// Build the bundled manufacturing subset from an extracted, official JSONL SDE.
// Usage: node scripts/build-industry-catalog.mjs /path/to/extracted/sde
import { createReadStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

const directory = process.argv[2]
if (!directory) throw new Error('Pass the directory containing the official JSONL SDE')
async function rows(file, consume) {
  const lines = createInterface({ input: createReadStream(resolve(directory, `${file}.jsonl`)), crlfDelay: Infinity })
  for await (const line of lines) if (line.trim()) consume(JSON.parse(line))
}
const types = new Map()
await rows('types', row => types.set(row._key, {
  name: row.name?.en ?? `Type #${row._key}`, nameRu: row.name?.ru ?? '',
  groupId: row.groupID, published: row.published === true,
  marketable: Number.isInteger(row.marketGroupID), volume: row.packagedVolume ?? row.volume ?? 0
}))
const dogma = new Map()
await rows('typeDogma', row => dogma.set(row._key, new Map((row.dogmaAttributes ?? []).map(a => [a.attributeID, a.value]))))
const requirementAttributes = [[182, 277], [183, 278], [184, 279], [1285, 1286], [1289, 1287], [1290, 1288]]
const skills = {}
for (const [id, type] of types) {
  const attrs = dogma.get(id)
  // The skill-time constant (attribute 275) distinguishes skill types.
  if (!attrs?.has(275) || !type.published) continue
  skills[id] = {
    name: type.name, nameRu: type.nameRu,
    required: requirementAttributes.flatMap(([a, b]) => attrs.get(a) > 0 ? [{ typeId: attrs.get(a), level: attrs.get(b) ?? 1 }] : []),
    // Industry/Advanced Industry apply globally; attribute 1982 applies only
    // when that skill is a direct manufacturing requirement of the blueprint.
    timeBonus: attrs.get(id === 3380 ? 440 : id === 3388 ? 1961 : 1982) ?? 0
  }
}
const blueprints = []
const neededTypes = new Set()
await rows('blueprints', row => {
  const activity = row.activities?.manufacturing
  const blueprint = types.get(row.blueprintTypeID)
  if (!blueprint?.published || !activity?.time || activity.products?.length !== 1 || !activity.materials?.length) return
  const product = activity.products[0]
  if (!types.get(product.typeID)?.published) return
  const entry = {
    blueprintTypeId: row.blueprintTypeID, name: blueprint.name,
    productTypeId: product.typeID, productName: types.get(product.typeID).name,
    productNameRu: types.get(product.typeID).nameRu,
    productQuantity: product.quantity, time: activity.time,
    maxRuns: row.maxProductionLimit, marketable: blueprint.marketable,
    materials: activity.materials.map(m => ({ typeId: m.typeID, quantity: m.quantity })),
    skills: (activity.skills ?? []).map(s => ({ typeId: s.typeID, level: s.level }))
  }
  blueprints.push(entry)
  for (const id of [entry.blueprintTypeId, entry.productTypeId, ...entry.materials.map(m => m.typeId)]) neededTypes.add(id)
})
let metadata
await rows('_sde', row => { if (row._key === 'sde') metadata = row })
const stations = {}
// NPC blueprint offers can be priced outside the selected hub. Keep their
// location and system IDs, never mistake a private structure for an NPC station.
await rows('npcStations', row => { stations[row._key] = row.solarSystemID })
const systems = {}
await rows('mapSolarSystems', row => { systems[row._key] = row.name?.en ?? `System #${row._key}` })
const catalog = {
  build: metadata.buildNumber, releasedAt: metadata.releaseDate,
  source: `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${metadata.buildNumber}-jsonl.zip`,
  blueprints: blueprints.sort((a, b) => a.productName.localeCompare(b.productName, 'en')),
  types: Object.fromEntries([...neededTypes].map(id => [id, types.get(id)])), skills, stations, systems
}
writeFileSync(new URL('../src/main/data/industry-catalog.json', import.meta.url), JSON.stringify(catalog))
console.log(`SDE ${catalog.build}: ${blueprints.length} manufacturing recipes, ${neededTypes.size} types, ${Object.keys(skills).length} skills`)
const topology = {}
await rows('mapSolarSystems', row => { topology[row._key] = { name: row.name.en, security: row.securityStatus, neighbors: [] } })
await rows('mapStargates', row => { topology[row.solarSystemID]?.neighbors.push(row.destination.solarSystemID) })
const operations = new Map()
await rows('stationOperations', row => operations.set(row._key, row))
const corporations = new Map()
await rows('npcCorporations', row => corporations.set(row._key, row.name.en))
const factories = {}
const roman = n => { const units = [[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]; let text = ''; for (const [v,s] of units) while (n >= v) { text += s; n -= v }; return text }
await rows('npcStations', row => {
  const operation = operations.get(row.operationID)
  if (!operation?.services.includes(14)) return // SDE station service: Factory.
  factories[row._key] = {
    systemId: row.solarSystemID,
    name: `${systems[row.solarSystemID]} ${roman(row.celestialIndex)}${row.orbitIndex ? ` - Moon ${row.orbitIndex}` : ''} - ${corporations.get(row.ownerID) ?? `Owner #${row.ownerID}`}${row.useOperationName ? ` ${operation.operationName.en}` : ''}`
  }
})
writeFileSync(new URL('../src/main/data/industry-locations.json', import.meta.url), JSON.stringify({ build: catalog.build, systems: topology, factories }))
console.log(`${Object.keys(topology).length} systems, ${Object.keys(factories).length} NPC factories`)
