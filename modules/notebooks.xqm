xquery version "3.1";

(:~
 : Notebook CRUD API — manages .ipynb documents stored in eXist-db.
 :
 : Supports:
 :   - Standalone notebooks in /db/apps/notebook/data/{name}.ipynb
 :   - Collections in /db/apps/notebook/data/{folder}/ with _notebook.json manifest
 :   - Nested paths: {folder}/{file}.ipynb
 :)
module namespace nb="http://exist-db.org/pkg/notebook/notebooks";

import module namespace config="http://exist-db.org/pkg/notebook/config" at "config.xqm";
import module namespace roaster="http://e-editiones.org/roaster";
import module namespace errors="http://e-editiones.org/roaster/errors";

declare %private variable $nb:DEFAULT_METADATA := map {
    "kernelspec": map {
        "display_name": "XQuery (eXist-db)",
        "language": "xquery",
        "name": "xquery-exist"
    },
    "language_info": map {
        "name": "xquery",
        "version": "4.0",
        "file_extension": ".xq"
    }
};

declare %private variable $nb:VERSIONS_COL := $config:DATA_ROOT || "/versions";

(:~
 : List all notebooks and collections.
 : Returns standalone notebooks + collection summaries.
 :)
declare function nb:list($request as map(*)) {
    if (not(xmldb:collection-available($config:DATA_ROOT))) then
        map { "notebooks": array {}, "collections": array {} }
    else
        let $standalone :=
            for $resource in xmldb:get-child-resources($config:DATA_ROOT)
            where ends-with($resource, ".ipynb")
            let $path := $config:DATA_ROOT || "/" || $resource
            let $content := nb:load-notebook($path)
            let $title := nb:extract-title($content, $resource)
            let $modified := xmldb:last-modified($config:DATA_ROOT, $resource)
            order by $title
            return map {
                "type": "notebook",
                "path": $resource,
                "slug": replace($resource, "\.ipynb$", ""),
                "title": $title,
                "modified": string($modified),
                "cellCount": array:size($content?cells)
            }

        let $collections :=
            for $dir in xmldb:get-child-collections($config:DATA_ROOT)
            where $dir ne "versions"
            let $manifest-path := $config:DATA_ROOT || "/" || $dir || "/_notebook.json"
            let $has-manifest := util:binary-doc-available($manifest-path)
            let $manifest :=
                if ($has-manifest) then
                    parse-json(util:binary-to-string(util:binary-doc($manifest-path)))
                else
                    map { "title": $dir, "chapters": array {} }
            let $chapter-count :=
                if ($has-manifest) then array:size($manifest?chapters)
                else count(xmldb:get-child-resources($config:DATA_ROOT || "/" || $dir)[ends-with(., ".ipynb")])
            order by ($manifest?title, $dir)[1]
            return map {
                "type": "collection",
                "path": $dir,
                "title": ($manifest?title, $dir)[1],
                "description": ($manifest?description, "")[1],
                "authors": ($manifest?authors, array {})[1],
                "difficulty": ($manifest?difficulty, "")[1],
                "chapterCount": $chapter-count
            }

        return map {
            "notebooks": array { $standalone },
            "collections": array { $collections }
        }
};

(:~
 : Get a collection's manifest (_notebook.json).
 :)
declare function nb:get-collection($request as map(*)) {
    let $name := $request?parameters?name
    let $manifest-path := $config:DATA_ROOT || "/" || $name || "/_notebook.json"
    return
        if (not(util:binary-doc-available($manifest-path))) then
            error($errors:NOT_FOUND, "Collection not found: " || $name)
        else
            let $manifest := parse-json(util:binary-to-string(util:binary-doc($manifest-path)))
            return map:merge((
                $manifest,
                map { "path": $name }
            ), map { "duplicates": "use-last" })
};

(:~
 : Create a new collection with a _notebook.json manifest.
 :)
declare function nb:create-collection($request as map(*)) {
    let $body := $request?body
    let $title := ($body?title, "Untitled Collection")[1]
    let $folder := ($body?folder, nb:slugify($title))[1]
    let $col-path := $config:DATA_ROOT || "/" || $folder
    return
        if (xmldb:collection-available($col-path)) then
            error($errors:BAD_REQUEST, "Collection already exists: " || $folder)
        else
            let $_ := xmldb:create-collection($config:DATA_ROOT, $folder)
            let $manifest := map {
                "title": $title,
                "description": ($body?description, "")[1],
                "authors": ($body?authors, array {})[1],
                "difficulty": ($body?difficulty, "")[1],
                "chapters": array {}
            }
            let $json := serialize($manifest, map { "method": "json", "indent": true() })
            let $_ := xmldb:store($col-path, "_notebook.json", $json, "application/json")
            return roaster:response(201, "application/json", map {
                "path": $folder,
                "title": $title,
                "created": true()
            }, ())
};

