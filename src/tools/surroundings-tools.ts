import { z } from "zod";
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';

// Mineflayer yaw: 0=north, π/2=west, π=south, 3π/2=east (clockwise from north going west)
// Index maps: round(yaw / (π/4)) % 8 → 0=N, 1=NW, 2=W, 3=SW, 4=S, 5=SE, 6=E, 7=NE
const COMPASS = ['north', 'north-west', 'west', 'south-west', 'south', 'south-east', 'east', 'north-east'];

function yawToCompass(yaw: number): string {
  const normalized = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const index = Math.round(normalized / (Math.PI / 4)) % 8;
  return COMPASS[index];
}

function pitchDescription(pitch: number): string {
  const deg = Math.round(pitch * 180 / Math.PI);
  if (deg > 45)  return `looking up ${deg}°`;
  if (deg < -45) return `looking down ${Math.abs(deg)}°`;
  if (deg > 10)  return `slightly up (${deg}°)`;
  if (deg < -10) return `slightly down (${deg}°)`;
  return `level (${deg}°)`;
}

// 8 horizontal directions in (dx, dz) order, clockwise from north
const HORIZONTAL_DIRS: { label: string; dx: number; dz: number }[] = [
  { label: 'north',      dx:  0, dz: -1 },
  { label: 'north-east', dx:  1, dz: -1 },
  { label: 'east',       dx:  1, dz:  0 },
  { label: 'south-east', dx:  1, dz:  1 },
  { label: 'south',      dx:  0, dz:  1 },
  { label: 'south-west', dx: -1, dz:  1 },
  { label: 'west',       dx: -1, dz:  0 },
  { label: 'north-west', dx: -1, dz: -1 },
];

function blockName(bot: Bot, x: number, y: number, z: number): string {
  return bot.blockAt(new Vec3(x, y, z))?.name ?? 'unknown';
}

function coord(x: number, y: number, z: number): string {
  return `(${x},${y},${z})`;
}

export function registerSurroundingsTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "scan-surroundings",
    "Get a snapshot of the bot's immediate environment: position, health/food, on-ground status, detailed 8-direction × 2-height block map with coordinates, nearby block type counts, and nearby entities.",
    {
      scanRadius: z.coerce.number().int().min(1).max(32).optional()
        .describe("Radius in blocks for the nearby block count scan (default: 8, max: 32)"),
      entityRadius: z.coerce.number().int().min(1).max(64).optional()
        .describe("Radius in blocks for the nearby entity scan (default: 16, max: 64)"),
    },
    async ({ scanRadius = 8, entityRadius = 16 }) => {
      const bot = getBot();
      const pos = bot.entity.position.floored();
      const x = pos.x, y = pos.y, z = pos.z;

      // --- On-ground check & ground Y detection ---
      const onGround = bot.entity.onGround;
      let groundY: number | null = null;
      for (let dy = 1; dy <= 32; dy++) {
        const b = bot.blockAt(new Vec3(x, y - dy, z));
        if (b && b.boundingBox === 'block') { groundY = y - dy + 1; break; }
      }

      const facing = yawToCompass(bot.entity.yaw);
      const yawDeg = Math.round(((bot.entity.yaw * 180 / Math.PI) % 360 + 360) % 360);
      const pitch  = pitchDescription(bot.entity.pitch);

      const lines: string[] = [
        `=== Surroundings at (${x}, ${y}, ${z}) ===`,
        `Health: ${bot.health}/20  Food: ${bot.food}/20`,
        `Facing: ${facing} (yaw=${yawDeg}°)  Pitch: ${pitch}`,
        `On ground: ${onGround}${!onGround
          ? `  ← WARNING: bot is floating — pathfinding will fail. ${groundY !== null ? `Nearest ground at Y=${groundY}` : 'No ground found within 32 blocks below'}`
          : ''}`,
        '',
      ];

      // --- Vertical axis (above head + below floor) ---
      // Bot occupies Y (feet) and Y+1 (head). Y-1 is floor, Y+2 is above head.
      lines.push(`Vertical (bot feet=Y${y}, head=Y${y + 1}):`);
      lines.push(`  floor      ${coord(x, y - 1, z)}: ${blockName(bot, x, y - 1, z)}`);
      lines.push(`  above-head ${coord(x, y + 2, z)}: ${blockName(bot, x, y + 2, z)}`);
      lines.push('');

      // --- 8-direction body map ---
      // For each direction show feet block, head block, and floor block (Y-1)
      // so the AI can see: passage blocked? floor solid? step up/down possible?
      const COL_DIR  = 12;
      const COL_FEET = 36;
      const COL_HEAD = 60;

      const header =
        'direction'.padEnd(COL_DIR) +
        'feet (x,y,z): block'.padEnd(COL_FEET - COL_DIR) +
        'head (x,y+1,z): block'.padEnd(COL_HEAD - COL_FEET) +
        'floor (x,y-1,z): block';
      lines.push(`8-direction body map:`);
      lines.push(`  ${header}`);
      lines.push(`  ${'-'.repeat(header.length)}`);

      for (const { label, dx, dz } of HORIZONTAL_DIRS) {
        const nx = x + dx, nz = z + dz;
        const feetBlock  = blockName(bot, nx, y,     nz);
        const headBlock  = blockName(bot, nx, y + 1, nz);
        const floorBlock = blockName(bot, nx, y - 1, nz);

        const dirCol   = label.padEnd(COL_DIR);
        const feetCol  = `${coord(nx, y,     nz)}: ${feetBlock}`.padEnd(COL_FEET - COL_DIR);
        const headCol  = `${coord(nx, y + 1, nz)}: ${headBlock}`.padEnd(COL_HEAD - COL_FEET);
        const floorCol = `${coord(nx, y - 1, nz)}: ${floorBlock}`;

        lines.push(`  ${dirCol}${feetCol}${headCol}${floorCol}`);
      }
      lines.push('');

      // --- Nearby block type counts ---
      const blockCounts: Record<string, number> = {};
      const r = scanRadius;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
            if (b && b.name !== 'air') {
              blockCounts[b.name] = (blockCounts[b.name] ?? 0) + 1;
            }
          }
        }
      }
      const topBlocks = Object.entries(blockCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      lines.push(`Nearby blocks within ${r}-block radius (top 10 by count):`);
      if (topBlocks.length === 0) {
        lines.push('  (none)');
      } else {
        for (const [name, count] of topBlocks) {
          lines.push(`  ${name}: ${count}`);
        }
      }
      lines.push('');

      // --- Nearby entities ---
      const nearbyEntities = Object.values(bot.entities)
        .filter(e => e !== bot.entity)
        .map(e => ({ e, dist: bot.entity.position.distanceTo(e.position) }))
        .filter(({ dist }) => dist <= entityRadius)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 10);

      lines.push(`Nearby entities within ${entityRadius} blocks:`);
      if (nearbyEntities.length === 0) {
        lines.push('  (none)');
      } else {
        for (const { e, dist } of nearbyEntities) {
          const name = (e as { username?: string }).username ?? e.name ?? e.type;
          const ep = e.position.floored();
          lines.push(`  ${name} at (${ep.x},${ep.y + 1},${ep.z}) — ${dist.toFixed(1)} blocks away (eye-level y)`);
        }
      }

      return factory.createResponse(lines.join('\n'));
    }
  );
}
