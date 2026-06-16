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

## Example: Build a Starter Shelter

You have been given: **stone, torches, dirt, a crafting table, and a bed.** No gathering needed — go straight to building.

The shelter is a 5×5 exterior (3×3 interior), 2 blocks tall, flat stone roof. The entrance is a 1-block gap on the south wall (column bx+2).

**Build order: shell first, interior last.** Complete all four walls and the roof before placing anything inside. The roof blocks need the walls as reference points, and interior items (bed, crafting table, torches) should only go in once the structure is fully enclosed.

**Tool rule:** Use `@batch-place-blocks` for structural blocks (walls, roof). Use `@place-block` (single) for interior items — bed, crafting table, torches.

```
# 1. Announce and fix your anchor
@read-chat()
@send-chat("Building a starter shelter!")
@scan-surroundings()
# Record your current position as (bx, by, bz).
# If the ground is uneven, place dirt to fill any holes now.
```

```
# 2. North wall — z = bz, both layers (10 blocks)
# BATCH: place all 10 blocks in ONE call — do not call place-block 10 times
@batch-place-blocks(blocks=[
  {x: bx,   y: by,   z: bz, item: "cobblestone"},
  {x: bx+1, y: by,   z: bz, item: "cobblestone"},
  {x: bx+2, y: by,   z: bz, item: "cobblestone"},
  {x: bx+3, y: by,   z: bz, item: "cobblestone"},
  {x: bx+4, y: by,   z: bz, item: "cobblestone"},
  {x: bx,   y: by+1, z: bz, item: "cobblestone"},
  {x: bx+1, y: by+1, z: bz, item: "cobblestone"},
  {x: bx+2, y: by+1, z: bz, item: "cobblestone"},
  {x: bx+3, y: by+1, z: bz, item: "cobblestone"},
  {x: bx+4, y: by+1, z: bz, item: "cobblestone"}
])
```

```
# 3. South wall — z = bz+4, both layers, entrance gap at bx+2 (8 blocks)
# BATCH: place all 8 blocks in ONE call — do not call place-block 8 times
@batch-place-blocks(blocks=[
  {x: bx,   y: by,   z: bz+4, item: "cobblestone"},
  {x: bx+1, y: by,   z: bz+4, item: "cobblestone"},
  {x: bx+3, y: by,   z: bz+4, item: "cobblestone"},
  {x: bx+4, y: by,   z: bz+4, item: "cobblestone"},
  {x: bx,   y: by+1, z: bz+4, item: "cobblestone"},
  {x: bx+1, y: by+1, z: bz+4, item: "cobblestone"},
  {x: bx+3, y: by+1, z: bz+4, item: "cobblestone"},
  {x: bx+4, y: by+1, z: bz+4, item: "cobblestone"}
])
```

```
# 4. West wall — x = bx, both layers, skip corners (6 blocks)
# BATCH: place all 6 blocks in ONE call — do not call place-block 6 times
@batch-place-blocks(blocks=[
  {x: bx, y: by,   z: bz+1, item: "cobblestone"},
  {x: bx, y: by,   z: bz+2, item: "cobblestone"},
  {x: bx, y: by,   z: bz+3, item: "cobblestone"},
  {x: bx, y: by+1, z: bz+1, item: "cobblestone"},
  {x: bx, y: by+1, z: bz+2, item: "cobblestone"},
  {x: bx, y: by+1, z: bz+3, item: "cobblestone"}
])
```

```
# 5. East wall — x = bx+4, both layers, skip corners (6 blocks)
# BATCH: place all 6 blocks in ONE call — do not call place-block 6 times
@batch-place-blocks(blocks=[
  {x: bx+4, y: by,   z: bz+1, item: "cobblestone"},
  {x: bx+4, y: by,   z: bz+2, item: "cobblestone"},
  {x: bx+4, y: by,   z: bz+3, item: "cobblestone"},
  {x: bx+4, y: by+1, z: bz+1, item: "cobblestone"},
  {x: bx+4, y: by+1, z: bz+2, item: "cobblestone"},
  {x: bx+4, y: by+1, z: bz+3, item: "cobblestone"}
])
```

