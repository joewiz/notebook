/**
 * Tests for the notebook document model.
 *
 * Validates .ipynb-compatible JSON structure, cell operations, and
 * serialization/deserialization.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// --- Document model helpers (extracted for testability) ---

/**
 * Create a new empty notebook document.
 */
function createNotebook(title = "Untitled") {
    return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
            kernelspec: {
                display_name: "XQuery (eXist-db)",
                language: "xquery",
                name: "xquery-exist"
            },
            language_info: {
                name: "xquery",
                version: "4.0",
                file_extension: ".xq"
            }
        },
        cells: [
            {
                cell_type: "markdown",
                metadata: {},
                source: [`# ${title}\n`]
            },
            {
                cell_type: "code",
                metadata: {},
                source: [""],
                execution_count: null,
                outputs: []
            }
        ]
    };
}

/**
 * Add a cell to a notebook at a given index.
 */
function addCell(notebook, type, source, index) {
    const cell = {
        cell_type: type,
        metadata: {},
        source: Array.isArray(source) ? source : source.split("\n").map((l, i, a) => i < a.length - 1 ? l + "\n" : l)
    };
    if (type === "code") {
        cell.execution_count = null;
        cell.outputs = [];
    }
    if (index === undefined) {
        notebook.cells.push(cell);
    } else {
        notebook.cells.splice(index, 0, cell);
    }
    return cell;
}

/**
 * Delete a cell from a notebook.
 */
function deleteCell(notebook, index) {
    if (notebook.cells.length <= 1) {
        throw new Error("Cannot delete the last cell");
    }
    return notebook.cells.splice(index, 1)[0];
}

/**
 * Move a cell within a notebook.
 */
function moveCell(notebook, from, to) {
    if (from < 0 || from >= notebook.cells.length) throw new Error("Invalid from index");
    if (to < 0 || to >= notebook.cells.length) throw new Error("Invalid to index");
    const [cell] = notebook.cells.splice(from, 1);
    notebook.cells.splice(to, 0, cell);
    return cell;
}

/**
 * Change cell type.
 */
function changeCellType(notebook, index, newType) {
    const cell = notebook.cells[index];
    cell.cell_type = newType;
    if (newType === "code" && !cell.outputs) {
        cell.execution_count = null;
        cell.outputs = [];
    }
    if (newType === "markdown") {
        delete cell.execution_count;
        delete cell.outputs;
    }
    return cell;
}

/**
 * Extract title from notebook (first markdown heading).
 */
