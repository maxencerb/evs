/**
 * Playground island. Boots Monaco with the real @maxencerb/evs + abitype
 * declarations (and the generated viem shim), wires the toolbar, and renders
 * run results — including the bytecode seam between editor and output.
 */

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
// Side effect: registers the TypeScript language service (the main entry only
// registers syntax highlighting); also the only home of its API in monaco 0.56.
import {
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  typescriptDefaults,
} from 'monaco-editor/language/typescript/monaco.contribution.js';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

import payload from '../generated/playground-dts.json';
import { examples } from './examples.ts';
import { runScript, type RunOutcome } from './run.ts';

import './playground.css';

const DEFAULT_RPC = 'https://ethereum-rpc.publicnode.com';
const RPC_STORAGE_KEY = 'evs-playground-rpc';
const CODE_STORAGE_KEY = 'evs-playground-code';

// ---------------------------------------------------------------------------
// Theme — follow the docs site's Starlight toggle, falling back to the OS.
// ---------------------------------------------------------------------------

function resolveTheme(): 'dark' | 'light' {
  const stored = localStorage.getItem('starlight-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const shared = {
  fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
};

monaco.editor.defineTheme('evs-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6e6a65', fontStyle: 'italic' },
    { token: 'keyword', foreground: '6fb0e8' },
    { token: 'string', foreground: '7fc8a9' },
    { token: 'number', foreground: 'e0a458' },
    { token: 'type', foreground: 'c9a8e0' },
    { token: 'identifier', foreground: 'e7e3df' },
  ],
  colors: {
    'editor.background': '#1B1A19',
    'editor.foreground': '#E7E3DF',
    'editorLineNumber.foreground': '#565350',
    'editorLineNumber.activeForeground': '#A29D97',
    'editor.lineHighlightBackground': '#1B1A19',
    'editorWidget.background': '#232220',
    'editorWidget.border': '#34322F',
    'editorSuggestWidget.background': '#232220',
    'editorHoverWidget.background': '#232220',
    'editorCursor.foreground': '#3FC08D',
    'editor.selectionBackground': '#2E7D6244',
  },
});

monaco.editor.defineTheme('evs-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8a857e', fontStyle: 'italic' },
    { token: 'keyword', foreground: '2b6cb0' },
    { token: 'string', foreground: '1f8a64' },
    { token: 'number', foreground: 'a3641c' },
    { token: 'type', foreground: '7c4d99' },
  ],
  colors: {
    'editor.background': '#F2F1EF',
    'editor.foreground': '#33302C',
    'editorLineNumber.foreground': '#B4B0AA',
    'editor.lineHighlightBackground': '#F2F1EF',
    'editorCursor.foreground': '#1F8A64',
    'editor.selectionBackground': '#1F8A6422',
  },
});

// ---------------------------------------------------------------------------
// Monaco boot
// ---------------------------------------------------------------------------

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker();
  },
};

// Mirrors tsconfig.base.json — evs's overload inference relies on
// exactOptionalPropertyTypes (kept in sync with check-playground-examples.ts).
typescriptDefaults.setCompilerOptions({
  target: ScriptTarget.ES2020,
  module: ModuleKind.ESNext,
  moduleResolution: ModuleResolutionKind.NodeJs,
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  allowNonTsExtensions: true,
});
typescriptDefaults.setEagerModelSync(true);
for (const [uri, content] of Object.entries(payload.files as Record<string, string>)) {
  typescriptDefaults.addExtraLib(content, uri);
}

const editorHost = document.getElementById('editor');
if (!editorHost) throw new Error('playground: #editor missing');

const model = monaco.editor.createModel(
  localStorage.getItem(CODE_STORAGE_KEY) ?? examples[0]?.code ?? '',
  'typescript',
  monaco.Uri.parse('file:///main.ts'),
);

const editor = monaco.editor.create(editorHost, {
  model,
  theme: resolveTheme() === 'dark' ? 'evs-dark' : 'evs-light',
  fontFamily: shared.fontFamily,
  fontSize: 13,
  lineHeight: 22,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'none',
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  padding: { top: 20, bottom: 20 },
  automaticLayout: true,
  tabSize: 2,
  // Completions inside string literals — where functionName/address live.
  quickSuggestions: { other: true, comments: false, strings: true },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
});