```
# 6. Roof — y = by+2, full 5×5 (25 blocks)
# BATCH: place all 25 blocks in ONE call — do not call place-block 25 times
@batch-place-blocks(blocks=[
  {x: bx,   y: by+2, z: bz,   item: "cobblestone"},
  {x: bx+1, y: by+2, z: bz,   item: "cobblestone"},
  {x: bx+2, y: by+2, z: bz,   item: "cobblestone"},
  {x: bx+3, y: by+2, z: bz,   item: "cobblestone"},
  {x: bx+4, y: by+2, z: bz,   item: "cobblestone"},
  {x: bx,   y: by+2, z: bz+1, item: "cobblestone"},
  {x: bx+1, y: by+2, z: bz+1, item: "cobblestone"},
  {x: bx+2, y: by+2, z: bz+1, item: "cobblestone"},
  {x: bx+3, y: by+2, z: bz+1, item: "cobblestone"},
  {x: bx+4, y: by+2, z: bz+1, item: "cobblestone"},
  {x: bx,   y: by+2, z: bz+2, item: "cobblestone"},
  {x: bx+1, y: by+2, z: bz+2, item: "cobblestone"},
  {x: bx+2, y: by+2, z: bz+2, item: "cobblestone"},
  {x: bx+3, y: by+2, z: bz+2, item: "cobblestone"},
  {x: bx+4, y: by+2, z: bz+2, item: "cobblestone"},
  {x: bx,   y: by+2, z: bz+3, item: "cobblestone"},
  {x: bx+1, y: by+2, z: bz+3, item: "cobblestone"},
  {x: bx+2, y: by+2, z: bz+3, item: "cobblestone"},
  {x: bx+3, y: by+2, z: bz+3, item: "cobblestone"},
  {x: bx+4, y: by+2, z: bz+3, item: "cobblestone"},
  {x: bx,   y: by+2, z: bz+4, item: "cobblestone"},
  {x: bx+1, y: by+2, z: bz+4, item: "cobblestone"},
  {x: bx+2, y: by+2, z: bz+4, item: "cobblestone"},
  {x: bx+3, y: by+2, z: bz+4, item: "cobblestone"},
  {x: bx+4, y: by+2, z: bz+4, item: "cobblestone"}
])
```

```
# 7. Furnish — use single @place-block for each interior item
@place-block(x=bx+1, y=by, z=bz+1, item="crafting_table")

# Bed occupies 2 blocks: foot at the placed position, head one block in the
# direction the bot is currently facing. Face south first so the head lands
# at (bx+3, by, bz+2) — both positions must be clear before placing.
@face-toward(x=bx+3, z=bz+2)   ← face south so the head block goes to bz+2
@place-block(x=bx+3, y=by, z=bz+1, item="bed")

# Torches go in the AIR space next to a wall, faceDirection points AT the wall block
# North wall torch: air at bz+1, facing the north wall (z=bz)
@place-block(x=bx+2, y=by+1, z=bz+1, item="torch", faceDirection="north")
# South wall torch: air at bz+3, facing the south wall (z=bz+4)
@place-block(x=bx+2, y=by+1, z=bz+3, item="torch", faceDirection="south")
```

```
# 8. Confirm
@scan-surroundings()
@send-chat("Shelter done!")
```

**Notes:**
- Replace bx, by, bz with the actual coordinates from step 1 before calling anything.
- Each wall/roof step is ONE `@batch-place-blocks(blocks=[...])` call. Never call `@place-block` in a loop block-by-block.
- If a block fails ("already a block there"), call @scan-surroundings and skip that coordinate.
- **Bed placement:** a bed needs 2 clear floor blocks. Always call @face-toward toward the head position first, then place at the foot position. If placement fails, check that the head block position is also free.
- Sleeping in the bed sets your spawn point — do it before nightfall.

---

## Tips

- **Batching blocks:** When placing more than one block, ALWAYS pass all of them in a single `@batch-place-blocks(blocks=[...])` call. Never call `@place-block` in a loop — batch everything into one call.
- Call @scan-surroundings after every movement to re-orient — never assume position.
- @can-craft before @craft-item — it tells you exactly what's missing.
- @find-blocks with count > 1 returns multiple locations so you can chain digs.
- If stuck, @scan-surroundings first — the body map usually shows exactly what's blocking you.
