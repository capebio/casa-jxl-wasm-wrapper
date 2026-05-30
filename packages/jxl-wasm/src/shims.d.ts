declare module "node:fs/promises" {
  export function readFile(path: string | URL): Promise<Uint8Array>;
  export function writeFile(path: string | URL, data: string | Uint8Array): Promise<void>;
  export function mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function access(path: string | URL, mode?: number): Promise<void>;
  export function stat(path: string | URL): Promise<{ size: number }>;
  export function readdir(path: string | URL): Promise<string[]>;
  export function rm(path: string | URL, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
