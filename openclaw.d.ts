declare module "openclaw/plugin-sdk/plugin-entry" {
  interface PluginToolDef {
    name: string;
    description: string;
    parameters: unknown;
    execute: (...args: any[]) => Promise<any>;
  }

  interface PluginApi {
    pluginConfig: Record<string, unknown>;
    logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug: (msg: string) => void;
    };
    registerTool: (tool: PluginToolDef) => void;
  }

  interface PluginEntryOptions {
    id: string;
    name: string;
    description: string;
    kind?: string;
    configSchema?: unknown;
    register: (api: PluginApi) => void;
  }

  export function definePluginEntry(options: PluginEntryOptions): unknown;
}
