import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

type Direction = 'forward' | 'back' | 'left' | 'right';

export function registerPositionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "get-position",
    "Get the current position of the bot",
    {},
    async () => {
      const bot = getBot();
      const position = bot.entity.position;
      const pos = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      };
      return factory.createResponse(`Current position: (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "move-to-position",
    "Move the bot to a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      range: z.coerce.number().finite().optional().describe("How close to get to the target (default: 1)"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (min: 50, default: no timeout)")
    },
    async ({ x, y, z, range = 1, timeoutMs = 60000 }: { x: number; y: number; z: number; range?: number; timeoutMs?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      // Pathfinder requires a valid ground node to start A*. If the bot is
      // mid-air, wait up to 3s for gravity to land it before planning.
      if (!bot.entity.onGround) {
        await new Promise<void>((resolve) => {
          const landTimeout = setTimeout(resolve, 3000);
          bot.once('move', function checkGround() {
            if (bot.entity.onGround) {
              clearTimeout(landTimeout);
              resolve();
            } else {
              bot.once('move', checkGround);
            }
          });
        });
      }

      const goal = new goals.GoalNear(x, y, z, range);
      const deadline = Date.now() + timeoutMs;
      let timedOut = false;

      // Attempt pathfinding with stuck detection.
      // Every 2 seconds we check whether the bot has moved. If it hasn't,
      // we stop the pathfinder, jump toward the target to clear a 1-block
      // ledge, then restart pathfinding. This handles holes and low ledges
      // that the pathfinder plans correctly but fails to execute in practice.
      const STUCK_CHECK_MS = 2000;
      const STUCK_THRESHOLD = 0.5; // blocks — less than this = stuck

      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const checkWindow = Math.min(STUCK_CHECK_MS, remaining);
        if (checkWindow <= 0) { timedOut = true; break; }

        const posAtStart = bot.entity.position.clone();

        // Run pathfinder for one check window
        let windowDone = false;
        let pathError: unknown = null;
        const gotoPromise = bot.pathfinder.goto(goal);

        await Promise.race([
          gotoPromise.then(() => { windowDone = true; }).catch((e: unknown) => { pathError = e; }),
          new Promise<void>(resolve => setTimeout(resolve, checkWindow)),
        ]);

        if (windowDone) {
          // Pathfinder reached the goal
          return factory.createResponse(`Successfully moved to position near (${x}, ${y}, ${z})`);
        }

        if (pathError) {
          const errName = (pathError as { name?: string }).name ?? '';
          if (errName === 'NoPath') {
            // A* confirmed no path exists — give up immediately
            bot.pathfinder.stop();
            gotoPromise.catch(() => {});
            throw new Error(
              `No path to (${x}, ${y}, ${z}) — target may be enclosed or unreachable. ` +
              `Call scan-surroundings to assess the area.`
            );
          }
          // PathStopped / Timeout / GoalChanged — pathfinder reset itself
          // (block update, chunk load, internal stuck detect, or we stopped it).
          // These are all normal; just fall through and check progress as usual.
          gotoPromise.catch(() => {});
        }

        // Ensure pathfinder is stopped before checking progress / jumping
        bot.pathfinder.stop();
        gotoPromise.catch(() => {});

        const moved = posAtStart.distanceTo(bot.entity.position);
        if (moved >= STUCK_THRESHOLD) {
          continue; // Making progress — restart pathfinder next iteration
        }

        if (bot.entity.onGround && Date.now() < deadline - 1500) {
          // pathfinder.stop() → fullStop() → clearControlStates(). Wait for it to settle.
          await new Promise<void>(resolve => setTimeout(resolve, 100));

          // Determine the grid-aligned step toward the target (rounded to nearest axis/diagonal)
          const pos = bot.entity.position;
          const tdx = x - pos.x, tdz = z - pos.z;
          const dist = Math.sqrt(tdx * tdx + tdz * tdz);
          const stepDx = dist > 0.1 ? Math.round(tdx / dist) : 0;
          const stepDz = dist > 0.1 ? Math.round(tdz / dist) : 0;
          const fp = pos.floored();

          const feetBlock = bot.blockAt(fp.offset(stepDx, 0, stepDz))?.name ?? 'air';
          const headBlock = bot.blockAt(fp.offset(stepDx, 1, stepDz))?.name ?? 'air';
          const aboveHead = bot.blockAt(fp.offset(0, 2, stepDz === 0 ? 0 : stepDz))?.name ?? 'air';
          const floorAhead = bot.blockAt(fp.offset(stepDx, -1, stepDz))?.name ?? 'air';

          // Face level toward the target (pitch=0 so 'forward' goes straight)
          const yaw = Math.atan2(-tdx, -tdz);
          await bot.look(yaw, 0, true);
          await new Promise<void>(resolve => setTimeout(resolve, 80));

          const isDropAhead = feetBlock === 'air' && floorAhead === 'air';
          const isStepUp    = feetBlock !== 'air' && headBlock === 'air' && aboveHead === 'air';
          const isWallOrOverhang = (feetBlock !== 'air' && headBlock !== 'air') ||
                                   (feetBlock === 'air' && headBlock !== 'air');

          if (isWallOrOverhang) {
            // Can't jump through a wall or overhang — let pathfinder re-plan around it
          } else if (isDropAhead || feetBlock === 'air') {
            // Path is clear ahead or there's a drop — just push forward and let gravity do it
            bot.setControlState('forward', true);
            await new Promise<void>(resolve => setTimeout(resolve, 600));
            bot.setControlState('forward', false);
          } else if (isStepUp) {
            // 1-block step: jump with delayed forward so bot clears the block top first
            bot.setControlState('jump', true);

            await new Promise<void>(resolve => {
              const t = setTimeout(resolve, 400);
              const check = () => { if (!bot.entity.onGround) { clearTimeout(t); resolve(); } else bot.once('move', check); };
              bot.once('move', check);
            });

            await new Promise<void>(resolve => setTimeout(resolve, 150));
            bot.setControlState('forward', true);

            await new Promise<void>(resolve => {
              if (bot.entity.onGround) { resolve(); return; }
              const t = setTimeout(resolve, 2000);
              const check = () => {
                if (bot.entity.onGround) { clearTimeout(t); resolve(); }
                else bot.once('move', check);
              };
              bot.once('move', check);
            });

            bot.setControlState('jump', false);
            bot.setControlState('forward', false);
          }
        }
      }

      // Timed out — collect obstacle info for the error message
      timedOut = true;
      const p = bot.entity.position;
      const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
      const below = bot.blockAt(p.offset(0, -1, 0))?.name ?? 'unknown';
      const dirs = [
        { name: 'north', dx: 0, dz: -1 }, { name: 'south', dx: 0, dz: 1 },
        { name: 'east',  dx: 1, dz:  0 }, { name: 'west',  dx: -1, dz: 0 },
      ];
      const obstacleLines = dirs.map(d => {
        const feet = bot.blockAt(p.offset(d.dx, 0, d.dz))?.name ?? 'air';
        const head = bot.blockAt(p.offset(d.dx, 1, d.dz))?.name ?? 'air';
        const floor = bot.blockAt(p.offset(d.dx, -1, d.dz))?.name ?? 'air';
        const feetCoord = `(${px+d.dx},${py},${pz+d.dz})`;
        const headCoord = `(${px+d.dx},${py+1},${pz+d.dz})`;
        let action = '';
        if (feet !== 'air' && head === 'air') action = ` → 1-block ledge: face-toward-xyz(${px+d.dx},${pz+d.dz}) then jump(forward)`;
        else if (feet !== 'air' && head !== 'air') action = ` → 2-block wall: dig-block${headCoord} first, then face-toward-xyz(${px+d.dx},${pz+d.dz}) and jump(forward)`;
        else if (feet === 'air' && floor === 'air') action = ' → drop ahead';
        void floor;
        return `  ${d.name}: feet${feetCoord}=${feet} head${headCoord}=${head}${action}`;
      }).join('\n');

      throw new Error(
        `Move timed out after ${timeoutMs}ms. Bot stopped at (${px}, ${py}, ${pz}) (block below: ${below}). Target was (${x}, ${y}, ${z}).\n` +
        `Adjacent obstacles:\n${obstacleLines}\n` +
        `Next steps: call scan-surroundings for full 8-direction view, then follow the action hint above for the direction toward your target.`
      );

    }
  );

  factory.registerTool(
    "descend-to-ground",
    "Move the bot down to a target Y level (or nearest ground if unspecified). Bypasses the pathfinder entirely — first tries walking in each cardinal direction to find a natural drop, then digs straight down through whatever is below. Use this whenever move-to-position fails because the direct downward path is blocked (e.g. stuck on a tree canopy).",
    {
      targetY: z.coerce.number().int().optional().describe("Y level to descend to. Defaults to the first non-leaf solid ground found below the bot."),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds (default: 30000)"),
    },
    async ({ targetY, timeoutMs = 30000 }: { targetY?: number; timeoutMs?: number }) => {
      const bot = getBot();
      bot.pathfinder.stop();

      const startPos = bot.entity.position.floored();

      // Auto-detect ground Y: scan down for first solid non-leaf block
      let resolvedY = targetY;
      if (resolvedY === undefined) {
        for (let dy = 1; dy <= 64; dy++) {
          const b = bot.blockAt(new Vec3(startPos.x, startPos.y - dy, startPos.z));
          if (b && b.boundingBox === 'block' && !b.name.includes('leaves')) {
            resolvedY = startPos.y - dy + 1;
            break;
          }
        }
        if (resolvedY === undefined) {
          return factory.createResponse('No solid ground found within 64 blocks below — cannot descend.');
        }
      }

      if (resolvedY >= startPos.y) {
        return factory.createResponse(`Already at or below target Y=${resolvedY} (current Y=${startPos.y}).`);
      }

      const deadline = Date.now() + timeoutMs;

      // Waits until onGround or timeout
      const waitForLanding = (maxMs: number) => new Promise<void>(resolve => {
        if (bot.entity.onGround) { resolve(); return; }
        const t = setTimeout(resolve, maxMs);
        const check = () => {
          if (bot.entity.onGround) { clearTimeout(t); resolve(); }
          else bot.once('move', check);
        };
        bot.once('move', check);
      });

      // --- Phase 1: walk in each direction and check if Y drops ---
      const dirs = ['forward', 'back', 'left', 'right'] as const;
      for (const dir of dirs) {
        if (Date.now() >= deadline || bot.entity.position.y <= resolvedY + 0.5) break;
        const beforeY = bot.entity.position.y;
        let fell = false;

        await new Promise<void>(resolve => {
          bot.setControlState(dir, true);
          const poll = setInterval(() => {
            if (bot.entity.position.y < beforeY - 0.5) {
              fell = true;
              clearInterval(poll);
              clearTimeout(giveUp);
              bot.setControlState(dir, false);
              resolve();
            }
          }, 80);
          const giveUp = setTimeout(() => {
            clearInterval(poll);
            bot.setControlState(dir, false);
            resolve();
          }, Math.min(2500, deadline - Date.now()));
        });

        if (fell) {
          await waitForLanding(Math.min(3000, deadline - Date.now()));
        }
      }

      // --- Phase 2: dig straight down through remaining blocks ---
      while (bot.entity.position.y > resolvedY + 0.5 && Date.now() < deadline) {
        const pos = bot.entity.position.floored();
        const below = bot.blockAt(new Vec3(pos.x, pos.y - 1, pos.z));

        if (!below || below.name === 'air') {
          // Air below — falling or about to; just wait
          await new Promise(r => setTimeout(r, 150));
          continue;
        }

        if (below.boundingBox === 'block') {
          try {
            await bot.dig(below, true, 'raycast');
          } catch { /* already gone */ }
        }

        await waitForLanding(Math.min(1500, deadline - Date.now()));
      }

      const final = bot.entity.position.floored();
      return factory.createResponse(
        `Descended from Y=${startPos.y} to Y=${final.y}. Now at (${final.x}, ${final.y}, ${final.z}).`
      );
    }
  );

  factory.registerTool(
    "look-at",
    "Point the bot's view at a compass heading with optional vertical pitch. " +
    "Use face-toward (pitch stays 0) before movement; use look-at when you need to aim up or down. " +
    "heading: 0=north, 90=east, 180=south, 270=west. pitch: 0=level, 90=straight up, -90=straight down.",
    {
      heading: z.coerce.number().describe("Compass heading in degrees: 0=north, 90=east, 180=south, 270=west"),
      pitch: z.coerce.number().optional().describe("Vertical angle in degrees: 0=level, 90=up, -90=down (default: 0)"),
    },
    async ({ heading, pitch = 0 }: { heading: number; pitch?: number }) => {
      const bot = getBot();
      const yaw = -heading * (Math.PI / 180);
      const pitchRad = pitch * (Math.PI / 180);
      await bot.look(yaw, pitchRad, true);
      const compassDir = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((heading % 360) + 360) % 360 / 45) % 8];
      return factory.createResponse(`Looking ${compassDir} (${heading}°), pitch ${pitch}°`);
    }
  );

  factory.registerTool(
    "face-toward",
    "Rotate the bot to face a compass heading. Pitch is always 0° (level) so forward movement goes exactly straight — no diagonal drift. " +
    "Always call this before jump or move-in-direction. " +
    "heading: 0=north, 90=east, 180=south, 270=west.",
    {
      heading: z.coerce.number().describe("Compass heading in degrees: 0=north, 90=east, 180=south, 270=west"),
    },
    async ({ heading }: { heading: number }) => {
      const bot = getBot();
      const yaw = -heading * (Math.PI / 180);
      await bot.look(yaw, 0, true);
      const compassDir = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((heading % 360) + 360) % 360 / 45) % 8];
      return factory.createResponse(`Facing ${compassDir} (${heading}°)`);
    }
  );

  factory.registerTool(
    "look-at-xyz",
    "Point the bot's view at an exact XYZ position (computes yaw and pitch automatically). Use look-at for compass-based aiming; use this when you have a specific coordinate to look at.",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate (use target's feet y + 1 for eye level)"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z: tz }) => {
      ({ x, y, z: tz } = coerceCoordinates(x, y, tz));
      const bot = getBot();
      await bot.lookAt(new Vec3(x, y, tz), true);
      return factory.createResponse(`Looking at (${x}, ${y}, ${tz})`);
    }
  );

  factory.registerTool(
    "face-toward-xyz",
    "Rotate the bot to face an XYZ coordinate, pitch forced to 0° (level) so movement stays straight. Use face-toward for compass headings; use this when you have a target coordinate.",
    {
      x: z.coerce.number().describe("Target X coordinate"),
      z: z.coerce.number().describe("Target Z coordinate"),
    },
    async ({ x, z: tz }: { x: number; z: number }) => {
      const bot = getBot();
      const pos = bot.entity.position;
      const dx = x - pos.x;
      const dz = tz - pos.z;
      const yaw = Math.atan2(-dx, -dz);
      await bot.look(yaw, 0, true);
      const compassDeg = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
      const compassDir = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(compassDeg / 45) % 8];
      return factory.createResponse(`Facing toward (${x}, ${tz}) — ${compassDir} (${compassDeg.toFixed(1)}°)`);
    }
  );

  factory.registerTool(
    "jump",
    "Make the bot jump, optionally while moving in a direction. Call face-toward before this to set the heading — 'forward' moves in whatever direction the bot is currently facing.",
    {
      direction: z.enum(['forward', 'back', 'left', 'right']).optional().describe("Direction to move while jumping (omit for a straight-up jump)"),
      duration: z.number().int().min(50).optional().describe("How long to hold the movement key in milliseconds (default: 600). Ignored when no direction is given."),
    },
    async ({ direction, duration = 600 }: { direction?: Direction; duration?: number }) => {
      const bot = getBot();

      // Stop pathfinder. fullStop() inside calls clearControlStates(), so we must
      // wait one event-loop tick before setting our own control states or they get wiped.
      bot.pathfinder.stop();
      await new Promise<void>(resolve => setTimeout(resolve, 100));

      // Must be on ground to jump — wait up to 2s if airborne
      if (!bot.entity.onGround) {
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 2000);
          const check = () => { if (bot.entity.onGround) { clearTimeout(t); resolve(); } else bot.once('move', check); };
          bot.once('move', check);
        });
      }

      if (!bot.entity.onGround) {
        return factory.createResponse('Cannot jump: bot is not on the ground.');
      }

      // Wait for rotation to propagate to the server
      await new Promise<void>(resolve => setTimeout(resolve, 100));

      const startPos = bot.entity.position.clone();

      const waitForAirborne = (maxMs: number) => new Promise<boolean>(resolve => {
        if (!bot.entity.onGround) { resolve(true); return; }
        const t = setTimeout(() => resolve(false), maxMs);
        const check = () => {
          if (!bot.entity.onGround) { clearTimeout(t); resolve(true); }
          else bot.once('move', check);
        };
        bot.once('move', check);
      });

      bot.setControlState('jump', true);

      // Wait up to 400ms for airborne. If the jump doesn't register (can happen
      // on high-latency servers), cycle the key and try once more.
      let airborne = await waitForAirborne(400);
      if (!airborne) {
        bot.setControlState('jump', false);
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        bot.setControlState('jump', true);
        airborne = await waitForAirborne(600);
      }

      if (!airborne) {
        bot.setControlState('jump', false);
        return factory.createResponse(
          'Jump did not register — bot stayed on the ground. ' +
          'Ensure there is solid ground beneath the bot (call scan-surroundings) and try again.'
        );
      }

      if (direction) {
        // Delay forward movement until the bot has risen above a 1-block step.
        // Setting direction immediately causes horizontal velocity to be zeroed
        // each tick by the block face collision while the bot is still below the
        // block's top. After ~150ms (3 physics ticks) the bot clears a 1-block
        // step and horizontal movement can push through unobstructed.
        await new Promise<void>(resolve => setTimeout(resolve, 150));
        bot.setControlState(direction, true);
      }

      // Wait for landing, releasing jump the moment the bot touches down.
      // jump=true while onGround causes an immediate re-jump on the next physics tick.
      await new Promise<void>(resolve => {
        if (bot.entity.onGround) { resolve(); return; }
        const t = setTimeout(resolve, duration + 1500);
        const check = () => {
          if (bot.entity.onGround) { clearTimeout(t); resolve(); }
          else bot.once('move', check);
        };
        bot.once('move', check);
      });

      bot.setControlState('jump', false);
      if (direction) bot.setControlState(direction, false);

      const endPos = bot.entity.position;
      const moved = startPos.distanceTo(endPos);
      const fp = endPos.floored();

      // If a directional jump made no progress, identify what's blocking
      if (direction && moved < 0.2) {
        const yaw = bot.entity.yaw;
        const dx = Math.round(-Math.sin(yaw));
        const dz = Math.round(-Math.cos(yaw));
        const feetBlock = bot.blockAt(fp.offset(dx, 0, dz))?.name ?? 'unknown';
        const headBlock = bot.blockAt(fp.offset(dx, 1, dz))?.name ?? 'unknown';
        const feetCoord = `(${fp.x+dx},${fp.y},${fp.z+dz})`;
        const headCoord = `(${fp.x+dx},${fp.y+1},${fp.z+dz})`;
        let wallMsg: string;
        if (feetBlock !== 'air' && headBlock === 'air') {
          // 1-block step — bot should be able to jump onto it
          wallMsg = `1-block step ahead — feet${feetCoord}: ${feetBlock}, head${headCoord}: air. ` +
            `Move right up to the block then jump: move-in-direction(forward, 200ms) then jump(forward).`;
        } else if (feetBlock !== 'air' && headBlock !== 'air') {
          // 2-block wall — needs digging
          wallMsg = `2-block wall ahead — feet${feetCoord}: ${feetBlock}, head${headCoord}: ${headBlock}. ` +
            `Dig head block first: dig-block(blocks=[{x:${fp.x+dx},y:${fp.y+1},z:${fp.z+dz}}]) then jump(forward).`;
        } else if (feetBlock === 'air' && headBlock !== 'air') {
          wallMsg = `Overhang ahead — head${headCoord}: ${headBlock}. Dig: dig-block(blocks=[{x:${fp.x+dx},y:${fp.y+1},z:${fp.z+dz}}]).`;
        } else {
          wallMsg = `No wall detected ahead — check scan-surroundings for obstacles.`;
        }
        return factory.createResponse(
          `Jumped ${direction}. Moved ${moved.toFixed(1)} blocks — blocked. ` +
          `Now at (${fp.x}, ${fp.y}, ${fp.z}).\n${wallMsg}`
        );
      }

      const result = direction
        ? `Jumped ${direction}. Moved ${moved.toFixed(1)} blocks. Now at (${fp.x}, ${fp.y}, ${fp.z}).`
        : `Jumped straight up. Now at (${fp.x}, ${fp.y}, ${fp.z}).`;

      return factory.createResponse(result);
    }
  );

  factory.registerTool(
    "move-in-direction",
    "Move the bot in a direction for a duration. Call face-toward first to set the heading — 'forward' moves in whatever direction the bot is currently facing.",
    {
      direction: z.enum(['forward', 'back', 'left', 'right']).describe("Direction to move"),
      duration: z.number().optional().describe("Duration in milliseconds (default: 1000)"),
    },
    async ({ direction, duration = 1000 }: { direction: Direction; duration?: number }) => {
      const bot = getBot();

      // Stop pathfinder. fullStop() inside calls clearControlStates(), so wait
      // for that to settle before setting our own rotation and control states.
      bot.pathfinder.stop();
      await new Promise<void>(resolve => setTimeout(resolve, 100));

      bot.clearControlStates();
      const startPos = bot.entity.position.clone();

      await new Promise<void>(resolve => {
        bot.setControlState(direction, true);
        setTimeout(() => {
          bot.setControlState(direction, false);
          resolve();
        }, duration);
      });

      const endPos = bot.entity.position;
      const moved = startPos.distanceTo(endPos);
      return factory.createResponse(
        `Moved ${direction} for ${duration}ms. Travelled ${moved.toFixed(1)} blocks. Now at (${Math.floor(endPos.x)}, ${Math.floor(endPos.y)}, ${Math.floor(endPos.z)}).`
      );
    }
  );
}
