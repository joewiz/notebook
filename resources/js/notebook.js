/**
 * notebook.js — Main notebook editor controller.
 *
 * Renders a Jupyter-like notebook interface from .ipynb JSON data.
 * Handles cell CRUD, execution with chaining, markdown rendering,
 * and document save/load.
 */

import {
    EditorState, EditorView, Compartment,
    keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
    drawSelection, highlightSpecialChars, placeholder,
    syntaxHighlighting, defaultHighlightStyle, indentOnInput,
    bracketMatching, indentUnit, foldGutter, foldKeymap,
    StreamLanguage, xqueryLanguage,
    defaultKeymap, history, historyKeymap, indentWithTab, toggleComment,
    searchKeymap, highlightSelectionMatches,
    autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
    linter, lintGutter, setDiagnostics,
    xml, json, html, markdown,
    tags, classHighlighter, highlightTree
} from "./cm-bundle.js";

// ---------------------------------------------------------------------------
// xqdoc directive helpers — parse and update @name, @data, @silent, @output
// in xqdoc comment blocks at the top of cell source.
//
// These directives provide round-trip compatibility between the Notebook web
// app and VS Code Jupyter kernel. The toolbar GUI reads from and writes to
// the xqdoc block, so users see the same directives in both environments.
// ---------------------------------------------------------------------------

const XQDOC_RE = /^(\s*)\(:~([\s\S]*?):\)/;

/**
 * Parse xqdoc directives from cell source.
 * @param {string} code - cell source
 * @returns {{ name, dataFormat, silent, output }} all nullable
 */
function parseXqdocDirectives(code) {
    const match = code.match(XQDOC_RE);
    if (!match) return { name: null, dataFormat: null, silent: false, output: null };

    const body = match[2];
    let name = null, dataFormat = null, silent = false, output = null;

    for (const line of body.split("\n")) {
        const stripped = line.trim().replace(/^[*:]\s?/, "");
        const nameM = stripped.match(/^@name\s+([a-zA-Z_][a-zA-Z0-9_-]*)/);
        if (nameM) { name = nameM[1]; continue; }
        const dataM = stripped.match(/^@data\s+(xml|json|text)\b/i);
        if (dataM) { dataFormat = dataM[1].toLowerCase(); continue; }
        if (/^@silent\b/.test(stripped)) { silent = true; continue; }
        const outputM = stripped.match(/^@output\s+(.*)/);
        if (outputM) {
            output = {};
            const pairRe = /([a-zA-Z][a-zA-Z0-9_-]*)=(\S+)/g;
            let m;
            while ((m = pairRe.exec(outputM[1])) !== null) {
                output[m[1]] = m[2];
            }
        }
    }
    return { name, dataFormat, silent, output };
}

/**
 * Extract prose lines (non-directive, non-empty) from an xqdoc body.
 */
function extractXqdocProse(body) {
    const prose = [];
    for (const line of body.split("\n")) {
        const stripped = line.trim().replace(/^[*:]\s?/, "");
        // Skip directive lines and blank lines
        if (/^@(name|data|silent|output|author|version|param|return|see|since|deprecated)\b/.test(stripped)) continue;
        if (stripped === "") continue;
        prose.push(stripped);
    }
    return prose;
}

/**
 * Build an xqdoc comment block from directives, preserving prose lines.
 * Returns null if all directives and prose are empty.
 */
function buildXqdocBlock(directives, prose) {
    const directiveLines = [];
    if (directives.name) directiveLines.push(` : @name ${directives.name}`);
    if (directives.dataFormat) directiveLines.push(` : @data ${directives.dataFormat}`);
    if (directives.silent) directiveLines.push(` : @silent`);
    if (directives.output && Object.keys(directives.output).length > 0) {
        const pairs = Object.entries(directives.output).map(([k, v]) => `${k}=${v}`).join(" ");
        directiveLines.push(` : @output ${pairs}`);
    }

    if (directiveLines.length === 0 && (!prose || prose.length === 0)) return null;

    const lines = [];
    if (prose && prose.length > 0) {
        for (const p of prose) lines.push(` : ${p}`);
        if (directiveLines.length > 0) lines.push(` :`);
    }
    lines.push(...directiveLines);

    return "(:~\n" + lines.join("\n") + "\n :)";
}

/**
 * Update or insert an xqdoc block at the top of cell source.
 * Preserves prose lines from any existing block.
 * @param {string} code - current cell source
 * @param {object} directives - { name, dataFormat, silent, output }
 * @returns {string} updated source
 */
function updateXqdocInSource(code, directives) {
    const existing = code.match(XQDOC_RE);
    const prose = existing ? extractXqdocProse(existing[2]) : [];
    const newBlock = buildXqdocBlock(directives, prose);

    if (existing) {
        if (newBlock) {
            return code.replace(XQDOC_RE, newBlock);
        } else {
            return code.replace(/^\s*\(:~[\s\S]*?:\)\s*\n?/, "");
        }
    } else {
        if (newBlock) {
            return newBlock + "\n" + code;
        } else {
            return code;
        }
    }
}

// ---------------------------------------------------------------------------
// Markdown rendering (simple but functional)
// ---------------------------------------------------------------------------

/**
 * Convert markdown text to HTML.
 * Handles: headings, bold, italic, code, links, images, lists, blockquotes,
 * code blocks, tables, horizontal rules, paragraphs.
 */
function renderMarkdown(source) {
    const lines = source.split("\n");
    let html = "";
    let inCodeBlock = false;
    let codeContent = "";
    let codeLang = "";
    let inList = false;
    let listType = "";
    let inBlockquote = false;
    let inTable = false;
    let tableRows = [];

    function flushList() {
        if (inList) {
            html += `</${listType}>`;
            inList = false;
        }
    }

    function flushBlockquote() {
        if (inBlockquote) {
            html += "</blockquote>";
            inBlockquote = false;
        }
    }

    function flushTable() {
        if (inTable && tableRows.length > 0) {
            html += "<table>";
            tableRows.forEach((row, idx) => {
                const tag = idx === 0 ? "th" : "td";
                const wrapper = idx === 0 ? "thead" : (idx === 1 ? "tbody" : "");
                if (wrapper === "thead") html += "<thead>";
                if (wrapper === "tbody") html += "<tbody>";
                html += "<tr>";
                row.forEach(cell => {
                    html += `<${tag}>${inlineMarkdown(cell.trim())}</${tag}>`;
                });
                html += "</tr>";
                if (wrapper === "thead") html += "</thead>";
            });
            html += "</tbody></table>";
            inTable = false;
            tableRows = [];
        }
    }

    function inlineMarkdown(text) {
        return text
            // Images
            .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1"/>')
            // Links
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
            // Bold+italic
            .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
            // Bold
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            // Italic
            .replace(/\*(.+?)\*/g, "<em>$1</em>")
            // Inline code
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            // Em dash
            .replace(/---/g, "\u2014")
            // En dash
            .replace(/--/g, "\u2013");
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Code blocks
        if (line.startsWith("```")) {
            if (inCodeBlock) {
                html += `<pre><code class="language-${codeLang}">${escapeHtml(codeContent.trimEnd())}</code></pre>`;
                inCodeBlock = false;
                codeContent = "";
                codeLang = "";
            } else {
                flushList();
                flushBlockquote();
                flushTable();
                inCodeBlock = true;
                codeLang = line.slice(3).trim();
            }
            continue;
        }

        if (inCodeBlock) {
            codeContent += line + "\n";
            continue;
        }

        // Blank line
        if (line.trim() === "") {
            flushList();
            flushBlockquote();
            flushTable();
            continue;
        }

        // Table row
        if (line.includes("|") && line.trim().startsWith("|")) {
            const cells = line.split("|").slice(1, -1);
            // Skip separator rows
            if (cells.every(c => /^[\s:-]+$/.test(c))) continue;
            if (!inTable) {
                flushList();
                flushBlockquote();
                inTable = true;
                tableRows = [];
            }
            tableRows.push(cells);
            continue;
        } else {
            flushTable();
        }

        // Headings
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            flushList();
            flushBlockquote();
            const level = headingMatch[1].length;
            html += `<h${level}>${inlineMarkdown(headingMatch[2])}</h${level}>`;
            continue;
        }

        // Horizontal rule
        if (/^[-*_]{3,}\s*$/.test(line)) {
            flushList();
            flushBlockquote();
            html += "<hr/>";
            continue;
        }

        // Blockquote
        if (line.startsWith("> ")) {
            flushList();
            if (!inBlockquote) {
                inBlockquote = true;
                html += "<blockquote>";
            }
            html += `<p>${inlineMarkdown(line.slice(2))}</p>`;
            continue;
        } else {
            flushBlockquote();
        }

        // Unordered list
        if (/^[-*+]\s+/.test(line)) {
            flushBlockquote();
            if (!inList || listType !== "ul") {
                flushList();
                inList = true;
                listType = "ul";
                html += "<ul>";
            }
            html += `<li>${inlineMarkdown(line.replace(/^[-*+]\s+/, ""))}</li>`;
            continue;
        }

        // Ordered list
        if (/^\d+\.\s+/.test(line)) {
            flushBlockquote();
            if (!inList || listType !== "ol") {
                flushList();
                inList = true;
                listType = "ol";
                html += "<ol>";
            }
            html += `<li>${inlineMarkdown(line.replace(/^\d+\.\s+/, ""))}</li>`;
            continue;
        }

        // Paragraph
        flushList();
        flushBlockquote();
        html += `<p>${inlineMarkdown(line)}</p>`;
    }

    // Flush remaining state
    if (inCodeBlock) {
        html += `<pre><code>${escapeHtml(codeContent.trimEnd())}</code></pre>`;
    }
    flushList();
    flushBlockquote();
    flushTable();

    return html;
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Output syntax highlighting (using CM6 parsers)
// ---------------------------------------------------------------------------

/**
 * Highlight a result string using CM6's parser for syntax coloring.
 */
function highlightOutput(text, type) {
    if (!text || text.length > 100000) return escapeHtml(text || "");

    let lang;
    switch (type) {
        case "xml":
            lang = xml();
            break;
        case "json":
            lang = json();
            break;
        case "html":
            lang = html();
            break;
        default:
            return escapeHtml(text);
    }

    const tree = lang.language.parser.parse(text);
    let result = "";
    let pos = 0;

    highlightTree(tree, classHighlighter, (from, to, classes) => {
        if (from > pos) result += escapeHtml(text.slice(pos, from));
        result += `<span class="${classes}">${escapeHtml(text.slice(from, to))}</span>`;
        pos = to;
    });
    if (pos < text.length) result += escapeHtml(text.slice(pos));

    return result;
}

// ---------------------------------------------------------------------------
// CSV to HTML table
// ---------------------------------------------------------------------------

/**
 * Parse CSV text and render as a styled HTML table.
 * Handles RFC 4180 quoting (double-quote escaping).
 */
