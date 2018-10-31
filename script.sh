#!/bin/bash

set -v
set -x
set +e

TMP_DIR=<%= setupPath %>/<%= appName %>/tmp

BUNDLE_DIR=${TMP_DIR}/bundle

cd ${TMP_DIR}
rm -rf bundle
tar xvzf bundle.tar.gz > /dev/null
chmod -R +x *
chown -R ${USER} ${BUNDLE_DIR}

cd <%= setupPath %>/<%= appName %>/

forever stopall

if [ -d app ]; then
  sudo rm -rf app
fi

sudo mv tmp/bundle app

cd <%= setupPath %>/<%= appName %>/app/programs/server
npm install --save

export PORT=80
export MONGO_URL=mongodb://127.0.0.1/<%= appName %>
export ROOT_URL=http://<%= appName %>

<% for(var key in env) { %>
  export <%- key %>=<%- ("" + env[key]).replace(/./ig, '\\$&') %>
<% } %>

forever start --minUptime 3000 --spinSleepTime 3000 -l <%= setupPath %>/<%= appName %>/log.log -o <%= setupPath %>/<%= appName %>/stdout.log -e <%= setupPath %>/<%= appName %>/error.log -a <%= setupPath %>/<%= appName %>/app/main.js