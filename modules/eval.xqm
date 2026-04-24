xquery version "3.1";

(:~
 : XQuery evaluation and linting API.
 :
 : Supports two chaining modes:
 :   1. Named cell caching (preferred): cell results are cached by user-defined
 :      name using eXist's cache module. Subsequent cells retrieve cached results
 :      instead of re-evaluating prior cells.
 :   2. Stateless re-evaluation (fallback): prior cell queries are re-sent and
 :      wrapped in let-bindings. Used when cache is unavailable or for unnamed cells.
 :)
module namespace eval="http://exist-db.org/pkg/notebook/eval";

import module namespace config="http://exist-db.org/pkg/notebook/config" at "config.xqm";
import module namespace roaster="http://e-editiones.org/roaster";
import module namespace errors="http://e-editiones.org/roaster/errors";
import module namespace cache="http://exist-db.org/xquery/cache";

(:~
 : Execute an XQuery expression with named cell chaining via cache.
 :
 : The client sends:
 :   - query: the current cell's XQuery source
 :   - session: a unique session ID (generated per page load)
 :   - cellName: optional user-defined name for this cell's result
 :   - context: array of preceding named cells, each with:
 :       - name: the cell's variable name
 :       - query: source code (used as fallback if not cached)
 :   - serialization: output format options
 :
 : On success, the result is cached under the cell's name for use by
 : subsequent cells. Named cells become $name variables; unnamed cells
 : are not cached or referenceable.
 :
 : @param $request the roaster request map
 : @return map with result, count, elapsed, type, cached — or error details
 :)
