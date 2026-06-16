import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import { coerceCoordinates } from './coordinate-utils.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
const MAX_FIND_BLOCKS_COUNT = 256;

interface FaceOption {
  direction: string;
  vector: Vec3;
}

// Items that occupy 2 horizontal blocks; second block extends in the bot's facing direction.
const TWO_BLOCK_HORIZONTAL = new Set(['bed', 'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed']);
// Items that occupy 2 vertical blocks; second block is directly above.
const TWO_BLOCK_VERTICAL = new Set(['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'bamboo_door', 'iron_door', 'crimson_door', 'warped_door', 'copper_door', 'exposed_copper_door', 'weathered_copper_door', 'oxidized_copper_door', 'waxed_copper_door', 'waxed_exposed_copper_door', 'waxed_weathered_copper_door', 'waxed_oxidized_copper_door', 'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_grass', 'large_fern']);

function yawToFacingOffset(yaw: number): Vec3 {
  // mineflayer yaw: 0=north(-Z), π/2=west(-X), π=south(+Z), -π/2=east(+X)
  const norm = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const sector = Math.round(norm / (Math.PI / 2)) % 4;
  // sector 0=north, 1=west, 2=south, 3=east
  const offsets = [new Vec3(0,0,-1), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(1,0,0)];
  return offsets[sector];
}

export function registerBlockTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const facingHeading: Record<string, number> = {
    north: 0, east: 90, south: 180, west: 270,
  };

  async function placeOne(
    bot: mineflayer.Bot,
    x: number, y: number, z: number,
    item?: string,
    faceDirection: FaceDirection = 'down',
    facing?: string
  ): Promise<string> {
    if (item) {
      const stack = bot.inventory.items().find(i => i.name === item);
      if (!stack) return `Cannot place ${item}: not found in inventory. Call @list-inventory to see what you have.`;
      await bot.equip(stack, 'hand');
    }

    const placePos = new Vec3(x, y, z).floored();
    ({ x, y, z } = placePos);

    const botPos = bot.entity.position.floored();
    if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
      return `You can't place a block where you're standing or one block above`;
    }

    const blockAtPos = bot.blockAt(placePos);
    if (blockAtPos && blockAtPos.name !== 'air') {
      const allFaces = [
        { label: 'above',  pos: placePos.offset( 0,  1,  0) },
        { label: 'below',  pos: placePos.offset( 0, -1,  0) },
        { label: 'north',  pos: placePos.offset( 0,  0, -1) },
        { label: 'south',  pos: placePos.offset( 0,  0,  1) },
        { label: 'east',   pos: placePos.offset( 1,  0,  0) },
        { label: 'west',   pos: placePos.offset(-1,  0,  0) },
      ];
      const free = allFaces
        .filter(f => bot.blockAt(f.pos)?.name === 'air')
        .map(f => `${f.label} (${f.pos.x},${f.pos.y},${f.pos.z})`);
      const hint = free.length > 0
        ? `Adjacent free positions: ${free.join(', ')}`
        : 'No adjacent free positions found.';
      return `There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z}). ${hint}`;
    }

    // Pre-check for 2-block items before spending time on pathfinding/placement.
    const itemName = item ?? bot.heldItem?.name ?? '';
    let forcedYaw: number | null = null;

    if (TWO_BLOCK_HORIZONTAL.has(itemName)) {
      const cardinals = [
        { name: 'north', offset: new Vec3( 0, 0, -1), heading: 0   },
        { name: 'south', offset: new Vec3( 0, 0,  1), heading: 180 },
        { name: 'east',  offset: new Vec3( 1, 0,  0), heading: 90  },
        { name: 'west',  offset: new Vec3(-1, 0,  0), heading: 270 },
      ];
      // Scan surrounding pairs: given pos can be foot or head.
      // For each direction, check [given, given+dir] and [given-dir, given] as (foot, head).
      const candidates: Array<{ foot: Vec3; heading: number }> = [];
      for (const dir of cardinals) {
        // Given = foot, neighbour = head
        const head1 = placePos.plus(dir.offset);
        if (bot.blockAt(head1)?.name === 'air' &&
            bot.blockAt(placePos.offset(0, -1, 0))?.name !== 'air' &&
            bot.blockAt(head1.offset(0, -1, 0))?.name !== 'air') {
          candidates.push({ foot: placePos.clone(), heading: dir.heading });
        }
        // Given = head, neighbour = foot
        const foot2 = placePos.minus(dir.offset);
        if (bot.blockAt(foot2)?.name === 'air' &&
            bot.blockAt(foot2.offset(0, -1, 0))?.name !== 'air' &&
            bot.blockAt(placePos.offset(0, -1, 0))?.name !== 'air') {
          candidates.push({ foot: foot2, heading: dir.heading });
        }
      }
      if (candidates.length === 0) {
        return `Cannot place ${itemName} at (${x},${y},${z}): no pair of adjacent air blocks with solid floors found in any cardinal direction.`;
      }
      const chosen = candidates[0];
      forcedYaw = -chosen.heading * (Math.PI / 180);
      log('info', `Placing ${itemName} foot at (${chosen.foot.x},${chosen.foot.y},${chosen.foot.z}), facing heading ${chosen.heading}`);
      ({ x, y, z } = chosen.foot);
      placePos.x = chosen.foot.x; placePos.y = chosen.foot.y; placePos.z = chosen.foot.z;
    } else if (TWO_BLOCK_VERTICAL.has(itemName)) {
      const abovePos = placePos.offset(0, 1, 0);
      const aboveBlock = bot.blockAt(abovePos);
      if (aboveBlock && aboveBlock.name !== 'air') {
        return `Cannot place ${itemName} at (${x},${y},${z}): block above at (${abovePos.x},${abovePos.y},${abovePos.z}) is occupied by ${aboveBlock.name}.`;
      }
    } else if (facing && facingHeading[facing] !== undefined) {
      forcedYaw = -facingHeading[facing] * (Math.PI / 180);
    }

    const possibleFaces: FaceOption[] = [
      { direction: 'down',  vector: new Vec3( 0, -1,  0) },
      { direction: 'north', vector: new Vec3( 0,  0, -1) },
      { direction: 'south', vector: new Vec3( 0,  0,  1) },
      { direction: 'east',  vector: new Vec3( 1,  0,  0) },
      { direction: 'west',  vector: new Vec3(-1,  0,  0) },
      { direction: 'up',    vector: new Vec3( 0,  1,  0) },
    ];

    if (faceDirection !== 'down') {
      const specificFace = possibleFaces.find(face => face.direction === faceDirection);
      if (specificFace) {
        possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
      }
    }

    // Move within placement range of the target (not the reference block).
    // Range 3 keeps the bot far enough to aim properly without standing on the block.
    if (bot.entity.position.distanceTo(placePos) > 4) {
      try {
        await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      } catch { /* carry on and try placing anyway */ }
    }

    if (forcedYaw !== null) {
      await bot.look(forcedYaw, bot.entity.pitch, true);
    }

    let lastError: unknown;
    let attemptedAny = false;
    for (const face of possibleFaces) {
      const referencePos = placePos.plus(face.vector);
      const referenceBlock = bot.blockAt(referencePos);

      if (!referenceBlock || referenceBlock.name === 'air') continue;

      attemptedAny = true;
      try {
        if (forcedYaw !== null) {
          // Keep the bot facing in the desired direction so the server places the
          // bed/door oriented correctly. Skip _genericPlace's internal lookAt by
          // passing forceLook:'ignore', then manually look at the reference face.
          await bot.look(forcedYaw, bot.entity.pitch, true);
          await (bot as any)._placeBlockWithOptions(referenceBlock, face.vector.scaled(-1), { swingArm: 'right', forceLook: 'ignore' });
        } else {
          await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
        }
        return `ok:(${x},${y},${z})`;
      } catch (placeError) {
        lastError = placeError;
        log('warn', `Failed to place at (${x},${y},${z}) using ${face.direction} face: ${placeError}`);
      }
    }

    if (attemptedAny) {
      return `Failed to place block at (${x}, ${y}, ${z}): ${lastError}`;
    }
    return `Failed to place block at (${x}, ${y}, ${z}): No solid adjacent block found to place against (all neighbors are air)`;
  }

  factory.registerTool(
    "place-block",
    "Place a single block at x/y/z. For placing 2 or more blocks (walls, floors, roofs) use batch-place-blocks instead. Pass `item` to auto-equip from inventory before placing.",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      item: z.string().optional().describe("Item name to equip and place (e.g. 'stone', 'crafting_table'). Auto-equips from inventory."),
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: 'down')"),
      facing: z.enum(['north', 'south', 'east', 'west']).optional().describe("Direction the bot faces before placing (0=north, 90=east, 180=south, 270=west). Use for directional blocks like beds, doors, and stairs to control their orientation."),
    },
    async ({ x, y, z, item, faceDirection = 'down', facing }: {
      x: number; y: number; z: number;
      item?: string; faceDirection?: FaceDirection; facing?: string;
    }) => {
      const bot = getBot();
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const msg = await placeOne(bot, x, y, z, item, faceDirection, facing);
      if (msg.startsWith('ok:')) {
        return factory.createResponse(`Placed block at (${x}, ${y}, ${z})`);
      }
      return factory.createResponse(msg);
    }
  );

  factory.registerTool(
    "batch-place-blocks",
    "Place multiple blocks in one call. Use this for any structure with 2 or more blocks — walls, floors, roofs, etc. Never call place-block in a loop; batch everything here instead. Each entry requires x, y, z and optionally item (auto-equips from inventory) and faceDirection (default: 'down').",
    {
      blocks: z.array(z.object({
        x: z.coerce.number(),
        y: z.coerce.number(),
        z: z.coerce.number(),
        item: z.preprocess(v => v ?? undefined, z.string().optional()).describe("Item to equip and place. Auto-equips from inventory."),
        faceDirection: z.preprocess(v => v ?? undefined, z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional()).describe("Face to place against (default: 'down')"),
      })).describe("All blocks to place. Pass the entire wall, floor, or roof as one list."),
    },
    async ({ blocks }: {
      blocks: { x: number; y: number; z: number; item?: string; faceDirection?: FaceDirection }[];
    }) => {
      const bot = getBot();
      const results: string[] = [];
      let placed = 0;
      for (const b of blocks) {
        const msg = await placeOne(bot, b.x, b.y, b.z, b.item, b.faceDirection ?? 'down');
        if (msg.startsWith('ok:')) {
          placed++;
        } else {
          results.push(msg);
        }
      }
      const summary = `Placed ${placed}/${blocks.length} blocks.`;
      return factory.createResponse(results.length > 0 ? `${summary}\nIssues:\n${results.join('\n')}` : summary);
    }
  );

  factory.registerTool(
    "dig-block",
    "Dig one or more blocks to clear a path. Provide either a single block (x, y, z) or a list of blocks via the `blocks` array. Use the array form to clear a 2-block-tall passage in one call — pass the head-level block first, then the foot-level block.",
    {
      x: z.coerce.number().optional().describe("X coordinate (single block)"),
      y: z.coerce.number().optional().describe("Y coordinate (single block)"),
      z: z.coerce.number().optional().describe("Z coordinate (single block)"),
      blocks: z.array(z.object({
        x: z.coerce.number(),
        y: z.coerce.number(),
        z: z.coerce.number(),
      })).optional().describe("List of blocks to dig in order. Use instead of x/y/z to dig multiple blocks in one call."),
    },
    async ({ x, y, z, blocks }) => {
      const bot = getBot();

      // Normalise to a flat list of positions
      const targets: Array<{ x: number; y: number; z: number }> = [];
      if (blocks && blocks.length > 0) {
        for (const b of blocks) {
          const coords = coerceCoordinates(b.x, b.y, b.z);
          targets.push(coords);
        }
      } else if (x !== undefined && y !== undefined && z !== undefined) {
        targets.push(coerceCoordinates(x, y, z));
      } else {
        return factory.createResponse('Provide either x/y/z or a blocks array.');
      }

      const results: string[] = [];

      const digOne = async (tx: number, ty: number, tz: number): Promise<string> => {
        const blockPos = new Vec3(tx, ty, tz);
        let block = bot.blockAt(blockPos);
        if (!block || block.name === 'air') {
          return `(${tx}, ${ty}, ${tz}): already air — skipped`;
        }

        const blockName = block.name;

        if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
          const goal = new goals.GoalNear(tx, ty, tz, 2);
          await bot.pathfinder.goto(goal);
          block = bot.blockAt(blockPos)!;
        }

        const harvestTools: Record<number, boolean> | undefined = (block as unknown as { harvestTools?: Record<number, boolean> }).harvestTools;
        if (harvestTools) {
          const tool = bot.inventory.items().find(item => harvestTools[item.type]);
          if (tool) {
            try { await bot.equip(tool, 'hand'); } catch { /* ignore */ }
          }
        }

        await bot.dig(block, true, 'raycast');
        await new Promise(resolve => setTimeout(resolve, 250));

        const remaining = bot.blockAt(blockPos);
        if (remaining && remaining.name !== 'air') {
          await bot.dig(remaining, true, 'raycast');
          await new Promise(resolve => setTimeout(resolve, 250));
        }

        return `(${tx}, ${ty}, ${tz}): dug ${blockName}`;
      };

      for (const t of targets) {
        const msg = await digOne(t.x, t.y, t.z);
        results.push(msg);
      }

      // Wait for drops to be collected after all digs are done
      await new Promise(resolve => setTimeout(resolve, 800));

      return factory.createResponse(results.join('\n'));
    }
  );

  factory.registerTool(
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block) {
        return factory.createResponse(`No block information found at position (${x}, ${y}, ${z})`);
      }

      return factory.createResponse(`Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
    }
  );

  factory.registerTool(
    "find-blocks",
    "Find one or more nearby blocks of a specific type",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)"),
      count: z.coerce.number().int().positive().optional().describe("Maximum number of blocks to return (default: 1; values above 256 are clamped)")
    },
    async ({ blockType, maxDistance = 16, count = 1 }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blocksByName = mcData.blocksByName;
      const normalizedCount = Math.min(count, MAX_FIND_BLOCKS_COUNT);

      if (!blocksByName[blockType]) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      const blockId = blocksByName[blockType].id;

      if (normalizedCount === 1) {
        const block = bot.findBlock({
          matching: blockId,
          maxDistance: maxDistance
        });

        if (!block) {
          return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
        }

        return factory.createResponse(`Found ${blockType} at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
      }

      const blocks = bot.findBlocks({
        point: bot.entity.position,
        matching: blockId,
        maxDistance: maxDistance,
        count: normalizedCount
      });

      if (blocks.length === 0) {
        return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      }

      const blocksList = blocks
        .map((block, i) => `${i + 1}. (${block.x}, ${block.y}, ${block.z})`)
        .join('\n');

      return factory.createResponse(`Found ${blocks.length} ${blockType} block(s) within ${maxDistance} blocks:\n${blocksList}`);
    }
  );
}