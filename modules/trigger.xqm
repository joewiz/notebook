xquery version "3.1";

(:~
 : Trigger module: creates shadow XML documents from .ipynb notebooks
 : for Lucene full-text search indexing.
 :
 : When a notebook is stored/updated in the data collection, this trigger:
 :   1. Parses the .ipynb JSON
 :   2. Extracts text from markdown cells and code cells
 :   3. Stores a shadow XML document in data-index/ for Lucene to index
 :
 : Shadow structure:
 :   <notebook>
 :       <title>...</title>
 :       <slug>my-notebook</slug>
 :       <url>/exist/apps/notebook/my-notebook</url>
 :       <body>concatenated markdown + code text</body>
 :   </notebook>
 :)
module namespace trigger="http://exist-db.org/pkg/notebook/trigger";

import module namespace config="http://exist-db.org/pkg/notebook/config" at "config.xqm";

declare variable $trigger:index-root := $config:APP_ROOT || "/data-index";

(:~
 : Create/update shadow document when a notebook is stored.
 :)
declare function trigger:after-create-document($uri as xs:anyURI) {
    trigger:store-shadow(xs:string($uri))
};

declare function trigger:after-update-document($uri as xs:anyURI) {
    trigger:store-shadow(xs:string($uri))
};

(:~
 : Remove shadow document when a notebook is deleted.
 :)
declare function trigger:after-delete-document($uri as xs:anyURI) {
    trigger:remove-shadow(xs:string($uri))
};

(:~
 : Parse an .ipynb file and store its shadow XML for indexing.
 :)
declare %private function trigger:store-shadow($uri as xs:string) {
    if (not(ends-with($uri, ".ipynb"))) then ()
    else if (not(util:binary-doc-available($uri))) then ()
    else
        try {
            let $raw := util:binary-to-string(util:binary-doc($uri))
            let $nb := parse-json($raw)
            let $cells := $nb?cells

            (: Extract title from first markdown heading :)
            let $title := trigger:extract-title($nb, $uri)

            (: Extract all text content from cells :)
            let $body := string-join(
                for $i in 1 to array:size($cells)
                let $cell := $cells($i)
                let $source :=
                    if ($cell?source instance of array(*)) then
                        string-join($cell?source?*, "")
                    else
                        string($cell?source)
                return $source,
                codepoints-to-string(10) || codepoints-to-string(10)
            )

            (: Build slug and URL :)
            let $slug := trigger:slug-from-uri($uri)
            let $url := "/exist/apps/notebook/" || $slug

            (: Create shadow document :)
            let $shadow-name := replace($slug, "/", "--") || ".xml"
            let $xml := <notebook>
                <title>{$title}</title>
                <slug>{$slug}</slug>
                <url>{$url}</url>
                <body>{$body}</body>
            </notebook>

            (: Ensure index collection exists :)
            let $_ :=
                if (not(xmldb:collection-available($trigger:index-root))) then
                    xmldb:create-collection($config:APP_ROOT, "data-index")
                else ()

            return xmldb:store($trigger:index-root, $shadow-name, $xml)
        } catch * {
            util:log("WARN", "notebook trigger: failed to index " || $uri || ": " || $err:description)
        }
};

(:~
 : Remove shadow document.
 :)
declare %private function trigger:remove-shadow($uri as xs:string) {
    if (not(ends-with($uri, ".ipynb"))) then ()
    else
        let $slug := trigger:slug-from-uri($uri)
        let $shadow-name := replace($slug, "/", "--") || ".xml"
        return
            if (xmldb:collection-available($trigger:index-root)
                and $shadow-name = xmldb:get-child-resources($trigger:index-root)) then
                xmldb:remove($trigger:index-root, $shadow-name)
            else ()
};

(:~
 : Extract title from notebook — first markdown heading or filename.
 :)
declare %private function trigger:extract-title($nb as map(*), $uri as xs:string) as xs:string {
    let $cells := $nb?cells
    let $first-md := (
        for $i in 1 to array:size($cells)
        let $cell := $cells($i)
        where $cell?cell_type eq "markdown"
        return $cell
    )[1]
    return
        if (exists($first-md)) then
            let $source :=
                if ($first-md?source instance of array(*)) then
                    string-join($first-md?source?*, "")
                else
                    string($first-md?source)
            let $heading := analyze-string($source, "^#\s+(.+)$", "m")
            return
                if ($heading//fn:group[@nr="1"]) then
                    string(($heading//fn:group[@nr="1"])[1])
                else
                    trigger:slug-from-uri($uri)
        else
            trigger:slug-from-uri($uri)
};

(:~
 : Convert a data collection URI to a URL-safe slug.
 : /db/apps/notebook/data/my-notebook.ipynb -> my-notebook
 : /db/apps/notebook/data/expath-crypto/01-hashing.ipynb -> expath-crypto/01-hashing
 :)
declare %private function trigger:slug-from-uri($uri as xs:string) as xs:string {
    let $rel := substring-after($uri, $config:DATA_ROOT || "/")
    return replace($rel, "\.ipynb$", "")
};

(:~
 : Create a safe shadow filename from a path (flattens / to --).
 :)
declare %private function trigger:shadow-name-from-uri($uri as xs:string) as xs:string {
    let $slug := trigger:slug-from-uri($uri)
    return replace($slug, "/", "--") || ".xml"
};