(:~
 : Update a collection's manifest (title, description, authors, chapter order).
 :)
declare function nb:update-collection($request as map(*)) {
    let $name := $request?parameters?name
    let $col-path := $config:DATA_ROOT || "/" || $name
    let $manifest-path := $col-path || "/_notebook.json"
    return
        if (not(util:binary-doc-available($manifest-path))) then
            error($errors:NOT_FOUND, "Collection not found: " || $name)
        else
            let $body := $request?body
            let $manifest := map {
                "title": ($body?title, $name)[1],
                "description": ($body?description, "")[1],
                "authors": ($body?authors, array {})[1],
                "difficulty": ($body?difficulty, "")[1],
                "chapters": ($body?chapters, array {})[1]
            }
            let $json := serialize($manifest, map { "method": "json", "indent": true() })
            let $_ := xmldb:store($col-path, "_notebook.json", $json, "application/json")
            return map {
                "path": $name,
                "saved": true()
            }
};

(:~
 : Get a notebook by path. Handles both standalone and collection notebooks.
 : Path can be "my-notebook.ipynb" or "expath-crypto/01-hashing.ipynb".
 :)
declare function nb:get($request as map(*)) {
    let $path := $request?parameters?path
    let $full-path := $config:DATA_ROOT || "/" || $path
    return
        if (not(util:binary-doc-available($full-path))) then
            error($errors:NOT_FOUND, "Notebook not found: " || $path)
        else
            let $notebook := nb:load-notebook($full-path)
            (: If this notebook is in a collection, add prev/next info :)
            let $parts := tokenize($path, "/")
            let $nav :=
                if (count($parts) eq 2) then
                    let $collection := $parts[1]
                    let $filename := $parts[2]
                    let $manifest-path := $config:DATA_ROOT || "/" || $collection || "/_notebook.json"
                    return
                        if (util:binary-doc-available($manifest-path)) then
                            let $manifest := parse-json(util:binary-to-string(util:binary-doc($manifest-path)))
                            let $chapters := $manifest?chapters
                            let $idx := (
                                for $i in 1 to array:size($chapters)
                                where $chapters($i)?file eq $filename
                                return $i
                            )[1]
                            return
                                if (exists($idx)) then map {
                                    "collection": $collection,
                                    "collectionTitle": $manifest?title,
                                    "chapterIndex": $idx,
                                    "chapterCount": array:size($chapters),
                                    "prev": if ($idx > 1) then map {
                                        "file": $chapters($idx - 1)?file,
                                        "title": $chapters($idx - 1)?title,
                                        "slug": $collection || "/" || replace($chapters($idx - 1)?file, "\.ipynb$", "")
                                    } else (),
                                    "next": if ($idx < array:size($chapters)) then map {
                                        "file": $chapters($idx + 1)?file,
                                        "title": $chapters($idx + 1)?title,
                                        "slug": $collection || "/" || replace($chapters($idx + 1)?file, "\.ipynb$", "")
                                    } else ()
                                }
                                else ()
                        else ()
                else ()
            return
                if (exists($nav)) then
                    map:put($notebook, "_nav", $nav)
                else
                    $notebook
};

(:~
 : Create a new notebook. Supports optional collection parameter.
 :)
declare function nb:create($request as map(*)) {
    let $body := $request?body
    let $title := ($body?title, "Untitled")[1]
    let $collection := $body?collection  (: optional: create inside a collection :)
    let $filename := ($body?filename, nb:slugify($title) || ".ipynb")[1]
    let $target-col :=
        if ($collection and $collection ne "") then
            let $col := $config:DATA_ROOT || "/" || $collection
            return (
                if (not(xmldb:collection-available($col))) then
                    xmldb:create-collection($config:DATA_ROOT, $collection)
                else (),
                $col
            )[last()]
        else
            $config:DATA_ROOT
    let $full-path := $target-col || "/" || $filename
    return
        if (util:binary-doc-available($full-path)) then
            error($errors:BAD_REQUEST, "Notebook already exists: " || $filename)
        else
            let $notebook := map {
                "nbformat": 4, "nbformat_minor": 5,
                "metadata": map:merge(($nb:DEFAULT_METADATA, map { "title": $title }), map { "duplicates": "use-last" }),
                "cells": array {
                    map { "cell_type": "markdown", "metadata": map {}, "source": array { "# " || $title || codepoints-to-string(10) } },
                    map { "cell_type": "code", "metadata": map {}, "source": array { "" }, "execution_count": (), "outputs": array {} }
                }
            }
            let $json := serialize($notebook, map { "method": "json", "indent": true() })
            let $stored := xmldb:store($target-col, $filename, $json, "application/json")
            let $rel-path :=
                if ($collection and $collection ne "") then $collection || "/" || $filename
                else $filename
            return roaster:response(201, "application/json", map {
                "path": $rel-path,
                "slug": replace($rel-path, "\.ipynb$", ""),
                "title": $title,
                "created": true()
            }, ())
};

