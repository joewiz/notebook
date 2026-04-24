xquery version "3.1";

(:~
 : URL routing controller for notebook2.
 :
 : URL design:
 :   /                        - landing page (notebook list)
 :   /search?q=...            - full-text search
 :   /login                   - login form / authenticate
 :   /logout                  - clear session
 :   /api/*                   - JSON APIs (notebooks CRUD, eval, lint)
 :   /resources/*             - static assets
 :   /{path}                  - open notebook for editing (no .ipynb extension)
 :)

import module namespace login="http://exist-db.org/xquery/login"
    at "resource:org/exist/xquery/modules/persistentlogin/login.xql";

declare namespace exist="http://exist.sourceforge.net/NS/exist";

declare variable $exist:path external;
declare variable $exist:resource external;
declare variable $exist:controller external;
declare variable $exist:prefix external;
declare variable $exist:root external;

declare variable $local:login-domain := "org.exist.login";

(: Process persistent login on every request :)
let $login := login:set-user($local:login-domain, xs:dayTimeDuration("P7D"), false())
let $user := request:get-attribute($local:login-domain || ".user")
let $method := lower-case(request:get-method())

return

if ($exist:path eq '') then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <redirect url="{request:get-uri()}/"/>
    </dispatch>

(: --- Landing page --- :)
else if ($exist:path eq "/" or $exist:path eq "") then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <forward url="{$exist:controller}/modules/view.xq">
            <set-attribute name="$section" value="landing"/>
        </forward>
    </dispatch>

(: --- Admin --- :)
else if ($exist:path eq "/admin" or $exist:path eq "/admin/") then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <forward url="{$exist:controller}/modules/view.xq">
            <set-attribute name="$section" value="admin"/>
        </forward>
    </dispatch>

(: --- Search --- :)
else if ($exist:path eq "/search" or $exist:path eq "/search/") then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <forward url="{$exist:controller}/modules/view.xq">
            <set-attribute name="$section" value="search"/>
        </forward>
    </dispatch>

(: --- Login (GET) --- :)
else if ($exist:resource eq "login" and $method eq "get") then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <forward url="{$exist:controller}/modules/view.xq">
            <set-attribute name="$section" value="login"/>
        </forward>
    </dispatch>

(: --- Login (POST) --- :)
else if ($exist:resource eq "login" and $method eq "post") then
    if ($user and not($user = ("guest", "nobody"))) then
        (: Login succeeded — redirect to the page they came from :)
        let $redirect := (request:get-parameter("redirect", ()), $exist:prefix || "/" || $exist:controller || "/")[1]
        return
        <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
            <redirect url="{$redirect}"/>
        </dispatch>
    else
        (: Login failed — show login form again :)
        <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
            <forward url="{$exist:controller}/modules/view.xq">
                <set-attribute name="$section" value="login"/>
            </forward>
        </dispatch>

(: --- Logout --- :)
else if ($exist:resource eq "logout") then (
    response:set-cookie($local:login-domain, "deleted", xs:dayTimeDuration("-P1D"), false(), (),
        request:get-context-path()),
    session:invalidate(),
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <redirect url="./"/>
    </dispatch>
)

(: --- Static resources --- :)
else if (matches($exist:path, "^/resources/")) then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <forward url="{$exist:controller}{$exist:path}">
            <set-header name="Cache-Control" value="max-age=3600"/>
        </forward>
    </dispatch>

(: --- API requests: forward to Roaster --- :)
else if (matches($exist:path, "^/api/")) then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <forward url="{$exist:controller}/modules/api.xq">
            <set-header name="Access-Control-Allow-Origin" value="*"/>
            <set-header name="Cache-Control" value="no-cache"/>
        </forward>
    </dispatch>

(: --- Everything else: treat as notebook path --- :)
else
    let $path := substring($exist:path, 2)  (: strip leading / :)
    return
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <forward url="{$exist:controller}/modules/view.xq">
            <set-attribute name="$section" value="notebook"/>
            <set-attribute name="$path" value="{$path}"/>
        </forward>
    </dispatch>
