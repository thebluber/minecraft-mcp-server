import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';

interface InventoryItem {
  name: string;
  count: number;
  slot: number;
}

export function registerInventoryTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async () => {
      const bot = getBot();
      const items = bot.inventory.items();
      const itemList: InventoryItem[] = items.map((item) => ({
        name: item.name,
        count: item.count,
        slot: item.slot
      }));

      if (items.length === 0) {
        return factory.createResponse("Inventory is empty");
      }

      let inventoryText = `Found ${items.length} items in inventory:\n\n`;
      itemList.forEach(item => {
        inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}\n`;
      });

      return factory.createResponse(inventoryText);
    }
  );

  factory.registerTool(
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().describe("Name or type of item to find")
    },
    async ({ nameOrType }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(nameOrType.toLowerCase())
      );

      if (item) {
        return factory.createResponse(`Found ${item.count} ${item.name} in inventory (slot ${item.slot})`);
      } else {
        return factory.createResponse(`Couldn't find any item matching '${nameOrType}' in inventory`);
      }
    }
  );

  factory.registerTool(
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().describe("Name of the item to equip"),
      destination: z.string().optional().describe("Where to equip the item (default: 'hand')")
    },
    async ({ itemName, destination = 'hand' }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(itemName.toLowerCase())
      );

      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      await bot.equip(item, destination as mineflayer.EquipmentDestination);
      return factory.createResponse(`Equipped ${item.name} to ${destination}`);
    }
  );

  factory.registerTool(
    "collect-dropped-items",
    "Walk to and collect nearby dropped item entities on the ground. Use this after digging blocks to pick up the drops.",
    {
      maxDistance: z.coerce.number().optional().describe("Maximum distance to search for drops (default: 16)"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds (default: 10000)")
    },
    async ({ maxDistance = 16, timeoutMs = 10000 }: { maxDistance?: number; timeoutMs?: number }) => {
      const bot = getBot();
      const deadline = Date.now() + timeoutMs;
      const collected: string[] = [];

      const getDrops = () =>
        Object.values(bot.entities).filter(e => {
          if (!e.getDroppedItem()) return false;
          return e.position.distanceTo(bot.entity.position) <= maxDistance;
        });

      let drops = getDrops();
      if (drops.length === 0) {
        return factory.createResponse('No dropped items found nearby.');
      }

      while (drops.length > 0 && Date.now() < deadline) {
        const target = drops[0];
        const item = target.getDroppedItem();
        if (!item) { drops = getDrops(); continue; }

        const itemName = item.name;
        const goal = new goals.GoalNear(target.position.x, target.position.y, target.position.z, 0);

        // Wait for pickup: either pathfinder reaches it and playerCollect fires, or timeout
        await new Promise<void>(resolve => {
          const remaining = Math.max(50, deadline - Date.now());
          const timer = setTimeout(resolve, remaining);

          const onCollect = (collector: { id: number }, collected: { id: number }) => {
            if (collector.id === bot.entity.id && collected.id === target.id) {
              clearTimeout(timer);
              resolve();
            }
          };
          bot.once('playerCollect', onCollect);

          bot.pathfinder.goto(goal).then(() => {
            // Give server up to 500ms to send the collect packet after arrival
            setTimeout(() => {
              bot.removeListener('playerCollect', onCollect);
              clearTimeout(timer);
              resolve();
            }, 500);
          }).catch(() => {
            bot.removeListener('playerCollect', onCollect);
            clearTimeout(timer);
            resolve();
          });
        });

        // Check if entity still exists (collected = gone)
        if (!bot.entities[target.id] || !bot.entities[target.id].isValid) {
          collected.push(itemName);
        }

        drops = getDrops();
      }

      if (collected.length === 0) {
        return factory.createResponse('Could not collect any dropped items (items may have despawned or been out of reach).');
      }
      return factory.createResponse(`Collected: ${collected.join(', ')}`);
    }
  );
}
