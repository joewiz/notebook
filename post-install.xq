xquery version "3.1";

(:~
 : Post-install: set up data collections, indexes, and triggers.
 :)

import module namespace config="http://exist-db.org/pkg/notebook/config" at "modules/config.xqm";
import module namespace trigger="http://exist-db.org/pkg/notebook/trigger" at "modules/trigger.xqm";

(: Create data collection if it doesn't exist :)
let $_ :=
    if (not(xmldb:collection-available($config:DATA_ROOT))) then
        xmldb:create-collection($config:APP_ROOT, "data")
    else ()

(: Create data-index collection :)
let $_ :=
    if (not(xmldb:collection-available($config:APP_ROOT || "/data-index"))) then
        xmldb:create-collection($config:APP_ROOT, "data-index")
    else ()

(: Ensure config parent paths exist :)
let $config-app-col := "/db/system/config" || $config:APP_ROOT
let $_ :=
    if (not(xmldb:collection-available($config-app-col))) then (
        (: Create the full path hierarchy :)
        let $parts := tokenize(substring-after($config-app-col, "/db/system/config/"), "/")
        let $_ :=
            fold-left($parts, "/db/system/config", function($parent, $child) {
                let $full := $parent || "/" || $child
                return (
                    if (not(xmldb:collection-available($full))) then
                        xmldb:create-collection($parent, $child)
                    else (),
                    $full
                )[last()]
            })
        return ()
    )
    else ()

(: Deploy trigger config to data/ collection :)
let $trigger-conf-col := $config-app-col || "/data"
let $_ :=
    if (not(xmldb:collection-available($trigger-conf-col))) then
        xmldb:create-collection($config-app-col, "data")
    else ()
let $_ := xmldb:store(
    $trigger-conf-col,
    "collection.xconf",
    doc($config:APP_ROOT || "/data-collection.xconf")
)

(: Deploy Lucene index config to data-index/ collection :)
let $index-conf-col := $config-app-col || "/data-index"
let $_ :=
    if (not(xmldb:collection-available($index-conf-col))) then
        xmldb:create-collection($config-app-col, "data-index")
    else ()
let $_ := xmldb:store(
    $index-conf-col,
    "collection.xconf",
    doc($config:APP_ROOT || "/data-index-collection.xconf")
)

(: Reindex existing notebooks — top-level and in subcollections :)
let $_ :=
    for $resource in xmldb:get-child-resources($config:DATA_ROOT)
    where ends-with($resource, ".ipynb")
    return trigger:after-update-document(xs:anyURI($config:DATA_ROOT || "/" || $resource))
let $_ :=
    for $sub-col in xmldb:get-child-collections($config:DATA_ROOT)
    where $sub-col ne "versions"
    let $sub-path := $config:DATA_ROOT || "/" || $sub-col
    return (
        (: Deploy trigger config to subcollection too :)
        let $sub-conf-col := $config-app-col || "/data/" || $sub-col
        let $_ :=
            if (not(xmldb:collection-available($sub-conf-col))) then
                xmldb:create-collection($config-app-col || "/data", $sub-col)
            else ()
        let $_ := xmldb:store($sub-conf-col, "collection.xconf", doc($config:APP_ROOT || "/data-collection.xconf"))
        return (),
        (: Index notebooks in subcollection :)
        for $resource in xmldb:get-child-resources($sub-path)
        where ends-with($resource, ".ipynb")
        return trigger:after-update-document(xs:anyURI($sub-path || "/" || $resource))
    )

(: Reindex the data-index collection :)
let $_ := xmldb:reindex($config:APP_ROOT || "/data-index")

return ()
