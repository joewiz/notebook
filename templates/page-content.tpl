---json
{
    "templating": {
        "extends": "templates/base-page.html"
    }
}
---
[% template title %][[ $page-title ]][% endtemplate %]

[% template head %]
[[ $extra-head ]]
[% endtemplate %]

[% template content %]
<div class="notebook-app">
    <nav class="app-tabs" aria-label="Notebook navigation">
        <ul>
            <li><a href="[[ $context-path ]]/" class="[[ $tabs?home ]]">Notebooks</a></li>
        </ul>
    </nav>
    [% if array:size($breadcrumb) > 0 %]
    <nav class="breadcrumb" aria-label="Breadcrumb">
        [% for $crumb in $breadcrumb?* %]
        [% if exists($crumb?url) %]
        <a href="[[ $crumb?url ]]">[[ $crumb?title ]]</a>
        <span class="breadcrumb-sep" aria-hidden="true">/</span>
        [% else %]
        <span aria-current="page">[[ $crumb?title ]]</span>
        [% endif %]
        [% endfor %]
    </nav>
    [% endif %]
    <section class="notebook-content">
        [[ $page-content ]]
    </section>
</div>
[% endtemplate %]
