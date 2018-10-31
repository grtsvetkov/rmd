#!/usr/bin/env node

require('colors');

let nodemiral = require('nodemiral'),
    path = require('path'),
    cjson = require('cjson'),
    fs = require('fs'),
    spawn = require('child_process').spawn,
    archiver = require('archiver')

    isWindows = /^win/.test(process.platform),

    mupErrorLog = (message) => {
        console.error(('Ошибка в mup.json файле: ' + message + '\n').red.bold);
        process.exit(1);
    },

    tmpDir = () => {
        let path = isWindows
            ? process.env.TEMP || process.env.TMP || (process.env.SystemRoot || process.env.windir) + '\\temp'
            : process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';


        return (isWindows ? /[^:]\\$/ : /.\/$/).test(path) ? path.slice(0, -1) : path;
    },

    rewriteHome = location => isWindows ? location.replace('~', process.env.USERPROFILE) : location.replace('~', process.env.HOME),

    getCanonicalPath = (location) => {
        let localDir = path.resolve(__dirname, location);
        return fs.existsSync(localDir) ? localDir : path.resolve(rewriteHome(location));
    },

    extend = (defaults, options) => {
        let extended = {};

        for (let prop in defaults) {
            if (Object.prototype.hasOwnProperty.call(defaults, prop)) {
                extended[prop] = defaults[prop];
            }
        }
        for (let prop in options) {
            if (Object.prototype.hasOwnProperty.call(options, prop)) {
                extended[prop] = options[prop];
            }
        }
        return extended;
    },

    once = function(fn, context) {
        let result;

        return function () {
            if (fn) {
                result = fn.apply(context || this, arguments);
                fn = null;
            }

            return result;
        };
    },

    mupJsonPath = path.resolve('mup.json'),
    settingsJsonPath = path.resolve('settings.json'),

    buildLocation = path.resolve(tmpDir(), 'meteor_build_' + String(Math.round(10000 - 0.5 + Math.random() * (99999 - 10001)))),
    bundlePath = path.resolve(buildLocation, 'bundle.tar.gz'),
    args = [
        'build', '--directory', buildLocation,
        '--architecture', 'os.linux.x86_64'
    ],
    config = fs.existsSync(mupJsonPath) ? cjson.load(mupJsonPath) : mupErrorLog('сам файл "mup.json" не найден.'),
    sshAgentExists = false,
    sshAgent = process.env.SSH_AUTH_SOCK;


console.log('------------------------------------------------'.bold.blue);
console.log('RIM Meteor DEPLOY:'.bold.blue);
console.log('------------------------------------------------\n'.bold.blue);

process.env.BUILD_LOCATION = buildLocation; // spawn inherits env vars from process.env, so we can simply set them like this
//process.env.TOOL_NODE_FLAGS = "--max-old-space-size=4096"; //HACK FROM FUCKING METEOR DEPLOY

config.env = config.env || {}; //initialize options
config.meteorBinary = (config.meteorBinary) ? getCanonicalPath(config.meteorBinary) : 'meteor';

if (typeof config.appName === 'undefined') {
    config.appName = 'meteor';
}

if (!config.server) {
    mupErrorLog('Server information does not exist');
}

if (sshAgent) {
    sshAgentExists = fs.existsSync(sshAgent);
    config.server.sshOptions = config.server.sshOptions || {};
    config.server.sshOptions.agent = sshAgent;
}

if (!config.server.host) {
    mupErrorLog('Server host does not exist');
} else if (!config.server.username) {
    mupErrorLog('Server username does not exist');
} else if (!config.server.password && !config.server.pem && !sshAgentExists) {
    mupErrorLog('Server password, pem or a ssh agent does not exist');
} else if (!config.app) {
    mupErrorLog('Path to app does not exist');
}

if (config.server.pem) {
    config.server.pem = rewriteHome(config.server.pem);
}

config.server.env = config.server.env || {};
config.server.env['CLUSTER_ENDPOINT_URL'] = config.server.env['CLUSTER_ENDPOINT_URL'] || 'http://' + config.server.host + ':' + (config.env['PORT'] || 80);

if (fs.existsSync(settingsJsonPath)) {
    config.env['METEOR_SETTINGS'] = JSON.stringify(require(settingsJsonPath));
}

console.log(('Сборка: ' + config.appName + '\n').blue);

if (isWindows) {
    // Sometimes cmd.exe not available in the path. See: http://goo.gl/ADmzoD
    config.meteorBinary = process.env.comspec || 'cmd.exe';
    args = ["/c", "meteor"].concat(args);
}

let meteor = spawn(config.meteorBinary, args, {cwd: rewriteHome(config.app)});

meteor.stdout.pipe(process.stdout, {end: false});
meteor.stderr.pipe(process.stderr, {end: false});

meteor.on('close', function (code) {

    if (code != 0) {
        console.log('\n=> Ошибка сборки.\n'.red.bold);
        process.exit(1);
    }

    let output = fs.createWriteStream(bundlePath),

        archive = archiver('tar', {
            gzip: true,
            gzipOptions: {
                level: 8 //default = 6
            }
        });

    archive.pipe(output);

    output.once('close', once(function () {

        let auth = {username: config.server.username};

        if (config.server.pem) {
            auth.pem = fs.readFileSync(path.resolve(config.server.pem), 'utf8');
        } else {
            auth.password = config.server.password;
        }

        let taskList = nodemiral.taskList('Развертывание приложения "' + config.appName + '"');

        taskList.copy('Загрузка сборки', {
            src: bundlePath,
            dest: '/opt/' + config.appName + '/tmp/bundle.tar.gz',
            progressBar: true
        });

        taskList.executeScript('Процесс развертывания', {
            script: path.resolve(__dirname, 'script.sh'),
            vars: {
                env: extend(config.env, config.server.env) || {},
                appName: config.appName,
                setupPath: config.setupPath || '/opt'
            }
        });

        taskList.run(nodemiral.session(config.server.host, auth, {
            ssh: config.server.sshOptions,
            keepAlive: true
        }), summaryMap => process.exit(summaryMap.some(summary => summary.error) ? 1 : 0));
    }));

    archive.once('error', err => {
        console.log('\n=> Архивирование не удалось: ', err.message);
        process.exit(1);
    });

    archive.directory(path.resolve(buildLocation, 'bundle'), 'bundle').finalize();
});