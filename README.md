# eXist-db Notebook

A Jupyter-inspired interactive XQuery notebook for [eXist-db](https://exist-db.org). Write literate, runnable documents that combine prose, code, and data — powered by XQuery and eXist-db's native XML/JSON database.

## Features

- **Markdown cells** for documentation with live rendering
- **XQuery code cells** with CodeMirror 6 editor, syntax highlighting, inline linting, and LSP code completion
- **Data cells** for inline XML, JSON, or text datasets — queryable from code cells via `@data` directive
- **Named cell chaining** with server-side result caching via `@name` directive
- **Rich output** — XML, JSON, HTML, CSV, and plain text with syntax highlighting
- **Serialization control** via xqdoc `@output` directives with `media-type=text/html` for rendered HTML/CSV output
- **Jupyter kernel compatibility** — notebooks round-trip between the web app and VS Code via [exist-jupyter-kernel](https://github.com/joewiz/exist-jupyter-kernel)
- **Collections** — organize notebooks into folders with `_notebook.json` manifests, reading order, and prev/next navigation
- **Version history** — automatic snapshots on save with restore
- **Full-text search** — Lucene-indexed with KWIC highlighting
- **Code formatting** via Prettier (XQuery, XML, JSON, Markdown)
- **Function hover docs** — on-hover tooltips showing function signatures and descriptions from eXist's LSP and docs API
- **Table of contents** sidebar with scroll-tracking active heading
- **Download/upload** notebooks as `.ipynb` files
- **Admin panel** — cache management, version cleanup, export
- **Site-wide integration** — shared navbar, search, breadcrumbs, consistent with eXist-db's app ecosystem

## Requirements

- eXist-db 7.0.0-SNAPSHOT+ (required for XQuery 4.0 and CSV serialization support)
- [Roaster](https://github.com/eeditiones/roaster) 1.8.0+
- [Jinks Templates](https://github.com/JinnElements/jinks-templates) 1.0.0+

## Installation

```bash
# Install dependencies and build
npm ci
npm run build

# Deploy to eXist-db
xst package install -f build/notebook-0.1.0.xar
```

## xqdoc Directives

Notebooks use xqdoc comment blocks at the top of code cells to control naming, serialization, and data handling. These directives work identically in the Notebook web app and in VS Code with the [Jupyter kernel](https://github.com/joewiz/exist-jupyter-kernel).

### `@name` — Named cell chaining

```xquery
(:~
 : XML book catalog.
 : @name books
 :)
collection("/db/data")//book
```

Later cells reference the result as `$books`. Results are cached server-side.

### `@output` — Serialization control

```xquery
(:~
 : @output method=xml indent=yes
 :)
doc("/db/apps/myapp/config.xml")
```

Add `media-type=text/html` to render HTML or CSV as formatted output instead of raw source:

```xquery
(:~
 : @output method=html media-type=text/html
 :)
<h1>Hello</h1>
```

All [W3C serialization parameters](https://qt4cg.org/specifications/xslt-xquery-serialization-40/Overview.html) are supported.

### `@data` — Data cells

Embed raw XML, JSON, or text data in a code cell. The content is wrapped before evaluation (`parse-json()` for JSON, string literal for text, pass-through for XML):

```xquery
(:~
 : Application configuration.
 : @name config
 : @data json
 : @silent
 :)
{"appName": "Dashboard", "version": "2.1"}
```

### `@silent` — Suppress output

Useful for data-only cells that exist to cache a named result:

```xquery
(:~
 : @name data
 : @data xml
 : @silent
 :)
<items><item>one</item></items>
```

### Toolbar integration

In the Notebook web app, the cell toolbar (name field, serialization dropdown, data format selector) reads from and writes to the xqdoc block in the cell source. Changes made in either the toolbar or the source stay in sync, ensuring round-trip compatibility between environments.

## Jupyter Kernel

For running notebooks in VS Code, JupyterLab, or any Jupyter client, install [exist-jupyter-kernel](https://github.com/joewiz/exist-jupyter-kernel). It implements the Jupyter wire protocol and proxies XQuery evaluation to this app's `/api/eval` endpoint.

Notebooks created in either environment are fully compatible — same `.ipynb` format, same xqdoc directives, same eval API.

## Development

```bash
# Development build (with source maps)
npm run build:dev

# Run tests
npm test

# Live sync to eXist-db (requires .existdb.json)
xst upload modules/view.xq /db/apps/notebook/modules
```

## Notebook Format

Notebooks use the `.ipynb` (Jupyter) format with XQuery kernel metadata:

```json
{
    "nbformat": 4,
    "nbformat_minor": 5,
    "metadata": {
        "kernelspec": {
            "display_name": "XQuery (eXist-db)",
            "language": "xquery",
            "name": "xquery-exist"
        }
    },
    "cells": [...]
}
```

Cell types: `code` (XQuery, including data cells with `@data` directive), `markdown`.

## Collections

Group related notebooks into folders with a `_notebook.json` manifest:

```json
{
    "title": "Getting Started with eXist-db",
    "authors": ["eXist-db Contributors"],
    "difficulty": "beginner",
    "chapters": [
        { "file": "01-hello-xquery.ipynb", "title": "Hello XQuery" },
        { "file": "02-analyzing-data.ipynb", "title": "Analyzing Data" }
    ]
}
```

Collections provide a table of contents landing page and prev/next chapter navigation.

## Project Structure

```
modules/
  api.xq              Roaster entry point
  notebooks.xqm       Notebook CRUD + collections + versioning
  eval.xqm            XQuery eval with named cell caching + xqdoc directive parsing
  admin.xqm            Admin API (cache, versions, export)
  trigger.xqm         Shadow document indexing for search
  config.xqm          App configuration
  view.xq             Page rendering
  nav.xqm             Site navigation (Jinks-generated)
  site-config.xqm     Site config (Jinks-generated)
resources/
  js/notebook.js       Main notebook editor + file browser + admin
  js/cm-bundle.js      CodeMirror 6 bundle entry
  css/notebook.css     App styles
  css/exist-site.css   Site-wide styles (Jinks-generated)
data/                  Notebook storage (.ipynb files + collections)
templates/             Jinks page templates
tools/
  migrate-content.js   Migration script (old markdown → .ipynb)
  bundle-prettier.js   Prettier bundle builder
test/                  Unit tests
```

## License

GPL-3.0
