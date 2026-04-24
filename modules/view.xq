xquery version "3.1";

(:~
 : View pipeline — renders pages as full HTML documents.
 : Uses nav.xqm and site-config.xqm for consistent site-wide navigation.
 :)

import module namespace config="http://exist-db.org/pkg/notebook/config" at "config.xqm";
import module namespace nav="http://exist-db.org/site/nav" at "nav.xqm";
import module namespace site-config="http://exist-db.org/site/shell-config" at "site-config.xqm";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
declare namespace exist="http://exist.sourceforge.net/NS/exist";
declare option output:method "html";
declare option output:media-type "text/html";

declare variable $local:section := request:get-attribute("$section");
declare variable $local:path := request:get-attribute("$path");
declare variable $local:ctx := request:get-context-path() || "/apps/notebook";

declare function local:render-section() {
    switch ($local:section)
    case "landing" return local:landing()
    case "notebook" return local:notebook($local:path)
    case "search" return local:search()
    case "admin" return local:admin()
    case "login" return local:login()
    default return local:not-found()
};

(:~
 : Landing page.
 :)
declare function local:landing() {
    let $is-dba := sm:is-dba(site-config:current-user())
    return
    local:page-wrapper("eXist-db Notebook", "home", (
        <h1 class="nb-page-title">eXist-db Notebook</h1>,
        <div id="nb-file-browser" class="nb-file-browser" data-is-admin="{$is-dba}"></div>
    ), (
        <script type="module" src="{$local:ctx}/resources/scripts/notebook.min.js"></script>
    ),
        array {
            map { "title": "Notebooks" }
        }
    )
};

(:~
 : Notebook editor page — or collection landing page.
 : Path can be "my-notebook" (standalone), "expath-crypto" (collection TOC),
 : or "expath-crypto/01-hashing" (chapter in collection).
 :)
declare function local:notebook($path as xs:string) {
    (: Local-only notebook (non-admin, loaded from browser sessionStorage) :)
    let $is-local := request:get-parameter("local", "") eq "1"
    return
        if ($is-local) then
            local:page-wrapper($path, "home",
                (
                    <div id="notebook-editor"
                         class="nb-editor"
                         data-path="{$path || '.ipynb'}"
                         data-slug="{$path}"
                         data-local="true">
                    </div>
                ),
                (
                    <script src="{$local:ctx}/resources/scripts/prettier-bundle.js"></script>,
                    <script type="module" src="{$local:ctx}/resources/scripts/notebook.min.js"></script>
                ),
                array {
                    map { "title": "Notebooks", "url": $local:ctx || "/" },
                    map { "title": $path }
                }
            )

    (: Try as standalone notebook :)
    else if (util:binary-doc-available($config:DATA_ROOT || "/" || $path || ".ipynb")) then
        local:render-notebook($path || ".ipynb", $path)

    (: Try as collection :)
    else if (xmldb:collection-available($config:DATA_ROOT || "/" || $path)
             and util:binary-doc-available($config:DATA_ROOT || "/" || $path || "/_notebook.json")) then
        local:collection-landing($path)

    (: Try as nested path: collection/chapter :)
    else if (util:binary-doc-available($config:DATA_ROOT || "/" || $path || ".ipynb")) then
        local:render-notebook($path || ".ipynb", $path)

    else
        local:not-found()
};

(:~
 : Render a notebook editor page.
 :)