(:~
 : Save/update a notebook. Creates a version snapshot before overwriting.
 :)
declare function nb:save($request as map(*)) {
    let $path := $request?parameters?path
    let $full-path := $config:DATA_ROOT || "/" || $path
    let $notebook := $request?body

    let $_ :=
        if (util:binary-doc-available($full-path)) then
            nb:create-snapshot($path)
        else ()

    let $notebook := map:merge((
        map {
            "nbformat": ($notebook?nbformat, 4)[1],
            "nbformat_minor": ($notebook?nbformat_minor, 5)[1],
            "metadata": map:merge(($nb:DEFAULT_METADATA, $notebook?metadata), map { "duplicates": "use-last" })
        },
        map:remove($notebook, ("nbformat", "nbformat_minor", "metadata"))
    ), map { "duplicates": "use-last" })

    (: Ensure parent collection exists for nested paths :)
    let $parts := tokenize($path, "/")
    let $_ :=
        if (count($parts) > 1) then
            let $parent := $config:DATA_ROOT || "/" || string-join(subsequence($parts, 1, count($parts) - 1), "/")
            return
                if (not(xmldb:collection-available($parent))) then
                    xmldb:create-collection($config:DATA_ROOT, string-join(subsequence($parts, 1, count($parts) - 1), "/"))
                else ()
        else ()

    let $filename := $parts[last()]
    let $parent := $config:DATA_ROOT || "/" || (if (count($parts) > 1) then string-join(subsequence($parts, 1, count($parts) - 1), "/") else "")
    let $parent := replace($parent, "/$", "")
    let $json := serialize($notebook, map { "method": "json", "indent": true() })
    let $stored := xmldb:store($parent, $filename, $json, "application/json")
    return map {
        "path": $path,
        "saved": true(),
        "modified": string(current-dateTime())
    }
};

(:~
 : Delete a notebook.
 :)
declare function nb:delete($request as map(*)) {
    let $path := $request?parameters?path
    let $full-path := $config:DATA_ROOT || "/" || $path
    return
        if (not(util:binary-doc-available($full-path))) then
            error($errors:NOT_FOUND, "Notebook not found: " || $path)
        else
            let $parts := tokenize($path, "/")
            let $filename := $parts[last()]
            let $parent :=
                if (count($parts) > 1) then
                    $config:DATA_ROOT || "/" || string-join(subsequence($parts, 1, count($parts) - 1), "/")
                else
                    $config:DATA_ROOT
            return (
                xmldb:remove($parent, $filename),
                map { "deleted": true() }
            )
};

(:~
 : Duplicate a notebook.
 :)
declare function nb:duplicate($request as map(*)) {
    let $path := $request?parameters?path
    let $full-path := $config:DATA_ROOT || "/" || $path
    return
        if (not(util:binary-doc-available($full-path))) then
            error($errors:NOT_FOUND, "Notebook not found: " || $path)
        else
            let $parts := tokenize($path, "/")
            let $filename := $parts[last()]
            let $base := replace($filename, "\.ipynb$", "")
            let $parent-rel :=
                if (count($parts) > 1) then string-join(subsequence($parts, 1, count($parts) - 1), "/")
                else ""
            let $parent-col :=
                if ($parent-rel ne "") then $config:DATA_ROOT || "/" || $parent-rel
                else $config:DATA_ROOT

            let $copy-base := nb:find-copy-name-in($parent-col, $base, 1)
            let $copy-filename := $copy-base || ".ipynb"

            let $notebook := nb:load-notebook($full-path)
            let $old-title := nb:extract-title($notebook, $path)
            let $new-title := $old-title || " (copy)"

            (: Update heading in first markdown cell :)
            let $cells := $notebook?cells
            let $first-md-idx := (
                for $i in 1 to array:size($cells)
                where $cells($i)?cell_type eq "markdown"
                return $i
            )[1]
            let $updated-cells :=
                if (empty($first-md-idx)) then $cells
                else
                    let $cell := $cells($first-md-idx)
                    let $src := if ($cell?source instance of array(*)) then string-join($cell?source?*, "") else string($cell?source)
                    let $new-src := replace($src, "^#\s+.+$", "# " || $new-title, "m")
                    return array:put($cells, $first-md-idx, map:put($cell, "source", $new-src))

            let $updated := $notebook
                => map:put("metadata", map:put($notebook?metadata, "title", $new-title))
                => map:put("cells", $updated-cells)
            let $json := serialize($updated, map { "method": "json", "indent": true() })
            let $stored := xmldb:store($parent-col, $copy-filename, $json, "application/json")
            let $rel-path :=
                if ($parent-rel ne "") then $parent-rel || "/" || $copy-filename
                else $copy-filename
            return roaster:response(201, "application/json", map {
                "path": $rel-path,
                "slug": replace($rel-path, "\.ipynb$", ""),
                "title": $new-title,
                "created": true()
            }, ())
};

