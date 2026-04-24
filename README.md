# eXist-db Notebook

A Jupyter-inspired interactive XQuery notebook for [eXist-db](https://exist-db.org). Write literate, runnable documents that combine prose, code, and data — powered by XQuery and eXist-db's native XML/JSON database.

## Features

- **Markdown cells** for documentation with live rendering
- **XQuery code cells** with CodeMirror 6 editor, syntax highlighting, inline linting, and LSP code completion
- **Data cells** for inline XML, JSON, or text datasets — queryable from code cells
- **Named cell chaining** with server-side result caching
- **Rich output** — XML, JSON, HTML, CSV, and plain text with syntax highlighting
- **Serialization options** — Adaptive, XML, JSON, HTML, XHTML, CSV, with indent control and source view variants
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

- eXist-db 6.1.0+ (7.0.0+ recommended for XQuery 4.0 support)
- [Roaster](https://github.com/eeditiones/roaster) 1.8.0+
- [Jinks Templates](https://github.com/JinnElements/jinks-templates) 1.0.0+

## Installation

```bash
# Install dependencies and build
npm ci
npm run build

# Deploy to eXist-db
xst package install -f build/notebook-1.0.0.xar
```

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

Cell types: `code` (XQuery), `markdown`, `raw` (data cells with `metadata.exist.kind: "data"`).

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
  eval.xqm            XQuery eval with named cell caching
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