declare function eval:run($request as map(*)) {
    let $body := $request?body
    let $raw-query := $body?query
    let $session := $body?session
    let $context := $body?context
    let $timeout := ($body?timeout, 5000)[1]

    (: Parse xqdoc directives (@name, @data, @silent) from the query :)
    let $directives := eval:parse-xqdoc-directives($raw-query)

    (: Cell name: directive @name takes priority over request body :)
    let $cell-name := ($directives?name, $body?cellName)[1]

    (: For @data cells, wrap the content as executable XQuery :)
    let $query :=
        if ($directives?dataFormat) then
            eval:wrap-data-cell($raw-query, $directives?dataFormat)
        else
            $raw-query

    (: Parse serialization options :)
    let $ser-opts := eval:parse-serialization($body?serialization)

    (: Ensure session cache exists :)
    let $cache-name := $config:CACHE_PREFIX || $session
    let $_ := eval:ensure-cache($cache-name)
    (: Client tells us if any cells have been run this session :)
    let $session-has-history := $body?sessionHasRun eq true()

    (: Build preamble: retrieve named cell results from cache,
       falling back to re-evaluation for cache misses :)
    (: Build preamble and track cache misses :)
    let $context-results :=
        if (exists($context)) then
            for $cell in $context?*
            let $name := $cell?name
            where $name and $name ne ""
            let $is-data := $cell?kind eq "data"
            let $cached := cache:get($cache-name, $name)
            let $hit := exists($cached)
            let $_ :=
                if ($hit) then ()
                else if ($is-data and $cell?content and $cell?content ne "") then
                    eval:parse-and-cache-data($cell?content, $cell?dataLanguage, $cache-name, $name)
                else if ($cell?query and $cell?query ne "") then
                    eval:eval-and-cache($cell?query, $cache-name, $name)
                else ()
            return map {
                "let": "let $" || $name || " := cache:get('" || $cache-name || "', '" || $name || "')",
                "hit": $hit
            }
        else ()

    let $preamble-lets :=
        for $r in $context-results
        return $r?let

    let $cache-misses := count($context-results[?hit eq false()])
    let $cache-total := count($context-results)

    (: Assemble and run the query :)
    let $full-query := eval:assemble-chained-query($query, $preamble-lets)

    let $start := util:system-time()
    return
        try {
            let $result := util:eval($full-query, false(), (), false())
            let $elapsed := util:system-time() - $start

            (: Cache this cell's result if it has a name :)
            let $_ :=
                if ($cell-name and $cell-name ne "") then
                    cache:put($cache-name, $cell-name, $result)
                else ()

            return map:merge((
                map {
                    "result": serialize($result, $ser-opts),
                    "count": count($result),
                    "elapsed": string($elapsed),
                    "type": ($ser-opts?method, "adaptive")[1]
                },
                if ($directives?silent eq true()) then
                    map { "silent": true() }
                else (),
                if ($cache-misses > 0 and $session-has-history) then
                    map { "cacheMisses": $cache-misses, "cacheTotal": $cache-total }
                else ()
            ))
        } catch * {
            map {
                "error": $err:description,
                "code": string($err:code),
                "line": $err:line-number,
                "column": $err:column-number
            }
        }
};

(:~
 : Compile-check XQuery code and return lint diagnostics.
 :
 : Accepts named cell references so the linter knows which variables
 : are available from preceding cells.
 :
 : @param $request the roaster request map
 : @return map with status (ok|fail), and on failure: message, line, column
 :)
declare function eval:lint($request as map(*)) {
    let $code := $request?body?code
    return
        if (not($code) or $code = "") then
            map { "status": "ok" }
        else
            (: For @data cells, lint the wrapped version instead of raw content :)
            let $directives := eval:parse-xqdoc-directives($code)
            let $code :=
                if ($directives?dataFormat) then
                    eval:wrap-data-cell($code, $directives?dataFormat)
                else
                    $code

            let $cell-names := $request?body?cellNames

            (: Inject external variable declarations for named preceding cells :)
            let $cell-decls :=
                if (exists($cell-names)) then
                    string-join(
                        for $name in $cell-names?*
                        where $name and $name ne ""
                        return "declare variable $" || $name || " external;",
                        codepoints-to-string(10)
                    ) || codepoints-to-string(10)
                else ""

            let $lint-code :=
                if ($cell-decls != "") then
                    let $pb := eval:peel-simple-prolog($code, "")
                    return $pb[1] || $cell-decls || $pb[2]
                else $code

            let $result := util:compile($lint-code)
            return
                if (not($result) or $result = "" or starts-with($result, "compiled")) then
                    map { "status": "ok" }
                else
                    let $msg := replace($result, "^error found while executing expression:\s*", "")
                    let $msg := replace($msg, "^org\.exist\.xquery\.\w+:\s*", "")
                    let $msg := replace($msg, "\n$", "")
                    let $loc := analyze-string($result, "\[at line (\d+), column (\d+)\]")
                    (: Adjust line numbers for injected declarations :)
                    let $decl-lines :=
                        if (exists($cell-names)) then
                            count($cell-names?*[. ne ""])
                        else 0
                    let $line := if ($loc//fn:group[@nr="1"]) then max((1, xs:integer($loc//fn:group[@nr="1"]) - $decl-lines)) else 1
                    let $column := if ($loc//fn:group[@nr="2"]) then xs:integer($loc//fn:group[@nr="2"]) else 1
                    return map {
                        "status": "fail",
                        "message": $msg,
                        "line": $line,
                        "column": $column
                    }
};


(: ==================== Directive parsing ==================== :)

(:~
 : Parse xqdoc-style directives from XQuery cell source.
 :
 : Recognized directives:
 :   @name <identifier>   — cell name (for caching)
 :   @data xml|json|text  — treat content as data, not XQuery
 :   @silent              — suppress output
 :
 : @param $code the cell source
 : @return map with name, dataFormat, silent keys (all optional)
 :)
declare %private function eval:parse-xqdoc-directives($code as xs:string) as map(*) {
    let $match := analyze-string($code, "^\s*\(:~([\s\S]*?):\)")
    let $body := string($match//fn:group[@nr="1"])
    return
        if ($body = "") then
            map {}
        else
            let $lines := tokenize($body, "\n")
            return map:merge((
                for $line in $lines
                let $stripped := replace(replace($line, "^\s+", ""), "^[*:]\s?", "")
                return (
                    let $name-match := analyze-string($stripped, "^@name\s+([a-zA-Z_][a-zA-Z0-9_-]*)")
                    return
                        if ($name-match//fn:match) then
                            map { "name": string($name-match//fn:group[@nr="1"]) }
                        else (),
                    let $data-match := analyze-string($stripped, "^@data\s+(xml|json|text)", "i")
                    return
                        if ($data-match//fn:match) then
                            map { "dataFormat": lower-case(string($data-match//fn:group[@nr="1"])) }
                        else (),
                    if (matches($stripped, "^@silent\b")) then
                        map { "silent": true() }
                    else ()
                )
            ))
};

(:~
 : Wrap data cell content as executable XQuery.
 :
 : Strips the xqdoc comment and wraps based on format:
 :   - json: parse-json('...')
 :   - text: string literal '...'
 :   - xml:  passed through (XML literals are valid XQuery)
 :
 : @param $code full cell source including xqdoc comment
 : @param $format "xml", "json", or "text"
 : @return executable XQuery string
 :)
declare %private function eval:wrap-data-cell($code as xs:string, $format as xs:string) as xs:string {
    let $content := replace($code, "^\s*\(:~[\s\S]*?:\)\s*", "")
    return
        switch ($format)
        case "json" return
            "parse-json('" || replace($content, "'", "''") || "')"
        case "text" return
            "'" || replace($content, "'", "''") || "'"
        default (: xml :) return
            $content
};

(: ==================== Private helpers ==================== :)

(:~
 : Parse serialization options from the request body.
 :)
declare %private function eval:parse-serialization($serialization) as map(*) {
    if ($serialization instance of map(*)) then
        let $raw := $serialization
        let $boolean-params := ("indent", "omit-xml-declaration", "standalone",
            "escape-uri-attributes", "include-content-type", "undeclare-prefixes")
        return map:merge(
            for $key in map:keys($raw)
            let $val := $raw($key)
            return map:entry($key,
                if ($key = $boolean-params) then
                    string($val) = ("yes", "true", "1")
                else
                    $val
            )
        )
    else
        map { "method": ($serialization, "adaptive")[1] }
};

(:~
 : Ensure a session cache exists with sane defaults.
 : Enforces the max session limit by destroying the oldest cache if exceeded.
 :)
declare %private function eval:ensure-cache($cache-name as xs:string) {
    if ($cache-name = cache:names()) then ()
    else (
        (: Enforce max sessions — evict oldest if at capacity :)
        let $nb-caches :=
            for $name in cache:names()
            where starts-with($name, $config:CACHE_PREFIX)
            return $name
        let $_ :=
            if (count($nb-caches) >= $config:CACHE_MAX_SESSIONS) then
                (: Destroy the first one found — rough LRU since Caffeine
                   orders by access time internally :)
                cache:destroy($nb-caches[1])
            else ()
        return
            cache:create($cache-name, map {
                "maximumSize": $config:CACHE_MAX_CELLS,
                "expireAfterAccess": $config:CACHE_EXPIRE_MS
            })
    )
};

(:~
 : Parse data cell content and cache the parsed result.
 : Supports XML (parse-xml), JSON (parse-json), and text (as-is).
 :)
declare %private function eval:parse-and-cache-data(
    $content as xs:string,
    $language as xs:string?,
    $cache-name as xs:string,
    $name as xs:string
) {
    try {
        let $parsed :=
            switch (($language, "xml")[1])
            case "xml" return parse-xml($content)
            case "json" return parse-json($content)
            default return $content
        return cache:put($cache-name, $name, $parsed)
    } catch * {
        util:log("WARN", "notebook: failed to parse data cell '" || $name || "': " || $err:description)
    }
};

(:~
 : Evaluate a query and cache its result under the given name.
 : Used for cache-miss fallback when a preceding cell hasn't been run yet.
 :)
declare %private function eval:eval-and-cache(
    $query as xs:string,
    $cache-name as xs:string,
    $name as xs:string
) {
    try {
        let $result := util:eval($query, false(), (), false())
        return cache:put($cache-name, $name, $result)
    } catch * {
        (: Silently skip — the main query will fail with a clear error
           about the missing variable :)
        ()
    }
};

(:~
 : Assemble the full query for a chained eval.
 : Peels simple prolog declarations off the user query, injects the let-chain,
 : then appends the body.
 :)
declare %private function eval:assemble-chained-query(
    $user-query    as xs:string,
    $preamble-lets as xs:string*
) as xs:string {
    if (empty($preamble-lets)) then
        $user-query
    else
        let $pb      := eval:peel-simple-prolog($user-query, "")
        let $prolog  := $pb[1]
        let $body    := $pb[2]
        (: Add cache module import so cache:get works in the assembled query :)
        let $cache-import := "import module namespace cache='http://exist-db.org/xquery/cache';" || codepoints-to-string(10)
        let $chain   := string-join($preamble-lets, codepoints-to-string(10)) || codepoints-to-string(10) || "return" || codepoints-to-string(10)
        return $prolog || $cache-import || $chain || $body
};

(:~
 : Recursively strip simple prolog declarations from the front of $q.
 : Returns ($accumulated-prolog, $remaining-body).
 :)
declare %private function eval:peel-simple-prolog($q as xs:string, $acc as xs:string) as xs:string+ {
    let $pattern := "^\s*((?:xquery|declare|import)\s+[^;{]+;)\s*"
    let $m       := analyze-string($q, $pattern, "si")
    let $matched := string($m//fn:match)
    return
        if ($matched = "") then
            ($acc, $q)
        else
            let $rest := string-join($m//fn:non-match/string(), "")
            return eval:peel-simple-prolog($rest, $acc || $matched || codepoints-to-string(10))
};
