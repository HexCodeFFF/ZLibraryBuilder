#!/usr/bin/env node

const {program} = require('commander');
const fs = require("fs");
const path = require("path");
const ncc = require('@vercel/ncc');

// set up CLI
program
    .name("zlibrary")
    .description("Build BetterDiscord plugins dependent on Zere's Plugin Library.\n" +
        "Will first attempt to search for a config.json, then a defaultConfig field of package.json before using CLI args.")
    .option('-p, --pluginFolder <folder>', 'Absolute or relative path to the folder containing the plugins that build scripts can build automatically.')
    .option('-r, --releaseFolder <folder>', 'Absolute or relative path to the folder where plugins that are built should be placed.')
    .option("-c, --copyToBD", "Boolean to determine if the built plugin should also be automatically copied over to your BD plugins directory. Very convenient for development.",)
    .option("-i, --addInstallScript", "Boolean to determine if the plugin should include the Windows Host Script install script. This means that users on Windows that double click the plugin will be prompted to automatically install the plugin.")
    .option("-p, --packLib", "Boolean to include all lib functions into the plugin file.")
    .option("-m, --multiPlugin", "Boolean to re-enable the default behavior of ZLibrary, which is trying to build all plugins in the pluginFolder. If disabled, will assume pluginFolder is the path to one plugin.")
    .option("-o, --oldHeader", "Boolean to re-enable the default ZLibrary plugin header generation. Leave disabled to pass all plugin `config.info` keys as JSDoc entries, allowing full control.");
program.parse();
const cliopts = program.opts()

// helper func for parsing args
function requireifexists(file) {
    if (fs.existsSync(file)) {
        return require(file)
    } else {
        return {}
    }
}

const defaults = {
    pluginFolder: './plugins',
    releaseFolder: './release',
    copyToBD: false,
    addInstallScript: false,
    packLib: false,
    multiPlugin: false,
    oldHeader: false
}
// figure out what args to actually use, prioritize CLI over JSON, use defaults if needed
let args = {}
const packagejson = requireifexists(path.join(process.cwd(), "./package.json"))
for (const source of [
    defaults,
    packagejson.defaultConfig,
    requireifexists(path.join(process.cwd(), "./config.json")),
    packagejson.buildConfig,
    cliopts
]
    ) {
    args = Object.assign(args, source)
}

// below code adapted from github:rauenzi/BDPluginLibrary/scripts/build.js

// replaced the original ternary mess with if-else because i cannot stand it
// get betterdiscord folder
let bdFolder;
if (process.platform === "win32") { // windows
    bdFolder = process.env.APPDATA;
} else if (process.platform === "darwin") { // mac
    bdFolder = process.env.HOME + "/Library/Preferences";
} else { // linux?
    if (process.env.XDG_CONFIG_HOME) {
        bdFolder = process.env.XDG_CONFIG_HOME;
    } else {
        bdFolder = process.env.HOME + "/.config";
    }
}
bdFolder += "/BetterDiscord/"


const template = fs.readFileSync(
    // grabbing from module to hopefully dynamically be able to update as needed, maybe breaking?
    // path.join("node_modules/pluginlibrary/scripts", args.packLib ? "template.remote.js" : "template.local.js")
    path.join(__dirname, "scripts", args.packLib ? "template.remote.js" : "template.local.js")
).toString();

function formatString(string, values) {
    for (const val in values) string = string.replace(new RegExp(`{{${val}}}`, "g"), () => values[val]);
    return string;
}

async function replaceAsync(str, regex, asyncFn) {
    const promises = [];
    str.replace(regex, (match, ...args) => {
        const promise = asyncFn(match, ...args);
        promises.push(promise);
    });
    const data = await Promise.all(promises);
    return str.replace(regex, () => data.shift());
}

async function embedFiles(pluginPath, content, pluginName, files) {
    // dynamically compile node modules

    // find all require statements that should be embedded
    const requirepath = /require\( *['"`]([a-z0-9_@-]+)['"`] *\/\* *zlibrarybuilder embed *\*\/ *\)/gi
    content = await replaceAsync(content, requirepath, async (arg, g1) => {
        // guess where the package.json is
        const modulebase = path.join(process.cwd(), "node_modules", g1)
        let pjsn = path.join(modulebase, "package.json");
        console.log(pjsn)
        // if it exists, its probably a node module
        if (fs.existsSync(pjsn)) {
            // compile and replace
            console.log(`detected node module ${g1}. compiling and embedding...`)
            // find entry point
            pjsn = path.resolve(modulebase, require(pjsn).main);
            // compile
            const {code, map, assets} = await ncc(pjsn)
            console.log("compiled!")
            // make it more like a function
            // ncc seems to always output like this with the settings i'm using
            return `${code.replace("module.exports = __webpack_exports__", "return __webpack_exports__")} /* ${arg} */`
        } else { // probably not a node module
            return arg
        }
    })

    // port from build.js
    for (const fileName of files) {
        content = content.replace(new RegExp(`require\\((['"\`])${fileName}(['"\`])\\)`, "g"),
            () => {
                const filePath = path.join(pluginPath, fileName);
                if (!fileName.endsWith(".js")) return `\`${fs.readFileSync(filePath).toString().replace(/\\/g, `\\\\`).replace(/\\\\\$\{/g, "\\${").replace(/`/g, "\\`")}\``;
                const exported = require(filePath);
                if (typeof (exported) !== "object" && !Array.isArray(exported)) return `(${require(filePath).toString()})`;
                if (Array.isArray(exported)) return `(${JSON.stringify(exported)})`;
                const raw = fs.readFileSync(filePath).toString().replace(/module\.exports\s*=\s*/, "return ");
                return `(() => {return ${raw}})() /* ${filePath} */`;
            });
    }
    return content;
}

