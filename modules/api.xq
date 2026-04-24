xquery version "3.1";

(:~
 : Roaster entry-point module for notebook2.
 : Routes /api/* requests to handler functions defined in OpenAPI specs.
 :)

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

import module namespace roaster="http://e-editiones.org/roaster";
import module namespace nb="http://exist-db.org/pkg/notebook/notebooks" at "notebooks.xqm";
import module namespace eval="http://exist-db.org/pkg/notebook/eval" at "eval.xqm";
import module namespace admin="http://exist-db.org/pkg/notebook/admin" at "admin.xqm";

roaster:route(
    ["modules/notebooks.json", "modules/eval.json", "modules/admin.json"],
    function($name as xs:string) {
        function-lookup(xs:QName($name), 1)
    }
)