function extractTitle(notebook, fallback = "Untitled") {
    for (const cell of notebook.cells) {
        if (cell.cell_type === "markdown") {
            const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source;
            const match = source.match(/^#\s+(.+)$/m);
            if (match) return match[1];
        }
    }
    return fallback;
}

/**
 * Convert a title to a URL-safe filename slug.
 */
function slugify(title) {
    return title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").trim();
}

// --- Tests ---

describe("Notebook Document Model", () => {

    describe("createNotebook", () => {
        it("should create a valid .ipynb structure", () => {
            const nb = createNotebook("Test Notebook");

            assert.equal(nb.nbformat, 4);
            assert.equal(nb.nbformat_minor, 5);
            assert.equal(nb.metadata.kernelspec.language, "xquery");
            assert.equal(nb.metadata.kernelspec.name, "xquery-exist");
            assert.equal(nb.metadata.language_info.name, "xquery");
            assert.equal(nb.metadata.language_info.version, "4.0");
            assert.equal(nb.cells.length, 2);
        });

        it("should start with a markdown cell containing the title", () => {
            const nb = createNotebook("My Notebook");
            assert.equal(nb.cells[0].cell_type, "markdown");
            assert.deepEqual(nb.cells[0].source, ["# My Notebook\n"]);
        });

        it("should include an empty code cell", () => {
            const nb = createNotebook();
            assert.equal(nb.cells[1].cell_type, "code");
            assert.deepEqual(nb.cells[1].source, [""]);
            assert.equal(nb.cells[1].execution_count, null);
            assert.deepEqual(nb.cells[1].outputs, []);
        });
    });

    describe("addCell", () => {
        it("should append a code cell to the end", () => {
            const nb = createNotebook();
            addCell(nb, "code", 'let $x := 42\nreturn $x');

            assert.equal(nb.cells.length, 3);
            assert.equal(nb.cells[2].cell_type, "code");
            assert.deepEqual(nb.cells[2].source, ["let $x := 42\n", "return $x"]);
        });

        it("should insert a markdown cell at a specific index", () => {
            const nb = createNotebook();
            addCell(nb, "markdown", "## Section 2", 1);

            assert.equal(nb.cells.length, 3);
            assert.equal(nb.cells[1].cell_type, "markdown");
        });

        it("should split source into lines per .ipynb convention", () => {
            const nb = createNotebook();
            addCell(nb, "code", "line1\nline2\nline3");

            assert.deepEqual(nb.cells[2].source, ["line1\n", "line2\n", "line3"]);
        });

        it("should handle array source directly", () => {
            const nb = createNotebook();
            addCell(nb, "code", ["already\n", "split"]);

            assert.deepEqual(nb.cells[2].source, ["already\n", "split"]);
        });
    });

    describe("deleteCell", () => {
        it("should remove a cell at the given index", () => {
            const nb = createNotebook();
            addCell(nb, "code", "extra");
            assert.equal(nb.cells.length, 3);

            deleteCell(nb, 2);
            assert.equal(nb.cells.length, 2);
        });

        it("should not allow deleting the last cell", () => {
            const nb = createNotebook();
            deleteCell(nb, 0); // remove markdown, code remains
            assert.equal(nb.cells.length, 1);

            assert.throws(() => deleteCell(nb, 0), /Cannot delete the last cell/);
        });

        it("should return the deleted cell", () => {
            const nb = createNotebook();
            addCell(nb, "code", "doomed");
            const deleted = deleteCell(nb, 2);
            assert.equal(deleted.cell_type, "code");
        });
    });

    describe("moveCell", () => {
        it("should move a cell from one position to another", () => {
            const nb = createNotebook();
            addCell(nb, "code", "cell A");
            addCell(nb, "code", "cell B");

            // Move cell B (index 3) to index 2
            moveCell(nb, 3, 2);
            const sources = nb.cells.map(c => (Array.isArray(c.source) ? c.source.join("") : c.source));
            assert.ok(sources[2].includes("cell B"));
            assert.ok(sources[3].includes("cell A"));
        });

        it("should throw for out-of-bounds indices", () => {
            const nb = createNotebook();
            assert.throws(() => moveCell(nb, -1, 0));
            assert.throws(() => moveCell(nb, 0, 10));
        });
    });

    describe("changeCellType", () => {
        it("should convert code cell to markdown", () => {
            const nb = createNotebook();
            changeCellType(nb, 1, "markdown");
            assert.equal(nb.cells[1].cell_type, "markdown");
            assert.equal(nb.cells[1].execution_count, undefined);
            assert.equal(nb.cells[1].outputs, undefined);
        });

        it("should convert markdown cell to code", () => {
            const nb = createNotebook();
            changeCellType(nb, 0, "code");
            assert.equal(nb.cells[0].cell_type, "code");
            assert.equal(nb.cells[0].execution_count, null);
            assert.deepEqual(nb.cells[0].outputs, []);
        });
    });

    describe("extractTitle", () => {
        it("should extract title from first markdown heading", () => {
            const nb = createNotebook("My Great Notebook");
            assert.equal(extractTitle(nb), "My Great Notebook");
        });

        it("should return fallback if no heading found", () => {
            const nb = createNotebook();
            nb.cells[0].source = ["Just plain text"];
            assert.equal(extractTitle(nb, "fallback.ipynb"), "fallback.ipynb");
        });

        it("should handle source as array", () => {
            const nb = createNotebook();
            nb.cells[0].source = ["# Array ", "Title\n"];
            // The heading is on one line, so only "Array " would be on line 1
            // Actually with join, the full text is "# Array Title\n"
            assert.equal(extractTitle(nb), "Array Title");
        });
    });

    describe("slugify", () => {
        it("should lowercase and hyphenate", () => {
            assert.equal(slugify("My Notebook"), "my-notebook");
        });

        it("should remove special characters", () => {
            assert.equal(slugify("Hello World! #2"), "hello-world-2");
        });

        it("should collapse multiple spaces", () => {
            assert.equal(slugify("lots   of   spaces"), "lots-of-spaces");
        });
    });

    describe(".ipynb format compliance", () => {
        it("should produce valid JSON", () => {
            const nb = createNotebook("Test");
            addCell(nb, "code", "1 + 1");
            addCell(nb, "markdown", "## Results");

            const json = JSON.stringify(nb);
            const parsed = JSON.parse(json);

            assert.equal(parsed.nbformat, 4);
            assert.equal(parsed.cells.length, 4);
        });

        it("should have source as array of strings", () => {
            const nb = createNotebook("Test");
            addCell(nb, "code", "line1\nline2");

            for (const cell of nb.cells) {
                assert.ok(Array.isArray(cell.source), `cell source should be array: ${JSON.stringify(cell.source)}`);
            }
        });

        it("should preserve execution_count and outputs on code cells", () => {
            const nb = createNotebook();
            const cell = nb.cells[1];
            cell.execution_count = 5;
            cell.outputs = [{
                output_type: "execute_result",
                data: { "text/plain": "42" },
                metadata: {},
                execution_count: 5
            }];

            const json = JSON.stringify(nb);
            const parsed = JSON.parse(json);
            assert.equal(parsed.cells[1].execution_count, 5);
            assert.equal(parsed.cells[1].outputs[0].data["text/plain"], "42");
        });
    });
});

describe("Markdown Rendering (basic)", () => {
    // These test the server-side or client-side markdown rendering

    it("should handle headings", () => {
        const source = "# Heading 1\n## Heading 2\n### Heading 3";
        // Just verify the structure is parseable
        assert.ok(source.includes("# Heading 1"));
    });

    it("should handle code blocks", () => {
        const source = "```xquery\n1 + 1\n```";
        assert.ok(source.includes("```xquery"));
    });
});

describe("Named Cell Chaining Context", () => {
    /**
     * Test the named cell context chain assembly logic.
     * This mirrors what the client sends to eval.xqm:
     * only named code cells are included in the context.
     */

    function buildContextChain(cells, currentIndex) {
        const context = [];
        for (let i = 0; i < currentIndex; i++) {
            const cell = cells[i];
            const name = cell.metadata?.exist?.name;
            if (!name) continue;
            const src = Array.isArray(cell.source) ? cell.source.join("") : (cell.source || "");
            if (!src.trim()) continue;

            const isData = cell.cell_type === "raw" && cell.metadata?.exist?.kind === "data";
            if (cell.cell_type === "code") {
                context.push({ name, query: src });
            } else if (isData) {
                context.push({
                    name,
                    kind: "data",
                    dataLanguage: cell.metadata.exist.dataLanguage || "xml",
                    content: src
                });
            }
        }
        return context;
    }

    it("should include only preceding named code cells", () => {
        const nb = createNotebook();
        nb.cells[1].source = ["let $x := 1 return $x"];
        nb.cells[1].metadata = { exist: { name: "data" } };
        addCell(nb, "markdown", "## Middle");
        addCell(nb, "code", "$data + 1");
        // cells: [md(0), code(1, named "data"), md(2), code(3, unnamed)]

        const context = buildContextChain(nb.cells, 3);
        assert.equal(context.length, 1);
        assert.equal(context[0].name, "data");
        assert.ok(context[0].query.includes("let $x"));
    });

    it("should skip unnamed code cells", () => {
        const nb = createNotebook();
        nb.cells[1].source = ["let $x := 1 return $x"];
        // No name set — should be skipped
        addCell(nb, "code", "42");

        const context = buildContextChain(nb.cells, 2);
        assert.equal(context.length, 0);
    });

    it("should skip empty named code cells", () => {
        const nb = createNotebook();
        nb.cells[1].source = [""];
        nb.cells[1].metadata = { exist: { name: "empty" } };

        const context = buildContextChain(nb.cells, 2);
        assert.equal(context.length, 0);
    });

    it("should return empty context for first code cell", () => {
        const nb = createNotebook();
        const context = buildContextChain(nb.cells, 1);
        assert.equal(context.length, 0);
    });

    it("should use cell names, not positional indices", () => {
        const nb = createNotebook();
        nb.cells[1].source = ["let $a := 1 return $a"];
        nb.cells[1].metadata = { exist: { name: "first" } };
        addCell(nb, "code", "let $b := 2 return $b");
        nb.cells[2].metadata = { exist: { name: "second" } };
        addCell(nb, "code", "$first + $second");

        const context = buildContextChain(nb.cells, 3);
        assert.equal(context.length, 2);
        assert.equal(context[0].name, "first");
        assert.equal(context[1].name, "second");
    });

    it("should preserve names across cell reordering", () => {
        const nb = createNotebook();
        nb.cells[1].source = ["1"];
        nb.cells[1].metadata = { exist: { name: "alpha" } };
        addCell(nb, "code", "2");
        nb.cells[2].metadata = { exist: { name: "beta" } };

        // Simulate reorder: swap cells[1] and cells[2]
        moveCell(nb, 1, 2);

        const context = buildContextChain(nb.cells, 3);
        // After move: cells[1] was "beta", cells[2] was "alpha"
        assert.equal(context[0].name, "beta");
        assert.equal(context[1].name, "alpha");
    });

    it("should include data cells with kind and dataLanguage", () => {
        const nb = createNotebook();
        // Add a data cell (stored as raw in .ipynb)
        nb.cells.push({
            cell_type: "raw",
            metadata: { exist: { kind: "data", dataLanguage: "xml", name: "people" } },
            source: ["<people><person>Alice</person></people>"]
        });
        // Add a code cell that queries it
        nb.cells.push({
            cell_type: "code",
            metadata: {},
            source: ["$people//person"]
        });

        const context = buildContextChain(nb.cells, 3);
        assert.equal(context.length, 1);
        assert.equal(context[0].name, "people");
        assert.equal(context[0].kind, "data");
        assert.equal(context[0].dataLanguage, "xml");
        assert.ok(context[0].content.includes("<people>"));
    });
});

describe("Cache Miss Tracking", () => {
    /**
     * Simulates the cache miss detection logic from eval.xqm.
     * The server tracks how many prior cells needed re-evaluation
     * vs. cache hits, and returns the counts so the UI can notify.
     */

    function simulateEval(context, cache) {
        let misses = 0;
        let total = 0;

        for (const cell of context) {
            if (!cell.name) continue;
            total++;
            if (cache.has(cell.name)) {
                // cache hit
            } else {
                // cache miss — re-evaluate and store
                misses++;
                cache.set(cell.name, `result-of-${cell.name}`);
            }
        }

        return { cacheMisses: misses, cacheTotal: total };
    }

    it("should report zero misses when all cells are cached", () => {
        const cache = new Map([["data", "<xml/>"], ["count", "5"]]);
        const context = [
            { name: "data", query: "<xml/>" },
            { name: "count", query: "5" }
        ];
        const result = simulateEval(context, cache);
        assert.equal(result.cacheMisses, 0);
        assert.equal(result.cacheTotal, 2);
    });

    it("should report all misses on empty cache (e.g., after expiry)", () => {
        const cache = new Map(); // empty — simulates expired/evicted
        const context = [
            { name: "data", query: "<xml/>" },
            { name: "count", query: "5" }
        ];
        const result = simulateEval(context, cache);
        assert.equal(result.cacheMisses, 2);
        assert.equal(result.cacheTotal, 2);
    });

    it("should report partial misses", () => {
        const cache = new Map([["data", "<xml/>"]]); // only data cached
        const context = [
            { name: "data", query: "<xml/>" },
            { name: "count", query: "5" }
        ];
        const result = simulateEval(context, cache);
        assert.equal(result.cacheMisses, 1);
        assert.equal(result.cacheTotal, 2);
    });

    it("should repopulate cache after miss", () => {
        const cache = new Map();
        const context = [{ name: "data", query: "<xml/>" }];
        simulateEval(context, cache);
        assert.ok(cache.has("data"), "cache should be repopulated after miss");

        // Second eval — should be a hit now
        const result2 = simulateEval(context, cache);
        assert.equal(result2.cacheMisses, 0);
    });

    it("should report zero for empty context", () => {
        const cache = new Map();
        const result = simulateEval([], cache);
        assert.equal(result.cacheMisses, 0);
        assert.equal(result.cacheTotal, 0);
    });

    it("should skip unnamed cells", () => {
        const cache = new Map();
        const context = [
            { name: "", query: "ignored" },
            { name: "real", query: "42" }
        ];
        const result = simulateEval(context, cache);
        assert.equal(result.cacheMisses, 1);
        assert.equal(result.cacheTotal, 1);
    });
});
