const esbuild = require("esbuild");
const chalk = require("chalk");
const mfs = require("micro-fs");
const path = require("path");
const fs = require("fs");
const commandLineArgs = require("command-line-args");
const { version } = require("../package.json");

const args = commandLineArgs([
    { name: "command", type: String, defaultOption: true, defaultValue: "build" },
    { name: "dev", type: Boolean }
]);

async function prepare() {
    const buildDir = path.join(__dirname, "..", "build");
    if (!fs.existsSync(buildDir)) {
        fs.mkdirSync(buildDir);
    }
}

async function clean() {
    console.log(chalk.blue("Cleaning files ..."));
    await mfs.delete([
        "resources/scripts/notebook.min.*",
        "expath-pkg.xml",
        "build/*.xar"
    ], { allowEmpty: true, silent: false });
}

async function bundle() {
    console.log(chalk.blue("Bundling notebook source files ..."));
    await esbuild
        .build({
            entryPoints: ["./scripts/bundle.js"],
            outfile: "./resources/scripts/notebook.min.js",
            bundle: true,
            minify: !args.dev,
            sourcemap: args.dev ? "linked" : false,
            format: "iife",
            platform: "browser",
            target: ["es2020"],
            logLevel: "info",
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

function replace(templatePath, outPath, data) {
    const content = fs.readFileSync(`${__dirname}/../${templatePath}`, "utf-8");
    const replaced = content.toString().replace(/{{(.*)?}}/g, function (match, p1) {
        return data[p1] || "";
    });
    fs.writeFileSync(`${__dirname}/../${outPath}`, replaced);
}

(async () => {
    if (args.command === "clean") {
        await clean();
        return;
    } else if (args.command === "prepare") {
        await prepare();
        return;
    }

    replace("expath-pkg.xml.tmpl", "expath-pkg.xml", { version });

    await bundle();

    console.log(chalk`Creating xar {cyan notebook-${version}.xar}`);
    mfs.zip(
        [
            "*.*",
            "modules/**/*",
            "resources/**/*",
            "templates/**/*",
            "data/**/*",
            "!.git*",
            "!*.tmpl",
            "!.github/**",
            "!node_modules/**",
            "!package-lock.json",
            "!cypress/**",
            "!scripts/**",
            "!test/**",
            "!src/**",
            "!resources/scripts/*.map",
            "!CLAUDE.md",
            "!build/**",
        ],
        `build/notebook-${version}.xar`,
        { base: "." }
    ).then(() => {
        console.log(chalk.bold("DONE."));
    });
})();