function csvToTable(text) {
    if (!text || !text.trim()) return "<em>Empty result</em>";

    const rows = parseCSV(text);
    if (rows.length === 0) return "<em>Empty result</em>";

    let html = '<table class="nb-csv-table">';
    // First row as header
    html += "<thead><tr>";
    for (const cell of rows[0]) {
        html += `<th>${escapeHtml(cell)}</th>`;
    }
    html += "</tr></thead><tbody>";
    for (let i = 1; i < rows.length; i++) {
        html += "<tr>";
        for (const cell of rows[i]) {
            html += `<td>${escapeHtml(cell)}</td>`;
        }
        html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
}

/**
 * Parse RFC 4180 CSV into an array of arrays.
 */
function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < text.length && text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                } else {
                    inQuotes = false;
                    i++;
                }
            } else {
                field += ch;
                i++;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
                i++;
            } else if (ch === ',') {
                row.push(field);
                field = "";
                i++;
            } else if (ch === '\n' || ch === '\r') {
                row.push(field);
                field = "";
                if (row.some(f => f !== "")) rows.push(row);
                row = [];
                if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
                i++;
            } else {
                field += ch;
                i++;
            }
        }
    }
    // Last field/row
    if (field || row.length > 0) {
        row.push(field);
        if (row.some(f => f !== "")) rows.push(row);
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Notebook controller
// ---------------------------------------------------------------------------

class NotebookEditor {
    constructor(container, notebookData, path) {
        this.container = container;
        this.path = path;
        this.notebook = notebookData;
        this.cells = [];
        this.selectedIndex = -1;
        this.modified = false;
        this.executionCount = 0;
        this.apiBase = this._resolveApiBase();
        // Session ID for cache — unique per page load, stable across cell runs
        this.sessionId = crypto.randomUUID();
        // Function hover tooltips
        this.hoverEnabled = localStorage.getItem("nb-hover-docs") !== "off";
        this._hoverTimeout = null;
        this._hoverTooltip = null;
        // Tracks whether any cell has been successfully run in this session
        this.sessionHasRun = false;
        // Undo stack for notebook-level operations (delete, move, type change)
        this.undoStack = [];
        this.maxUndoDepth = 50;

        this.render();
        this._bindGlobalKeys();
    }

    _resolveApiBase() {
        // Derive API base from current URL
        const pathParts = window.location.pathname.split("/apps/notebook");
        return pathParts[0] + "/apps/notebook/api";
    }

    /**
     * Generate the serialization controls HTML (dropdown + indent checkbox).
     * Used in both _renderCell and insertCell.
     */
    static serializationControls() {
        return `
            <select class="nb-ser-select" title="Output serialization">
                <option value="adaptive">Adaptive</option>
                <option value="xml">XML</option>
                <option value="json">JSON</option>
                <option value="text">Text</option>
                <option value="html">HTML</option>
                <option value="html-raw">HTML (raw)</option>
                <option value="xhtml">XHTML</option>
                <option value="xhtml-raw">XHTML (raw)</option>
                <option value="csv">CSV</option>
                <option value="csv-raw">CSV (raw)</option>
            </select>
            <label class="nb-indent-label" title="Indent output">
                <input type="checkbox" class="nb-indent-check"/> indent
            </label>
        `;
    }

    // --- Rendering ---

    render() {
        this.container.innerHTML = "";

        // Toolbar
        this.toolbar = this._createToolbar();
        this.container.appendChild(this.toolbar);

        // Layout: cells + TOC sidebar
        const layout = document.createElement("div");
        layout.className = "nb-layout";

        // Cells container
        this.cellsContainer = document.createElement("div");
        this.cellsContainer.className = "nb-cells";
        layout.appendChild(this.cellsContainer);

        // TOC sidebar
        this.tocSidebar = document.createElement("aside");
        this.tocSidebar.className = "nb-toc";
        this.tocSidebar.innerHTML = '<div class="nb-toc-header">Contents</div><ul class="nb-toc-list"></ul>';
        layout.appendChild(this.tocSidebar);

        this.container.appendChild(layout);

        // Render cells from notebook data
        const cells = this.notebook.cells;
        for (let i = 0; i < cells.length; i++) {
            this._renderCell(cells[i], i);
        }

        // Bottom insert point
        this._renderInsertPoint(this.cellsContainer, cells.length);

        // Select first cell
        if (this.cells.length > 0) {
            this.selectCell(0);
        }

        // Build TOC after cells are rendered
        this._buildToc();
    }

    _createToolbar() {
        const toolbar = document.createElement("div");
        toolbar.className = "nb-toolbar";

        toolbar.innerHTML = `
            <div class="nb-toolbar-group">
                <button class="nb-btn nb-btn-sm" data-action="save" title="Save (Ctrl+S)">&#128190; Save</button>
                <button class="nb-btn nb-btn-sm" data-action="download" title="Download .ipynb file">&#11015; Download</button>
                <button class="nb-btn nb-btn-sm" data-action="duplicate" title="Duplicate notebook">&#128203; Duplicate</button>
                <button class="nb-btn nb-btn-sm" data-action="history" title="Version history">&#128336; History</button>
                <button class="nb-btn nb-btn-sm" data-action="add-code" title="Add XQuery cell">&#10010; XQuery</button>
                <button class="nb-btn nb-btn-sm" data-action="add-data" title="Add Data cell (XML/JSON/text)">&#10010; Data</button>
                <button class="nb-btn nb-btn-sm" data-action="add-markdown" title="Add Markdown cell">&#10010; Markdown</button>
            </div>
            <div class="nb-toolbar-separator"></div>
            <div class="nb-toolbar-group">
                <button class="nb-btn nb-btn-sm" data-action="format-cell" title="Reformat selected cell">&#8621; Format</button>
                <button class="nb-btn nb-btn-sm" data-action="format-all" title="Reformat all source cells">Format All</button>
                <button class="nb-btn nb-btn-sm" data-action="run-cell" title="Run selected cell (Cmd/Ctrl+Enter)">&#9654; Run</button>
                <button class="nb-btn nb-btn-sm" data-action="run-all" title="Run all cells">Run All</button>
                <button class="nb-btn nb-btn-sm" data-action="run-above" title="Run all cells above">Run Above</button>
            </div>
            <div class="nb-toolbar-separator"></div>
            <div class="nb-toolbar-group">
                <button class="nb-btn nb-btn-sm" data-action="toggle-md-edit" title="Toggle Markdown edit/render">&#9998; Edit MD</button>
            </div>
            <div class="nb-toolbar-separator"></div>
            <div class="nb-toolbar-group">
                <button class="nb-btn nb-btn-sm nb-btn-icon" data-action="move-up" title="Move cell up">&#9650;</button>
                <button class="nb-btn nb-btn-sm nb-btn-icon" data-action="move-down" title="Move cell down">&#9660;</button>
                <button class="nb-btn nb-btn-sm nb-btn-danger" data-action="delete-cell" title="Delete cell">&#128465; Delete</button>
            </div>
            <div class="nb-toolbar-separator"></div>
            <div class="nb-toolbar-group">
                <button class="nb-btn nb-btn-sm" data-action="undo" title="Undo (Ctrl+Z outside editor)">&#8630; Undo</button>
            </div>
            <button class="nb-btn nb-btn-sm nb-hover-toggle ${this.hoverEnabled ? 'active' : ''}" data-action="toggle-hover" title="Toggle function hover docs">Hover Docs</button>
            <span class="nb-toolbar-title"></span>
            <span class="nb-toolbar-status"></span>
        `;

        toolbar.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;
            this._handleToolbarAction(btn.dataset.action);
        });

        return toolbar;
    }

    _handleToolbarAction(action) {
        switch (action) {
            case "save": this.save(); break;
            case "add-code": this.insertCell("code", this.selectedIndex + 1); break;
            case "add-data": this.insertCell("data", this.selectedIndex + 1); break;
            case "add-markdown": this.insertCell("markdown", this.selectedIndex + 1); break;
            case "format-cell": this.formatCell(this.selectedIndex); break;
            case "format-all": this.formatAllCells(); break;
            case "run-cell": this.runSelectedCell(); break;
            case "run-all": this.runAllCells(); break;
            case "run-above": this.runCellsAbove(); break;
            case "move-up": this.moveCellUp(this.selectedIndex); break;
            case "move-down": this.moveCellDown(this.selectedIndex); break;
            case "delete-cell": this.deleteCell(this.selectedIndex); break;
            case "undo": this.undo(); break;
            case "toggle-md-edit": this.toggleMarkdownEdit(); break;
            case "toggle-hover": this.toggleHoverDocs(); break;
            case "download": this.download(); break;
            case "duplicate": this.duplicate(); break;
            case "history": this.showHistory(); break;
        }
    }

    // --- Cell rendering ---

    _renderCell(cellData, index) {
        // Parse xqdoc directives from source to detect @data cells
        const cellSource = Array.isArray(cellData.source)
            ? cellData.source.join("")
            : (cellData.source || "");
        const xqdoc = cellData.cell_type === "code"
            ? parseXqdocDirectives(cellSource)
            : { name: null, dataFormat: null, silent: false, output: null };

        // A code cell with @data is treated as a data cell for UI purposes
        const isDataFromXqdoc = cellData.cell_type === "code" && xqdoc.dataFormat != null;
        // Legacy: raw + exist.kind === "data"
        const isLegacyData = cellData.cell_type === "raw" && cellData.metadata?.exist?.kind === "data";
        const isDataCell = isDataFromXqdoc || isLegacyData;

        const internalType = isLegacyData ? "data" : cellData.cell_type;
        const dataLanguage = isDataFromXqdoc
            ? xqdoc.dataFormat
            : (cellData.metadata?.exist?.dataLanguage || "xml");

        const cellEl = document.createElement("div");
        cellEl.className = `nb-cell nb-cell-${isDataCell ? "data" : internalType}`;
        cellEl.dataset.index = index;

        // Resolve name: xqdoc @name > metadata
        const cellName = xqdoc.name || cellData.metadata?.exist?.name || "";

        // Cell actions bar
        const actions = document.createElement("div");
        actions.className = "nb-cell-actions";
        const typeBadge = isDataCell ? "data"
            : internalType === "code" ? "xquery"
            : "markdown";
        actions.innerHTML = `
            <span class="nb-cell-type-badge">${typeBadge}</span>
            ${internalType === "code" && !isDataCell ? `
                <input class="nb-cell-name" type="text"
                    placeholder="name"
                    title="Cell name (\u2014 result becomes $name in subsequent cells)"
                    value="${cellName}"
                    spellcheck="false"/>
                ${NotebookEditor.serializationControls()}
                <button class="nb-btn-icon" data-action="run" title="Run cell (Cmd/Ctrl+Enter)">&#9654;</button>
            ` : ""}
            ${isDataCell ? `
                <input class="nb-cell-name" type="text"
                    placeholder="name (required)"
                    title="Cell name \u2014 data becomes $name in code cells"
                    value="${cellName}"
                    spellcheck="false"/>
                <select class="nb-data-lang" title="Data format">
                    <option value="xml" ${dataLanguage === "xml" ? "selected" : ""}>XML</option>
                    <option value="json" ${dataLanguage === "json" ? "selected" : ""}>JSON</option>
                    <option value="text" ${dataLanguage === "text" ? "selected" : ""}>Text</option>
                </select>
                <button class="nb-btn-icon" data-action="run" title="Run cell (load data)">&#9654;</button>
            ` : ""}
            <button class="nb-btn-icon" data-action="move-up" title="Move up">&#9650;</button>
            <button class="nb-btn-icon" data-action="move-down" title="Move down">&#9660;</button>
            <button class="nb-btn-icon" data-action="delete" title="Delete cell">&#10005;</button>
            <span class="nb-cell-actions-sep"></span>
            <button class="nb-btn-icon nb-btn-add" data-action="add-code-below" title="Add XQuery cell below">+XQ</button>
            <button class="nb-btn-icon nb-btn-add" data-action="add-data-below" title="Add Data cell below">+D</button>
            <button class="nb-btn-icon nb-btn-add" data-action="add-md-below" title="Add Markdown cell below">+MD</button>
        `;

        // Set initial serialization from xqdoc @output > metadata
        const serSelect = actions.querySelector(".nb-ser-select");
        const indentCheck = actions.querySelector(".nb-indent-check");
        const outputDirective = xqdoc.output;
        if (serSelect) {
            const method = outputDirective?.method
                || cellData.metadata?.exist?.serialization?.method;
            const mediaType = outputDirective?.["media-type"];
            if (method) {
                // Map method + media-type to dropdown value
                // method=html + media-type=text/html → "html" (rendered)
                // method=html (no media-type) → "html-raw"
                if (mediaType === "text/html") {
                    // Rendered variant: use method as-is (html, xhtml, csv)
                    serSelect.value = method;
                } else if (method === "html" || method === "xhtml" || method === "csv") {
                    // Raw variant: method without media-type
                    serSelect.value = method + "-raw";
                } else {
                    serSelect.value = method;
                }
            }
        }
        if (indentCheck) {
            const indent = outputDirective?.indent
                || cellData.metadata?.exist?.serialization?.indent;
            if (indent) {
                indentCheck.checked = indent === "yes";
            }
        }

        // Wire up name input (code + data cells)
        // Writes to both the xqdoc block in the source and cell metadata
        const nameInput = actions.querySelector(".nb-cell-name");
        if (nameInput) {
            nameInput.addEventListener("change", () => {
                const idx = this._cellIndex(cellEl);
                if (idx >= 0) {
                    const name = nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
                    nameInput.value = name;
                    this.cells[idx].cellName = name;
                    if (!this.cells[idx].metadata.exist) this.cells[idx].metadata.exist = {};
                    this.cells[idx].metadata.exist.name = name;

                    // Update xqdoc block in the editor source
                    this._updateCellXqdoc(idx, { name: name || null });

                    this._markModified();
                }
            });
        }

        // Wire up data language selector — updates @data in xqdoc block
        const dataLangSelect = actions.querySelector(".nb-data-lang");
        if (dataLangSelect) {
            dataLangSelect.addEventListener("change", () => {
                const idx = this._cellIndex(cellEl);
                if (idx >= 0) {
                    this.cells[idx].dataLanguage = dataLangSelect.value;
                    if (!this.cells[idx].metadata.exist) this.cells[idx].metadata.exist = {};
                    this.cells[idx].metadata.exist.dataLanguage = dataLangSelect.value;
                    this._updateCellXqdoc(idx, { dataFormat: dataLangSelect.value });
                    this._markModified();
                }
            });
        }

        // Wire up serialization controls to update xqdoc @output
        if (serSelect) {
            serSelect.addEventListener("change", () => {
                const idx = this._cellIndex(cellEl);
                if (idx >= 0) {
                    this._syncSerializationToXqdoc(idx, serSelect, indentCheck);
                }
            });
        }
        if (indentCheck) {
            indentCheck.addEventListener("change", () => {
                const idx = this._cellIndex(cellEl);
                if (idx >= 0) {
                    this._syncSerializationToXqdoc(idx, serSelect, indentCheck);
                }
            });
        }

        actions.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;
            const idx = this._cellIndex(cellEl);
            switch (btn.dataset.action) {
                case "run": this.runCell(idx); break;
                case "move-up": this.moveCellUp(idx); break;
                case "move-down": this.moveCellDown(idx); break;
                case "delete": this.deleteCell(idx); break;
                case "add-code-below": this.insertCell("code", idx + 1); break;
                case "add-data-below": this.insertCell("data", idx + 1); break;
                case "add-md-below": this.insertCell("markdown", idx + 1); break;
            }
        });

        cellEl.appendChild(actions);

        // Cell content
        const source = Array.isArray(cellData.source)
            ? cellData.source.join("")
            : (cellData.source || "");

        const cellRecord = {
            element: cellEl,
            type: internalType,
            editor: null,
            source: source,
            outputs: cellData.outputs || [],
            executionCount: cellData.execution_count || null,
            metadata: cellData.metadata || {},
            cellName: cellData.metadata?.exist?.name || "",
            dataLanguage: dataLanguage
        };

        if (internalType === "code") {
            this._renderCodeCell(cellEl, cellRecord, source);
        } else if (internalType === "data") {
            this._renderDataCell(cellEl, cellRecord, source);
        } else {
            this._renderMarkdownCell(cellEl, cellRecord, source);
        }

        // Cell click to select
        cellEl.addEventListener("click", () => {
            this.selectCell(this._cellIndex(cellEl));
        });

        // Insert into DOM
        const insertPoint = this._renderInsertPoint(null, index);
        this.cellsContainer.appendChild(cellEl);
        this.cellsContainer.appendChild(insertPoint);

        // Track cell
        this.cells.splice(index, 0, cellRecord);
        this._reindexCells();

        return cellRecord;
    }

    _renderCodeCell(cellEl, cellRecord, source) {
        const inputDiv = document.createElement("div");
        inputDiv.className = "nb-cell-input";

        // Create CM6 editor
        const extensions = this._buildCodeExtensions(cellRecord);
        const state = EditorState.create({
            doc: source,
            extensions
        });
        const view = new EditorView({ state, parent: inputDiv });
        cellRecord.editor = view;

        cellEl.appendChild(inputDiv);

        // Output area
        const outputDiv = document.createElement("div");
        outputDiv.className = "nb-cell-output";
        cellEl.appendChild(outputDiv);

        // Render existing outputs
        if (cellRecord.outputs && cellRecord.outputs.length > 0) {
            this._renderOutputs(outputDiv, cellRecord.outputs, cellRecord);
        }

        // Set up hover tooltips for function docs
        this._setupCellHover(cellRecord);
    }

    _renderDataCell(cellEl, cellRecord, source) {
        const inputDiv = document.createElement("div");
        inputDiv.className = "nb-cell-input";

        const extensions = this._buildDataExtensions(cellRecord);
        const state = EditorState.create({
            doc: source,
            extensions
        });
        const view = new EditorView({ state, parent: inputDiv });
        cellRecord.editor = view;

        cellEl.appendChild(inputDiv);
    }

    _renderMarkdownCell(cellEl, cellRecord, source) {
        // Rendered markdown view
        const rendered = document.createElement("div");
        rendered.className = "nb-md-rendered";
        rendered.innerHTML = renderMarkdown(source);

        // Source editor (hidden by default)
        const sourceDiv = document.createElement("div");
        sourceDiv.className = "nb-md-source";

        cellEl.appendChild(rendered);
        cellEl.appendChild(sourceDiv);

        // Double-click to edit
        rendered.addEventListener("dblclick", () => {
            this._enterMarkdownEdit(cellRecord);
        });
    }

    _enterMarkdownEdit(cellRecord) {
        const cellEl = cellRecord.element;
        cellEl.classList.add("editing");

        const sourceDiv = cellEl.querySelector(".nb-md-source");
        if (!cellRecord.editor) {
            const state = EditorState.create({
                doc: cellRecord.source,
                extensions: this._buildMarkdownExtensions(cellRecord)
            });
            cellRecord.editor = new EditorView({ state, parent: sourceDiv });
        }
        cellRecord.editor.focus();
    }

    _exitMarkdownEdit(cellRecord) {
        const cellEl = cellRecord.element;
        if (!cellEl.classList.contains("editing")) return;

        cellEl.classList.remove("editing");

        // Update source from editor
        if (cellRecord.editor) {
            const newSource = cellRecord.editor.state.doc.toString();
            if (newSource !== cellRecord.source) {
                cellRecord.source = newSource;
                this._markModified();
            }
            // Re-render markdown
            const rendered = cellEl.querySelector(".nb-md-rendered");
            rendered.innerHTML = renderMarkdown(cellRecord.source);
        }
    }

    _renderInsertPoint(parent, index) {
        const div = document.createElement("div");
        div.className = "nb-insert-cell";
        div.innerHTML = `
            <button class="nb-btn nb-btn-sm" data-insert="code">&#10010; XQuery</button>
            <button class="nb-btn nb-btn-sm" data-insert="data">&#10010; Data</button>
            <button class="nb-btn nb-btn-sm" data-insert="markdown">&#10010; Markdown</button>
        `;
        div.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-insert]");
            if (!btn) return;
            this.insertCell(btn.dataset.insert, index);
        });
        if (parent) parent.appendChild(div);
        return div;
    }

    // --- CM6 extensions ---

    _buildCodeExtensions(cellRecord) {
        const self = this;
        return [
            EditorView.lineWrapping,
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            indentUnit.of("    "),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            xqueryLanguage,
            autocompletion({ override: [ctx => self._completeXQuery(ctx)] }),
            lintGutter(),
            linter(view => self._lintCell(cellRecord, view)),
            keymap.of([
                // Custom bindings first — take priority over defaults
                {
                    key: "Ctrl-Enter",
                    mac: "Cmd-Enter",
                    run: () => {
                        const idx = self._cellIndex(cellRecord.element);
                        self.runCell(idx);
                        return true;
                    }
                },
                {
                    key: "Shift-Enter",
                    run: () => {
                        const idx = self._cellIndex(cellRecord.element);
                        (async () => {
                            await self.runCell(idx);
                            const len = self.cells.length;
                            if (idx < len - 1) {
                                self.selectCell(idx + 1);
                            } else {
                                self.insertCell("code", len);
                            }
                        })();
                        return true;
                    }
                },
                {
                    key: "Ctrl-s",
                    mac: "Cmd-s",
                    run: () => { self.save(); return true; }
                },
                indentWithTab,
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...searchKeymap,
                ...historyKeymap,
                ...completionKeymap,
                ...foldKeymap,
            ]),
            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    cellRecord.source = update.state.doc.toString();
                    self._markModified();
                }
            })
        ];
    }

    _buildMarkdownExtensions(cellRecord) {
        const self = this;
        return [
            EditorView.lineWrapping,
            lineNumbers(),
            highlightSpecialChars(),
            history(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            highlightActiveLine(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            markdown(),
            keymap.of([
                // Custom bindings first
                {
                    key: "Shift-Enter",
                    run: () => {
                        self._exitMarkdownEdit(cellRecord);
                        // Advance to next cell
                        const idx = self._cellIndex(cellRecord.element);
                        if (idx < self.cells.length - 1) {
                            self.selectCell(idx + 1);
                        }
                        return true;
                    }
                },
                {
                    key: "Ctrl-Enter",
                    mac: "Cmd-Enter",
                    run: () => {
                        self._exitMarkdownEdit(cellRecord);
                        return true;
                    }
                },
                {
                    key: "Escape",
                    run: () => {
                        self._exitMarkdownEdit(cellRecord);
                        return true;
                    }
                },
                {
                    key: "Ctrl-s",
                    mac: "Cmd-s",
                    run: () => { self.save(); return true; }
                },
                indentWithTab,
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...historyKeymap,
            ]),
            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    cellRecord.source = update.state.doc.toString();
                    self._markModified();
                }
            })
        ];
    }

    _buildDataExtensions(cellRecord) {
        const self = this;
        // Choose language mode based on dataLanguage
        const langExt = cellRecord.dataLanguage === "json" ? json()
            : cellRecord.dataLanguage === "xml" ? xml()
            : [];
        return [
            EditorView.lineWrapping,
            lineNumbers(),
            highlightSpecialChars(),
            history(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            highlightActiveLine(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            langExt,
            keymap.of([
                {
                    key: "Ctrl-s",
                    mac: "Cmd-s",
                    run: () => { self.save(); return true; }
                },
                indentWithTab,
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...historyKeymap,
            ]),
            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    cellRecord.source = update.state.doc.toString();
                    self._markModified();
                }
            })
        ];
    }

    // --- Completion ---

    async _completeXQuery(context) {
        // Only trigger on explicit activation or after typing a word/prefix
        const word = context.matchBefore(/[\w:$.\-]+/);
        if (!word && !context.explicit) return null;

        const prefix = word ? word.text : "";
        const from = word ? word.from : context.pos;

        // Fetch completions from eXist langservice endpoint (cached per session)
        if (!this._completionCache) {
            try {
                const langBase = this.apiBase.replace("/apps/notebook/api", "/apps/existdb-openapi/api");
                const resp = await fetch(`${langBase}/langservice/completions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        expression: context.state.doc.toString(),
                        line: 0,
                        col: 0
                    })
                });
                this._completionCache = await resp.json();
            } catch {
                return null;
            }
        }

        // Filter by prefix
        const lowerPrefix = prefix.toLowerCase();
        const filtered = this._completionCache
            .filter(c => c.label.toLowerCase().includes(lowerPrefix))
            .slice(0, 50);

        if (filtered.length === 0) return null;

        return {
            from,
            options: filtered.map(c => ({
                label: c.label.replace(/#\d+$/, ""),  // Strip arity suffix for display
                type: "function",
                detail: c.detail || "",
                info: c.documentation ? () => {
                    const div = document.createElement("div");
                    div.style.cssText = "max-width: 400px; max-height: 300px; overflow: auto; font-size: 0.8rem; line-height: 1.4; padding: 0.5rem;";
                    div.innerHTML = `<strong>${escapeHtml(c.detail || c.label)}</strong><br/><br/>${escapeHtml(c.documentation)}`;
                    return div;
                } : undefined,
                apply: c.insertText || c.label.replace(/#\d+$/, "")
            }))
        };
    }

    // --- Linting ---

    async _lintCell(cellRecord, view) {
        const code = view.state.doc.toString();
        if (!code.trim()) return [];

        const idx = this._cellIndex(cellRecord.element);

        // Collect names of preceding named code and data cells
        const cellNames = [];
        for (let i = 0; i < idx; i++) {
            if ((this.cells[i].type === "code" || this.cells[i].type === "data") && this.cells[i].cellName) {
                cellNames.push(this.cells[i].cellName);
            }
        }

        try {
            const resp = await fetch(`${this.apiBase}/lint`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    code,
                    cellNames: cellNames.length > 0 ? cellNames : undefined
                })
            });
            const result = await resp.json();

            if (result.status === "ok") return [];

            const line = Math.max(0, (result.line || 1) - 1);
            const lineInfo = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
            return [{
                from: lineInfo.from + Math.max(0, (result.column || 1) - 1),
                to: lineInfo.to,
                severity: "error",
                message: result.message || "Compilation error"
            }];
        } catch (e) {
            return [];
        }
    }

    // --- Formatting ---

    /**
     * Determine the Prettier parser for a cell.
     */
    _prettierParser(cell) {
        if (cell.type === "code") return "xquery";
        if (cell.type === "data") {
            switch (cell.dataLanguage) {
                case "xml": return "xml";
                case "json": return "json";
                default: return null;
            }
        }
        if (cell.type === "markdown") return "markdown";
        return null;
    }

    /**
     * Format a single cell using Prettier.
     */
    async formatCell(index) {
        if (index < 0 || index >= this.cells.length) return;
        const cell = this.cells[index];
        if (!cell.editor) return;

        const parser = this._prettierParser(cell);
        if (!parser) return;

        if (typeof prettierBundle === "undefined") {
            this._updateStatus("Prettier not loaded");
            return;
        }

        const code = cell.editor.state.doc.toString();
        if (!code.trim()) return;

        // Try formatting — if prettier-plugin-xquery can't parse XQuery 4.0
        // syntax, catch the error and show a message rather than blocking entirely

        try {
            const formatted = await prettierBundle.prettier.format(code, {
                parser,
                plugins: prettierBundle.plugins,
                tabWidth: 4,
                printWidth: 80,
                xmlWhitespaceSensitivity: "ignore",
                xmlSelfClosingSpace: true,
                bracketSameLine: true
            });

            // Replace editor content if changed
            const trimmed = formatted.replace(/\n$/, "");
            if (trimmed !== code) {
                cell.editor.dispatch({
                    changes: { from: 0, to: cell.editor.state.doc.length, insert: trimmed }
                });
                this._markModified();
            }
        } catch (err) {
            this._updateStatus("Format error: " + err.message);
        }
    }

    /**
     * Format all code, data, and markdown cells.
     */
    async formatAllCells() {
        for (let i = 0; i < this.cells.length; i++) {
            const cell = this.cells[i];
            if (cell.editor && this._prettierParser(cell)) {
                await this.formatCell(i);
            }
        }
    }

    // --- Execution ---

    async runCell(index) {
        const cell = this.cells[index];
        if (!cell || cell.type !== "code") return;

        const source = cell.editor
            ? cell.editor.state.doc.toString()
            : cell.source;

        if (!source.trim()) return;

        // Build context chain from preceding NAMED code and data cells
        const context = [];
        for (let i = 0; i < index; i++) {
            const c = this.cells[i];
            if (!c.cellName) continue;
            const src = c.editor ? c.editor.state.doc.toString() : c.source;
            if (!src.trim()) continue;

            if (c.type === "code") {
                context.push({ name: c.cellName, query: src });
            } else if (c.type === "data") {
                context.push({
                    name: c.cellName,
                    kind: "data",
                    dataLanguage: c.dataLanguage || "xml",
                    content: src
                });
            }
        }

        // Get serialization from dropdown + indent checkbox
        const serSelect = cell.element.querySelector(".nb-ser-select");
        const indentCheck = cell.element.querySelector(".nb-indent-check");
        let displayMethod = serSelect ? serSelect.value : "adaptive";
        const indent = indentCheck ? (indentCheck.checked ? "yes" : "no") : "no";

        // Map display methods to serialization parameters.
        // Rendered variants (html, csv) use media-type=text/html.
        // Raw variants (html-raw, csv-raw) use method only — no media-type.
        let actualMethod = displayMethod;
        let mediaType = undefined;
        let isRaw = false;
        if (displayMethod === "html-raw") {
            actualMethod = "html";
            isRaw = true;
        } else if (displayMethod === "xhtml-raw") {
            actualMethod = "xhtml";
            isRaw = true;
        } else if (displayMethod === "csv-raw") {
            actualMethod = "csv";
            isRaw = true;
        } else if (displayMethod === "html" || displayMethod === "xhtml") {
            mediaType = "text/html";
        } else if (displayMethod === "csv") {
            mediaType = "text/html";
        }

        const serialization = { method: actualMethod, indent };
        if (mediaType) serialization["media-type"] = mediaType;

        // Mark running
        cell.element.classList.add("running");
        cell.element.classList.remove("error");
        this.executionCount++;
        cell.executionCount = this.executionCount;

        const outputDiv = cell.element.querySelector(".nb-cell-output");
        outputDiv.innerHTML = '<div class="nb-output-area" style="color: var(--nb-text-muted);">Running...</div>';

        try {
            const resp = await fetch(`${this.apiBase}/eval`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: source,
                    session: this.sessionId,
                    sessionHasRun: this.sessionHasRun,
                    cellName: cell.cellName || undefined,
                    context: context.length > 0 ? context : undefined,
                    serialization,
                    timeout: 10000
                })
            });
            const result = await resp.json();

            cell.element.classList.remove("running");

            if (result.error) {
                cell.element.classList.add("error");
                cell.outputs = [{
                    output_type: "error",
                    ename: result.code || "Error",
                    evalue: result.error,
                    traceback: result.line ? [`Line ${result.line}, Column ${result.column}`] : []
                }];
            } else if (result.silent) {
                // @silent: cell executed and cached, but suppress output
                cell.outputs = [];
            } else {
                // Use displayMethod for rendering (e.g., "html-raw" shows raw markup)
                const renderType = isRaw ? displayMethod : result.type;
                cell.outputs = [{
                    output_type: "execute_result",
                    data: { "text/plain": result.result },
                    metadata: {
                        type: renderType,
                        count: result.count,
                        elapsed: result.elapsed
                    },
                    execution_count: cell.executionCount
                }];
            }

            this._renderOutputs(outputDiv, cell.outputs, cell);
            this.sessionHasRun = true;

            // Show cache miss notification if prior cells were re-evaluated
            if (result.cacheMisses > 0) {
                this._showToast(
                    `Cache expired \u2014 re-evaluated ${result.cacheMisses} of ${result.cacheTotal} prior cell${result.cacheTotal !== 1 ? "s" : ""}`,
                    3000
                );
            }
        } catch (err) {
            cell.element.classList.remove("running");
            cell.element.classList.add("error");
            outputDiv.innerHTML = `<div class="nb-output-error"><span class="error-name">Network Error:</span> ${escapeHtml(err.message)}</div>`;
        }
    }

    async runSelectedCell() {
        if (this.selectedIndex < 0) return;
        const idx = this.selectedIndex;
        const cell = this.cells[idx];
        if (cell && cell.type === "code") {
            await this.runCell(idx);
        }
        // Always advance or insert, even for non-code cells
        const currentLen = this.cells.length;
        if (idx < currentLen - 1) {
            this.selectCell(idx + 1);
        } else {
            this.insertCell("code", currentLen);
        }
    }

    async runAllCells() {
        for (let i = 0; i < this.cells.length; i++) {
            if (this.cells[i].type === "code") {
                await this.runCell(i);
            }
        }
    }

    async runCellsAbove() {
        for (let i = 0; i < this.selectedIndex; i++) {
            if (this.cells[i].type === "code") {
                await this.runCell(i);
            }
        }
    }

    // --- Output rendering ---

    _renderOutputs(container, outputs, cellRecord) {
        container.innerHTML = "";
        if (!outputs || outputs.length === 0) return;

        for (const output of outputs) {
            if (output.output_type === "error") {
                const errorDiv = document.createElement("div");
                errorDiv.className = "nb-output-error";
                errorDiv.innerHTML = `<span class="error-name">${escapeHtml(output.ename || "Error")}:</span> ${escapeHtml(output.evalue || "")}`;
                if (output.traceback && output.traceback.length > 0) {
                    errorDiv.innerHTML += `<br/><span style="color: var(--nb-text-muted)">${escapeHtml(output.traceback.join("\n"))}</span>`;
                }
                container.appendChild(errorDiv);
            } else if (output.output_type === "execute_result" || output.output_type === "display_data") {
                const data = output.data || {};
                const text = data["text/plain"] || "";
                const outputType = output.metadata?.type || "adaptive";

                // Output label
                const label = document.createElement("div");
                label.className = "nb-output-label";
                label.textContent = "Output";
                container.appendChild(label);

                const area = document.createElement("div");
                area.className = `nb-output-area output-${outputType}`;

                if ((outputType === "html" || outputType === "xhtml") || data["text/html"]) {
                    area.classList.add("output-html");
                    area.innerHTML = data["text/html"] || text;
                } else if (outputType === "html-raw" || outputType === "xhtml-raw") {
                    area.innerHTML = highlightOutput(text, "html");
                } else if (outputType === "xml") {
                    area.innerHTML = highlightOutput(text, "xml");
                } else if (outputType === "json") {
                    area.innerHTML = highlightOutput(text, "json");
                } else if (outputType === "csv") {
                    area.classList.add("output-html");
                    area.innerHTML = csvToTable(text);
                } else if (outputType === "csv-raw") {
                    area.textContent = text;
                } else if (outputType === "adaptive") {
                    const trimmed = text.trimStart();
                    if (trimmed.startsWith("<")) {
                        area.innerHTML = highlightOutput(text, "xml");
                    } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                        area.innerHTML = highlightOutput(text, "json");
                    } else {
                        area.textContent = text;
                    }
                } else {
                    area.textContent = text;
                }
                container.appendChild(area);

                // Execution metadata footer — visually separated
                if (output.metadata?.count != null || output.metadata?.elapsed) {
                    const meta = document.createElement("div");
                    meta.className = "nb-output-meta";
                    const parts = [];
                    if (output.metadata.count != null) parts.push(`${output.metadata.count} item${output.metadata.count !== 1 ? "s" : ""}`);
                    if (output.metadata.elapsed) parts.push(output.metadata.elapsed);
                    meta.textContent = parts.join(" \u2022 ");
                    container.appendChild(meta);
                }
            }
        }
    }

    // --- Cell operations ---

    selectCell(index) {
        // If re-selecting the same cell, do nothing (preserves markdown edit mode)
        if (index === this.selectedIndex) return;

        // Deselect previous
        if (this.selectedIndex >= 0 && this.selectedIndex < this.cells.length) {
            const prev = this.cells[this.selectedIndex];
            prev.element.classList.remove("selected");
            // Exit markdown edit if leaving this cell
            if (prev.type === "markdown") {
                this._exitMarkdownEdit(prev);
            }
        }

        this.selectedIndex = index;
        if (index >= 0 && index < this.cells.length) {
            this.cells[index].element.classList.add("selected");
        }
    }

    toggleMarkdownEdit() {
        if (this.selectedIndex < 0) return;
        const cell = this.cells[this.selectedIndex];
        if (cell.type !== "markdown") return;

        if (cell.element.classList.contains("editing")) {
            this._exitMarkdownEdit(cell);
        } else {
            this._enterMarkdownEdit(cell);
        }
    }

    insertCell(type, index) {
        if (index < 0) index = 0;
        if (index > this.cells.length) index = this.cells.length;

        // "+D" creates a code cell with xqdoc data directives
        const isDataInsert = type === "data";
        const actualType = isDataInsert ? "code" : type;
        const initialSource = isDataInsert
            ? "(:~\n : @name untitled\n : @data xml\n : @silent\n :)\n"
            : "";

        const cellData = {
            cell_type: actualType,
            metadata: {},
            source: initialSource,
            execution_count: null,
            outputs: []
        };

        // Create the cell element and insert it
        const cellEl = document.createElement("div");
        cellEl.className = `nb-cell nb-cell-${actualType}`;

        const actions = document.createElement("div");
        actions.className = "nb-cell-actions";
        const typeBadge = isDataInsert ? "data" : actualType === "code" ? "xquery" : "markdown";
        actions.innerHTML = `
            <span class="nb-cell-type-badge">${typeBadge}</span>
            ${actualType === "code" && !isDataInsert ? `
                <input class="nb-cell-name" type="text"
                    placeholder="name"
                    title="Cell name \u2014 result becomes $name in subsequent cells"
                    spellcheck="false"/>
                ${NotebookEditor.serializationControls()}
                <button class="nb-btn-icon" data-action="run" title="Run cell">&#9654;</button>
            ` : ""}
            ${isDataInsert ? `
                <input class="nb-cell-name" type="text"
                    placeholder="name (required)"
                    title="Cell name \u2014 data becomes $name in code cells"
                    value="untitled"
                    spellcheck="false"/>
                <select class="nb-data-lang" title="Data format">
                    <option value="xml" selected>XML</option>
                    <option value="json">JSON</option>
                    <option value="text">Text</option>
                </select>
                <button class="nb-btn-icon" data-action="run" title="Run cell (load data)">&#9654;</button>
            ` : ""}
            <button class="nb-btn-icon" data-action="move-up" title="Move up">&#9650;</button>
            <button class="nb-btn-icon" data-action="move-down" title="Move down">&#9660;</button>
            <button class="nb-btn-icon" data-action="delete" title="Delete cell">&#10005;</button>
            <span class="nb-cell-actions-sep"></span>
            <button class="nb-btn-icon nb-btn-add" data-action="add-code-below" title="Add XQuery cell below">+XQ</button>
            <button class="nb-btn-icon nb-btn-add" data-action="add-data-below" title="Add Data cell below">+D</button>
            <button class="nb-btn-icon nb-btn-add" data-action="add-md-below" title="Add Markdown cell below">+MD</button>
        `;

        const self = this;
        actions.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;
            const idx = self._cellIndex(cellEl);
            switch (btn.dataset.action) {
                case "run": self.runCell(idx); break;
                case "move-up": self.moveCellUp(idx); break;
                case "move-down": self.moveCellDown(idx); break;
                case "delete": self.deleteCell(idx); break;
                case "add-code-below": self.insertCell("code", idx + 1); break;
                case "add-data-below": self.insertCell("data", idx + 1); break;
                case "add-md-below": self.insertCell("markdown", idx + 1); break;
            }
        });

        // Wire up name input for new cells — writes to xqdoc block
        const nameInput = actions.querySelector(".nb-cell-name");
        if (nameInput) {
            nameInput.addEventListener("change", () => {
                const idx = self._cellIndex(cellEl);
                if (idx >= 0) {
                    const name = nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
                    nameInput.value = name;
                    self.cells[idx].cellName = name;
                    if (!self.cells[idx].metadata.exist) self.cells[idx].metadata.exist = {};
                    self.cells[idx].metadata.exist.name = name;
                    self._updateCellXqdoc(idx, { name: name || null });
                    self._markModified();
                }
            });
        }

        // Wire up data language selector — updates @data in xqdoc block
        const dataLangSelect = actions.querySelector(".nb-data-lang");
        if (dataLangSelect) {
            dataLangSelect.addEventListener("change", () => {
                const idx = self._cellIndex(cellEl);
                if (idx >= 0) {
                    self.cells[idx].dataLanguage = dataLangSelect.value;
                    if (!self.cells[idx].metadata.exist) self.cells[idx].metadata.exist = {};
                    self.cells[idx].metadata.exist.dataLanguage = dataLangSelect.value;
                    self._updateCellXqdoc(idx, { dataFormat: dataLangSelect.value });
                    self._markModified();
                }
            });
        }

        cellEl.appendChild(actions);

        const cellRecord = {
            element: cellEl,
            type: actualType,
            editor: null,
            source: initialSource,
            outputs: [],
            executionCount: null,
            metadata: cellData.metadata,
            cellName: isDataInsert ? "untitled" : "",
            dataLanguage: isDataInsert ? "xml" : undefined
        };

        cellEl.addEventListener("click", () => {
            self.selectCell(self._cellIndex(cellEl));
        });

        if (actualType === "code") {
            const inputDiv = document.createElement("div");
            inputDiv.className = "nb-cell-input";
            const extensions = this._buildCodeExtensions(cellRecord);
            const state = EditorState.create({ doc: initialSource, extensions });
            const view = new EditorView({ state, parent: inputDiv });
            cellRecord.editor = view;
            cellEl.appendChild(inputDiv);

            const outputDiv = document.createElement("div");
            outputDiv.className = "nb-cell-output";
            cellEl.appendChild(outputDiv);
            this._setupCellHover(cellRecord);
        } else {
            const rendered = document.createElement("div");
            rendered.className = "nb-md-rendered";
            const sourceDiv = document.createElement("div");
            sourceDiv.className = "nb-md-source";
            cellEl.appendChild(rendered);
            cellEl.appendChild(sourceDiv);
            rendered.addEventListener("dblclick", () => {
                self._enterMarkdownEdit(cellRecord);
            });
        }

        // Insert into DOM
        const insertPoint = this._renderInsertPoint(null, index);
        const refEl = this.cells[index]?.element;
        if (refEl) {
            this.cellsContainer.insertBefore(insertPoint, refEl);
            this.cellsContainer.insertBefore(cellEl, insertPoint);
        } else {
            this.cellsContainer.appendChild(cellEl);
            this.cellsContainer.appendChild(insertPoint);
        }

        this.cells.splice(index, 0, cellRecord);
        this._reindexCells();
        this.selectCell(index);
        this._markModified();

        // Focus the editor
        if ((type === "code" || type === "data") && cellRecord.editor) {
            cellRecord.editor.focus();
        } else if (type === "markdown") {
            this._enterMarkdownEdit(cellRecord);
        }

        return cellRecord;
    }

    deleteCell(index) {
        if (this.cells.length <= 1) return; // Keep at least one cell

        this._pushUndo("delete cell");

        const cell = this.cells[index];
        // Destroy editor
        if (cell.editor) cell.editor.destroy();

        // Remove from DOM — cell element + preceding insert point
        const prevInsert = cell.element.previousElementSibling;
        if (prevInsert?.classList.contains("nb-insert-cell")) {
            prevInsert.remove();
        }
        cell.element.remove();

        this.cells.splice(index, 1);
        this._reindexCells();
        this._markModified();

        // Select adjacent cell
        if (index >= this.cells.length) index = this.cells.length - 1;
        this.selectCell(index);
    }

    moveCellUp(index) {
        if (index <= 0) return;
        this._pushUndo("move cell");
        this._swapCells(index, index - 1);
        this.selectCell(index - 1);
    }

    moveCellDown(index) {
        if (index >= this.cells.length - 1) return;
        this._pushUndo("move cell");
        this._swapCells(index, index + 1);
        this.selectCell(index + 1);
    }

    _swapCells(a, b) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const loEl = this.cells[lo].element;
        const hiEl = this.cells[hi].element;

        // Swap in DOM
        const hiNext = hiEl.nextSibling;
        loEl.parentNode.insertBefore(hiEl, loEl);
        if (hiNext) {
            loEl.parentNode.insertBefore(loEl, hiNext);
        } else {
            loEl.parentNode.appendChild(loEl);
        }

        // Swap in array
        [this.cells[lo], this.cells[hi]] = [this.cells[hi], this.cells[lo]];
        this._reindexCells();
        this._markModified();
    }

    // --- Undo ---

    /**
     * Snapshot current notebook state onto the undo stack.
     * Call this BEFORE any destructive operation.
     */
    _pushUndo(description) {
        // Capture current cell state as serializable data
        const snapshot = {
            description,
            selectedIndex: this.selectedIndex,
            cells: this.cells.map(cell => {
                const source = cell.editor
                    ? cell.editor.state.doc.toString()
                    : cell.source;
                return {
                    type: cell.type,
                    source,
                    outputs: cell.outputs ? JSON.parse(JSON.stringify(cell.outputs)) : [],
                    executionCount: cell.executionCount,
                    metadata: JSON.parse(JSON.stringify(cell.metadata || {})),
                    cellName: cell.cellName || ""
                };
            })
        };

        this.undoStack.push(snapshot);
        if (this.undoStack.length > this.maxUndoDepth) {
            this.undoStack.shift();
        }
    }

    /**
     * Restore notebook to the most recent snapshot.
     */
    undo() {
        if (this.undoStack.length === 0) return;

        const snapshot = this.undoStack.pop();

        // Destroy all current editors
        for (const cell of this.cells) {
            if (cell.editor) cell.editor.destroy();
        }
        this.cells = [];

        // Clear the cells container
        this.cellsContainer.innerHTML = "";

        // Rebuild from snapshot
        for (let i = 0; i < snapshot.cells.length; i++) {
            const cellData = snapshot.cells[i];
            this._renderCell({
                cell_type: cellData.type,
                source: cellData.source,
                outputs: cellData.outputs,
                execution_count: cellData.executionCount,
                metadata: cellData.metadata
            }, i);
        }

        // Bottom insert point
        this._renderInsertPoint(this.cellsContainer, this.cells.length);

        // Restore selection
        const idx = Math.min(snapshot.selectedIndex, this.cells.length - 1);
        if (idx >= 0) {
            this.selectCell(idx);
        }

        this._markModified();
    }

    // --- Save ---

    async save() {
        const notebook = this._serializeNotebook();

        try {
            const resp = await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(this.path)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(notebook)
            });

            if (resp.status === 401 || resp.status === 403) {
                this._showLoginDialog(() => this.save());
                return;
            }

            const result = await resp.json();

            if (result.saved) {
                this.modified = false;
                this._updateStatus();
            } else if (result.description && /permission|not have write access|not authorized/i.test(result.description)) {
                // Permission error from eXist — prompt for login
                this._showLoginDialog(() => this.save());
            } else if (result.description) {
                this._updateStatus(result.description);
            }
        } catch (err) {
            console.error("Save failed:", err);
            this._updateStatus("Save failed: " + err.message);
        }
    }

    download() {
        const notebook = this._serializeNotebook();
        const json = JSON.stringify(notebook, null, 4);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = this.path;
        a.click();
        URL.revokeObjectURL(url);
    }

    async duplicate() {
        try {
            const resp = await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(this.path)}/duplicate`, {
                method: "POST"
            });
            if (resp.status === 401 || resp.status === 403) {
                this._showLoginDialog(() => this.duplicate());
                return;
            }
            const result = await resp.json();
            if (result.description && /permission|not have write access/i.test(result.description)) {
                this._showLoginDialog(() => this.duplicate());
                return;
            }
            if (result.slug) {
                window.location.href = result.slug;
            }
        } catch (err) {
            console.error("Duplicate failed:", err);
        }
    }

    async showHistory() {
        try {
            const resp = await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(this.path)}/versions`);
            const versions = await resp.json();
            this._renderHistoryDialog(versions);
        } catch (err) {
            console.error("Failed to load history:", err);
        }
    }

    _renderHistoryDialog(versions) {
        const overlay = document.createElement("div");
        overlay.className = "nb-dialog-overlay";

        const formatDate = (ts) => {
            try {
                const d = new Date(ts);
                return d.toLocaleString();
            } catch {
                return ts;
            }
        };

        const formatSize = (bytes) => {
            if (bytes < 1024) return bytes + " B";
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
            return (bytes / (1024 * 1024)).toFixed(1) + " MB";
        };

        overlay.innerHTML = `
            <div class="nb-dialog nb-dialog-wide">
                <h2>Version History</h2>
                ${versions.length === 0
                    ? '<p style="color: var(--nb-text-muted);">No previous versions. Versions are created each time you save.</p>'
                    : `<div class="nb-version-list">
                        ${versions.map(v => `
                            <div class="nb-version-item">
                                <div class="nb-version-info">
                                    <span class="nb-version-date">${formatDate(v.modified)}</span>
                                    <span class="nb-version-size">${formatSize(v.size)}</span>
                                </div>
                                <button class="nb-btn nb-btn-sm" data-restore="${v.version}">Restore</button>
                            </div>
                        `).join("")}
                    </div>`
                }
                <div class="nb-dialog-actions">
                    <button class="nb-btn" data-action="cancel">Close</button>
                </div>
            </div>
        `;

        overlay.addEventListener("click", async (e) => {
            const action = e.target.closest("[data-action]")?.dataset.action;
            if (action === "cancel" || e.target === overlay) {
                overlay.remove();
                return;
            }

            const restoreBtn = e.target.closest("[data-restore]");
            if (restoreBtn) {
                const version = restoreBtn.dataset.restore;
                if (confirm(`Restore this version? Your current notebook will be saved as a snapshot first.`)) {
                    try {
                        const resp = await fetch(
                            `${this.apiBase}/notebooks/${encodeURIComponent(this.path)}/versions/${encodeURIComponent(version)}`,
                            { method: "POST" }
                        );
                        const result = await resp.json();
                        if (result.restored) {
                            overlay.remove();
                            window.location.reload();
                        }
                    } catch (err) {
                        console.error("Restore failed:", err);
                    }
                }
            }
        });

        document.body.appendChild(overlay);
    }

    _showLoginDialog(onSuccess) {
        const overlay = document.createElement("div");
        overlay.className = "nb-dialog-overlay";
        overlay.innerHTML = `
            <div class="nb-dialog">
                <h2>Login Required</h2>
                <p style="color: var(--nb-text-muted); margin-bottom: 1rem;">You need to log in to save notebooks.</p>
                <div class="nb-dialog-field">
                    <label for="nb-login-user">Username</label>
                    <input type="text" id="nb-login-user" autocomplete="username"/>
                </div>
                <div class="nb-dialog-field">
                    <label for="nb-login-pass">Password</label>
                    <input type="password" id="nb-login-pass" autocomplete="current-password"/>
                </div>
                <div id="nb-login-error" style="color: var(--nb-danger); font-size: 0.85rem; display: none;"></div>
                <div class="nb-dialog-actions">
                    <button class="nb-btn" data-action="cancel">Cancel</button>
                    <button class="nb-btn nb-btn-primary" data-action="login">Login</button>
                </div>
            </div>
        `;

        const userInput = overlay.querySelector("#nb-login-user");
        const passInput = overlay.querySelector("#nb-login-pass");
        const errorEl = overlay.querySelector("#nb-login-error");

        const doLogin = async () => {
            const user = userInput.value.trim();
            const password = passInput.value;
            if (!user) return;

            try {
                const loginBase = this.apiBase.replace("/api", "");
                const resp = await fetch(`${loginBase}/login`, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: `user=${encodeURIComponent(user)}&password=${encodeURIComponent(password)}`
                });

                if (resp.ok) {
                    overlay.remove();
                    if (onSuccess) onSuccess();
                } else {
                    errorEl.textContent = "Login failed. Check your credentials.";
                    errorEl.style.display = "block";
                }
            } catch (err) {
                errorEl.textContent = "Connection error.";
                errorEl.style.display = "block";
            }
        };

        overlay.addEventListener("click", (e) => {
            const action = e.target.closest("[data-action]")?.dataset.action;
            if (action === "cancel" || e.target === overlay) overlay.remove();
            if (action === "login") doLogin();
        });

        passInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") doLogin();
        });
        userInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") passInput.focus();
        });

        document.body.appendChild(overlay);
        userInput.focus();
    }

    _serializeNotebook() {
        return {
            nbformat: this.notebook.nbformat || 4,
            nbformat_minor: this.notebook.nbformat_minor || 5,
            metadata: this.notebook.metadata || {},
            cells: this.cells.map(cell => {
                const source = cell.editor
                    ? cell.editor.state.doc.toString()
                    : cell.source;

                // Data cells are stored as "raw" in .ipynb format
                const ipynbType = cell.type === "data" ? "raw" : cell.type;
                const cellData = {
                    cell_type: ipynbType,
                    metadata: cell.metadata,
                    source: source.split("\n").map((line, i, arr) =>
                        i < arr.length - 1 ? line + "\n" : line
                    )
                };

                if (cell.type === "code") {
                    cellData.execution_count = cell.executionCount;
                    cellData.outputs = cell.outputs || [];
                }

                return cellData;
            })
        };
    }

    // --- Utilities ---

    _cellIndex(element) {
        return this.cells.findIndex(c => c.element === element);
    }

    _reindexCells() {
        this.cells.forEach((cell, i) => {
            cell.element.dataset.index = i;
        });
    }

    /**
     * Sync the serialization dropdown and indent checkbox to the xqdoc @output block.
     */
    _syncSerializationToXqdoc(idx, serSelect, indentCheck) {
        const displayMethod = serSelect?.value || "adaptive";
        const indent = indentCheck?.checked ? "yes" : null;

        // Map dropdown value to @output parameters
        let method = displayMethod;
        let mediaType = null;
        if (displayMethod === "html-raw") method = "html";
        else if (displayMethod === "xhtml-raw") method = "xhtml";
        else if (displayMethod === "csv-raw") method = "csv";
        else if (displayMethod === "html" || displayMethod === "xhtml") mediaType = "text/html";
        else if (displayMethod === "csv") mediaType = "text/html";

        // Build @output object — only include non-default values
        const output = {};
        if (method && method !== "adaptive") output.method = method;
        if (mediaType) output["media-type"] = mediaType;
        if (indent) output.indent = indent;

        this._updateCellXqdoc(idx, {
            output: Object.keys(output).length > 0 ? output : null
        });

        // Also update metadata for backward compat
        if (!this.cells[idx].metadata.exist) this.cells[idx].metadata.exist = {};
        this.cells[idx].metadata.exist.serialization = { method, indent: indent || "no" };
        this._markModified();
    }

    /**
     * Update the xqdoc block in a cell's editor source.
     * Merges the given directive changes with existing directives.
     * @param {number} idx - cell index
     * @param {object} changes - directive fields to update (name, dataFormat, silent, output)
     */
    _updateCellXqdoc(idx, changes) {
        const cell = this.cells[idx];
        if (!cell || !cell.editor) return;

        const currentSource = cell.editor.state.doc.toString();
        const current = parseXqdocDirectives(currentSource);

        // Merge changes into current directives
        const merged = {
            name: "name" in changes ? changes.name : current.name,
            dataFormat: "dataFormat" in changes ? changes.dataFormat : current.dataFormat,
            silent: "silent" in changes ? changes.silent : current.silent,
            output: "output" in changes ? changes.output : current.output,
        };

        const newSource = updateXqdocInSource(currentSource, merged);
        if (newSource !== currentSource) {
            cell.editor.dispatch({
                changes: { from: 0, to: currentSource.length, insert: newSource }
            });
        }
    }

    _markModified() {
        this.modified = true;
        this._updateStatus();
    }

    _updateStatus(message) {
        const status = this.toolbar.querySelector(".nb-toolbar-status");
        if (message) {
            status.className = "nb-toolbar-status modified";
            status.textContent = message;
        } else if (this.modified) {
            status.className = "nb-toolbar-status modified";
            status.textContent = "Unsaved changes";
        } else {
            status.className = "nb-toolbar-status";
            status.textContent = "Saved";
        }
    }

    _showToast(message, duration = 3000) {
        const toast = document.createElement("div");
        toast.className = "nb-toast";
        toast.textContent = message;
        document.body.appendChild(toast);
        // Trigger animation
        requestAnimationFrame(() => toast.classList.add("visible"));
        setTimeout(() => {
            toast.classList.remove("visible");
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    _bindGlobalKeys() {
        document.addEventListener("keydown", (e) => {
            // Ctrl/Cmd+S to save
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                this.save();
            }
            // Ctrl/Cmd+Z to undo (when not in an editor — CM6 handles its own undo)
            if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && !e.target.closest(".cm-editor")) {
                e.preventDefault();
                this.undo();
            }
            // Cmd/Ctrl+Enter to run in place (when not in an editor)
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.target.closest(".cm-editor")) {
                e.preventDefault();
                if (this.selectedIndex >= 0) this.runCell(this.selectedIndex);
            }
            // Shift+Enter to run and advance (when not in an editor)
            if (e.shiftKey && e.key === "Enter" && !e.target.closest(".cm-editor")) {
                e.preventDefault();
                this.runSelectedCell();
            }
        });
    }

    // --- Table of Contents ---

    _buildToc() {
        const tocList = this.tocSidebar.querySelector(".nb-toc-list");
        const headings = this.cellsContainer.querySelectorAll(".nb-md-rendered h1, .nb-md-rendered h2, .nb-md-rendered h3, .nb-md-rendered h4");

        if (headings.length === 0) {
            this.tocSidebar.style.display = "none";
            return;
        }

        // Assign IDs to headings for anchor links
        const items = [];
        headings.forEach((heading, i) => {
            const id = "heading-" + i;
            heading.id = id;
            const level = parseInt(heading.tagName[1]);
            items.push({ id, text: heading.textContent, level, element: heading });
        });

        // Build TOC HTML
        const minLevel = Math.min(...items.map(h => h.level));
        tocList.innerHTML = items.map(h => {
            const indent = h.level - minLevel;
            return `<li class="nb-toc-item nb-toc-level-${indent}">
                <a href="#${h.id}" data-toc-id="${h.id}">${escapeHtml(h.text)}</a>
            </li>`;
        }).join("");

        // Click handling — smooth scroll
        tocList.addEventListener("click", (e) => {
            const link = e.target.closest("[data-toc-id]");
            if (link) {
                e.preventDefault();
                const target = document.getElementById(link.dataset.tocId);
                if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        });

        // Intersection Observer for active heading tracking
        this._tocObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    tocList.querySelectorAll(".nb-toc-active").forEach(el => el.classList.remove("nb-toc-active"));
                    const link = tocList.querySelector(`[data-toc-id="${entry.target.id}"]`);
                    if (link) {
                        link.parentElement.classList.add("nb-toc-active");
                        // Scroll TOC to keep active item visible
                        link.scrollIntoView({ block: "nearest", behavior: "smooth" });
                    }
                }
            }
        }, {
            rootMargin: "-80px 0px -70% 0px",
            threshold: 0
        });

        items.forEach(h => this._tocObserver.observe(h.element));
    }

    // --- Function hover docs ---

    toggleHoverDocs() {
        this.hoverEnabled = !this.hoverEnabled;
        localStorage.setItem("nb-hover-docs", this.hoverEnabled ? "on" : "off");
        const btn = this.toolbar.querySelector("[data-action='toggle-hover']");
        if (btn) btn.classList.toggle("active", this.hoverEnabled);
        if (!this.hoverEnabled) this._dismissHover();
    }

    _setupCellHover(cellRecord) {
        if (!cellRecord.editor || cellRecord.type !== "code") return;
        const editorDom = cellRecord.editor.dom;

        editorDom.addEventListener("mousemove", (e) => {
            if (!this.hoverEnabled) return;
            clearTimeout(this._hoverTimeout);
            // Reset last hover func so moving to a new position re-triggers
            this._lastHoverFunc = null;
            this._hoverTimeout = setTimeout(() => {
                this._handleHover(e, cellRecord);
            }, 400);
        });

        editorDom.addEventListener("mouseleave", () => {
            clearTimeout(this._hoverTimeout);
            this._lastHoverFunc = null;
            setTimeout(() => {
                if (this._hoverTooltip && !this._hoverTooltip.matches(":hover")) {
                    this._dismissHover();
                }
            }, 300);
        });
    }

    async _handleHover(e, cellRecord) {
        if (!cellRecord.editor) return;
        const view = cellRecord.editor;
        try {
            var pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        } catch { return; }
        if (pos == null || pos < 0 || pos > view.state.doc.length) return;

        // Extract the word at the cursor position
        const line = view.state.doc.lineAt(pos);
        const lineText = line.text;
        const col = pos - line.from;

        // Find word boundaries
        let start = col, end = col;
        while (start > 0 && /[\w:\-.]/.test(lineText[start - 1])) start--;
        while (end < lineText.length && /[\w:\-.]/.test(lineText[end])) end++;
        const word = lineText.slice(start, end);

        if (!word || word.length < 2 || !/^[a-z][\w:\-.]*$/i.test(word)) return;

        // Check if followed by ( — indicates a function call
        const afterWord = lineText.slice(end).trimStart();
        if (!afterWord.startsWith("(")) return;

        // Split into prefix:name
        const parts = word.split(":");
        const lib = parts.length > 1 ? parts[0] : "fn";
        const name = parts.length > 1 ? parts[1] : parts[0];

        // Don't re-fetch for same function
        if (this._lastHoverFunc === word) return;
        this._lastHoverFunc = word;

        try {
            let shown = false;

            // Try langservice hover first (works when expression compiles)
            try {
                const langBase = this.apiBase.replace("/apps/notebook/api", "/apps/existdb-openapi/api");
                const resp = await fetch(`${langBase}/langservice/hover`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        expression: view.state.doc.toString(),
                        line: line.number - 1,
                        column: start
                    })
                });
                const data = await resp.json();
                if (data && data.contents) {
                    this._showHoverTooltip(data, lib, name, e.clientX, e.clientY);
                    shown = true;
                }
            } catch {}

            // Fallback: look up by function name via docs API (always works,
            // even when the expression has undeclared variables)
            if (!shown) {
                const docsBase = this.apiBase.replace("/apps/notebook/api", "/apps/docs");
                try {
                    const docsResp = await fetch(`${docsBase}/api/functions/${lib}/${name}`);
                    if (docsResp.ok) {
                        const docsData = await docsResp.json();
                        if (docsData && docsData.signatures && docsData.signatures.length > 0) {
                            // Build contents from all signatures
                            const sigs = docsData.signatures;
                            const sigLines = sigs.map(s => s.signature).join("\n");
                            const desc = sigs[0].description || "";
                            this._showHoverTooltip({
                                contents: sigLines + (desc ? "\n\n" + desc : "")
                            }, lib, name, e.clientX, e.clientY);
                        }
                    }
                } catch {}
            }
        } catch {}
    }

    _showHoverTooltip(data, lib, name, x, y) {
        this._dismissHover();

        const tooltip = document.createElement("div");
        tooltip.className = "nb-hover-tooltip";

        // LSP returns "signature\n\ndescription" in contents — split them
        const raw = typeof data.contents === "string" ? data.contents : (data.signature || `${lib}:${name}()`);
        const splitIdx = raw.indexOf("\n\n");
        const sig = splitIdx > 0 ? raw.substring(0, splitIdx) : raw;
        const desc = data.description || (splitIdx > 0 ? raw.substring(splitIdx + 2) : "");
        const docsUrl = `${this.apiBase.replace("/apps/notebook/api", "/apps/docs")}/functions/${lib}/${name}`;

        tooltip.innerHTML = `
            <div class="nb-hover-sig"><code>${escapeHtml(sig)}</code></div>
            ${desc ? `<div class="nb-hover-desc">${escapeHtml(desc).substring(0, 400)}${desc.length > 400 ? "..." : ""}</div>` : ""}
            <a href="${docsUrl}" class="nb-hover-link" target="_blank">View full docs &rarr;</a>
        `;

        // Position near cursor, clamped to viewport
        const pad = 10;
        tooltip.style.left = Math.min(x + pad, window.innerWidth - 420) + "px";
        tooltip.style.top = (y + pad) + "px";

        // Keep alive when hovering the tooltip itself
        tooltip.addEventListener("mouseenter", () => clearTimeout(this._hoverDismissTimer));
        tooltip.addEventListener("mouseleave", () => {
            this._hoverDismissTimer = setTimeout(() => this._dismissHover(), 300);
        });

        document.body.appendChild(tooltip);
        this._hoverTooltip = tooltip;

        // Auto-dismiss after 8 seconds
        this._hoverDismissTimer = setTimeout(() => this._dismissHover(), 8000);
    }

    _dismissHover() {
        if (this._hoverTooltip) {
            this._hoverTooltip.remove();
            this._hoverTooltip = null;
        }
        this._lastHoverFunc = null;
        clearTimeout(this._hoverDismissTimer);
    }
}

// ---------------------------------------------------------------------------
// File browser / landing page controller (JupyterLab-style)
// ---------------------------------------------------------------------------

class FileBrowser {
    constructor(container) {
        this.container = container;
        this.apiBase = this._resolveApiBase();
        this.isAdmin = container.dataset.isAdmin === "true";
        this.notebooks = [];
        this.selected = new Set();
        this.viewMode = localStorage.getItem("nb-view-mode") || "grid";
        this.sortKey = "modified";
        this.sortAsc = false;
        this.contextMenu = null;

        this.render();
        this.loadNotebooks();
        this._bindGlobalEvents();
    }

    _resolveApiBase() {
        const pathParts = window.location.pathname.split("/apps/notebook");
        return pathParts[0] + "/apps/notebook/api";
    }

    render() {
        this.container.innerHTML = `
            <div class="fb-layout">
                <div class="fb-main">
                    <header class="fb-toolbar">
                        <div class="fb-actions">
                            <button class="nb-btn nb-btn-primary" data-action="new">&#10010; New</button>
                            <button class="nb-btn" data-action="new-collection">&#128193; New Collection</button>
                            <button class="nb-btn" data-action="upload">&#11014; Upload</button>
                            <input type="file" class="fb-upload-input" accept=".ipynb" multiple hidden/>
                            <button class="nb-btn nb-btn-sm" data-bulk="duplicate">Duplicate</button>
                            <button class="nb-btn nb-btn-sm nb-btn-danger" data-bulk="delete">Delete</button>
                            <div class="fb-view-toggle">
                                <button class="nb-btn nb-btn-sm ${this.viewMode === 'grid' ? 'active' : ''}" data-view="grid" title="Grid view">&#9638;</button>
                                <button class="nb-btn nb-btn-sm ${this.viewMode === 'table' ? 'active' : ''}" data-view="table" title="Table view">&#9776;</button>
                            </div>
                        </div>
                    </header>
                    <div class="fb-content"></div>
                    <div class="fb-drop-zone">
                        <div class="fb-drop-message">Drop .ipynb files here to upload</div>
                    </div>
                </div>
            </div>
        `;

        // Wire up toolbar
        this.container.querySelector("[data-action='new']").addEventListener("click", () => this.showNewDialog());
        this.container.querySelector("[data-action='new-collection']").addEventListener("click", () => this.showNewCollectionDialog());
        this.container.querySelector("[data-action='upload']").addEventListener("click", () => {
            this.container.querySelector(".fb-upload-input").click();
        });
        this.container.querySelector(".fb-upload-input").addEventListener("change", (e) => this.handleUpload(e.target.files));

        // View toggle
        this.container.querySelectorAll("[data-view]").forEach(btn => {
            btn.addEventListener("click", () => {
                this.viewMode = btn.dataset.view;
                localStorage.setItem("nb-view-mode", this.viewMode);
                this.container.querySelectorAll("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === this.viewMode));
                this.renderContent();
            });
        });

        // Admin-only buttons — disable for non-admin
        if (!this.isAdmin) {
            for (const sel of ["[data-action='new-collection']", "[data-action='upload']", "[data-bulk='duplicate']", "[data-bulk='delete']"]) {
                const btn = this.container.querySelector(sel);
                if (btn) {
                    btn.disabled = true;
                    btn.title = "Requires admin access";
                }
            }
        }

        // Bulk actions (in toolbar)
        this.container.querySelector("[data-bulk='duplicate']").addEventListener("click", () => {
            if (this.selected.size > 0 && this.isAdmin) this.bulkDuplicate();
        });
        this.container.querySelector("[data-bulk='delete']").addEventListener("click", () => {
            if (this.selected.size > 0 && this.isAdmin) this.bulkDelete();
        });

        // Drag and drop
        const main = this.container.querySelector(".fb-main");
        const dropZone = this.container.querySelector(".fb-drop-zone");
        let dragCounter = 0;
        main.addEventListener("dragenter", (e) => { e.preventDefault(); dragCounter++; dropZone.classList.add("visible"); });
        main.addEventListener("dragleave", () => { dragCounter--; if (dragCounter <= 0) { dropZone.classList.remove("visible"); dragCounter = 0; } });
        main.addEventListener("dragover", (e) => e.preventDefault());
        main.addEventListener("drop", (e) => {
            e.preventDefault();
            dragCounter = 0;
            dropZone.classList.remove("visible");
            if (e.dataTransfer.files.length) this.handleUpload(e.dataTransfer.files);
        });
    }

    async loadNotebooks() {
        try {
            const resp = await fetch(`${this.apiBase}/notebooks`);
            const data = await resp.json();
            this.notebooks = data.notebooks || [];
            this.collections = data.collections || [];
            this.renderContent();
            this._updateBulkBar();
        } catch (err) {
            console.error("Failed to load notebooks:", err);
        }
    }

    renderContent() {
        const content = this.container.querySelector(".fb-content");

        if (this.notebooks.length === 0 && this.collections.length === 0) {
            content.innerHTML = '<div class="nb-empty"><p>No notebooks yet. Click <strong>+ New</strong> or drag a .ipynb file here.</p></div>';
            return;
        }

        if (this.viewMode === "table") {
            this.renderTable(content);
        } else {
            this.renderGrid(content);
        }
    }

    renderGrid(content) {
        let html = "";

        // Standalone notebooks
        if (this.notebooks.length > 0) {
            const sorted = this._sortedNotebooks();
            html += `<div class="nb-grid">${sorted.map(nb => {
                const checked = this.selected.has(nb.path) ? "checked" : "";
                const modified = new Date(nb.modified).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
                return `
                    <div class="nb-card-wrap" data-path="${nb.path}">
                        <label class="nb-card-check"><input type="checkbox" ${checked} data-select="${nb.path}"/></label>
                        <a href="${nb.slug}" class="nb-card">
                            <h3>${escapeHtml(nb.title)}</h3>
                            <div class="nb-card-meta">
                                <span>${nb.cellCount} cells</span>
                                <time>${modified}</time>
                            </div>
                        </a>
                    </div>
                `;
            }).join("")}</div>`;
        }

        // Collections
        if (this.collections.length > 0) {
            if (this.notebooks.length > 0) html += '<h3 class="fb-section-heading">Collections</h3>';
            html += `<div class="nb-grid">${this.collections.map(col => `
                <div class="nb-card-wrap">
                    <a href="${col.path}" class="nb-card nb-card-collection">
                        <h3>${escapeHtml(col.title)}</h3>
                        <div class="nb-card-meta">
                            <span>${col.chapterCount} chapters</span>
                            <span>${col.difficulty || ""}</span>
                        </div>
                        ${col.description ? `<p class="nb-card-desc">${escapeHtml(col.description)}</p>` : ""}
                    </a>
                </div>
            `).join("")}</div>`;
        }

        content.innerHTML = html;
        this._wireContentEvents(content);
    }

    renderTable(content) {
        const arrow = (key) => this.sortKey === key ? (this.sortAsc ? " &#9650;" : " &#9660;") : "";

        // Merge notebooks and collections into a single sortable list
        const allItems = [
            ...this.notebooks.map(nb => ({
                type: "notebook", path: nb.path, slug: nb.slug,
                title: nb.title, count: nb.cellCount, countLabel: nb.cellCount,
                modified: nb.modified, modifiedLabel: new Date(nb.modified).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
            })),
            ...this.collections.map(col => ({
                type: "collection", path: col.path, slug: col.path,
                title: col.title, count: col.chapterCount, countLabel: `${col.chapterCount} ch.`,
                modified: "", modifiedLabel: col.difficulty || ""
            }))
        ];

        // Sort the merged list
        const key = this.sortKey;
        const dir = this.sortAsc ? 1 : -1;
        allItems.sort((a, b) => {
            let va = key === "title" ? a.title.toLowerCase()
                   : key === "cellCount" ? a.count
                   : key === "modified" ? (a.modified ? new Date(a.modified) : new Date(0))
                   : a.title.toLowerCase();
            let vb = key === "title" ? b.title.toLowerCase()
                   : key === "cellCount" ? b.count
                   : key === "modified" ? (b.modified ? new Date(b.modified) : new Date(0))
                   : b.title.toLowerCase();
            if (va < vb) return -dir;
            if (va > vb) return dir;
            return 0;
        });

        const rows = allItems.map(item => {
            if (item.type === "notebook") {
                const checked = this.selected.has(item.path) ? "checked" : "";
                return `<tr data-path="${item.path}">
                    <td><input type="checkbox" ${checked} data-select="${item.path}"/></td>
                    <td><a href="${item.slug}">${escapeHtml(item.title)}</a></td>
                    <td>${item.countLabel}</td>
                    <td><time>${item.modifiedLabel}</time></td>
                </tr>`;
            } else {
                return `<tr class="fb-table-collection">
                    <td></td>
                    <td><a href="${item.slug}">${escapeHtml(item.title)}</a> <span class="fb-table-badge">${item.count} chapters</span></td>
                    <td>${item.countLabel}</td>
                    <td>${item.modifiedLabel}</td>
                </tr>`;
            }
        }).join("");

        content.innerHTML = `
            <table class="fb-table">
                <thead><tr>
                    <th class="fb-th-check"><input type="checkbox" class="fb-select-all"/></th>
                    <th class="fb-th-sort" data-sort="title">Name${arrow("title")}</th>
                    <th class="fb-th-sort" data-sort="cellCount">Cells${arrow("cellCount")}</th>
                    <th class="fb-th-sort" data-sort="modified">Modified${arrow("modified")}</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;

        content.querySelectorAll("[data-sort]").forEach(th => {
            th.addEventListener("click", () => {
                const key = th.dataset.sort;
                if (this.sortKey === key) this.sortAsc = !this.sortAsc;
                else { this.sortKey = key; this.sortAsc = true; }
                this.renderContent();
            });
        });

        content.querySelector(".fb-select-all")?.addEventListener("change", (e) => {
            if (e.target.checked) this.notebooks.forEach(nb => this.selected.add(nb.path));
            else this.selected.clear();
            this.renderContent();
            this._updateBulkBar();
        });

        this._wireContentEvents(content);
    }

    _wireContentEvents(content) {
        // Checkboxes
        content.querySelectorAll("[data-select]").forEach(cb => {
            cb.addEventListener("change", () => {
                if (cb.checked) this.selected.add(cb.dataset.select);
                else this.selected.delete(cb.dataset.select);
                this._updateBulkBar();
            });
        });

        // Context menu
        content.querySelectorAll("[data-path]").forEach(el => {
            el.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                this.showContextMenu(e, el.dataset.path);
            });
        });
    }

    _updateBulkBar() {
        const hasSelection = this.selected.size > 0;
        const dupBtn = this.container.querySelector("[data-bulk='duplicate']");
        const delBtn = this.container.querySelector("[data-bulk='delete']");
        if (!this.isAdmin) {
            dupBtn.disabled = true;
            delBtn.disabled = true;
            dupBtn.title = "Requires admin access";
            delBtn.title = "Requires admin access";
        } else {
            dupBtn.disabled = !hasSelection;
            delBtn.disabled = !hasSelection;
            dupBtn.title = hasSelection ? `Duplicate ${this.selected.size} selected` : "Select notebooks first";
            delBtn.title = hasSelection ? `Delete ${this.selected.size} selected` : "Select notebooks first";
        }
    }

    _sortedNotebooks() {
        const key = this.sortKey;
        const dir = this.sortAsc ? 1 : -1;
        return [...this.notebooks].sort((a, b) => {
            let va = a[key], vb = b[key];
            if (key === "modified") { va = new Date(va); vb = new Date(vb); }
            if (key === "title") { va = va.toLowerCase(); vb = vb.toLowerCase(); }
            if (va < vb) return -dir;
            if (va > vb) return dir;
            return 0;
        });
    }

    // --- Context menu ---

    showContextMenu(e, path) {
        this.hideContextMenu();
        const nb = this.notebooks.find(n => n.path === path);
        if (!nb) return;

        const menu = document.createElement("div");
        menu.className = "fb-context-menu";
        menu.style.left = e.pageX + "px";
        menu.style.top = e.pageY + "px";
        menu.innerHTML = `
            <button data-ctx="open">Open</button>
            <button data-ctx="rename">Rename</button>
            <button data-ctx="duplicate">Duplicate</button>
            <button data-ctx="download">Download</button>
            <hr/>
            <button data-ctx="delete" class="danger">Delete</button>
        `;

        menu.addEventListener("click", async (ev) => {
            const action = ev.target.dataset.ctx;
            this.hideContextMenu();
            switch (action) {
                case "open": window.location.href = path.replace(/\.ipynb$/, ""); break;
                case "rename": this.showRenameDialog(nb); break;
                case "duplicate": await this.duplicateNotebook(path); break;
                case "download": this.downloadNotebook(nb); break;
                case "delete": await this.deleteNotebook(path); break;
            }
        });

        document.body.appendChild(menu);
        this.contextMenu = menu;
    }

    hideContextMenu() {
        if (this.contextMenu) { this.contextMenu.remove(); this.contextMenu = null; }
    }

    // --- Operations ---

    showNewDialog() {
        const overlay = document.createElement("div");
        overlay.className = "nb-dialog-overlay";
        const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").trim();
        overlay.innerHTML = `
            <div class="nb-dialog">
                <h2>New Notebook</h2>
                ${!this.isAdmin ? `
                    <p class="nb-dialog-warning">You are not logged in as admin. Your notebook will only exist in the current session and won't save to disk. Use the <strong>Download</strong> button to save your work.</p>
                ` : ""}
                <div class="nb-dialog-field">
                    <label for="nb-title">Title</label>
                    <input type="text" id="nb-title" placeholder="My Notebook" autofocus/>
                    <span class="nb-dialog-preview" id="nb-filename-preview"></span>
                </div>
                <div class="nb-dialog-actions">
                    <button class="nb-btn" data-action="cancel">Cancel</button>
                    <button class="nb-btn nb-btn-primary" data-action="create">Create</button>
                </div>
            </div>
        `;
        const input = overlay.querySelector("#nb-title");
        const preview = overlay.querySelector("#nb-filename-preview");
        input.addEventListener("input", () => {
            const slug = slugify(input.value.trim());
            preview.textContent = slug ? slug + ".ipynb" : "";
        });
        const create = async () => {
            const title = input.value.trim() || "Untitled";

            if (!this.isAdmin) {
                // Non-admin: create a local-only notebook in the browser
                const slug = slugify(title) || "untitled";
                const notebook = {
                    nbformat: 4, nbformat_minor: 5,
                    metadata: { kernelspec: { display_name: "XQuery (eXist-db)", language: "xquery", name: "xquery-exist" }, language_info: { name: "xquery", version: "4.0", file_extension: ".xq" }, title },
                    cells: [
                        { cell_type: "markdown", metadata: {}, source: "# " + title + "\n" },
                        { cell_type: "code", metadata: {}, source: "", execution_count: null, outputs: [] }
                    ]
                };
                // Store in sessionStorage so the editor can pick it up
                sessionStorage.setItem("nb-local-" + slug, JSON.stringify(notebook));
                overlay.remove();
                window.location.href = slug + "?local=1";
                return;
            }

            try {
                const resp = await fetch(`${this.apiBase}/notebooks`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title })
                });
                const result = await resp.json();
                overlay.remove();
                if (result.description && /permission|not have write access/i.test(result.description)) {
                    alert("Save failed: " + result.description);
                    return;
                }
                if (result.slug) window.location.href = result.slug;
                else if (result.path) window.location.href = result.path.replace(/\.ipynb$/, "");
            } catch (err) {
                overlay.remove();
                alert("Failed to create notebook: " + err.message);
            }
        };
        overlay.addEventListener("click", (e) => {
            const a = e.target.closest("[data-action]")?.dataset.action;
            if (a === "cancel" || e.target === overlay) overlay.remove();
            if (a === "create") create();
        });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); if (e.key === "Escape") overlay.remove(); });
        document.body.appendChild(overlay);
        input.focus();
    }

    showRenameDialog(nb) {
        const overlay = document.createElement("div");
        overlay.className = "nb-dialog-overlay";
        const currentName = nb.path.replace(/\.ipynb$/, "");
        overlay.innerHTML = `
            <div class="nb-dialog">
                <h2>Rename Notebook</h2>
                <div class="nb-dialog-field">
                    <label for="nb-rename">Filename</label>
                    <input type="text" id="nb-rename" value="${currentName}" autofocus/>
                </div>
                <div class="nb-dialog-actions">
                    <button class="nb-btn" data-action="cancel">Cancel</button>
                    <button class="nb-btn nb-btn-primary" data-action="rename">Rename</button>
                </div>
            </div>
        `;
        const input = overlay.querySelector("#nb-rename");
        input.select();
        const doRename = async () => {
            const newName = input.value.trim();
            if (!newName || newName === currentName) { overlay.remove(); return; }
            const resp = await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(nb.path)}/rename`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: newName })
            });
            overlay.remove();
            await this.loadNotebooks();
        };
        overlay.addEventListener("click", (e) => {
            const a = e.target.closest("[data-action]")?.dataset.action;
            if (a === "cancel" || e.target === overlay) overlay.remove();
            if (a === "rename") doRename();
        });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") doRename(); if (e.key === "Escape") overlay.remove(); });
        document.body.appendChild(overlay);
        input.focus();
    }

    showNewCollectionDialog() {
        const overlay = document.createElement("div");
        overlay.className = "nb-dialog-overlay";
        overlay.innerHTML = `
            <div class="nb-dialog nb-dialog-wide">
                <h2>New Collection</h2>
                <div class="nb-dialog-field">
                    <label for="nc-title">Title</label>
                    <input type="text" id="nc-title" placeholder="My Tutorial Series" autofocus/>
                </div>
                <div class="nb-dialog-field">
                    <label for="nc-desc">Description</label>
                    <input type="text" id="nc-desc" placeholder="A brief description..."/>
                </div>
                <div class="nb-dialog-field">
                    <label for="nc-authors">Authors</label>
                    <input type="text" id="nc-authors" placeholder="Author Name (comma-separated)"/>
                </div>
                <div class="nb-dialog-field">
                    <label for="nc-difficulty">Difficulty</label>
                    <select id="nc-difficulty">
                        <option value="beginner">Beginner</option>
                        <option value="intermediate" selected>Intermediate</option>
                        <option value="advanced">Advanced</option>
                    </select>
                </div>
                <div class="nb-dialog-actions">
                    <button class="nb-btn" data-action="cancel">Cancel</button>
                    <button class="nb-btn nb-btn-primary" data-action="create">Create</button>
                </div>
            </div>
        `;
        const doCreate = async () => {
            const title = overlay.querySelector("#nc-title").value.trim();
            if (!title) return;
            const authors = overlay.querySelector("#nc-authors").value.split(",").map(s => s.trim()).filter(Boolean);
            const resp = await fetch(`${this.apiBase}/collections`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title,
                    description: overlay.querySelector("#nc-desc").value.trim(),
                    authors,
                    difficulty: overlay.querySelector("#nc-difficulty").value,
                })
            });
            const result = await resp.json();
            overlay.remove();
            if (result.path) window.location.href = result.path;
        };
        overlay.addEventListener("click", (e) => {
            const a = e.target.closest("[data-action]")?.dataset.action;
            if (a === "cancel" || e.target === overlay) overlay.remove();
            if (a === "create") doCreate();
        });
        overlay.querySelector("#nc-title").addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.remove(); });
        document.body.appendChild(overlay);
        overlay.querySelector("#nc-title").focus();
    }

    async duplicateNotebook(path) {
        await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(path)}/duplicate`, { method: "POST" });
        await this.loadNotebooks();
    }

    async deleteNotebook(path) {
        if (!confirm("Delete this notebook? This cannot be undone.")) return;
        await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(path)}`, { method: "DELETE" });
        this.selected.delete(path);
        await this.loadNotebooks();
        this._updateBulkBar();
    }

    downloadNotebook(nb) {
        const url = `${this.apiBase}/notebooks/${encodeURIComponent(nb.path)}`;
        fetch(url).then(r => r.json()).then(data => {
            const json = JSON.stringify(data, null, 4);
            const blob = new Blob([json], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = nb.path;
            a.click();
            URL.revokeObjectURL(a.href);
        });
    }

    async handleUpload(files) {
        for (const file of files) {
            if (!file.name.endsWith(".ipynb")) continue;
            const text = await file.text();
            try {
                JSON.parse(text); // validate JSON
                await fetch(`${this.apiBase}/notebooks/upload`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ filename: file.name, content: text })
                });
            } catch (err) {
                console.error("Upload failed:", file.name, err);
            }
        }
        await this.loadNotebooks();
    }

    async bulkDuplicate() {
        for (const path of this.selected) {
            await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(path)}/duplicate`, { method: "POST" });
        }
        this.selected.clear();
        await this.loadNotebooks();
        this._updateBulkBar();
    }

    async bulkDelete() {
        if (!confirm(`Delete ${this.selected.size} notebook(s)? This cannot be undone.`)) return;
        for (const path of this.selected) {
            await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(path)}`, { method: "DELETE" });
        }
        this.selected.clear();
        await this.loadNotebooks();
        this._updateBulkBar();
    }

    _bindGlobalEvents() {
        document.addEventListener("click", () => this.hideContextMenu());
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.hideContextMenu(); });
    }
}

// ---------------------------------------------------------------------------
// Collection editor (for collection landing pages)
// ---------------------------------------------------------------------------

class CollectionEditor {
    constructor(collectionPath, apiBase) {
        this.collectionPath = collectionPath;
        this.apiBase = apiBase;
        this.manifest = null;
    }

    async show() {
        const resp = await fetch(`${this.apiBase}/collections/${encodeURIComponent(this.collectionPath)}`);
        this.manifest = await resp.json();
        this.renderDialog();
    }

    renderDialog() {
        const m = this.manifest;
        const overlay = document.createElement("div");
        overlay.className = "nb-dialog-overlay";
        overlay.innerHTML = `
            <div class="nb-dialog nb-dialog-wide">
                <h2>Edit Collection</h2>
                <div class="nb-dialog-field">
                    <label for="ce-title">Title</label>
                    <input type="text" id="ce-title" value="${escapeHtml(m.title || "")}"/>
                </div>
                <div class="nb-dialog-field">
                    <label for="ce-desc">Description</label>
                    <input type="text" id="ce-desc" value="${escapeHtml(m.description || "")}"/>
                </div>
                <div class="nb-dialog-field">
                    <label for="ce-authors">Authors (comma-separated)</label>
                    <input type="text" id="ce-authors" value="${m.authors ? (Array.isArray(m.authors) ? m.authors.join(", ") : m.authors) : ""}"/>
                </div>
                <div class="nb-dialog-field">
                    <label for="ce-difficulty">Difficulty</label>
                    <select id="ce-difficulty">
                        <option value="beginner" ${m.difficulty === "beginner" ? "selected" : ""}>Beginner</option>
                        <option value="intermediate" ${m.difficulty === "intermediate" ? "selected" : ""}>Intermediate</option>
                        <option value="advanced" ${m.difficulty === "advanced" ? "selected" : ""}>Advanced</option>
                    </select>
                </div>
                <div class="nb-dialog-field">
                    <label>Chapter Order</label>
                    <p class="admin-hint">Drag to reorder. Changes are saved when you click Save.</p>
                    <ul id="ce-chapters" class="ce-chapter-list">
                        ${m.chapters.map((ch, i) => `
                            <li class="ce-chapter-item" draggable="true" data-idx="${i}">
                                <span class="ce-drag-handle">&#9776;</span>
                                <span class="ce-chapter-title">${escapeHtml(ch.title)}</span>
                                <span class="ce-chapter-file">${ch.file}</span>
                                <button class="nb-btn-icon nb-btn-danger ce-remove-btn" data-remove="${i}" title="Remove from collection">&#10005;</button>
                            </li>
                        `).join("")}
                    </ul>
                </div>
                <div class="nb-dialog-actions">
                    <button class="nb-btn" data-action="cancel">Cancel</button>
                    <button class="nb-btn nb-btn-primary" data-action="save">Save</button>
                </div>
            </div>
        `;

        this.overlay = overlay;
        this._wireDragDrop(overlay);
        this._wireRemove(overlay);

        overlay.addEventListener("click", (e) => {
            const a = e.target.closest("[data-action]")?.dataset.action;
            if (a === "cancel" || e.target === overlay) overlay.remove();
            if (a === "save") this.save(overlay);
        });

        document.body.appendChild(overlay);
    }

    _wireDragDrop(overlay) {
        const list = overlay.querySelector("#ce-chapters");
        let dragItem = null;

        list.addEventListener("dragstart", (e) => {
            dragItem = e.target.closest(".ce-chapter-item");
            if (dragItem) {
                dragItem.classList.add("dragging");
                e.dataTransfer.effectAllowed = "move";
            }
        });

        list.addEventListener("dragend", () => {
            if (dragItem) dragItem.classList.remove("dragging");
            dragItem = null;
        });

        list.addEventListener("dragover", (e) => {
            e.preventDefault();
            const target = e.target.closest(".ce-chapter-item");
            if (target && target !== dragItem) {
                const rect = target.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    list.insertBefore(dragItem, target);
                } else {
                    list.insertBefore(dragItem, target.nextSibling);
                }
            }
        });
    }

    _wireRemove(overlay) {
        overlay.querySelectorAll("[data-remove]").forEach(btn => {
            btn.addEventListener("click", () => {
                btn.closest(".ce-chapter-item").remove();
            });
        });
    }

    async save(overlay) {
        const chapters = [];
        overlay.querySelectorAll(".ce-chapter-item").forEach(li => {
            const idx = parseInt(li.dataset.idx);
            const ch = this.manifest.chapters[idx];
            if (ch) chapters.push(ch);
        });

        const authors = overlay.querySelector("#ce-authors").value.split(",").map(s => s.trim()).filter(Boolean);

        const updated = {
            title: overlay.querySelector("#ce-title").value.trim(),
            description: overlay.querySelector("#ce-desc").value.trim(),
            authors,
            difficulty: overlay.querySelector("#ce-difficulty").value,
            chapters,
        };

        await fetch(`${this.apiBase}/collections/${encodeURIComponent(this.collectionPath)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updated),
        });

        overlay.remove();
        window.location.reload();
    }
}

