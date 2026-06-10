# Changes & Setup Notes

A summary of all changes made to this fork and what is required to run correctly on Minecraft 1.21.11.

---

## Third-Party Patches (Manual — Re-apply After `npm install`)

These are not in `package.json` and will be lost when running `npm install`. Re-apply them after any install.

### 1. mineflayer-pathfinder — 1.21.x hitbox fix

**Why:** On Minecraft 1.21.x, the server's collision sweep has a floating-point edge case that rejects movement when the client hitbox (`playerHalfWidth = 0.3`) aligns perfectly with a block edge. This caused the bot to silently fail to move or climb steps.

**Fix:** Replace the published package with a fork that sets `playerHalfWidth = 0.30001` on first movement tick, creating a micro-gap that bypasses the server bug.

**Source:** https://github.com/PrismarineJS/mineflayer-pathfinder/pull/364

```bash
npm install github:invisbleia/mineflayer-pathfinder-1.21.11#master
```

**Verify:**
```bash
grep "playerHalfWidth" node_modules/mineflayer-pathfinder/index.js
# Should print: if (bot.physics && bot.physics.playerHalfWidth === 0.3) {
```

---

### 2. prismarine-viewer — 1.21.11 version support

**Why:** The published `prismarine-viewer@1.33.0` does not include `1.21.11` in its supported versions list, causing the viewer to fail silently on 1.21.11 servers.

**Fix:** Add `'1.21.11'` to the `supportedVersions` array in `node_modules/prismarine-viewer/viewer/lib/version.js`.

**Source:** https://github.com/PrismarineJS/prismarine-viewer/pull/475

The fork cannot be installed directly (its native `gl`/`canvas` dependencies fail to build). Apply as a manual edit instead:

In `node_modules/prismarine-viewer/viewer/lib/version.js` line 1, add `'1.21.11'` to the end of the `supportedVersions` array:

```js
// Before
const supportedVersions = ['1.8.8', ..., '1.21.4']

// After
const supportedVersions = ['1.8.8', ..., '1.21.4', '1.21.11']
```

**Verify:**
```bash
grep "1.21.11" node_modules/prismarine-viewer/viewer/lib/version.js
```

---

## Code Changes

### New files

| File | Purpose |
|---|---|
| `src/viewer.ts` | prismarine-viewer lifecycle — starts, closes, and tracks the viewer port |
| `src/tools/surroundings-tools.ts` | `scan-surroundings` tool — 8-direction block map, nearby block counts, nearby entities |
| `src/tools/screenshot-tools.ts` | `take-screenshot` tool — captures the viewer via puppeteer and returns base64 PNG |
| `PLAYBOOK.md` | LLM guidance document — how the AI agent should use tools effectively |

---

### `src/bot-connection.ts`

- **Pathfinder Movements config:** disabled `dontMineUnderFallingBlock` so the bot can navigate through sand/gravel columns; added all leaf block variants to the `carpets` set so the pathfinder treats them as passable.
- **Viewer startup:** calls `startViewer(bot, viewerPort)` on spawn when `--viewer-port` is configured.
- **Graceful disconnect:** replaced `bot.quit()` calls with a `quit`/`end` fallback (mineflayer 1.21.x changed the API).

---

### `src/main.ts`

- Added `scan-surroundings`, `take-screenshot` tool registrations.
- Wired `captureScreenshot` into `ToolFactory` for automatic before/after screenshot wrapping.
- Added `SIGTERM` / `SIGINT` signal handlers for clean shutdown.
- Added `closeViewer()` and `closeScreenshotBrowser()` to the shutdown path.

---

### `src/tool-factory.ts`

- **Image content support:** `McpResponse.content` now accepts `{ type: "image", data, mimeType }` blocks in addition to text.
- **Before/after screenshots:** `ToolFactory` accepts an optional `screenshotFn`. When set, every tool call automatically captures a screenshot before and after execution and appends both as image content blocks to the response. Skipped for `take-screenshot` itself.
- **Tool call logging:** logs tool name, arguments preview, duration, and result preview on every call.

---

### `src/tools/position-tools.ts`

This file was largely rewritten. Key changes:

#### Compass heading convention
All facing tools use `0=north, 90=east, 180=south, 270=west`. Conversion: `yaw = -heading * (π/180)`. No diagonals exposed.

#### New tools
- `face-toward(heading)` — rotate to a compass heading, pitch locked to 0.
- `face-toward-xyz(x, z)` — rotate to face a coordinate, pitch locked to 0.
- `look-at(heading, pitch?)` — compass heading with optional vertical pitch.
- `look-at-xyz(x, y, z)` — point at a 3D coordinate (full yaw + pitch).

#### `jump` tool — three physics fixes
1. **150ms forward delay:** after detecting airborne, waits 150ms before enabling the direction key. Without this, `forward` active during ascent causes `moveEntity` to zero horizontal velocity every tick while the bot is still below the block's top face.
2. **Jump-on-landing clear:** releases `jump` the moment `onGround` becomes true (not after a fixed timeout). Without this, `jump=true` while `onGround=true` causes an immediate re-jump on the next physics tick.
3. **Removed `lookAtX/Y/Z` params:** facing is now set separately via `face-toward` before calling `jump`.

#### `move-in-direction` tool
- Added 100ms delay + explicit `clearControlStates()` after stopping the pathfinder, preventing a race where pathfinder's deferred `clearControlStates()` wiped the direction we just set.
- Removed `lookAtX/Y/Z` params — call `face-toward` first.

#### `move-to-position` stuck recovery — fully rewritten
Old: blindly looked at target (with pitch) and jumped forward.

New: reads what's actually blocking before acting:
1. Computes grid-aligned step direction toward target.
2. Checks `feetBlock`, `headBlock`, `aboveHead`, `floorAhead`.
3. **Wall or overhang** → skip; let pathfinder re-plan.
4. **Drop or clear path** → push `forward` 600ms at pitch=0 (lets gravity handle descent).
5. **1-block step with head clearance** → face heading + 150ms-delayed jump.

Also fixed: was using `bot.lookAt(target)` (with downward pitch toward destination), which made `forward` push diagonally into the ground instead of off a ledge. Now uses `bot.look(yaw, 0, true)` (pitch=0) for all movement facing.

#### `face-toward` yaw formula fix
Fixed `Math.atan2(-dx, dz)` → `Math.atan2(-dx, -dz)` (both negated). The missing negation on `dz` caused north/south to be swapped 180°.

---

### `src/tools/block-tools.ts`

- **`place-block` auto-equip:** added optional `item` parameter. When provided, the tool finds the item in inventory and equips it before placing — no separate `equip-item` call needed.

---

### `src/viewer.ts`

- Launches prismarine-viewer with `firstPerson: true` (was `false` — was showing a third-person orbit camera instead of the bot's eye view).
- Stores a close handle for clean shutdown.

---

## Running the Server

```bash
npm run build
node dist/main.js \
  --host <server-address> \
  --port 25565 \
  --username <bot-name> \
  --viewer-port 3007      # enables take-screenshot tool for agent to 'see' bot's environment, use 0 to disable (e.g. if getting 'too many URL images in request' error or similar) 
```

`--viewer-port` starts the prismarine-viewer web server at `http://localhost:3007`. Without it, `take-screenshot` returns a text message and no before/after images are attached to tool responses.
