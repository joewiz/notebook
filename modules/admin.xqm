xquery version "3.1";

(:~
 : Admin API — cache management and app configuration.
 : Restricted to dba users.
 :)
module namespace admin="http://exist-db.org/pkg/notebook/admin";

import module namespace config="http://exist-db.org/pkg/notebook/config" at "config.xqm";
import module namespace roaster="http://e-editiones.org/roaster";
import module namespace errors="http://e-editiones.org/roaster/errors";
import module namespace cache="http://exist-db.org/xquery/cache";

(:~
 : Verify the current user is a dba.
 :)
declare %private function admin:require-dba() {
    let $groups := (sm:id()//sm:group/string(), sm:id()//sm:effective/sm:group/string())
    return
        if ($groups = "dba") then ()
        else error($errors:FORBIDDEN, "Admin access requires dba privileges")
};

(:~
 : Get current cache configuration and defaults.
 :)
declare function admin:get-config($request as map(*)) {
    admin:require-dba(),
    map {
        "cache": map {
            "maxCells": $config:CACHE_MAX_CELLS,
            "expireMs": $config:CACHE_EXPIRE_MS,
            "maxSessions": $config:CACHE_MAX_SESSIONS,
            "prefix": $config:CACHE_PREFIX
        },
        "versioning": map {
            "maxVersions": $config:MAX_VERSIONS
        }
    }
};

(:~
 : List all notebook session caches with their keys and sizes.
 :)
declare function admin:list-caches($request as map(*)) {
    admin:require-dba(),
    let $all-names := cache:names()
    let $nb-caches :=
        for $name in $all-names
        where starts-with($name, $config:CACHE_PREFIX)
        let $session-id := substring-after($name, $config:CACHE_PREFIX)
        let $keys := cache:keys($name)
        return map {
            "name": $name,
            "sessionId": $session-id,
            "keys": array { $keys },
            "entryCount": count($keys)
        }
    return map {
        "caches": array { $nb-caches },
        "totalCaches": count($nb-caches),
        "allCacheNames": array { $all-names }
    }
};

(:~
 : Get details for a specific cache — list all keys and their value types.
 :)
declare function admin:cache-detail($request as map(*)) {
    admin:require-dba(),
    let $name := $request?parameters?name
    return
        if (not($name = cache:names())) then
            error($errors:NOT_FOUND, "Cache not found: " || $name)
        else
            let $keys := cache:keys($name)
            return map {
                "name": $name,
                "entries": array {
                    for $key in $keys
                    let $value := cache:get($name, $key)
                    return map {
                        "key": $key,
                        "type":
                            if ($value instance of node()) then "node"
                            else if ($value instance of map(*)) then "map"
                            else if ($value instance of array(*)) then "array"
                            else if ($value instance of xs:string) then "string"
                            else if ($value instance of xs:integer) then "integer"
                            else if ($value instance of xs:double) then "double"
                            else "other",
                        "preview":
                            substring(
                                serialize($value, map { "method": "adaptive" }),
                                1, 200
                            )
                    }
                }
            }
};

(:~
 : Remove a single entry from a cache.
 :)
declare function admin:cache-remove-entry($request as map(*)) {
    admin:require-dba(),
    let $name := $request?parameters?name
    let $key := $request?body?key
    return
        if (not($name = cache:names())) then
            error($errors:NOT_FOUND, "Cache not found: " || $name)
        else (
            cache:remove($name, $key),
            map { "removed": true(), "key": $key, "cache": $name }
        )
};

(:~
 : Clear all entries from a cache (keeps the cache itself).
 :)
declare function admin:cache-clear($request as map(*)) {
    admin:require-dba(),
    let $name := $request?parameters?name
    return
        if (not($name = cache:names())) then
            error($errors:NOT_FOUND, "Cache not found: " || $name)
        else (
            cache:clear($name),
            map { "cleared": true(), "cache": $name }
        )
};

(:~
 : Destroy a cache entirely.
 :)
declare function admin:cache-destroy($request as map(*)) {
    admin:require-dba(),
    let $name := $request?parameters?name
    return
        if (not($name = cache:names())) then
            error($errors:NOT_FOUND, "Cache not found: " || $name)
        else (
            cache:destroy($name),
            map { "destroyed": true(), "cache": $name }
        )
};

(: ==================== Version Management ==================== :)

(:~
 : List all version snapshots, grouped by notebook.
 :)
declare function admin:list-versions($request as map(*)) {
    admin:require-dba(),
    let $versions-col := $config:DATA_ROOT || "/versions"
    return
        if (not(xmldb:collection-available($versions-col))) then
            map { "notebooks": array {}, "totalVersions": 0, "totalSize": 0 }
        else
            let $all := xmldb:get-child-resources($versions-col)
            (: Group versions by notebook base name :)
            let $notebooks := distinct-values(
                for $v in $all
                where ends-with($v, ".ipynb")
                (: Extract base name: "my-notebook.2026-04-23T14-46.ipynb" → "my-notebook" :)
                return replace($v, "\.\d{4}-\d{2}-\d{2}T.*$", "")
            )
            return map {
                "notebooks": array {
                    for $nb-name in $notebooks
                    let $prefix := $nb-name || "."
                    let $versions :=
                        for $v in $all
                        where starts-with($v, $prefix) and ends-with($v, ".ipynb")
                        let $modified := xmldb:last-modified($versions-col, $v)
                        let $size := xmldb:size($versions-col, $v)
                        order by $modified descending
                        return map {
                            "filename": $v,
                            "modified": string($modified),
                            "size": $size
                        }
                    order by $nb-name
                    return map {
                        "notebook": $nb-name,
                        "notebookFile": $nb-name || ".ipynb",
                        "versions": array { $versions },
                        "count": count($versions),
                        "totalSize": sum($versions ! ?size)
                    }
                },
                "totalVersions": count($all[ends-with(., ".ipynb")]),
                "totalSize": sum(for $v in $all[ends-with(., ".ipynb")] return xmldb:size($versions-col, $v))
            }
};

(:~
 : Delete a specific version snapshot.
 :)
declare function admin:delete-version($request as map(*)) {
    admin:require-dba(),
    let $filename := $request?parameters?filename
    let $versions-col := $config:DATA_ROOT || "/versions"
    let $path := $versions-col || "/" || $filename
    return
        if (not(util:binary-doc-available($path))) then
            error($errors:NOT_FOUND, "Version not found: " || $filename)
        else (
            xmldb:remove($versions-col, $filename),
            map { "deleted": true(), "filename": $filename }
        )
};

(:~
 : Delete all versions for a specific notebook.
 :)
declare function admin:delete-versions-for($request as map(*)) {
    admin:require-dba(),
    let $notebook := $request?parameters?notebook
    let $versions-col := $config:DATA_ROOT || "/versions"
    let $prefix := replace($notebook, "\.ipynb$", "") || "."
    let $deleted :=
        if (not(xmldb:collection-available($versions-col))) then ()
        else
            for $v in xmldb:get-child-resources($versions-col)
            where starts-with($v, $prefix) and ends-with($v, ".ipynb")
            return (
                xmldb:remove($versions-col, $v),
                $v
            )
    return map {
        "deleted": array { $deleted },
        "count": count($deleted),
        "notebook": $notebook
    }
};

(:~
 : Purge old version snapshots, keeping the most recent N per notebook.
 : Query param ?keep=N (default 1). Use ?keep=0 to delete everything.
 :)
declare function admin:delete-all-versions($request as map(*)) {
    admin:require-dba(),
    let $keep := xs:integer(($request?parameters?keep, 1)[1])
    let $versions-col := $config:DATA_ROOT || "/versions"
    let $deleted :=
        if (not(xmldb:collection-available($versions-col))) then ()
        else
            let $all := xmldb:get-child-resources($versions-col)[ends-with(., ".ipynb")]
            (: Group by notebook base name :)
            let $notebooks := distinct-values(
                for $v in $all
                return replace($v, "\.\d{4}-\d{2}-\d{2}T.*$", "")
            )
            return
                for $nb-name in $notebooks
                let $prefix := $nb-name || "."
                let $versions :=
                    for $v in $all
                    where starts-with($v, $prefix)
                    let $modified := xmldb:last-modified($versions-col, $v)
                    order by $modified descending
                    return $v
                (: Keep the newest $keep, delete the rest :)
                let $to-delete := subsequence($versions, $keep + 1)
                return
                    for $v in $to-delete
                    return (
                        xmldb:remove($versions-col, $v),
                        $v
                    )
    return map {
        "count": count($deleted),
        "kept": $keep,
        "deleted": true()
    }
};

(: ==================== Export ==================== :)

(:~
 : Export all notebooks as a JSON array (for backup/migration).
 :)
declare function admin:export-all($request as map(*)) {
    admin:require-dba(),
    array {
        for $resource in xmldb:get-child-resources($config:DATA_ROOT)
        where ends-with($resource, ".ipynb")
        let $content := parse-json(util:binary-to-string(util:binary-doc($config:DATA_ROOT || "/" || $resource)))
        return map {
            "filename": $resource,
            "notebook": $content
        }
    }
};

(:~
 : Clear ALL notebook caches.
 :)
declare function admin:cache-clear-all($request as map(*)) {
    admin:require-dba(),
    let $destroyed :=
        for $name in cache:names()
        where starts-with($name, $config:CACHE_PREFIX)
        return (
            cache:destroy($name),
            $name
        )
    return map {
        "destroyed": array { $destroyed },
        "count": count($destroyed)
    }
};