// ---------------------------------------------------------------------------
// Admin panel controller
// ---------------------------------------------------------------------------

class AdminPanel {
    constructor(container) {
        this.container = container;
        this.apiBase = this._resolveApiBase();
        this.render();
        this.loadData();
    }

    _resolveApiBase() {
        const pathParts = window.location.pathname.split("/apps/notebook");
        return pathParts[0] + "/apps/notebook/api";
    }

    render() {
        this.container.innerHTML = `
            <h2>Cache Management</h2>
            <div class="admin-section">
                <h3>Cache Configuration (defaults for new caches)</h3>
                <div class="admin-config" id="admin-config">Loading...</div>
            </div>
            <div class="admin-section">
                <h3>Active Caches
                    <button class="nb-btn nb-btn-sm nb-btn-danger" id="admin-clear-all">Destroy All</button>
                    <button class="nb-btn nb-btn-sm" id="admin-refresh">Refresh</button>
                </h3>
                <div id="admin-caches">Loading...</div>
            </div>

            <h2>Version Snapshots</h2>
            <div class="admin-section">
                <h3>Saved Versions
                    <button class="nb-btn nb-btn-sm" id="admin-purge-old">Purge Old (keep latest)</button>
                    <button class="nb-btn nb-btn-sm nb-btn-danger" id="admin-delete-all-versions">Delete All</button>
                    <button class="nb-btn nb-btn-sm" id="admin-refresh-versions">Refresh</button>
                </h3>
                <div id="admin-versions">Loading...</div>
            </div>

            <h2>Export</h2>
            <div class="admin-section">
                <p>Download all notebooks as a single JSON file for backup or migration.</p>
                <button class="nb-btn nb-btn-primary" id="admin-export">&#11015; Export All Notebooks</button>
            </div>
        `;

        this.container.querySelector("#admin-clear-all").addEventListener("click", () => this.clearAll());
        this.container.querySelector("#admin-refresh").addEventListener("click", () => this.loadData());
        this.container.querySelector("#admin-purge-old").addEventListener("click", () => this.purgeOldVersions());
        this.container.querySelector("#admin-delete-all-versions").addEventListener("click", () => this.deleteAllVersions());
        this.container.querySelector("#admin-refresh-versions").addEventListener("click", () => this.loadVersions());
        this.container.querySelector("#admin-export").addEventListener("click", () => this.exportAll());
    }

