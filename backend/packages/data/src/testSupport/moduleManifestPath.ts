export function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}
