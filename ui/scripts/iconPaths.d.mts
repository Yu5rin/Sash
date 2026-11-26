// iconPaths.mjs の型（テストから使うため）。
export function num(v: number | string): string;
export function minify(d: string): string;
export function tokens(d: string): string[];
export function tidy(d: string, where: string): string;
export function absoluteStart(d: string, where: string): string;
export function elementToPath(tag: string, a: Record<string, string | number>, where: string): string;
export function packPaths(list: string[]): string;