    async loadData() {
        try {
            const [configResp, cachesResp] = await Promise.all([
                fetch(`${this.apiBase}/admin/config`),
                fetch(`${this.apiBase}/admin/caches`)
            ]);
            const config = await configResp.json();
            const caches = await cachesResp.json();
            this.renderConfig(config);
            this.renderCaches(caches);
        } catch (err) {
            this.container.querySelector("#admin-caches").textContent = "Failed to load: " + err.message;
        }
        this.loadVersions();
    }

    renderConfig(config) {
        const el = this.container.querySelector("#admin-config");
        const c = config.cache;
        const v = config.versioning;
        el.innerHTML = `
            <table class="admin-table">
                <tbody>
                    <tr><td>Max cells per session</td><td><strong>${c.maxCells}</strong></td></tr>
                    <tr><td>Cache expiry (inactivity)</td><td><strong>${(c.expireMs / 60000).toFixed(0)} minutes</strong> (${c.expireMs} ms)</td></tr>
                    <tr><td>Max concurrent sessions</td><td><strong>${c.maxSessions}</strong> (oldest evicted when exceeded)</td></tr>
                    <tr><td>Cache prefix</td><td><code>${c.prefix}</code></td></tr>
                    <tr><td>Max version snapshots</td><td><strong>${v.maxVersions}</strong></td></tr>
                </tbody>
            </table>
            <p class="admin-hint">To change defaults, edit <a href="${this.apiBase.replace('/apps/notebook/api', '/apps/eXide/index.html')}?open=/db/apps/notebook/modules/config.xqm" target="_blank"><code>modules/config.xqm</code></a> in eXide.</p>
        `;
    }

