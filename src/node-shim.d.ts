// The worker runs in Node, but this plugin has no package.json to install @types/node from.
// Declares only what src/worker.ts uses.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { timeout?: number; maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): unknown
}

declare const process: { env: Record<string, string | undefined> }
