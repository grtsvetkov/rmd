#!/usr/bin/env node

require('colors');

var nodemiral = require('nodemiral'),
    path = require('path'),
    cjson = require('cjson'),
    fs = require('fs'),
    spawn = require('child_process').spawn,
    archiver = require('archiver'),
    _ = require('underscore'),

    isWindows = /^win/.test(process.platform);

function tmpDir() {
    var trailingSlashRe = isWindows ? /[^:]\\$/ : /.\/$/,
        path;

    if (isWindows) {
        path = process.env.TEMP ||
            process.env.TMP ||
            (process.env.SystemRoot || process.env.windir) + '\\temp';
    } else {
        path = process.env.TMPDIR ||
            process.env.TMP ||
            process.env.TEMP ||
            '/tmp';
    }

    if (trailingSlashRe.test(path)) {
        path = path.slice(0, -1);
    }

    return path;
}

function haveSummaryMapErrors(summaryMap) {
    return _.some(summaryMap, function (summary) {
        return summary.error;
    });
}

function rewriteHome(location) {
    return isWindows ? location.replace('~', process.env.USERPROFILE) : location.replace('~', process.env.HOME);
}

function mupErrorLog(message) {
    console.error(('Ошибка в mup.json файле: ' + message + '\n').red.bold);
    process.exit(1);
}

function getCanonicalPath(location) {
    var localDir = path.resolve(__dirname, location);
    return fs.existsSync(localDir) ? localDir : path.resolve(rewriteHome(location));
}

console.log('------------------------------------------------'.bold.blue);
console.log('RIM Meteor DEPLOY:'.bold.blue);
console.log('------------------------------------------------\n'.bold.blue);

var mupJsonPath = path.resolve('mup.json'),
    settingsJsonPath = path.resolve('settings.json'),
    buildLocation = path.resolve(tmpDir(), 'meteor_build_' + String(_.random(10000, 99999))),
    bundlePath = path.resolve(buildLocation, 'bundle.tar.gz'),
    args = [
        'build', '--directory', buildLocation,
        '--architecture', 'os.linux.x86_64'
    ];
config = fs.existsSync(mupJsonPath) ? cjson.load(mupJsonPath) : mupErrorLog('сам файл "mup.json" не найден.');

// spawn inherits env vars from process.env, so we can simply set them like this
process.env.BUILD_LOCATION = buildLocation;
//process.env.TOOL_NODE_FLAGS = "--max-old-space-size=4096"; //HACK FROM FUCKING METEOR DEPLOY

config.env = config.env || {}; //initialize options

config.meteorBinary = (config.meteorBinary) ? getCanonicalPath(config.meteorBinary) : 'meteor';

if (typeof config.appName === 'undefined') {
    config.appName = 'meteor';
}

if (!config.server) {
    mupErrorLog('Server information does not exist');
}

var sshAgentExists = false,
    sshAgent = process.env.SSH_AUTH_SOCK;

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

var meteor = spawn(config.meteorBinary, args, {cwd: rewriteHome(config.app)});

meteor.stdout.pipe(process.stdout, {end: false});
meteor.stderr.pipe(process.stderr, {end: false});

meteor.on('close', function (code) {

    if (code != 0) {
        console.log('\n=> Ошибка сборки.\n'.red.bold);
        process.exit(1);
    }

    var output = fs.createWriteStream(bundlePath),

        archive = archiver('tar', {
            gzip: true,
            gzipOptions: {
                level: 8 //default = 6
            }
        });

    archive.pipe(output);

    output.once('close', _.once(function () {

        var auth = {username: config.server.username};

        if (config.server.pem) {
            auth.pem = fs.readFileSync(path.resolve(config.server.pem), 'utf8');
        } else {
            auth.password = config.server.password;
        }

        var taskList = nodemiral.taskList('Развертывание приложения "' + config.appName + '"');

        taskList.copy('Загрузка сборки', {
            src: bundlePath,
            dest: '/opt/' + config.appName + '/tmp/bundle.tar.gz',
            progressBar: true
        });

        taskList.executeScript('Процесс развертывания', {
            script: path.resolve(__dirname, 'script.sh'),
            vars: {
                env: _.extend({}, config.env, config.server.env) || {},
                deployCheckWaitTime: config.deployCheckWaitTime || 20,
                appName: config.appName
            }
        });

        taskList.run(nodemiral.session(config.server.host, auth, {
            ssh: config.server.sshOptions,
            keepAlive: true
        }), function (summaryMap) {
            process.exit(haveSummaryMapErrors(summaryMap) ? 1 : 0);
        });
    }));

    archive.once('error', function (err) {
        console.log('\n=> Архивирование не удалось: ', err.message);
        process.exit(1);
    });

    archive.directory(path.resolve(buildLocation, 'bundle'), 'bundle').finalize();
});