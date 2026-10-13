# Fly Safe

Free, fully unlocked desktop intelligence companion for EVE Online.

Fly Safe turns the Local chat roster, D-scan, and Probe Scanner data you copy into practical local intel. It provides pilot and corporation lookups, risk signals, a Watchlist, route risk, market tools, personal finance, wormhole-chain mapping, Hunter Planner, Doctrine Matcher, and optional Corp / Fleet workspaces.

## Installers

Installers are available in [GitHub Releases](https://github.com/xbronde7/fly-safe/releases):

- macOS Apple Silicon: [Fly Safe 1.1.13 preview](https://github.com/xbronde7/fly-safe/releases/tag/v1.1.13), `Fly-Safe-1.1.13-arm64.dmg`.
- Windows 10/11 x64: [Fly Safe 1.0.0](https://github.com/xbronde7/fly-safe/releases/tag/v1.0.0), `Fly-Safe-Setup-1.0.0-x64.exe`.

## Free and unlocked

Restored version **1.1.13** adds a separate nine-line mass-production
planner: long multi-run jobs, distinct blueprints, one shared material/BUY basket,
full contract/BPO cash outlay, common budget and regional demand limits. The BPC
monitor stays single-run. Defaults: 24-hour cycle, jobs at least four hours/two runs.
It does not multiply one profitable run by nine or submit jobs automatically.
Version 1.1.12 added full station BUY/SELL depth and a current
Jita valuation of each manufactured batch (net BUY, estimated net SELL, and
profit against its cost). Depth is independent of the quote quantity; source
timestamps are retained on cache hits. SELL is not a guaranteed sale.

The manufacturing radar and job monitor:

Opt-in background BPC deal monitoring uses purchased copies and all-market
materials, with configurable BUY profit notifications. **Готовая продукция**
tracks real manufacturing jobs, automatically prices recipe materials from market
purchases, and needs only BPC price/runs entry. Missing-history/current Jita price
and base factory-fee fallbacks are explicitly labelled estimates, never exact
historical payments or free resources. Previously confirmed costs are preserved.

Manual profit search ranks long BUY-backed batches by whole-batch cash profit,
not one-run hourly earnings. SELL estimates remain secondary. The common plan
respects active-character line skills, current BUY/resource depth and conservative
7/30-day regional demand; missing demand excludes a product from that plan.
Nine distinct simultaneous BPC/BPO instances are required to fill nine lines.
All materials are newly bought at SELL; existing stock/purchases do not reduce
this planning budget. The wallet ledger and finished-goods costing are unchanged.
Production defaults to Jita; compare NPC factories within 10 gate jumps. See
[manufacturing documentation](INDUSTRY.md) for permissions, formulas and limitations.
Version 1.1.13 is a restored preview. All 867 regression tests, TypeScript checks,
and production builds pass. See [publication validation](PUBLISH-1.1.13.md).

All local features are included. There is no license key, paid plan, subscription, or payment verification.

EVE SSO sign-in remains required for features that retrieve data from official EVE APIs. Fly Safe never reads EVE memory or cache, intercepts game traffic, controls the EVE client, or sends Local and D-scan data to a remote service.

## Support Fly Safe

Donations are optional and help fund maintenance and future updates.

- Donatty: [donatty.com/xbronde](https://donatty.com/xbronde)
- Bitcoin (BTC): `13mQGzbcyaW5RtfzMvL4dxtzANHnAS2zbC`
- ISK: serg Xbronde

## Data and limitations

- ESI does not expose the Local roster; Fly Safe only works with data you deliberately copy.
- EVE SSO connects only the character you approve and can be revoked through EVE Online's Authorized Applications page.
- Public killmail data is incomplete and historical; a risk signal is guidance, not proof that a pilot is currently present.
- Your local database stores cache, Watchlist, and encounter data on your computer.

## Credits

Fly Safe is not affiliated with or endorsed by CCP Games or zKillboard.

© 2014 CCP hf. All rights reserved. EVE, EVE Online, CCP, and related logos and images are trademarks or registered trademarks of CCP hf.

## Development

Use Node.js 24 and npm. From the repository root:

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run package:mac
```

The optional relay server has its own `server/package.json` and README.
The macOS publication workflow builds the restored source and publishes a
prerelease after packaging succeeds. It does not reuse or overwrite the older
1.0.0 installers.
