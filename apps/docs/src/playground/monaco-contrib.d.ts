/**
 * monaco-editor 0.56 ships no .d.ts for the TypeScript contribution subpath
 * (the old `monaco.languages.typescript` namespace is gone in the new layout —
 * the language service API is exported from the module directly). Minimal
 * honest typings for what the playground uses.
 */
declare module 'monaco-editor/language/typescript/monaco.contribution.js' {
  import type { Uri } from 'monaco-editor';

  export const ScriptTarget: Record<string, number>;
  export const ModuleKind: Record<string, number>;
  export const ModuleResolutionKind: Record<string, number>;

  export const typescriptDefaults: {
    setCompilerOptions(options: Record<string, unknown>): void;
    setEagerModelSync(value: boolean): void;
    addExtraLib(content: string, filePath?: string): { dispose(): void };
  };

  export interface TsDiagnosticMessageChain {
    messageText: string | TsDiagnosticMessageChain;
  }
  export interface TsDiagnostic {
    start?: number | undefined;
    messageText: string | TsDiagnosticMessageChain;
  }
  export interface TsWorkerClient {
    getSyntacticDiagnostics(uri: string): Promise<TsDiagnostic[]>;
    getSemanticDiagnostics(uri: string): Promise<TsDiagnostic[]>;
    getEmitOutput(uri: string): Promise<{ outputFiles: { text: string }[] }>;
  }

  export function getTypeScriptWorker(): Promise<(...uris: Uri[]) => Promise<TsWorkerClient>>;
}
