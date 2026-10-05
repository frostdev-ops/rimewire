export function installedPaths(root?: string): {
  plugin: string;
  cli: string;
  skills: string;
};
export function checkedPaths(root?: string): ReturnType<typeof installedPaths>;
export function nodeExecutable(): string;
