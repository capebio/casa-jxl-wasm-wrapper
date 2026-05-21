declare const process:
  | {
      platform: string;
      arch: string;
      env: Record<string, string | undefined>;
      versions?: {
        node?: string;
      };
    }
  | undefined;

interface ImportMeta {
  url: string;
}

declare module "node:module" {
  export function createRequire(url: string): any;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare module "node:fs" {
  export function accessSync(path: string): void;
}
