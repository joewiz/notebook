#!/usr/bin/env node

/**
 * Migrate content from the old notebook app (markdown + fenced code blocks)
 * to notebook2's .ipynb format with folder-based collections.
 *
 * Books become folders with _notebook.json manifests.
 * Standalone .md files become top-level .ipynb files.
 *
 * Usage: node tools/migrate-content.js [--source ../notebook/data] [--output ./data]
 */

const fs = require("fs");
const path = require("path");
const commandLineArgs = require("command-line-args");

const args = commandLineArgs([
    { name: "source", type: String, defaultValue: path.resolve(__dirname, "../../notebook/data") },
    { name: "output", type: String, defaultValue: path.resolve(__dirname, "../data") },
    { name: "dry-run", type: Boolean, defaultValue: false },
]);

const DEFAULT_METADATA = {
    kernelspec: {
        display_name: "XQuery (eXist-db)",
        language: "xquery",
        name: "xquery-exist",
    },
    language_info: {
        name: "xquery",
        version: "4.0",
        file_extension: ".xq",
    },
};

/**
 * Parse a markdown file into an array of cells.
 */
function parseMarkdown(source) {
    const lines = source.split("\n");
    const cells = [];
    let mdBuffer = [];
    let inFence = false;
    let fenceLang = "";
    let fenceAttrs = {};
    let codeBuffer = [];

    function flushMarkdown() {
        const text = mdBuffer.join("\n").trim();
        if (text) {
            cells.push({ cell_type: "markdown", metadata: {}, source: text });
        }
        mdBuffer = [];
    }

    for (const line of lines) {
        const fenceOpen = line.match(/^```(\w+)(?:\s+\{([^}]*)\})?\s*$/);
        const fenceClose = /^```\s*$/.test(line);

        if (inFence) {
            if (fenceClose) {
                inFence = false;
                const code = codeBuffer.join("\n");
                const lang = fenceLang.toLowerCase();

                if (lang === "xquery") {
                    const metadata = {};
                    if (Object.keys(fenceAttrs).length > 0) {
                        metadata.exist = { serialization: {} };
                        for (const [k, v] of Object.entries(fenceAttrs)) {
                            metadata.exist.serialization[k] = v;
                        }
                    }
                    cells.push({
                        cell_type: "code", metadata, source: code,
                        execution_count: null, outputs: [],
                    });
                } else if (lang === "xml" || lang === "json") {
                    cells.push({
                        cell_type: "raw",
                        metadata: { exist: { kind: "data", dataLanguage: lang } },
                        source: code,
                    });
                } else {
                    mdBuffer.push("```" + fenceLang);
                    mdBuffer.push(...codeBuffer);
                    mdBuffer.push("```");
                }
                codeBuffer = [];
            } else {
                codeBuffer.push(line);
            }
        } else if (fenceOpen) {
            flushMarkdown();
            inFence = true;
            fenceLang = fenceOpen[1];
            fenceAttrs = {};
            codeBuffer = [];
            if (fenceOpen[2]) {
                for (const part of fenceOpen[2].split(/\s+/)) {
                    const [k, v] = part.split("=");
                    if (k && v) fenceAttrs[k] = v;
                }
            }
        } else {
            mdBuffer.push(line);
        }
    }
    flushMarkdown();
    if (inFence) {
        mdBuffer.push("```" + fenceLang);
        mdBuffer.push(...codeBuffer);
        flushMarkdown();
    }
    return cells;
}

/**
 * Parse YAML-like front matter.
 */
function parseFrontMatter(source) {
    const lines = source.split("\n");
    if (lines[0] !== "---") return { body: source, meta: {} };
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---") { end = i; break; }
    }
    if (end < 0) return { body: source, meta: {} };
    const meta = {};
    for (let i = 1; i < end; i++) {
        const m = lines[i].match(/^(\w+):\s*(.+)$/);
        if (m) meta[m[1]] = m[2].trim();
    }
    return { body: lines.slice(end + 1).join("\n"), meta };
}

/**
 * Convert a markdown file to an .ipynb notebook.
 */
function convertFile(mdPath, bookMeta) {
    const raw = fs.readFileSync(mdPath, "utf-8");
    const { body, meta } = parseFrontMatter(raw);
    const cells = parseMarkdown(body);

    let title = meta.title || "";
    if (!title) {
        for (const cell of cells) {
            if (cell.cell_type === "markdown") {
                const m = cell.source.match(/^#\s+(.+)$/m);
                if (m) { title = m[1]; break; }
            }
        }
    }
    if (!title) title = path.basename(mdPath, ".md");

    const notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { ...DEFAULT_METADATA, title },
        cells,
    };

    if (bookMeta) {
        notebook.metadata.book = {
            title: bookMeta.title,
            authors: bookMeta.authors,
            difficulty: bookMeta.difficulty,
        };
    }

    return notebook;
}

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// --- Main ---

const sourceDir = args.source;
const outputDir = args.output;

if (!fs.existsSync(sourceDir)) {
    console.error(`Source directory not found: ${sourceDir}`);
    process.exit(1);
}
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

let convertedBooks = 0;
let convertedChapters = 0;
let convertedStandalone = 0;

