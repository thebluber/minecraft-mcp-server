# Minecraft MCP Bot Playbook

---

## First Thing: Say Hi

Check @read-chat first. If you haven't introduced yourself yet, do it now — be natural and brief, mention what you're here to do. If you've already introduced yourself, just greet anyone present and state your current goal.

```
# First time
send-chat("Hey! I'm MineBot, an AI bot. Going to gather some wood and stone today — let's see how this goes!")

# Returning
send-chat("Back! Still working on that stone axe.")
```

Don't skip this. Chat first, then start working.

---

## Core Loop

```
@scan-surroundings → decide → act → @scan-surroundings to verify
```

---

## Facing

All movement is relative to where the bot is facing. **Always call @face-toward before @move-in-direction or @jump.**

| Heading | Direction |
|---|---|
| 0 | North |
| 90 | East |
| 180 | South |
| 270 | West |

- @face-toward — compass heading, pitch locked level. Use before movement.
- @face-toward-xyz — face toward a coordinate, pitch locked level.
- @look-at — compass heading with optional pitch (up/down).
- @look-at-xyz — point at a specific 3D coordinate.

---

## Awareness

### @scan-surroundings

Call at the start of every task, after any failed move, and whenever disoriented.

Gives you: position, health, food, on-ground status, 8-direction block map, nearby block counts, nearby entities.

**Reading the body map:**

| feet | head | floor | Situation | What to do |
|---|---|---|---|---|
| air | air | solid | Clear | Walk freely |
| air | air | air | Drop | Use @descend-to-ground |
| solid | air | solid | 1-block step | @face-toward + @jump forward |
| solid | solid | * | Wall | Dig both blocks first |
| air | solid | * | Overhang | Dig the head block |

Use the coordinates from the map directly in @dig-block — no mental math needed.

---

## Movement

- @move-to-position — pathfinder handles steps, drops (up to 4 blocks), and routing. Has built-in stuck recovery that jumps 1-block ledges automatically.
- @descend-to-ground — use whenever you need to go **down**. Never use @move-to-position to descend.
- @move-in-direction — nudge in a direction for a duration. Call @face-toward first.
- @jump — clears a 1-block step. Call @face-toward first.

**If @move-to-position times out:** call @scan-surroundings, read the obstacle report in the error, dig the blocking blocks, then retry.

---

## Digging

- Never dig the block directly below your feet — you'll fall.
- Dig head-level blocks before foot-level (prevents sand/gravel falling on you).
- Check @scan-surroundings before digging to confirm the target coordinates are what you expect.

```
# Clear a wall to the north (coordinates from body map)
@dig-block(blocks=[
  {x: 12, y: 65, z: -6},   ← head first
  {x: 12, y: 64, z: -6}    ← then foot
])
```

---

## Gathering Materials

```
@scan-surroundings(scanRadius=16)       ← see what's nearby
@find-blocks(blockType, maxDistance=32) ← locate specific blocks
@move-to-position(x, y, z)             ← go there
@scan-surroundings()                    ← re-orient
@dig-block(x, y, z)                    ← dig it
@collect-dropped-items()               ← pick up drops
@list-inventory()                      ← check what you have
```

---

## Crafting

```
@list-inventory()           ← know what you have
@can-craft(item)            ← check if possible, shows missing ingredients
@craft-item(item)           ← craft it
@list-inventory()           ← verify
```

`@craft-item` automatically uses a nearby crafting table if one is within 16 blocks. For recipes that require a table (stone axe, pickaxe, etc.), just make sure you're standing next to one before crafting:

```
@find-blocks(crafting_table, maxDistance=16)
@move-to-position(table_x, table_y, table_z)
@craft-item(stone_axe)
```

If you don't have a crafting table yet, craft one first — it only needs the 2×2 hand grid:
```
@craft-item(oak_planks)
@craft-item(crafting_table)
@place-block(x, y, z, item="crafting_table")   ← place it next to you
@craft-item(stone_axe)                          ← now it'll use the table
```

---

## Example: Stone Axe from Scratch

```
# 1. Announce
@read-chat()
@send-chat("Going to gather wood and stone to craft a stone axe!")

# 2. Get wood
@scan-surroundings(scanRadius=16)
@find-blocks(oak_log, maxDistance=32)
@move-to-position(log_x, log_y, log_z)
@dig-block × 3–4 logs
@collect-dropped-items()

# 3. Craft planks + sticks + crafting table
@craft-item(oak_planks)
@craft-item(crafting_table)
@craft-item(stick)

# 4. Place crafting table and make wooden pickaxe first
@place-block(x, y, z, item="crafting_table")
@craft-item(wooden_pickaxe)

# 5. Mine stone
@find-blocks(stone, maxDistance=16)
@move-to-position(stone_x, stone_y, stone_z)
@equip-item(wooden_pickaxe)
@dig-block × 3 cobblestone
@collect-dropped-items()

# 6. Craft stone axe
@move-to-position(crafting_table_x, crafting_table_y, crafting_table_z)
@craft-item(stone_axe)
@list-inventory()   ← confirm stone axe is there
```

---

## Tips

- Call @scan-surroundings after every movement to re-orient — never assume position.
- @can-craft before @craft-item — it tells you exactly what's missing.
- @find-blocks with count > 1 returns multiple locations so you can chain digs.
- If stuck, @scan-surroundings first — the body map usually shows exactly what's blocking you.
