xquery version "3.1";

(:~
 : Navigation module.
 :
 : Reads the nav bar item list from data/nav-config.xml.
 : Supports two entry types:
 :   <app abbrev="..." title="..." fallback="..."/>
 :       Only shown when the app is installed; URL is context-path + /apps/{abbrev}.
 :   <link title="..." href="https://..." /> or <link title="..." path="/apps/..."/>
 :       Always shown; href is used as-is, path is prepended with context-path.
 :       Links have no abbrev so they are excluded from the search-scope selector.
 :)
module namespace nav = "http://exist-db.org/site/nav";

declare namespace n = "http://exist-db.org/site/nav";

(:~
 : Return an array of maps for the nav bar, in document order.
 :
 : Each map contains:
 :   - title:      display label
 :   - abbrev:     package abbreviation (empty string for <link> entries)
 :   - url:        resolved URL
 :   - active:     true when the current request URI starts with the app's path
 :   - external:   true for http/https URLs (opens in new tab)
 :
 : @return array of nav item maps
 :)
declare function nav:apps() as array(*) {
    let $context     := try { request:get-context-path() } catch * { "/exist" }
    let $current-uri := try { request:get-uri() }         catch * { "" }
    let $nav-config  := doc("/db/apps/exist-site-shell/data/nav-config.xml")/n:nav-config
    return array {
        for $entry in $nav-config/(n:app | n:link)
        return
            typeswitch ($entry)

            case element(n:app) return
                let $abbrev   := $entry/@abbrev/string()
                let $app-path := $context || "/apps/" || $abbrev
                where xmldb:collection-available("/db/apps/" || $abbrev)
                return map {
                    "title":    $entry/@title/string(),
                    "abbrev":   $abbrev,
                    "url":      $app-path,
                    "active":   starts-with($current-uri, $app-path),
                    "external": false()
                }

            case element(n:link) return
                let $url :=
                    if ($entry/@href) then $entry/@href/string()
                    else $context || $entry/@path/string()
                let $external := starts-with($url, "http://") or starts-with($url, "https://")
                return map {
                    "title":    $entry/@title/string(),
                    "abbrev":   "",
                    "url":      $url,
                    "active":   not($external) and starts-with($current-uri, $url),
                    "external": $external
                }

            default return ()
    }
};

(:~
 : Two-argument overload for compatibility with the profile's base-page.html,
 : which calls nav:apps($nav?items, $context-path). The arguments are ignored —
 : nav-config.xml is the authoritative source.
 :)
declare function nav:apps($items as item()*, $context-path as xs:string) as array(*) {
    nav:apps()
};