    renderCaches(data) {
        const el = this.container.querySelector("#admin-caches");
        if (data.totalCaches === 0) {
            el.innerHTML = '<p class="admin-empty">No active notebook caches.</p>';
            return;
        }

        el.innerHTML = `
            <p>${data.totalCaches} active session cache${data.totalCaches !== 1 ? "s" : ""}
                <button class="nb-btn nb-btn-sm" id="admin-caches-show-all">Show All</button>
                <button class="nb-btn nb-btn-sm" id="admin-caches-hide-all" hidden>Hide All</button>
            </p>
            <div class="admin-cache-list">
                ${data.caches.map(c => `
                    <div class="admin-cache-item" data-cache="${c.name}">
                        <div class="admin-cache-header">
                            <span class="admin-cache-name">${c.sessionId}</span>
                            <span class="admin-cache-count">${c.entryCount} entries</span>
                            <button class="nb-btn nb-btn-sm" data-action="expand">Show</button>
                            <button class="nb-btn nb-btn-sm" data-action="clear">Clear</button>
                            <button class="nb-btn nb-btn-sm nb-btn-danger" data-action="destroy">Destroy</button>
                        </div>
                        <div class="admin-cache-detail" hidden></div>
                    </div>
                `).join("")}
            </div>
        `;

        const showAllBtn = el.querySelector("#admin-caches-show-all");
        const hideAllBtn = el.querySelector("#admin-caches-hide-all");
        showAllBtn.addEventListener("click", () => {
            el.querySelectorAll("[data-cache]").forEach(item => {
                const name = item.dataset.cache;
                const detail = item.querySelector(".admin-cache-detail");
                if (detail.hidden) this.expandCache(name, item);
            });
            showAllBtn.hidden = true;
            hideAllBtn.hidden = false;
        });
        hideAllBtn.addEventListener("click", () => {
            el.querySelectorAll(".admin-cache-detail").forEach(d => d.hidden = true);
            showAllBtn.hidden = false;
            hideAllBtn.hidden = true;
        });

        el.querySelectorAll("[data-action]").forEach(btn => {
            const item = btn.closest("[data-cache]");
            const name = item.dataset.cache;
            btn.addEventListener("click", () => {
                switch (btn.dataset.action) {
                    case "expand": this.expandCache(name, item); break;
                    case "clear": this.clearCache(name); break;
                    case "destroy": this.destroyCache(name); break;
                }
            });
        });
    }