declare function local:render-notebook($filepath as xs:string, $slug as xs:string) {
    let $full-path := $config:DATA_ROOT || "/" || $filepath
    let $notebook := parse-json(util:binary-to-string(util:binary-doc($full-path)))
    let $title := local:extract-title($notebook, $filepath)

    (: Build navigation info for collection chapters :)
    let $parts := tokenize($filepath, "/")
    let $nav-data :=
        if (count($parts) eq 2) then
            let $collection := $parts[1]
            let $manifest-path := $config:DATA_ROOT || "/" || $collection || "/_notebook.json"
            return
                if (util:binary-doc-available($manifest-path)) then
                    let $manifest := parse-json(util:binary-to-string(util:binary-doc($manifest-path)))
                    let $chapters := $manifest?chapters
                    let $idx := (
                        for $i in 1 to array:size($chapters)
                        where $chapters($i)?file eq $parts[2]
                        return $i
                    )[1]
                    return
                        if (exists($idx)) then
                            map {
                                "collection": $collection,
                                "collectionTitle": $manifest?title,
                                "index": $idx,
                                "total": array:size($chapters),
                                "prev": if ($idx > 1) then $chapters($idx - 1) else (),
                                "next": if ($idx < array:size($chapters)) then $chapters($idx + 1) else ()
                            }
                        else ()
                else ()
        else ()

    let $breadcrumb :=
        if (exists($nav-data)) then
            array {
                map { "title": "Notebooks", "url": $local:ctx || "/" },
                map { "title": $nav-data?collectionTitle, "url": $local:ctx || "/" || $nav-data?collection },
                map { "title": $title }
            }
        else
            array {
                map { "title": "Notebooks", "url": $local:ctx || "/" },
                map { "title": $title }
            }

    (: Build prev/next nav bar HTML :)
    let $nav-bar :=
        if (exists($nav-data)) then
            <nav class="nb-chapter-nav" aria-label="Chapter navigation">
                {
                    if (exists($nav-data?prev)) then
                        <a href="{$local:ctx}/{$nav-data?collection}/{replace($nav-data?prev?file, '\.ipynb$', '')}" class="nb-chapter-prev">
                            &#8592; {$nav-data?prev?title}
                        </a>
                    else <span class="nb-chapter-prev"></span>
                }
                <span class="nb-chapter-pos">
                    <a href="{$local:ctx}/{$nav-data?collection}">{$nav-data?collectionTitle}</a>
                    ({$nav-data?index} of {$nav-data?total})
                </span>
                {
                    if (exists($nav-data?next)) then
                        <a href="{$local:ctx}/{$nav-data?collection}/{replace($nav-data?next?file, '\.ipynb$', '')}" class="nb-chapter-next">
                            {$nav-data?next?title} &#8594;
                        </a>
                    else <span class="nb-chapter-next"></span>
                }
            </nav>
        else ()

    return local:page-wrapper($title, "home",
        (
            $nav-bar,
            <div id="notebook-editor"
                 class="nb-editor"
                 data-path="{$filepath}"
                 data-slug="{$slug}">
            </div>,
            <script id="notebook-data" type="application/json">{
                serialize($notebook, map { "method": "json" })
            }</script>,
            $nav-bar  (: repeat at bottom :)
        ),
        (
            <script src="{$local:ctx}/resources/scripts/prettier-bundle.js"></script>,
            <script type="module" src="{$local:ctx}/resources/scripts/notebook.min.js"></script>
        ),
        $breadcrumb
    )
};

(:~
 : Collection landing page — shows TOC from _notebook.json.
 :)
declare function local:collection-landing($collection as xs:string) {
    let $manifest-path := $config:DATA_ROOT || "/" || $collection || "/_notebook.json"
    let $manifest := parse-json(util:binary-to-string(util:binary-doc($manifest-path)))
    let $title := ($manifest?title, $collection)[1]
    let $chapters := $manifest?chapters

    let $is-dba := sm:is-dba(site-config:current-user())
    return local:page-wrapper($title, "home", (
        <div class="nb-collection-landing" data-collection="{$collection}">
            <header class="nb-collection-header">
                <div style="display: flex; align-items: center; gap: 1rem;">
                    <h1>{$title}</h1>
                    {
                        if ($is-dba) then
                            <button id="edit-collection-btn" class="nb-btn nb-btn-sm">Edit Collection</button>
                        else ()
                    }
                </div>
                {
                    if ($manifest?authors instance of array(*) and array:size($manifest?authors) > 0) then
                        <p class="nb-collection-authors">by {string-join($manifest?authors?*, ", ")}</p>
                    else ()
                }
                {
                    if ($manifest?difficulty and $manifest?difficulty ne "") then
                        <span class="nb-collection-difficulty">{$manifest?difficulty}</span>
                    else ()
                }
                {
                    if ($manifest?description and $manifest?description ne "") then
                        <p class="nb-collection-desc">{$manifest?description}</p>
                    else ()
                }
            </header>
            <ol class="nb-collection-toc">{
                for $i in 1 to array:size($chapters)
                let $ch := $chapters($i)
                let $slug := $collection || "/" || replace($ch?file, "\.ipynb$", "")
                return
                    <li>
                        <a href="{$slug}">{$ch?title}</a>
                    </li>
            }</ol>
        </div>
    ), (
        <script type="module" src="{$local:ctx}/resources/scripts/notebook.min.js"></script>
    ),
        array {
            map { "title": "Notebooks", "url": $local:ctx || "/" },
            map { "title": $title }
        }
    )
};