// ---------------------------------------------------------------------------
// Toolbar: example tabs, RPC field, run button
// ---------------------------------------------------------------------------

const tabsHost = document.getElementById('tabs');
const rpcInput = document.getElementById('rpc') as HTMLInputElement | null;
const runButton = document.getElementById('run') as HTMLButtonElement | null;
const statusHost = document.getElementById('status');
const consoleHost = document.getElementById('console');
const seamHex = document.getElementById('seam-hex');
const seamBytes = document.getElementById('seam-bytes');
if (!tabsHost || !rpcInput || !runButton || !statusHost || !consoleHost || !seamHex || !seamBytes) {
  throw new Error('playground: markup out of sync with main.ts');
}

let activeExample: string | null = null;

function markActiveTab() {
  for (const button of tabsHost!.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.example === activeExample));
  }
}

for (const example of examples) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = example.label;
  button.dataset.example = example.id;
  button.addEventListener('click', () => {
    activeExample = example.id;
    model.setValue(example.code);
    markActiveTab();
    editor.focus();
  });
  tabsHost.appendChild(button);
}

const savedCode = localStorage.getItem(CODE_STORAGE_KEY);
activeExample = savedCode === null ? (examples[0]?.id ?? null) : null;
for (const example of examples) {
  if (savedCode === example.code) activeExample = example.id;
}
markActiveTab();

model.onDidChangeContent(() => {
  localStorage.setItem(CODE_STORAGE_KEY, model.getValue());
  const matching = examples.find((example) => example.code === model.getValue());
  const next = matching?.id ?? null;
  if (next !== activeExample) {
    activeExample = next;
    markActiveTab();
  }
});

rpcInput.placeholder = DEFAULT_RPC;
rpcInput.value = localStorage.getItem(RPC_STORAGE_KEY) ?? '';
rpcInput.addEventListener('change', () => {
  localStorage.setItem(RPC_STORAGE_KEY, rpcInput.value.trim());
});

// ---------------------------------------------------------------------------
// Run + render
// ---------------------------------------------------------------------------

function setStatus(kind: 'idle' | 'running' | 'ok' | 'error', text: string) {
  statusHost!.dataset.kind = kind;
  statusHost!.textContent = text;
}

function line(className: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function render(outcome: RunOutcome) {
  consoleHost!.replaceChildren();

  if (outcome.diagnostics) {
    setStatus('error', `${outcome.diagnostics.length} type error(s)`);
    for (const diagnostic of outcome.diagnostics) {
      consoleHost!.appendChild(line('pg-line pg-line-error', diagnostic));
    }
    return;
  }

  for (const entry of outcome.logs) {
    consoleHost!.appendChild(line(`pg-line pg-line-${entry.level}`, entry.text));
  }
  if (outcome.error) {
    consoleHost!.appendChild(line('pg-line pg-line-error', outcome.error));
    setStatus('error', 'failed');
  } else {
    const script = outcome.compiled[0];
    const compiledPart = script ? `${script.bytes} B of bytecode` : 'ran';
    const rpcPart =
      outcome.rpc.requests > 0
        ? `${outcome.rpc.requests} rpc request${outcome.rpc.requests === 1 ? '' : 's'}`
        : 'no rpc requests';
    setStatus('ok', `${compiledPart} · ${rpcPart} · ${Math.round(outcome.totalMs)} ms`);
    if (outcome.logs.length === 0) {
      consoleHost!.appendChild(
        line(
          'pg-line pg-line-dim',
          'Finished with no console output — log something to see it here.',
        ),
      );
    }
  }

  const script = outcome.compiled[0];
  if (script) {
    seamBytes!.textContent = `${script.bytes} B`;
    seamHex!.textContent = script.runtimeBytecode.slice(2);
  }
}

let running = false;

async function run() {
  if (running) return;
  running = true;
  runButton!.disabled = true;
  setStatus('running', 'compiling…');
  try {
    const rpcUrl = rpcInput!.value.trim() || DEFAULT_RPC;
    const outcome = await runScript(model, rpcUrl);
    render(outcome);
  } catch (thrown) {
    setStatus('error', thrown instanceof Error ? thrown.message : String(thrown));
  } finally {
    running = false;
    runButton!.disabled = false;
  }
}

runButton.addEventListener('click', () => void run());
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run());

setStatus('idle', 'Run compiles in your browser and fires one eth_call at the RPC above.');
