var chalk = require("chalk");
console.clear();
process.title = "CatMagick";
console.log(`${chalk.cyan("-".repeat(Math.floor((process.stdout.columns - 11) / 2)))}${chalk.red.bgBlack("[CatMagick]")}${chalk.cyan("-".repeat(Math.ceil((process.stdout.columns - 11) / 2)))}`);
log("INFO", "Starting server...");
var fs = require("fs");
var path = require("path");
if (!fs.existsSync(path.join(__dirname, "..", "..", "config.json"))) {
  log("FATAL", `There was no "config.json" file found`);
  process.exit(1);
}
try {
  var config = require("../../config.json");
} catch(err) {
  log("FATAL", "Could not parse config due to the following error:");
  console.error(err);
  process.exit(1);
}
var babel = require("@babel/core");
var pako = require("pako");
var vm = require("vm");
var Module = require("module");
var chokidar = null;
var typeorm = null;
var cattojs = null;

var defaultConfig = {
  "web": {
    "port": null,
    "domain": null,
    "proxies": 0
  },
  "SSL": {
    "enabled": !1,
    "proxy": !1,
    "cert": "cert.pem",
    "key": "key.pem"
  },
  "logs": {
    "requests": !0,
    "WebSocket": !0,
  },
  "database": {
    "enabled": !1,
    "type": "sqlite",
    "file": "database.db"
  },
  "features": {
    "sourceMaps": !0,
    "SSR": !1,
    "minify": !0
  },
  "hotReload": {
    "routes": !0,
    "middleware": !0,
    "database": !0,
    "events": !0,
    "config": !0
  },
  "sessions": {
    "secret": null,
    "secureCookie": !0
  },
  "captcha": {
    "enabled": !1,
    "provider": "recaptcha",
    "siteKey": null,
    "secretKey": null
  }
};

config = Object.assign({}, defaultConfig, config);
Object.keys(config).forEach(category => {
  if (!defaultConfig[category]) {
    log("FATAL", `Unknown config category "${category}"`);
    return process.exit(1);
  }
  config[category] = Object.assign({}, defaultConfig[category], config[category]);
});

var major = process.version.slice(1).split(".")[0];
var minor = process.version.slice(1).split(".")[1];
if (config.hotReload.routes || config.hotReload.middleware || config.hotReload.database || config.hotReload.events || config.hotReload.config) {
  if (major > 14 || (major == 14 && minor >= 18)) {
    chokidar = require("chokidar");
  } else {
    log("FATAL", "You need at least NodeJS v14.18.0 to use hot-reload");
    process.exit(1);
  }
}
if (config.database.enabled) {
  if (major < 16) {
    log("FATAL", "You need at least NodeJS v16.0.0 to use database");
    process.exit(1);
  }
  typeorm = require("typeorm");
}
if (!Array.prototype.flat) {
  log("INFO", "Native Array.flat not supported, injecting polyfill...");
  function flat() {
    var t = isNaN(arguments[0]) ? 1 : Number(arguments[0]);
    return t ? Array.prototype.reduce.call(this, function(a, e) {
      return Array.isArray(e) ? a.push.apply(a, flat.call(e, t - 1)) : a.push(e), a
    }, []) : Array.prototype.slice.call(this);
  }
  Object.defineProperty(Array.prototype, "flat", {
    "configurable": !0,
    "value": flat,
    "writable": !0
  });
}
cattojs = require("catto.js");

var CatMagick = {};
var options = {
  "proxies": config.web.proxies,
  "ssl": (config.SSL.enabled && !config.SSL.proxy),
  "cert": config.SSL.cert,
  "key": config.SSL.key,
  "sslProxy": (config.SSL.enabled && config.SSL.proxy),
  "secureCookie": config.sessions.secureCookie
};
if (config.web.port) {
  options.port = config.web.port;
}
if (config.web.domain) {
  options.domain = config.web.domain;
}
if (config.sessions.sessionSecret) {
  options.secret = config.sessions.sessionSecret;
}
var server = new cattojs.Server(options);
var compileCache = {};
var wsClients = [];
var dataSource = null;
var databaseEntities = {};
var databaseRelations = new Map;