// (naively) pass the `config.info` straight to the JSDoc
function buildheader(name, config) {
    if (!config) return "";
    // name field is required
    if (!config.name) {
        config.name = name
    }
    // spaces in plugin names cause epic compilation failures?
    config.name = config.name.replace("\n", "").replace(" ", "")

    let header = `/**\n`;
    for (let [prop, value] of Object.entries(config)) {
        // blank/undefined is CRINGE
        if (!value) continue
        // has to be list for ZLib, but cant be JSDoced zadly
        if (prop === "authors") continue

        header += ` * @${prop} ${value}\n`
    }
    header += ` */`
    return header
}

async function packplugin(pluginPath) {
    // get plugin config
    pluginPath = path.resolve(process.cwd(), pluginPath)
    const configPath = path.join(pluginPath, "config.json");
    if (!fs.existsSync(configPath)) {
        console.error(`Could not find "${configPath}". Skipping...`);
        return
    }
    const config = require(configPath);
    // get name from config
    const pluginName = (config.info.name || path.basename(pluginPath)).replace(" ", "")
    console.log(`Building ${pluginName} from ${configPath}`);
    // embed all files
    const files = fs.readdirSync(pluginPath).filter(f => f !== "config.json" && f !== config.main);
    const pluginrequire = require(path.join(pluginPath, config.main))
    const content = await embedFiles(pluginPath, (pluginrequire.default || pluginrequire).toString(), pluginName, files);
    // "build" plugin

    // jsdoc header
    let header;
    if (args.oldHeader) {
        // backwards compatability i guess?
        header = buildheader(pluginName, {
            "name": config.info.name || pluginName,
            "version": config.info.version || "", // this wasnt even in the original build script but COME ONNNN
            "website": config.info.github || "",
            "source": config.info.github_raw || "",
            "patreon": config.info.patreonLink || "",
            "donate": config.info.paypalLink || "",
            "authorLink": config.info.authorLink || "",
            "invite": config.info.inviteCode || "",
        });
    } else {
        // magic new generation!
        header = buildheader(pluginName, config.info);
        // zlibrary overrides JSDoc author with its own thing, if user (sensibly but naively) uses the BD fields, convert them to ZLib fields
        if (!config.info.authors && config.info.author) {
            let author = {
                "name": config.info.author
            }
            if (config.info.authorId) {
                author["discord_id"] = config.info.authorId
            }
            config.info.authors = [author]
        }
        console.log(config)
    }
    // building is done at runtime via ZLib, all we need to do is load the proper stuff into the template
    let result = formatString(template, {
        PLUGIN_NAME: config.info.name || pluginName,
        CONFIG: JSON.stringify(config),
        INNER: content,
        HEADER: header,
        INSTALL_SCRIPT: args.addInstallScript ? require(path.join(__dirname, "scripts", "installscript.js")) : ""
    });
    if (args.addInstallScript) result = result + "\n/*@end@*/";
    // node wont create folders on its own
    if (!fs.existsSync(args.releaseFolder))
        fs.mkdirSync(args.releaseFolder, {recursive: true})
    // write result
    // formatstring allows for dynamic folders, inherited from build.js
    const buildFile = path.join(formatString(args.releaseFolder, {PLUGIN_NAME: pluginName}), pluginName + ".plugin.js");
    fs.writeFileSync(buildFile, result);
    // copy to BD if needed
    if (args.copyToBD) {
        console.log(`Copying ${pluginName} to BD folder`);
        fs.writeFileSync(path.join(bdFolder, "plugins", pluginName + ".plugin.js"), result);
    }
    // done!
    console.log(`${pluginName} built successfully`);
    console.log(`${pluginName} saved as ${buildFile}`);
}

async function main() {
    console.time("Build took");
    if (args.multiPlugin) {
        // try to pack all directories of pluginfolder if that's what the user wants

        for (const plugin of fs.readdirSync(path.join(process.cwd(), args.pluginFolder))
            .filter(f => fs.lstatSync(path.join(args.pluginFolder, f)).isDirectory())) {
            await packplugin(path.join(process.cwd(), args.pluginFolder, plugin))
        }
    } else {
        await packplugin(args.pluginFolder)
    }
    console.timeEnd("Build took");
}

main()