var Duplex = require('stream').Duplex;
var WebSocketServer = require('ws').Server;
var through = require('through');
var path = require('path');

// server is the HTTP server which is listening for requests. This is _NOT_
// middleware, but the server itself. (UPGRADE requests are handled separately
// from the regular process).
module.exports = function(server, store, serverOptions, clientOptions) {
  /*
   if (clientOptions.reconnect == null) clientOptions.reconnect = true;
   */
  serverOptions = serverOptions || {}
  clientOptions = clientOptions || {}


  if (clientOptions.reconnect == null) clientOptions.reconnect = true;
  var clientOptionsJson = JSON.stringify(clientOptions);

  // Add the client side script to the Browserify bundle. Set the clientOptions
  // needed to connect to the corresponding server by injecting them into the
  // file during bundling
  store.on('bundle', function(bundle) {
    var browserFilename = path.join(__dirname, 'browser.js');
    bundle.transform(function(filename) {
      if (filename !== browserFilename) return through();
      var file = '';
      return through(
        function write(data) {
          file += data;
        }
        , function end() {
          var rendered = file.replace('{{clientOptions}}', clientOptionsJson);
          this.queue(rendered);
          this.queue(null);
        }
      );
    });
    bundle.add(browserFilename);
  });

  serverOptions.server = server;
  var wss = new WebSocketServer(serverOptions);
  wss.on('connection', function(client){
    var rejected = false;
    var rejectReason;
    function reject(reason) {
      rejected = true;
      if (reason) rejectReason = reason;
    }
    store.emit('client', client, reject);
    if (rejected) {
      // Tell the client to stop trying to connect
      client.close(1001, rejectReason);
      return;
    }

    var stream = createStream(client, store.logger);
    var agent = store.shareClient.listen(stream, client.upgradeReq);
    store.emit('share agent', agent, stream);
  });
};

/**
 * @param {EventEmitters} client is a websocket client session for a given
 * browser window/tab that is has a connection
 * @return {Duplex} stream
 */
function createStream(client, logger) {
  var stream = new Duplex({objectMode: true});

  stream._write = function _write(chunk, encoding, callback) {
    // Silently drop messages after the session is closed
    if (client.state !== 'closed') {
      client.send(JSON.stringify(chunk));

      if (logger) {
        logger.write({type: 'S->C', chunk: chunk, client: client});
      }

    }
    callback();
  };
  // Ignore. You can't control the information, man!
  stream._read = function _read() {};

  client.on('message', function onMessage(data) {
    try {
      data = JSON.parse(data);
    } catch(e) {
      console.warn('Invalid message from client', data);
      return;
    }
    // Ignore Racer channel messages
    if (data && data.racer) return;
    stream.push(data);
    if (logger) {
      logger.write({type: 'C->S', chunk: data, client: client});
    }

  });

  stream.on('error', function onError() {
    client.stop();
  });

  client.on('close', function onClose() {
    stream.end();
    stream.emit('close');
    stream.emit('end');
    stream.emit('finish');
  });

  return stream;
}