(:~
 : Rename a notebook.
 :)
declare function nb:rename($request as map(*)) {
    let $path := $request?parameters?path
    let $full-path := $config:DATA_ROOT || "/" || $path
    let $new-name := $request?body?name
    return
        if (not(util:binary-doc-available($full-path))) then
            error($errors:NOT_FOUND, "Notebook not found: " || $path)
        else if (not($new-name) or $new-name eq "") then
            error($errors:BAD_REQUEST, "New name is required")
        else
            let $parts := tokenize($path, "/")
            let $parent-rel := if (count($parts) > 1) then string-join(subsequence($parts, 1, count($parts) - 1), "/") else ""
            let $parent-col := if ($parent-rel ne "") then $config:DATA_ROOT || "/" || $parent-rel else $config:DATA_ROOT
            let $old-filename := $parts[last()]
            let $new-filename := if (ends-with($new-name, ".ipynb")) then $new-name else $new-name || ".ipynb"
            let $new-path := if ($parent-rel ne "") then $parent-rel || "/" || $new-filename else $new-filename
            return
                if (util:binary-doc-available($parent-col || "/" || $new-filename)) then
                    error($errors:BAD_REQUEST, "A notebook with that name already exists")
                else
                    let $content := util:binary-to-string(util:binary-doc($full-path))
                    let $_ := xmldb:store($parent-col, $new-filename, $content, "application/json")
                    let $_ := xmldb:remove($parent-col, $old-filename)
                    return map {
                        "path": $new-path,
                        "slug": replace($new-path, "\.ipynb$", ""),
                        "renamed": true()
                    }
};

(:~
 : Upload/import a notebook.
 :)
declare function nb:upload($request as map(*)) {
    let $body := $request?body
    let $filename := $body?filename
    let $content := $body?content
    let $collection := ($body?collection, "")[1]
    return
        if (not($filename) or $filename eq "") then
            error($errors:BAD_REQUEST, "Filename is required")
        else
            let $full-filename := if (ends-with($filename, ".ipynb")) then $filename else $filename || ".ipynb"
            let $target-col :=
                if ($collection ne "") then $config:DATA_ROOT || "/" || $collection
                else $config:DATA_ROOT
            let $final-filename :=
                if (util:binary-doc-available($target-col || "/" || $full-filename)) then
                    nb:find-copy-name-in($target-col, replace($full-filename, "\.ipynb$", ""), 1) || ".ipynb"
                else $full-filename
            let $json := if ($content instance of map(*)) then serialize($content, map { "method": "json", "indent": true() }) else $content
            let $_ := xmldb:store($target-col, $final-filename, $json, "application/json")
            let $rel-path := if ($collection ne "") then $collection || "/" || $final-filename else $final-filename
            return roaster:response(201, "application/json", map {
                "path": $rel-path,
                "slug": replace($rel-path, "\.ipynb$", ""),
                "uploaded": true()
            }, ())
};

(:~
 : List version history for a notebook.
 :)