(:~
 : Search page.
 :)
declare function local:search() {
    let $q := request:get-parameter("q", "")
    let $idx-col := $config:APP_ROOT || "/data-index"
    let $results :=
        if ($q ne "" and xmldb:collection-available($idx-col)) then
            let $hits := collection($idx-col)//notebook[
                ft:query(., $q, map { "fields": "site-content" })
            ]
            return
                for $hit in $hits
                order by ft:score($hit) descending
                let $highlighted := ft:highlight-field-matches($hit, "site-content")
                return map {
                    "title": ($hit/title/string(), "Untitled")[1],
                    "url": $hit/slug/string(),
                    "highlighted": $highlighted
                }
        else ()

    return local:page-wrapper("Search", "search", (
        <div class="nb-search-page">
            <h1>Search Notebooks</h1>
            <form class="nb-search-form" action="search" method="get">
                <input type="search" name="q" value="{$q}"
                       placeholder="Search notebooks..."
                       aria-label="Search notebook content"
                       autofocus="autofocus"/>
                <button type="submit" class="nb-btn nb-btn-primary">Search</button>
            </form>
            {
                if ($q ne "") then (
                    <p class="nb-search-summary">
                        {count($results)} result{if (count($results) ne 1) then "s" else ""}
                        {" "}for <strong>{$q}</strong>
                    </p>,
                    if (empty($results)) then
                        <p>No notebooks matched your search.</p>
                    else
                        <ul class="nb-search-results">{
                            for $r in $results
                            return
                                <li class="nb-search-result">
                                    <h2><a href="{$r?url}">{$r?title}</a></h2>
                                    <p class="nb-search-snippet">{
                                        (: ft:highlight-field-matches returns exist:field with exist:match children :)
                                        let $field := $r?highlighted
                                        let $text := string($field)
                                        (: Find first match position, extract ~200 chars around it :)
                                        let $first-match := ($field//exist:match)[1]
                                        let $match-text := string($first-match)
                                        let $full := string($field)
                                        let $pos := if (exists($first-match)) then string-length(substring-before($full, $match-text)) else 0
                                        let $start := max((1, $pos - 60))
                                        let $end := min((string-length($full), $pos + string-length($match-text) + 140))
                                        let $excerpt := substring($full, $start, $end - $start)
                                        return (
                                            if ($start > 1) then "..." else (),
                                            (: Re-highlight the match text within the excerpt :)
                                            if (exists($first-match) and contains($excerpt, $match-text)) then (
                                                substring-before($excerpt, $match-text),
                                                <mark>{$match-text}</mark>,
                                                let $after := substring-after($excerpt, $match-text)
                                                return
                                                    if (string-length($after) > 140) then substring($after, 1, 140) || "..."
                                                    else $after
                                            ) else (
                                                if (string-length($excerpt) > 200) then substring($excerpt, 1, 200) || "..."
                                                else $excerpt
                                            )
                                        )
                                    }</p>
                                </li>
                        }</ul>
                ) else ()
            }
        </div>
    ), (),
        array {
            map { "title": "Notebooks", "url": $local:ctx || "/" },
            map { "title": "Search" }
        }
    )
};

(:~
 : Admin page — cache management (dba only).
 :)
