/** `@/*` is a path of this fixture's tsconfig, which the package's own type check does not read. */
declare module '@/limits.ts' {
  export const MIN: bigint;
}