    async expandCache(name, item) {
        const detail = item.querySelector(".admin-cache-detail");
        if (!detail.hidden) { detail.hidden = true; return; }

        try {
            const resp = await fetch(`${this.apiBase}/admin/caches/${encodeURIComponent(name)}`);
            const data = await resp.json();

            detail.innerHTML = `
                <table class="admin-table admin-table-entries">
                    <thead><tr><th>Key</th><th>Type</th><th>Preview</th><th></th></tr></thead>
                    <tbody>
                        ${data.entries.map(e => `
                            <tr>
                                <td><code>${escapeHtml(e.key)}</code></td>
                                <td>${e.type}</td>
                                <td class="admin-preview">${escapeHtml(e.preview)}</td>
                                <td><button class="nb-btn nb-btn-sm nb-btn-danger" data-remove-key="${e.key}">Remove</button></td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            `;

            detail.querySelectorAll("[data-remove-key]").forEach(btn => {
                btn.addEventListener("click", async () => {
                    await fetch(`${this.apiBase}/admin/caches/${encodeURIComponent(name)}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ key: btn.dataset.removeKey })
                    });
                    // Re-expand this cache detail instead of full reload
                    detail.hidden = true;
                    this.expandCache(name, item);
                    // Update entry count in header
                    const countEl = item.querySelector(".admin-cache-count");
                    if (countEl) {
                        const n = Math.max(0, parseInt(countEl.textContent) - 1);
                        countEl.textContent = `${n} entries`;
                    }
                });
            });

            detail.hidden = false;
        } catch (err) {
            detail.innerHTML = `<p>Error: ${err.message}</p>`;
            detail.hidden = false;
        }
    }

    async clearCache(name) {
        await fetch(`${this.apiBase}/admin/caches/${encodeURIComponent(name)}`, { method: "PUT" });
        this.loadData();
    }

    async destroyCache(name) {
        if (!confirm("Destroy this cache? Active sessions using it will lose cached results.")) return;
        await fetch(`${this.apiBase}/admin/caches/${encodeURIComponent(name)}`, { method: "DELETE" });
        this.loadData();
    }

    async clearAll() {
        if (!confirm("Destroy ALL notebook caches? All active sessions will lose cached results.")) return;
        await fetch(`${this.apiBase}/admin/caches`, { method: "DELETE" });
        this.loadData();
    }

    // --- Versions ---

    async loadVersions() {
        const el = this.container.querySelector("#admin-versions");
        try {
            const resp = await fetch(`${this.apiBase}/admin/versions`);
            const data = await resp.json();
            this.renderVersions(data);
        } catch (err) {
            el.textContent = "Failed to load: " + err.message;
        }
    }

    renderVersions(data) {
        const el = this.container.querySelector("#admin-versions");
        const formatSize = (bytes) => {
            if (bytes < 1024) return bytes + " B";
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
            return (bytes / (1024 * 1024)).toFixed(1) + " MB";
        };
        const formatDate = (ts) => {
            try { return new Date(ts).toLocaleString(); } catch { return ts; }
        };

        if (data.totalVersions === 0) {
            el.innerHTML = '<p class="admin-empty">No version snapshots stored.</p>';
            return;
        }

        el.innerHTML = `
            <p>${data.totalVersions} snapshot${data.totalVersions !== 1 ? "s" : ""} across ${data.notebooks.length} notebook${data.notebooks.length !== 1 ? "s" : ""} (${formatSize(data.totalSize)} total)
                <button class="nb-btn nb-btn-sm" id="admin-versions-show-all">Show All</button>
                <button class="nb-btn nb-btn-sm" id="admin-versions-hide-all" hidden>Hide All</button>
            </p>
            <div class="admin-cache-list">
                ${data.notebooks.map(nb => `
                    <div class="admin-cache-item" data-nb="${nb.notebookFile}">
                        <div class="admin-cache-header">
                            <span class="admin-cache-name">${escapeHtml(nb.notebook)}</span>
                            <span class="admin-cache-count">${nb.count} version${nb.count !== 1 ? "s" : ""} (${formatSize(nb.totalSize)})</span>
                            <button class="nb-btn nb-btn-sm" data-action="expand-versions">Show</button>
                            <button class="nb-btn nb-btn-sm nb-btn-danger" data-action="delete-nb-versions">Delete All</button>
                        </div>
                        <div class="admin-version-detail" hidden></div>
                    </div>
                `).join("")}
            </div>
        `;

        const showAllBtn = el.querySelector("#admin-versions-show-all");
        const hideAllBtn = el.querySelector("#admin-versions-hide-all");
        showAllBtn.addEventListener("click", () => {
            el.querySelectorAll("[data-nb]").forEach(item => {
                const nbFile = item.dataset.nb;
                const nb = data.notebooks.find(n => n.notebookFile === nbFile);
                const detail = item.querySelector(".admin-version-detail");
                if (detail.hidden) this.toggleVersionDetail(item, nb, formatDate, formatSize);
            });
            showAllBtn.hidden = true;
            hideAllBtn.hidden = false;
        });
        hideAllBtn.addEventListener("click", () => {
            el.querySelectorAll(".admin-version-detail").forEach(d => d.hidden = true);
            showAllBtn.hidden = false;
            hideAllBtn.hidden = true;
        });

        el.querySelectorAll("[data-action]").forEach(btn => {
            const item = btn.closest("[data-nb]");
            const nbFile = item.dataset.nb;
            const nb = data.notebooks.find(n => n.notebookFile === nbFile);
            btn.addEventListener("click", () => {
                if (btn.dataset.action === "expand-versions") {
                    this.toggleVersionDetail(item, nb, formatDate, formatSize);
                } else if (btn.dataset.action === "delete-nb-versions") {
                    this.deleteVersionsFor(nbFile);
                }
            });
        });
    }

    toggleVersionDetail(item, nb, formatDate, formatSize) {
        const detail = item.querySelector(".admin-version-detail");
        if (!detail.hidden) { detail.hidden = true; return; }

        detail.innerHTML = `
            <table class="admin-table admin-table-entries">
                <thead><tr><th>Date</th><th>Size</th><th></th></tr></thead>
                <tbody>
                    ${nb.versions.map(v => `
                        <tr>
                            <td>${formatDate(v.modified)}</td>
                            <td>${formatSize(v.size)}</td>
                            <td>
                                <button class="nb-btn nb-btn-sm" data-download-version="${v.filename}">Download</button>
                                <button class="nb-btn nb-btn-sm nb-btn-danger" data-delete-version="${v.filename}">Delete</button>
                            </td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        `;

        detail.querySelectorAll("[data-delete-version]").forEach(btn => {
            btn.addEventListener("click", async () => {
                await fetch(`${this.apiBase}/admin/versions/${encodeURIComponent(btn.dataset.deleteVersion)}`, { method: "DELETE" });
                // Remove the row and update count
                btn.closest("tr").remove();
                const remaining = detail.querySelectorAll("tbody tr").length;
                const countEl = item.querySelector(".admin-cache-count");
                if (countEl) countEl.textContent = `${remaining} version${remaining !== 1 ? "s" : ""}`;
                if (remaining === 0) {
                    detail.hidden = true;
                    this.loadVersions();
                }
            });
        });

        detail.querySelectorAll("[data-download-version]").forEach(btn => {
            btn.addEventListener("click", () => {
                const filename = btn.dataset.downloadVersion;
                const url = `${this.apiBase.replace("/api", "")}/data/versions/${filename}`;
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                a.click();
            });
        });

        detail.hidden = false;
    }

    async deleteVersionsFor(nbFile) {
        if (!confirm(`Delete all version snapshots for ${nbFile}?`)) return;
        await fetch(`${this.apiBase}/admin/versions/notebook/${encodeURIComponent(nbFile)}`, { method: "DELETE" });
        this.loadVersions();
    }

    async purgeOldVersions() {
        if (!confirm("Delete old version snapshots? The most recent snapshot for each notebook will be kept.")) return;
        const resp = await fetch(`${this.apiBase}/admin/versions?keep=1`, { method: "DELETE" });
        const result = await resp.json();
        this.loadVersions();
    }

    async deleteAllVersions() {
        if (!confirm("Delete ALL version snapshots, including the most recent? This cannot be undone.")) return;
        await fetch(`${this.apiBase}/admin/versions?keep=0`, { method: "DELETE" });
        this.loadVersions();
    }

    // --- Export ---

    async exportAll() {
        try {
            const resp = await fetch(`${this.apiBase}/admin/export`);
            const data = await resp.json();
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const date = new Date().toISOString().slice(0, 10);
            a.download = `notebooks-export-${date}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Export failed:", err);
        }
    }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function init() {
    // Notebook editor page
    const editorEl = document.getElementById("notebook-editor");
    if (editorEl) {
        const isLocal = editorEl.dataset.local === "true";
        let notebook, path;

        if (isLocal) {
            // Local-only notebook — load from sessionStorage
            const slug = editorEl.dataset.slug;
            const stored = sessionStorage.getItem("nb-local-" + slug);
            if (stored) {
                notebook = JSON.parse(stored);
                path = editorEl.dataset.path;
            } else {
                // No stored data — create a minimal notebook
                notebook = {
                    nbformat: 4, nbformat_minor: 5,
                    metadata: {},
                    cells: [
                        { cell_type: "markdown", metadata: {}, source: "# Untitled\n" },
                        { cell_type: "code", metadata: {}, source: "", execution_count: null, outputs: [] }
                    ]
                };
                path = editorEl.dataset.path;
            }
        } else {
            const dataScript = document.getElementById("notebook-data");
            if (!dataScript) return;
            notebook = JSON.parse(dataScript.textContent);
            path = editorEl.dataset.path;
        }

        const editor = new NotebookEditor(editorEl, notebook, path);

        // For local notebooks, override save to warn
        if (isLocal) {
            editor._isLocal = true;
            const origSave = editor.save.bind(editor);
            editor.save = async function() {
                // Try saving — if it fails with permission error, save to sessionStorage instead
                const nb = this._serializeNotebook();
                try {
                    const resp = await fetch(`${this.apiBase}/notebooks/${encodeURIComponent(this.path)}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(nb)
                    });
                    const result = await resp.json();
                    if (result.saved) {
                        this.modified = false;
                        this._updateStatus("Saved to server");
                        return;
                    }
                } catch {}
                // Save to sessionStorage as fallback
                const slug = editorEl.dataset.slug;
                sessionStorage.setItem("nb-local-" + slug, JSON.stringify(nb));
                this.modified = false;
                this._updateStatus("Saved to browser (session only \u2014 use Download to keep)");
            };
        }
        return;
    }

    // File browser / landing page
    const browserEl = document.getElementById("nb-file-browser");
    if (browserEl) {
        new FileBrowser(browserEl);
        return;
    }

    // Collection landing page — edit button
    const editColBtn = document.getElementById("edit-collection-btn");
    if (editColBtn) {
        const colEl = document.querySelector(".nb-collection-landing");
        const collectionPath = colEl?.dataset.collection;
        if (collectionPath) {
            const pathParts = window.location.pathname.split("/apps/notebook");
            const apiBase = pathParts[0] + "/apps/notebook/api";
            editColBtn.addEventListener("click", () => {
                new CollectionEditor(collectionPath, apiBase).show();
            });
        }
        return;
    }

    // Admin panel
    const adminEl = document.getElementById("nb-admin");
    if (adminEl) {
        new AdminPanel(adminEl);
    }
}

// Run on DOM ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
