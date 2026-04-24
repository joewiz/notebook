xquery version "3.1";

(:~
 : Site configuration module for eXist-db site apps.
 :
 : Provides common functions used by templates across all
 : apps generated from the exist-site profile.
 :
 : Cross-reference resolution
 : --------------------------
 : site-config:resolve($ref) expands {abbrev[/path][#fragment]} references
 : to absolute URLs. If the named app is installed locally the local URL is
 : returned; otherwise the app's configured fallback URL (from nav-config.xml
 : in exist-site-shell) is used. This lets authors write portable cross-app
 : links without hard-coding host names or worrying about which apps a
 : particular installation has deployed.
 :
 : Examples:
 :   {eXide}                            → /exist/apps/eXide
 :   {docs/articles/repo#how-to}        → /exist/apps/docs/articles/repo#how-to
 :   {docs/functions/fn/string-join#3}  → /exist/apps/docs/functions/fn/string-join#3
 :   {blog/2026/welcome#intro}          → /exist/apps/blog/2026/welcome#intro
 :)
module namespace site-config = "http://exist-db.org/site/shell-config";

declare namespace n = "http://exist-db.org/site/nav";

(:~ Path to the nav-config registry in the site-shell app. :)
declare variable $site-config:REGISTRY-PATH :=
    "/db/apps/exist-site-shell/data/nav-config.xml";

(:~
 : Resolve a {abbrev[/path][#fragment]} cross-reference to an absolute URL.
 :
 : If $ref does not match the pattern (i.e. is not wrapped in braces) it is
 : returned unchanged so callers can pass any href safely.
 :
 : @param $ref  a cross-reference in the form {abbrev[/path][#fragment]},
 :              or any other string (returned as-is)
 : @return resolved URL string
 :)
declare function site-config:resolve($ref as xs:string) as xs:string {
    if (not(matches($ref, "^\{[^}]+\}$"))) then
        $ref
    else
        let $inner   := replace($ref, "^\{|\}$", "")
        (: Split fragment from the rest :)
        let $fragment := if (contains($inner, "#")) then "#" || substring-after($inner, "#") else ""
        let $no-frag  := if (contains($inner, "#")) then substring-before($inner, "#") else $inner
        (: First path segment is the app abbreviation :)
        let $abbrev  := if (contains($no-frag, "/")) then substring-before($no-frag, "/") else $no-frag
        let $path    := if (contains($no-frag, "/")) then "/" || substring-after($no-frag, "/") else ""
        let $context := try { request:get-context-path() } catch * { "/exist" }
        let $base    :=
            if (xmldb:collection-available("/db/apps/" || $abbrev)) then
                $context || "/apps/" || $abbrev
            else
                (: look up fallback in the registry :)
                let $entry := doc($site-config:REGISTRY-PATH)/n:nav-config/n:app[@abbrev = $abbrev]
                return
                    if (exists($entry/@fallback)) then
                        string($entry/@fallback)
                    else
                        (: no registry entry — produce a recognisable broken-link marker :)
                        "#unresolved-" || $abbrev
        return $base || $path || $fragment
};

(:~
 : Get the root URL for a named app.
 : Convenience wrapper around site-config:resolve() for app-root links.
 :
 : @param $abbrev  eXpath package abbreviation
 : @return URL string (local or fallback)
 :)
declare function site-config:app-url($abbrev as xs:string) as xs:string {
    site-config:resolve("{" || $abbrev || "}")
};

(:~
 : Get the current authenticated user.
 :
 : @return the username string
 :)
declare function site-config:current-user() as xs:string {
    let $login-user := try { request:get-attribute("org.exist.login.user") } catch * { () }
    return
        if (exists($login-user) and $login-user != "") then
            $login-user
        else
            sm:id()//sm:real/sm:username/string()
};

(:~
 : Check whether the current user is authenticated (not guest).
 :
 : @return true if logged in
 :)
declare function site-config:is-logged-in() as xs:boolean {
    site-config:current-user() != "guest"
};