// --- Process books → folders with _notebook.json ---
for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const bookJsonPath = path.join(sourceDir, entry.name, "book.json");
    if (!fs.existsSync(bookJsonPath)) continue;

    const bookMeta = JSON.parse(fs.readFileSync(bookJsonPath, "utf-8"));
    const bookDir = path.join(sourceDir, entry.name);
    const outBookDir = path.join(outputDir, entry.name);

    if (!args["dry-run"]) {
        fs.mkdirSync(outBookDir, { recursive: true });
    }

    // Build _notebook.json manifest
    const chapters = [];
    for (const chapter of (bookMeta.chapters || [])) {
        const chapterPath = path.join(bookDir, chapter.file);
        if (!fs.existsSync(chapterPath)) {
            console.warn(`  SKIP: ${chapterPath} (not found)`);
            continue;
        }

        const notebook = convertFile(chapterPath, bookMeta);
        const outName = chapter.file.replace(".md", ".ipynb");
        const outPath = path.join(outBookDir, outName);

        chapters.push({
            file: outName,
            title: chapter.title || notebook.metadata.title,
        });

        if (args["dry-run"]) {
            console.log(`  DRY: ${entry.name}/${outName} (${notebook.cells.length} cells)`);
        } else {
            fs.writeFileSync(outPath, JSON.stringify(notebook, null, 4));
            console.log(`  OK: ${entry.name}/${outName} (${notebook.cells.length} cells)`);
        }
        convertedChapters++;
    }

    // Write _notebook.json
    const manifest = {
        title: bookMeta.title,
        description: bookMeta.description || "",
        authors: bookMeta.authors || [],
        difficulty: bookMeta.difficulty || "intermediate",
        chapters,
    };

    if (args["dry-run"]) {
        console.log(`  DRY: ${entry.name}/_notebook.json (${chapters.length} chapters)`);
    } else {
        fs.writeFileSync(
            path.join(outBookDir, "_notebook.json"),
            JSON.stringify(manifest, null, 4)
        );
        console.log(`  OK: ${entry.name}/_notebook.json (${chapters.length} chapters)`);
    }

    // Copy data/ subdirectory if it exists
    const dataDir = path.join(bookDir, "data");
    if (fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()) {
        if (!args["dry-run"]) {
            copyDirSync(dataDir, path.join(outBookDir, "data"));
            console.log(`  OK: ${entry.name}/data/ (copied)`);
        } else {
            console.log(`  DRY: ${entry.name}/data/ (would copy)`);
        }
    }

    convertedBooks++;
}

// --- Process standalone .md files ---
for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const mdPath = path.join(sourceDir, entry.name);
    const notebook = convertFile(mdPath, null);
    const outName = slugify(entry.name.replace(".md", "")) + ".ipynb";
    const outPath = path.join(outputDir, outName);

    if (args["dry-run"]) {
        console.log(`  DRY: ${outName} (${notebook.cells.length} cells)`);
    } else {
        fs.writeFileSync(outPath, JSON.stringify(notebook, null, 4));
        console.log(`  OK: ${outName} (${notebook.cells.length} cells)`);
    }
    convertedStandalone++;
}

// --- Process joewiz.org/ standalone files ---
const joewizDir = path.join(sourceDir, "joewiz.org");
if (fs.existsSync(joewizDir)) {
    // Create a joewiz.org collection
    const outJoewizDir = path.join(outputDir, "joewiz");
    if (!args["dry-run"]) {
        fs.mkdirSync(outJoewizDir, { recursive: true });
    }

    const joewizChapters = [];
    for (const entry of fs.readdirSync(joewizDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const mdPath = path.join(joewizDir, entry.name);
        const notebook = convertFile(mdPath, null);
        const outName = entry.name.replace(".md", ".ipynb");
        const outPath = path.join(outJoewizDir, outName);

        joewizChapters.push({
            file: outName,
            title: notebook.metadata.title,
        });

        if (args["dry-run"]) {
            console.log(`  DRY: joewiz/${outName} (${notebook.cells.length} cells)`);
        } else {
            fs.writeFileSync(outPath, JSON.stringify(notebook, null, 4));
            console.log(`  OK: joewiz/${outName} (${notebook.cells.length} cells)`);
        }
        convertedStandalone++;
    }

    // Write manifest
    const manifest = {
        title: "Joe Wicentowski's XQuery Articles",
        description: "Standalone XQuery articles and techniques",
        authors: ["Joe Wicentowski"],
        difficulty: "intermediate",
        chapters: joewizChapters,
    };
    if (!args["dry-run"]) {
        fs.writeFileSync(path.join(outJoewizDir, "_notebook.json"), JSON.stringify(manifest, null, 4));
        console.log(`  OK: joewiz/_notebook.json (${joewizChapters.length} chapters)`);
    }
    convertedBooks++;
}

console.log(`\nBooks: ${convertedBooks}, Chapters: ${convertedChapters}, Standalone: ${convertedStandalone}`);
console.log(`Total notebooks: ${convertedChapters + convertedStandalone}`);

/**
 * Recursively copy a directory.
 */
function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
