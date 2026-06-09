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

export function registerBlockTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "place-block",
    "Place a block at the specified position. Pass `item` to automatically equip the block from inventory before placing — no need to call equip-item separately.",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      item: z.string().optional().describe("Item name to equip and place (e.g. 'crafting_table', 'oak_planks'). Auto-equips from inventory."),
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: 'down')")
    },
    async ({ x, y, z, item, faceDirection = 'down' }: { x: number, y: number, z: number, item?: string, faceDirection?: FaceDirection }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      if (item) {
        const stack = bot.inventory.items().find(i => i.name === item);
        if (!stack) {
          return factory.createResponse(`Cannot place ${item}: not found in inventory. Call @list-inventory to see what you have.`);
        }
        await bot.equip(stack, 'hand');
      }

      const placePos = new Vec3(x, y, z).floored();
      ({ x, y, z } = placePos);

      const botPos = bot.entity.position.floored();
      if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
        return factory.createResponse(`You can't place a block where you're standing or one block above`);
      }

      const blockAtPos = bot.blockAt(placePos);

      if (blockAtPos && blockAtPos.name !== 'air') {
        return factory.createResponse(`There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`);
      }

      const possibleFaces: FaceOption[] = [
        { direction: 'down', vector: new Vec3(0, -1, 0) },
        { direction: 'north', vector: new Vec3(0, 0, -1) },
        { direction: 'south', vector: new Vec3(0, 0, 1) },
        { direction: 'east', vector: new Vec3(1, 0, 0) },
        { direction: 'west', vector: new Vec3(-1, 0, 0) },
        { direction: 'up', vector: new Vec3(0, 1, 0) }
      ];

      if (faceDirection !== 'down') {
        const specificFace = possibleFaces.find(face => face.direction === faceDirection);
        if (specificFace) {
          possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
        }
      }

      for (const face of possibleFaces) {
        const referencePos = placePos.plus(face.vector);
        const referenceBlock = bot.blockAt(referencePos);

        if (referenceBlock && referenceBlock.name !== 'air') {
          if (!bot.canSeeBlock(referenceBlock)) {
            const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
            await bot.pathfinder.goto(goal);
          }

          await bot.lookAt(placePos, true);

          try {
            await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
            return factory.createResponse(`Placed block at (${x}, ${y}, ${z}) using ${face.direction} face`);
          } catch (placeError) {
            log('warn', `Failed to place using ${face.direction} face: ${placeError}`);
            continue;
          }
        }
      }

      return factory.createResponse(`Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found`);
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