CatMagick.verifyCaptcha = async token => {
  if (!config.captcha.enabled) {
    return !0;
  }
  if (!token) {
    return !1;
  }
  var verifyLink = "https://www.google.com/recaptcha/api/siteverify";
  if (config.captcha.provider == "hcaptcha") {
    verifyLink = "https://api.hcaptcha.com/siteverify";
  }
  if (config.captcha.provider == "turnstile") {
    verifyLink = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  }
  return (await fetch(verifyLink, {
    "method": "POST",
    "headers": {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    "body": new URLSearchParams({
      "secret": config.captcha.secretKey,
      "response": token
    })
  }).then(res => res.json())).success;
};

CatMagick.dispatchEvent = (event, data, condition) => {
  wsClients.filter(condition || (() => !0)).forEach(wsClient => {
    wsClient.send(pako.deflate(JSON.stringify([event, data])));
  });
};

CatMagick.wholeNumber = {
  "type": "bigint"
};

CatMagick.floatingNumber = {
  "type": "double"
};

CatMagick.limitedText = length => ({
  "type": "varchar",
  length
});

CatMagick.unlimitedText = {
  "type": "text"
};

CatMagick.boolean = {
  "type": "boolean"
};

CatMagick.createDatabase = columns => {
  if (!Object.keys(columns).length) {
    throw "Database must have at least one property.";
  }
  var name = path.basename((new Error).stack.split("\n")[2].match(/\((.+):\d+:\d+\)/)[1]).slice(0, -3);
  var primary = Object.keys(columns)[0];
  for (var column of Object.keys(columns)) {
    if (columns[column] instanceof typeorm.EntitySchema) {
      if (!databaseRelations.has(name)) {
        databaseRelations.set(name, new Map);
      }
      databaseRelations.get(name).set(column, columns[column]);
      var relationPrimary = JSON.parse(JSON.stringify(columns[column].options.columns[Object.keys(columns[column].options.columns)[0]]));
      delete relationPrimary.primary;
      delete relationPrimary.generated;
      columns[column] = relationPrimary;
    }
  }
  columns = JSON.parse(JSON.stringify(columns));
  columns[primary].primary = !0;
  if (columns[primary].type == "bigint") {
    columns[primary].type = "int";
    columns[primary].generated = !0;
  }
  Object.keys(columns).slice(1).forEach(column => columns[column].nullable = !0);
  return new typeorm.EntitySchema({ name, columns });
};

CatMagick.Database = class {
  constructor(name, repo) {
    this.name = name;
    this._repo = repo;
  }

  async get(props) {
    if (!props) {
      props = {};
    }
    return await Promise.all((await this._repo.findBy(props)).map(async entity => {
      var entity2 = {};
      Object.defineProperty(entity2, "_props", {
        get() {
          return entity;
        }
      });
      for (var prop of Object.keys(entity)) {
        if (databaseRelations.has(this.name) && databaseRelations.get(this.name).has(prop) && entity[prop] !== null) {
          entity2[prop] = (await CatMagick.useDatabase(databaseRelations.get(this.name).get(prop).options.name).get(Object.fromEntries([
            [Object.keys(databaseRelations.get(this.name).get(prop).options.columns)[0], entity[prop]]
          ])))[0];
        } else {
          entity2[prop] = entity[prop];
        }
      }
      entity2.edit = async props2 => {
        Object.assign(entity2, props2);
        for (var prop of Object.keys(props2)) {
          if (databaseRelations.has(this.name) && databaseRelations.get(this.name).has(prop) && props2[prop]) {
            entity[prop] = props2[prop]._props[Object.keys(databaseRelations.get(this.name).get(prop).options.columns)[0]];
          } else {
            entity[prop] = props2[prop];
          }
        }
        await this._repo.save(entity);
      };
      entity2.delete = async () => {
        await this._repo.remove(entity);
      };
      return entity2;
    }));
  }

  async add(props) {
    if (!props) {
      props = {};
    }
    if (databaseRelations.has(this.name)) {
      for (var prop of Object.keys(props)) {
        if (databaseRelations.get(this.name).has(prop) && props[prop]) {
          props[prop] = props[prop]._props[Object.keys(databaseRelations.get(this.name).get(prop).options.columns)[0]];
        }
      }
    }
    var entity = this._repo.create(props);
    await this._repo.save(entity);
    return entity;
  }

  async delete(props) {
    if (props && Object.keys(props).length) {
      await this._repo.delete(props);
    } else {
      await this._repo.clear();
    }
  }
};

CatMagick.useDatabase = name => {
  return new CatMagick.Database(name, dataSource.getRepository(databaseEntities[name]));
};

if (typeof globalThis !== "undefined") {
  globalThis.CatMagick = CatMagick;
} else {
  global.CatMagick = CatMagick;
}

function configureDatabase(hotReload) {
  if (!fs.existsSync(path.join(__dirname, "..", "..", "databases"))) {
    log("FATAL", `Database is enabled, but there was no "databases" folder found`);
    process.exit(1);
  }
  try {
    var failed = !1;
    var entities = fs.readdirSync(path.join(__dirname, "..", "..", "databases")).map(database => {
      if (failed) {
        return;
      }
      try {
        var value = require(path.join(__dirname, "..", "..", "databases", database));
        if (!(value instanceof typeorm.EntitySchema)) {
          log("WARN", `Skipping invalid database "${database.slice(0, -3)}"`);
        }
        return value;
      } catch(error) {
        if (hotReload) {
          log("ERROR", "Could not complete database hot reload due to the following error:");
          console.error(error);
          failed = !0;
          return;
        }
        log("FATAL", "Could not configure database due to the following error:");
        console.error(error);
        process.exit(1);
      }
    });
    if (failed) {
      return !1;
    }
    entities = entities.filter(entity => entity instanceof typeorm.EntitySchema);
    dataSource = new typeorm.DataSource({
      "type": config.database.type,
      "database": path.join(__dirname, "..", "..", config.database.file),
      "synchronize": !0,
      entities
    });
    databaseEntities = Object.fromEntries(entities.map(entity => [entity.options.name, entity]));
  } catch(error) {
    if (error instanceof typeorm.DriverPackageNotInstalledError) {
      log("FATAL", `You are using ${error.message.match(/^([A-Za-z0-9_-]+) package has not been found installed/)[1]} database, but "${error.message.match(/npm install ([A-Za-z0-9_-]+) --save/)[1]}" is not installed`);
      process.exit(1);
    }
    log("FATAL", "Could not configure database due to the following error:");
    console.error(error);
    process.exit(1);
  }
  return !0;
}

if (config.database.enabled) {
  configureDatabase(!1);
}

if (!fs.existsSync(path.join(__dirname, "..", "..", "routes"))) {
  log("FATAL", `There was no "routes" folder found`);
  process.exit(1);
}

if (!fs.existsSync(path.join(__dirname, "..", "..", "middleware"))) {
  log("FATAL", `There was no "middleware" folder found`);
  process.exit(1);
}

if (!fs.existsSync(path.join(__dirname, "..", "..", "events"))) {
  log("FATAL", `There was no "events" folder found`);
  process.exit(1);
}

function log(type, text) {
  var color = "white";
  if (type == "SUCCESS") {
    color = "green";
  }
  if (type == "WARN") {
    color = "yellow";
  }
  if (type == "ERROR") {
    color = "redBright";
  }
  if (type == "FATAL") {
    color = "red";
  }
  console.log(`${chalk[color](`[${(new Date).toLocaleString().split(", ").join(" / ")}] ${type}`)} - ${chalk[color](text)}`);
}

function patchHTML(code) {
  var doctype = code.startsWith("<!DOCTYPE html>");
  if (doctype) {
    code = code.replace(/^<!DOCTYPE html>(\r?\n)?/, "");
  }
  var captchaImport = "";
  if (config.captcha.enabled) {
    if (config.captcha.provider == "recaptcha") {
      captchaImport = `<script src="https://www.google.com/recaptcha/api.js?onload=CatMagickHandleCaptcha&render=explicit" async defer></script>\n<script>\n  CatMagick.captchaSiteKey = "${config.captcha.siteKey}";\n</script>\n`;
    }
    if (config.captcha.provider == "hcaptcha") {
      captchaImport = `<script src="https://js.hcaptcha.com/1/api.js?onload=CatMagickHandleCaptcha&render=explicit" async defer></script>\n<script>\n  CatMagick.captchaSiteKey = "${config.captcha.siteKey}";\n</script>\n`;
    }
    if (config.captcha.provider == "turnstile") {
      captchaImport = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=CatMagickHandleCaptcha&render=explicit&compat=recaptcha" async defer></script>\n<script>\n  CatMagick.captchaSiteKey = "${config.captcha.siteKey}";\n</script>\n`;
    }
  }
  return `${doctype ? "<!DOCTYPE html>\n" : ""}<link href="/catmagick_client.css" rel="stylesheet">\n<script src="/catmagick_client.js"></script>\n${captchaImport}${code}`;
}

server.use((req, res, next) => {
  res.header("X-Powered-By", "CatMagick");

  var originalEnd = res.end;
  res.end = function() {
    originalEnd.apply(res, arguments);
    if (config.logs.requests) {
      var type = (res.statusCode < 400) ? "INFO" : "ERROR";
      var statusTexts = {
        "101": "Switching Protocols",
        "200": "OK",
        "201": "Created",
        "202": "Accepted",
        "204": "No Content",
        "206": "Partial Content",
        "301": "Moved Permanently",
        "302": "Found",
        "304": "Not Modified",
        "307": "Temporary Redirect",
        "308": "Permanent Redirect",
        "400": "Bad Request",
        "401": "Unauthorized",
        "402": "Payment Required",
        "403": "Forbidden",
        "404": "Not Found",
        "405": "Method Not Allowed",
        "406": "Not Acceptable",
        "408": "Request Timeout",
        "409": "Conflict",
        "410": "Gone",
        "411": "Length Required",
        "413": "Payload Too Large",
        "414": "URI Too Long",
        "415": "Unsupported Media Type",
        "418": "I'm a teapot",
        "423": "Locked",
        "429": "Too Many Requests",
        "500": "Internal Server Error",
        "501": "Not Implemented",
        "502": "Bad Gateway",
        "503": "Service Unavailable",
        "504": "Gateway Timeout",
        "507": "Insufficient Storage",
        "520": "Unknown Error",
        "521": "Web Server Is Down",
        "522": "Connection Timed Out"
      };
      log(type, `${req.ip} - ${req.method} ${req.path} - ${res.statusCode}${statusTexts[res.statusCode] ? ` ${statusTexts[res.statusCode]}` : ""}`);
    }
  };

  var originalSendFile = res.sendFile;
  res.sendFile = function(filePath) {
    if (filePath.endsWith(".html")) {
      res.header("Content-Type", "text/html; charset=UTF-8");
      return res.end(patchHTML(fs.readFileSync(filePath).toString("utf-8")));
    }
    if (filePath.endsWith(".jsx")) {
      res.header("Content-Type", "text/jsx; charset=UTF-8");
      function fallback() {
        res.end(babel.transformSync((compileCache[filePath] || ""), {
          "presets": [["minify", {
            "keepClassName": !0
          }]].slice(config.features.minify ? 0 : 1),
          "plugins": ["babel-plugin-transform-catmagick-jsx"],
          "sourceMaps": config.features.sourceMaps ? "inline": !1,
          "sourceFileName": path.basename(filePath),
          "minified": config.features.minify
        }).code);
      }
      var textElementSymbol = Symbol("CatMagick.TextElement");
      function __transform(element) {
        if (Array.isArray(element)) {
          return element.map(__transform).join("");
        }
        if (element.type === textElementSymbol) {
          return element.props.nodeValue;
        } else {
          return `<${element.type}${Object.keys(element.props).map(prop => ` ${prop}={${JSON.stringify(element.props[prop])}}`).join("")}>${element.children.map(__transform).join("")}</${element.type}>`;
        }
      }
      var code = fs.readFileSync(filePath).toString("utf-8");
      code = code.replace(/"@private"((?:\r?\nvar .+;)+|\r?\nasync function ([^()]+)\((.*?)\) {\r?\n[^]+?\r?\n})(\r?\n\r?\n|$)/g, (_, _code2, funcName, funcArgs, spacing) => {
        if (!funcName) {
          return "";
        }
        return `async function ${funcName}(${funcArgs}) {\n  var response = await CatMagick.fetch("/${path.relative(path.join(__dirname, "..", "..", "routes"), filePath)}", {\n    "method": "POST",\n    "headers": {\n      "X-CatMagick-Call": "${funcName}"\n    },\n    "body": [${funcArgs}]\n  });\n  if (response.status == 200) {\n    return await response.json();\n  } else if (response.status != 204) {\n    throw await response.text();\n  }\n}${spacing}`;
      });
      if (config.features.SSR) {
        var parts = code.split(/{_% ([^]+?) %_}/g);
        var compile = "";
        parts.forEach((part, index) => {
          compile += ((index + 1) % 2 < 1 ? `${part}\n` : `__output += ${JSON.stringify(part)}.replace(/{_%= ([^]+?) %_}/g, (_, g) => __escape(__transform(eval(__pretransform(g))))).replace(/{_%- ([^]+?) %_}/g, (_, g) => __transform(eval(__pretransform(g))));\n`);
        });
        var context = vm.createContext({
          req, console, __transform,
          "require": (typeof Module.createRequire === "function") ? Module.createRequire(path.dirname(filePath) + path.sep) : name => {
            if (!name.startsWith(".")) {
              return require(name);
            }
            return require(path.join(path.dirname(filePath), name));
          },
          "__output": "",
          "__pretransform": code => {
            return babel.transformSync(code, {
              "plugins": ["babel-plugin-transform-catmagick-jsx"],
              "sourceMaps": !1
            }).code;
          },
          "__escape": str => {
            if (str === void 0) {
              return "undefined";
            }
            if (typeof str !== "string") {
              str = str.toString();
            }
            return str.split("<").join("&lt;").split(">").join("&gt;");
          },
          "CatMagick": {
            "createElement": (type, props, ...children) => {
              props = (props || {});
              children = children.flat(Infinity).filter(child => child !== void 0 && child !== null && child !== !1).map(child => (typeof child === "string" || typeof child === "number") ? {
                "type": textElementSymbol,
                "props": {
                  "nodeValue": child.toString()
                },
                "children": []
              } : child);
              return [{ type, props, children }];
            }
          }
        });
        try {
          vm.runInContext(compile, context);
        } catch(err) {
          log("ERROR", `${req.path} - Cannot compile JSX due to the following error:`);
          console.error(err.message);
          return fallback();
        }
        code = context.__output;
      }
      try {
        var compiled = babel.transformSync(code, {
          "presets": [["minify", {
            "keepClassName": !0
          }]].slice(config.features.minify ? 0 : 1),
          "plugins": ["babel-plugin-transform-catmagick-jsx"],
          "sourceMaps": config.features.sourceMaps ? "inline": !1,
          "sourceFileName": path.basename(filePath),
          "minified": config.features.minify
        }).code;
        compileCache[filePath] = code;
      } catch(err) {
        log("ERROR", `${req.path} - Cannot compile JSX due to the following error:`);
        console.error(err.message);
        return fallback();
      }
      return res.end(compiled);
    }
    return originalSendFile.apply(res, arguments);
  };

  next();
}).ws("/events", (ws, req) => {
  wsClients.push(ws);
  if (config.logs.WebSocket) {
    log("INFO", `${req.ip} - WebSocket user connected`);
  }
  ws.on("message", message => {
    if (message == "PING") {
      return ws.send("PONG");
    }
    try {
      var msg = JSON.parse(pako.inflate(message, {
        "to": "string"
      }));
    } catch(_) {
      if (config.logs.WebSocket) {
        log("WARN", `${req.ip} - Received invalid WebSocket packet.`);
      }
      return;
    }
    if (["/", "\\", "\x07", "\n", "\b", "\t", "\v", "\f", "\r", "\x7F"].find(char => msg[0].includes(char))) {
      if (config.logs.WebSocket) {
        log("WARN", `${req.ip} - Blocked possibly dangerous WebSocket packet.`);
      }
      return;
    }
    if (!fs.existsSync(path.join(__dirname, "..", "..", "events", `${msg[0]}.js`))) {
      if (config.logs.WebSocket) {
        log("WARN", `${req.ip} - Received unknown WebSocket event "${msg[0]}".`);
      }
      return;
    }
    try {
      require(path.join(__dirname, "..", "..", "events", `${msg[0]}.js`))(msg[1], ws);
    } catch(err) {
      log("ERROR", `${req.ip} - Cannot execute event "${msg[0]}" due to the following error:`);
      console.error(err);
    }
  });
  ws.on("close", () => {
    wsClients = wsClients.filter(wsClient => wsClient !== ws);
    if (config.logs.WebSocket) {
      log("INFO", `${req.ip} - WebSocket user disconnected`);
    }
  });
}).use(async (req, res, next) => {
  for (var middleware of fs.readdirSync(path.join(__dirname, "..", "..", "middleware"))) {
    try {
      if (!await require(path.join(__dirname, "..", "..", "middleware", middleware))(req, res, next)) {
        return;
      }
    } catch(err) {
      log("ERROR", `${req.path} - Cannot execute middleware "${middleware}" due to the following error:`);
      console.error(err);
      res.status(500);
      if (fs.existsSync("500.html")) {
        return res.sendFile(path.join(__dirname, "..", "..", "500.html"));
      }
      return res.end("500 Internal Server Error");
    }
  }

  if (req.path == "/catmagick_client.css") {
    return res.sendFile(path.join(__dirname, "catmagick_client.css"));
  }
  if (req.path == "/catmagick_client.js") {
    res.header("Content-Type", "application/javascript; charset=UTF-8");
    var catmagickClient = fs.readFileSync(path.join(__dirname, "catmagick_client.js")).toString("utf-8");
    if (config.features.minify) {
      catmagickClient = babel.transformSync(catmagickClient, {
        "presets": [["minify", {
          "keepClassName": !0
        }]],
        "sourceMaps": !1,
        "minified": !0
      }).code;
    }
    return res.end(fs.readFileSync(path.join(__dirname, "pako.min.js")).toString("utf-8") + "\n\n" + catmagickClient);
  }

  var parts = req.path.split("/").filter(part => part);
  var currentDirectory = path.join(__dirname, "..", "..", "routes");
  while(parts.length) {
    var part = parts.shift();
    if (part.split(".").join("")) {
      var elements = fs.readdirSync(currentDirectory);
      if (elements.includes(part) && part != "_route.js") {
        currentDirectory = path.join(currentDirectory, part);
      } else if (elements.find(element => element.length > 1 && element.startsWith("$"))) {
        req.params[elements.find(element => element.length > 1 && element.startsWith("$")).slice(1)] = part;
        currentDirectory = path.join(currentDirectory, elements.find(element => element.length > 1 && element.startsWith("$")));
      } else if (elements.includes("$")) {
        currentDirectory = path.join(currentDirectory, "$");
      } else {
        return next();
      }
    }
  }
  if (fs.statSync(currentDirectory).isFile()) {
    if (req.method == "POST") {
      if (currentDirectory.endsWith(".jsx")) {
        var code = fs.readFileSync(currentDirectory).toString("utf-8");
        var serverCode = "";
        var serverFunctions = new Set;
        var callFunction = req.get("X-CatMagick-Call");
        Array.from(code.matchAll(/"@private"((?:\r?\nvar .+;)+|\r?\nasync function ([^()]+)\((.*?)\) {\r?\n[^]+?\r?\n})(\r?\n\r?\n|$)/g)).forEach(match => {
          serverCode += match[1];
          serverCode += match[4];
          if (match[2]) {
            serverFunctions.add(match[2]);
          }
        });
        if (!Array.isArray(req.body) || !serverFunctions.has(callFunction)) {
          res.status(400);
          if (fs.existsSync("400.html")) {
            return res.sendFile(path.join(__dirname, "..", "..", "400.html"));
          }
          return res.end("400 Bad Request");
        }
        var context = vm.createContext({
          req, console, CatMagick,
          "require": (typeof Module.createRequire === "function") ? Module.createRequire(path.dirname(currentDirectory) + path.sep) : name => {
            if (!name.startsWith(".")) {
              return require(name);
            }
            return require(path.join(path.dirname(currentDirectory), name));
          }
        });
        try {
          vm.runInContext(serverCode, context);
        } catch(err) {
          log("ERROR", `${req.path} - Cannot execute private JSX due to the following error:`);
          console.error(err.message);
          res.status(500);
          if (fs.existsSync("500.html")) {
            return res.sendFile(path.join(__dirname, "..", "..", "500.html"));
          }
          return res.end("500 Internal Server Error");
        }
        try {
          var result = await context[callFunction](...req.body);
          if (result !== void 0) {
            return res.json(result);
          }
          res.status(204);
          return res.end();
        } catch(err) {
          res.status(400);
          return res.end(err.toString());
        }
      }
      res.status(405);
      if (fs.existsSync("405.html")) {
        return res.sendFile(path.join(__dirname, "..", "..", "405.html"));
      }
      return res.end("405 Method Not Allowed");
    }
    return res.sendFile(currentDirectory);
  }
  if (fs.existsSync(path.join(currentDirectory, "_route.js"))) {
    try {
      var methods = await require(path.join(currentDirectory, "_route.js"));
      if (!methods[req.method.toLowerCase()]) {
        res.status(405);
        if (fs.existsSync("405.html")) {
          return res.sendFile(path.join(__dirname, "..", "..", "405.html"));
        }
        return res.end("405 Method Not Allowed");
      }
      return methods[req.method.toLowerCase()](req, res, next);
    } catch(err) {
      log("ERROR", `${req.path} - Cannot execute route due to the following error:`);
      console.error(err);
      res.status(500);
      if (fs.existsSync("500.html")) {
        return res.sendFile(path.join(__dirname, "..", "..", "500.html"));
      }
      return res.end("500 Internal Server Error");
    }
  }
  if (fs.existsSync(path.join(currentDirectory, "index.html"))) {
    return res.sendFile(path.join(currentDirectory, "index.html"));
  }
  if (!fs.readdirSync(currentDirectory).length) {
    log("WARN", `${req.path} - Found empty directory`);
  }
  next();
}).use((_, res) => {
  res.status(404);
  if (fs.existsSync("404.html")) {
    res.sendFile(path.join(__dirname, "..", "..", "404.html"));
  } else {
    res.end("404 Not Found");
  }
}).on("running", () => {
  log("SUCCESS", `Server is running on ${chalk.cyan.underline(`0.0.0.0:${server.options.port}`)}`);
});

if (config.database.enabled) {
  dataSource.initialize().then(() => {
    log("SUCCESS", "Database connected successfuly");
    server.run();
  }).catch(error => {
    log("FATAL", "Could not connect to database due to the following error:");
    console.error(error);
  });
} else {
  server.run();
}

var watchPaths = [];
if (config.hotReload.routes) {
  watchPaths.push(path.join(__dirname, "..", "..", "routes"));
}
if (config.hotReload.middleware) {
  watchPaths.push(path.join(__dirname, "..", "..", "middleware"));
}
if (config.hotReload.events) {
  watchPaths.push(path.join(__dirname, "..", "..", "events"));
}
if (watchPaths.length) {
  chokidar.watch(watchPaths, {
    "cwd": path.join(__dirname, "..", ".."),
    "ignored": (path2, stats) => stats && stats.isFile() && path.basename(path.join(path2, "..")) != "middleware" && path.basename(path.join(path2, "..")) != "events" && path.basename(path2) != "_route.js"
  }).on("change", file => {
    file = file.split("\\").join("/");
    if (path.basename(path.join(file, "..")) == "middleware") {
      log("INFO", `/${path.basename(file)} - Doing middleware hot reload`);
    } else if (path.basename(path.join(file, "..")) == "events") {
      log("INFO", `/${path.basename(file)} - Doing event hot reload`);
    } else {
      log("INFO", `/${file.replace("routes/", "").slice(0, -10)} - Doing route hot reload`);
    }
    delete module.constructor._cache[require.resolve(path.join(__dirname, "..", "..", file))];
  });
}

if (config.database.enabled && config.hotReload.database) {
  chokidar.watch(path.join(__dirname, "..", "..", "databases"), {
    "cwd": path.join(__dirname, "..", "..", "databases"),
    "ignoreInitial": !0
  }).on("all", async (event, file) => {
    if (event == "addDir" || event == "unlinkDir") {
      return;
    }
    log("INFO", "Doing database hot reload...");
    delete module.constructor._cache[require.resolve(path.join(__dirname, "..", "..", "databases", file))];
    if (dataSource.isInitialized) {
      try {
        await dataSource.destroy();
        log("INFO", "Database disconnected due to hot reload");
      } catch(_) {
        // Database might be in connecting state, we ignore that
      }
    }
    if (configureDatabase(!0)) {
      dataSource.initialize().then(() => {
        log("SUCCESS", "Database hot reload completed");
      }).catch(error => {
        log("ERROR", "Could not connect to database due to the following error:");
        console.error(error);
      });
    }
  });
}

if (config.hotReload.config) {
  chokidar.watch(path.join(__dirname, "..", "..", "config.json"), {
    "cwd": path.join(__dirname, "..", "..", "config.json")
  }).on("change", () => {
    log("INFO", "Doing config hot reload");
    delete module.constructor._cache[require.resolve(path.join(__dirname, "..", "..", "config.json"))];
    var originalConfig = Object.assign({}, config);
    try {
      config = require("../../config.json");
    } catch(err) {
      log("ERROR", "Could not parse config due to the following error:");
      return console.error(err);
    }
    var cancelReload = !1;
    config = Object.assign({}, defaultConfig, config);
    Object.keys(config).forEach(category => {
      if (cancelReload) {
        return;
      }
      if (!defaultConfig[category]) {
        log("ERROR", `Unknown config category "${category}"`);
        cancelReload = !0;
      }
      config[category] = Object.assign({}, defaultConfig[category], config[category]);
    });
    if (cancelReload) {
      config = originalConfig;
    }
  });
}

CatMagick.server = server;
