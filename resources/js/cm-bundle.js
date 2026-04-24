/**
 * CodeMirror 6 bundle for notebook2.
 *
 * Bundles CM6 core + XQuery language support (via legacy mode) + markdown +
 * XML + JSON + HTML for output highlighting.
 * Exported as ES module imports consumed by notebook.js.
 */

// --- State ---
export {
    EditorState,
    Compartment,
    StateField,
    StateEffect
} from "@codemirror/state";

// --- View ---
export {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
    highlightSpecialChars,
    placeholder
} from "@codemirror/view";

// --- Language ---
export {
    syntaxHighlighting,
    HighlightStyle,
    indentOnInput,
    bracketMatching,
    defaultHighlightStyle,
    indentUnit,
    StreamLanguage,
    foldGutter,
    foldKeymap
} from "@codemirror/language";

// --- Commands ---
export {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    toggleComment
} from "@codemirror/commands";

// --- Search ---
export {
    searchKeymap,
    highlightSelectionMatches
} from "@codemirror/search";

// --- Autocomplete ---
export {
    autocompletion,
    completionKeymap,
    closeBrackets,
    closeBracketsKeymap
} from "@codemirror/autocomplete";

// --- Lint ---
export {
    linter,
    lintGutter,
    setDiagnostics
} from "@codemirror/lint";

// --- Legacy XQuery mode ---
import { StreamLanguage } from "@codemirror/language";
import { xQuery } from "@codemirror/legacy-modes/mode/xquery";
export const xqueryLanguage = StreamLanguage.define(xQuery);

// --- Language packs ---
export { xml } from "@codemirror/lang-xml";
export { json } from "@codemirror/lang-json";
export { html } from "@codemirror/lang-html";
export { markdown } from "@codemirror/lang-markdown";

// --- Theme ---
export { oneDark } from "@codemirror/theme-one-dark";

// --- Lezer highlight (for output highlighting) ---
export { tags, classHighlighter, highlightTree } from "@lezer/highlight";
