import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import { BotConnection } from './bot-connection.js';
import { log } from './logger.js';

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpResponse = {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
};

export class ToolFactory {
  constructor(
    private server: McpServer,
    private connection: BotConnection,
    private screenshotFn?: () => Promise<string | null>
  ) {}

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: (args: any) => Promise<McpResponse>
  ): void {
    // take-screenshot manages its own image output — don't wrap it
    const wrapScreenshots = name !== 'take-screenshot' && !!this.screenshotFn;

    this.server.tool(name, description, schema, async (args: unknown): Promise<McpResponse> => {
      const connectionCheck = await this.connection.checkConnectionAndReconnect();

      if (!connectionCheck.connected) {
        return {
          content: [{ type: "text", text: connectionCheck.message! }],
          isError: true
        };
      }

      const argsPreview = this.previewArgs(args);
      log('info', `tool:${name} called ${argsPreview}`);
      const start = Date.now();

      try {
        const parsedArgs = this.shouldValidateSchema(schema)
          ? this.parseArgs(schema as ZodRawShape, args)
          : args;

        const before = wrapScreenshots ? await this.screenshotFn!() : null;
        const result = await executor(parsedArgs);
        const after = wrapScreenshots ? await this.screenshotFn!() : null;

        if (before) {
          result.content.push({ type: "text", text: "Before:" });
          result.content.push({ type: "image", data: before, mimeType: "image/png" });
        }
        if (after) {
          result.content.push({ type: "text", text: "After:" });
          result.content.push({ type: "image", data: after, mimeType: "image/png" });
        }

        const ms = Date.now() - start;
        const status = result.isError ? 'error' : 'ok';
        const first = result.content[0];
        const resultPreview = this.previewResult(first?.type === 'text' ? first.text : first?.type === 'image' ? '[image]' : undefined);
        log('info', `tool:${name} ${status} (${ms}ms) → ${resultPreview}`);
        return result;
      } catch (error) {
        const ms = Date.now() - start;
        log('error', `tool:${name} threw after ${ms}ms: ${(error as Error).message}`);
        return this.createErrorResponse(error as Error);
      }
    });
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = error instanceof Error ? error.message : error;
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true
    };
  }

  private previewArgs(args: unknown): string {
    if (!args || (typeof args === 'object' && Object.keys(args as object).length === 0)) {
      return '(no args)';
    }
    try {
      const s = JSON.stringify(args);
      return s.length > 120 ? s.slice(0, 120) + '…' : s;
    } catch {
      return '(unserializable args)';
    }
  }

  private previewResult(text: string | undefined): string {
    if (!text) return '(empty)';
    const oneline = text.replace(/\n/g, ' ');
    return oneline.length > 120 ? oneline.slice(0, 120) + '…' : oneline;
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}