declare function nb:versions($request as map(*)) {
    let $path := $request?parameters?path
    (: Flatten path for version naming: expath-crypto/01-hashing → expath-crypto--01-hashing :)
    let $version-prefix := replace(replace($path, "\.ipynb$", ""), "/", "--") || "."
    return
        if (not(xmldb:collection-available($nb:VERSIONS_COL))) then
            array {}
        else
            array {
                for $resource in xmldb:get-child-resources($nb:VERSIONS_COL)
                where starts-with($resource, $version-prefix) and ends-with($resource, ".ipynb")
                let $timestamp := replace(replace($resource, "^" || replace($version-prefix, "\.", "\\."), ""), "\.ipynb$", "")
                let $modified := xmldb:last-modified($nb:VERSIONS_COL, $resource)
                order by $modified descending
                return map {
                    "version": $resource,
                    "timestamp": $timestamp,
                    "modified": string($modified),
                    "size": xmldb:size($nb:VERSIONS_COL, $resource)
                }
            }
};

(:~
 : Restore a specific version.
 :)
declare function nb:restore($request as map(*)) {
    let $path := $request?parameters?path
    let $version := $request?parameters?version
    let $full-path := $config:DATA_ROOT || "/" || $path
    let $version-path := $nb:VERSIONS_COL || "/" || $version
    return
        if (not(util:binary-doc-available($version-path))) then
            error($errors:NOT_FOUND, "Version not found: " || $version)
        else
            let $_ := if (util:binary-doc-available($full-path)) then nb:create-snapshot($path) else ()
            let $content := util:binary-to-string(util:binary-doc($version-path))
            let $parts := tokenize($path, "/")
            let $filename := $parts[last()]
            let $parent := if (count($parts) > 1) then $config:DATA_ROOT || "/" || string-join(subsequence($parts, 1, count($parts) - 1), "/") else $config:DATA_ROOT
            let $stored := xmldb:store($parent, $filename, $content, "application/json")
            return map {
                "path": $path,
                "restored": true(),
                "fromVersion": $version,
                "modified": string(current-dateTime())
            }
};


(: ==================== Private helpers ==================== :)

declare %private function nb:create-snapshot($path as xs:string) {
    let $full-path := $config:DATA_ROOT || "/" || $path
    let $_ :=
        if (not(xmldb:collection-available($nb:VERSIONS_COL))) then
            xmldb:create-collection($config:DATA_ROOT, "versions")
        else ()
    (: Flatten nested path for version naming :)
    let $flat-base := replace(replace($path, "\.ipynb$", ""), "/", "--")
    let $ts := replace(replace(string(current-dateTime()), ":", "-"), "\+.*$", "")
    let $version-name := $flat-base || "." || $ts || ".ipynb"
    let $content := util:binary-to-string(util:binary-doc($full-path))
    let $stored := xmldb:store($nb:VERSIONS_COL, $version-name, $content, "application/json")

    (: Prune old versions :)
    let $prefix := $flat-base || "."
    let $all-versions :=
        for $resource in xmldb:get-child-resources($nb:VERSIONS_COL)
        where starts-with($resource, $prefix) and ends-with($resource, ".ipynb")
        let $modified := xmldb:last-modified($nb:VERSIONS_COL, $resource)
        order by $modified descending
        return $resource
    let $to-remove := subsequence($all-versions, $config:MAX_VERSIONS + 1)
    let $_ := for $old in $to-remove return xmldb:remove($nb:VERSIONS_COL, $old)
    return $version-name
};

declare %private function nb:find-copy-name-in($col as xs:string, $base as xs:string, $n as xs:integer) as xs:string {
    let $candidate := if ($n eq 1) then $base || "-copy" else $base || "-copy-" || $n
    return
        if (util:binary-doc-available($col || "/" || $candidate || ".ipynb")) then
            nb:find-copy-name-in($col, $base, $n + 1)
        else $candidate
};

declare %private function nb:load-notebook($path as xs:string) as map(*) {
    parse-json(util:binary-to-string(util:binary-doc($path)))
};

declare %private function nb:extract-title($notebook as map(*), $filename as xs:string) as xs:string {
    let $cells := $notebook?cells
    let $first-md := (
        for $i in 1 to array:size($cells)
        let $cell := $cells($i)
        where $cell?cell_type eq "markdown"
        return $cell
    )[1]
    return
        if (exists($first-md)) then
            let $source := if ($first-md?source instance of array(*)) then string-join($first-md?source?*, "") else string($first-md?source)
            let $heading := analyze-string($source, "^#\s+(.+)$", "m")
            return
                if ($heading//fn:group[@nr="1"]) then string(($heading//fn:group[@nr="1"])[1])
                else replace($filename, "\.ipynb$", "")
        else replace($filename, "\.ipynb$", "")
};

declare %private function nb:slugify($title as xs:string) as xs:string {
    replace(normalize-space(replace(lower-case($title), "[^a-z0-9\s-]", "")), "\s+", "-")
};
