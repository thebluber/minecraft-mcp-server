import { z } from "zod";
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';

type Entity = ReturnType<Bot['nearestEntity']>;

export function registerEntityTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "find-entity",
    "Find the nearest entity of a specific type",
    {
      type: z.string().optional().describe("Type of entity to find (empty for any entity)"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type = '', maxDistance = 16 }) => {
      const bot = getBot();
      const entityFilter = (entity: NonNullable<Entity>) => {
        if (!type) return true;
        if (type === 'player') return entity.type === 'player';
        if (type === 'mob') return entity.type === 'mob';
        return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);

      if (!entity || bot.entity.position.distanceTo(entity.position) > maxDistance) {
        return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
      }

      const entityName = entity.name || (entity as { username?: string }).username || entity.type;
      return factory.createResponse(`Found ${entityName} at position (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})`);
    }
  );

  factory.registerTool(
    "attack-entity",
    "Move within melee range of the nearest matching entity and attack it once. Use find-entity first to confirm the entity is nearby.",
    {
      type: z.string().optional().describe("Entity type or name to attack (empty for nearest entity)"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)"),
      meleeRange: z.coerce.number().finite().optional().describe("How close to get before attacking (default: 3)"),
    },
    async ({ type = '', maxDistance = 16, meleeRange = 3 }) => {
      const bot = getBot();

      const entityFilter = (entity: NonNullable<Entity>) => {
        if (entity === bot.entity) return false;
        if (!type) return true;
        if (type === 'player') return entity.type === 'player';
        if (type === 'mob') return entity.type === 'mob';
        return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);
      if (!entity || bot.entity.position.distanceTo(entity.position) > maxDistance) {
        return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
      }

      const entityName = entity.name || (entity as { username?: string }).username || entity.type;
      const distance = bot.entity.position.distanceTo(entity.position);

      if (distance > meleeRange) {
        const goal = new goals.GoalFollow(entity, meleeRange);
        try {
          await Promise.race([
            bot.pathfinder.goto(goal),
            new Promise<void>(resolve => setTimeout(resolve, 10000)),
          ]);
          bot.pathfinder.stop();
        } catch {
          bot.pathfinder.stop();
        }
      }

      await bot.lookAt(entity.position.offset(0, entity.height / 2, 0), true);
      bot.attack(entity);

      const finalDist = bot.entity.position.distanceTo(entity.position);
      const ep = entity.position;
      return factory.createResponse(
        `Attacked ${entityName} at (${Math.floor(ep.x)}, ${Math.floor(ep.y)}, ${Math.floor(ep.z)}). Distance at attack: ${finalDist.toFixed(1)} blocks.`
      );
    }
  );
}