declare function local:admin() {
    let $user := site-config:current-user()
    let $is-dba := sm:is-dba($user)
    return
        let $admin-breadcrumb := array {
                map { "title": "Notebooks", "url": $local:ctx || "/" },
                map { "title": "Admin" }
            }
        return
        if (not($is-dba)) then
            local:page-wrapper("Admin", "admin", (
                <div class="nb-login">
                    <form id="login-form" method="post" action="login">
                        <h2>Admin Login</h2>
                        <p style="color: var(--nb-text-muted); margin-bottom: 1rem;">Admin access requires dba privileges.</p>
                        <label for="user">Username</label>
                        <input type="text" id="user" name="user" required="required" autofocus="autofocus"/>
                        <label for="password">Password</label>
                        <input type="password" id="password" name="password"/>
                        <input type="hidden" name="redirect" value="{$local:ctx}/admin"/>
                        <button type="submit" class="nb-btn nb-btn-primary">Login</button>
                    </form>
                </div>
            ), (), $admin-breadcrumb)
        else
            local:page-wrapper("Admin", "admin", (
                <div id="nb-admin" class="nb-admin"></div>
            ), (
                <script type="module" src="{$local:ctx}/resources/scripts/notebook.min.js"></script>
            ), $admin-breadcrumb)
};

(:~
 : Login page.
 :)
declare function local:login() {
    let $redirect := request:get-parameter("redirect", $local:ctx || "/")
    return
    local:page-wrapper("Login", "", (
        <div class="nb-login">
            <form id="login-form" method="post" action="login">
                <h2>Login</h2>
                <label for="user">Username</label>
                <input type="text" id="user" name="user" required="required" autofocus="autofocus"/>
                <label for="password">Password</label>
                <input type="password" id="password" name="password"/>
                <input type="hidden" name="redirect" value="{$redirect}"/>
                <button type="submit" class="nb-btn nb-btn-primary">Login</button>
            </form>
        </div>
    ))
};

(:~
 : 404 page.
 :)
declare function local:not-found() {
    response:set-status-code(404),
    local:page-wrapper("Not Found", "", (
        <div class="nb-error">
            <h1>404</h1>
            <p>The page you're looking for doesn't exist.</p>
            <a href="{$local:ctx}/" class="nb-btn">Back to Notebooks</a>
        </div>
    ))
};

(:~
 : Extract title from notebook.
 :)
declare function local:extract-title($notebook as map(*), $fallback as xs:string) as xs:string {
    let $cells := $notebook?cells
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
                    replace($fallback, "\.ipynb$", "")
        else
            replace($fallback, "\.ipynb$", "")
};

(:~
 : Page wrapper with full site-shell-compatible navbar.
 :)
declare function local:page-wrapper($title as xs:string, $active-tab as xs:string, $content as node()*) {
    local:page-wrapper($title, $active-tab, $content, (), ())
};

