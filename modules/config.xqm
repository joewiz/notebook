xquery version "3.1";

(:~
 : Shared configuration for the notebook app.
 :)
module namespace config="http://exist-db.org/pkg/notebook/config";

declare variable $config:APP_ROOT := "/db/apps/notebook";
declare variable $config:DATA_ROOT := $config:APP_ROOT || "/data";

(: Cache configuration — sane defaults for a shared server.
   Local installs may increase these. :)

(: Maximum number of items cached per session :)
declare variable $config:CACHE_MAX_CELLS := 50;

(: Cache expiry: 10 minutes of inactivity :)
declare variable $config:CACHE_EXPIRE_MS := 600000;

(: Maximum number of concurrent sessions :)
declare variable $config:CACHE_MAX_SESSIONS := 20;

(: Cache name prefix — each notebook session gets its own cache :)
declare variable $config:CACHE_PREFIX := "nb-session-";

(: Version history: max snapshots to keep per notebook :)
declare variable $config:MAX_VERSIONS := 20;
