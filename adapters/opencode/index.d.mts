export interface OpenCodeConfig {
  mcp?: Record<string, unknown>;
  skills?: { paths?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}
export default function RimewirePlugin(context: {
  directory: string;
  client?: {
    app?: {
      log?: (
        input: unknown,
        options?: { signal: AbortSignal },
      ) => Promise<unknown>;
    };
  };
}): Promise<{
  config(config: OpenCodeConfig): Promise<void>;
  event(input: {
    event: { type: string; [key: string]: unknown };
  }): Promise<void>;
  dispose(): Promise<void>;
}>;