declare function local:page-wrapper($title as xs:string, $active-tab as xs:string, $content as node()*, $extra-head as node()*, $breadcrumb as array(*)?) {
    let $cp := request:get-context-path()
    let $apps := nav:apps()
    let $user := site-config:current-user()
    let $shell-base := $cp || "/apps/exist-site-shell"
    return
    <html lang="en">
        <head>
            <meta charset="UTF-8"/>
            <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
            <title>{$title} — Notebook</title>
            <link rel="stylesheet" href="{$local:ctx}/resources/css/exist-site.css"/>
            <link rel="stylesheet" href="{$local:ctx}/resources/css/notebook.css"/>
            { $extra-head }
        </head>
        <body>
            <a href="#main-content" class="skip-link">Skip to content</a>
            <header class="site-header">
                <nav class="site-nav" aria-label="Main navigation">
                    <a href="{$shell-base}" class="site-logo">
                        <img src="{$local:ctx}/resources/images/exist-logo.svg" alt="eXist-db" height="32"/>
                    </a>
                    <ul class="site-menu">{
                        for $app in $apps?*
                        return
                            <li>{
                                if ($app?active) then
                                    <a href="{$app?url}" class="active">{$app?title}</a>
                                else if ($app?external) then
                                    <a href="{$app?url}" target="_blank" rel="noopener">{$app?title}</a>
                                else
                                    <a href="{$app?url}">{$app?title}</a>
                            }</li>
                    }</ul>

                    { (: Site-wide search form :) }
                    <div class="site-search-wrapper">
                        <form class="site-search" action="{$shell-base}/search" method="get" id="site-search-form">
                            <label for="site-search-input" class="visually-hidden">Search</label>
                            <div class="search-input-group">
                                <input type="search" id="site-search-input" name="q"
                                       placeholder="Search docs, functions, notebooks..."
                                       autocomplete="off"
                                       aria-label="Sitewide search"
                                       aria-owns="search-scope-popup"/>
                                <button type="button" class="search-scope-btn" id="search-scope-btn"
                                        aria-haspopup="listbox" aria-expanded="false"
                                        aria-controls="search-scope-popup"
                                        aria-label="Search scope: All apps">
                                    <span id="search-scope-label">All</span>
                                    <span class="search-scope-arrow" aria-hidden="true">&#9662;</span>
                                </button>
                            </div>
                            <input type="hidden" name="app" id="search-app-input" value=""/>
                        </form>
                        <ul class="search-scope-popup" id="search-scope-popup" role="listbox"
                            aria-label="Search scope" hidden="hidden">
                            <li class="scope-opt" role="option" tabindex="-1"
                                data-abbrev="" data-label="All">All apps</li>
                            {
                                for $app in $apps?*
                                where $app?abbrev ne ""
                                return
                                    <li class="scope-opt" role="option" tabindex="-1"
                                        data-abbrev="{$app?abbrev}"
                                        data-label="{$app?title}">
                                        { if ($app?active) then attribute data-active { "true" } else () }
                                        {$app?title}
                                    </li>
                            }
                        </ul>
                    </div>

                    <div class="site-user">{
                        if ($user ne "guest") then (
                            <span>{$user}</span>,
                            <a href="{$local:ctx}/logout">Logout</a>
                        ) else
                            <a href="{$local:ctx}/login?redirect={encode-for-uri(request:get-uri())}">Login</a>
                    }</div>
                </nav>
            </header>
            <main id="main-content" class="site-main">
                <div class="notebook-app">
                    { local:render-tabs($active-tab) }
                    {
                        if (exists($breadcrumb) and array:size($breadcrumb) > 0) then
                            <nav class="breadcrumb" aria-label="Breadcrumb">{
                                for $crumb at $pos in $breadcrumb?*
                                return (
                                    if (exists($crumb?url)) then
                                        (<a href="{$crumb?url}">{$crumb?title}</a>,
                                         <span class="breadcrumb-sep" aria-hidden="true">/</span>)
                                    else
                                        <span aria-current="page">{$crumb?title}</span>
                                )
                            }</nav>
                        else ()
                    }
                    <section class="notebook-content">
                        { $content }
                    </section>
                </div>
            </main>
            <footer class="site-footer">
                <p>Copyright 2001-2026 The eXist-db Authors.
                   <a href="https://github.com/eXist-db/exist">Source</a> |
                   <a href="https://exist-db.org">exist-db.org</a>
                </p>
            </footer>
            { (: Site-shell scripts for search scope and function doc tooltips :) }
            <script src="{$shell-base}/resources/js/search-scope.js"></script>
            <script src="{$shell-base}/resources/js/function-docs.js" type="module"></script>
        </body>
    </html>
};

declare function local:render-tabs($active as xs:string) {
    <nav class="app-tabs" aria-label="Notebook navigation">
        <ul>
            <li><a href="{$local:ctx}/" class="{if ($active eq 'home') then 'active' else ''}">Notebooks</a></li>
            <li><a href="{$local:ctx}/search" class="{if ($active eq 'search') then 'active' else ''}">Search</a></li>
            <li><a href="{$local:ctx}/admin" class="{if ($active eq 'admin') then 'active' else ''}">Admin</a></li>
        </ul>
    </nav>
};

(: Entry point :)
local:render-section()
