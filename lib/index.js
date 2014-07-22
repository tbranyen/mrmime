const zlib = require("zlib");
const https = require("https");
const path = require("path");
const fs = require("fs");
const deepEqual = require("assert").deepEqual;
const express = require("express");
const yaml = require("js-yaml");
const Promise = require("promise");
const request = require("request");
const bodyParser = require("body-parser");
const indent = require("./utils/indent");

var encode = encodeURIComponent;
var readFile = Promise.denodeify(fs.readFile);

exports.instrument = function(options) {
  var server = express();

  Object.keys(options.static || {}).forEach(function(route) {
    server.use(route, express.static(options.static[route]));
  });

  var local = path.join.bind(path, __dirname);

  // Default the SSL server proxy to a self-signed certificate.
  if (!options.ssl) {
    options.ssl = {
      key: fs.readFileSync(local("ssl/server.key"), "utf8"),
      cert: fs.readFileSync(local("ssl/server.crt"), "utf8")
    };
  }

  // Load the json and urlencoded middlewares.
  server.use(bodyParser.json());
  server.use(bodyParser.urlencoded({
    extended: true 
  }));

  // Respond to all requests from all verbs.
  server.all("*", function(req, res, next) {
    var method = req.method;
    var headers = req.headers;
    var protocol = req.protocol;

    var host = req.get("host");
    var port = req.get("port");

    var parts = req.originalUrl.split("?");
    var pathname = parts[0];
    var search = parts[1];

    var actual = {
      method: method,
      protocol: protocol,
      search: search || ""
    };

    var file = encode(pathname) + ".yaml";
    var fixturePath = path.join(options.out, encode(options.mock.host), file);

    Promise
      .resolve(fixturePath)
      .then(readFile).catch(function() {
        // Only send an error if we aren't recording.
        if (!options.record) {
          res.send(404, fixturePath + " not found");
        }
      })
      .then(function(snapshots) {
        return new Promise(function(resolve) {
          var match = null;
          var all = [];

          yaml.loadAll(snapshots, function(snapshot) {
            var expected = {
              method: snapshot.method,
              protocol: snapshot.protocol,
              search: snapshot.search
            };

            try {
              deepEqual(actual, expected);
              match = snapshot;
            }
            catch (unhandledException) {
              /* This just means a match was not found. */
            }

            if (snapshot) {
              all.push(snapshot);
            }
          });

          // Add a new result.
          if (!match) {
            match = actual;
            all.push(match);
          }

          resolve({ all: all, match: match });
        }).catch(function(err) {
          console.log(err); 
        });
      })
      .then(function(snapshots) {
        var mock = options.mock;
        var buffer = null;
        var response = null;

        // If we're recording, pass through and fetch the latest data for this
        // mock.
        if (options.record) {
          // Augment the headers to simulate a pass-through.
          headers["host"] = mock.host;
          headers["origin"] = mock.protocol + mock.host;
          headers["referer"] = mock.protocol + mock.host + "/";

          // Necessary to avoid issues with request.
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

          var form = {};

          var proxyRequest = {
            method: method,
            headers: headers,
            qs: search,
            uri: mock.protocol + mock.host + pathname,
            maxRedirects: Infinity
          };

          if (typeof req.body === "object") {
            proxyRequest.form = req.body;
          }
          else {
            proxyRequest.body = req.body;
          }

          response = request(proxyRequest);

          response.on("response", function(resp) {
            var gzip = resp;

            if (resp.headers["content-encoding"] === "gzip") {
              gzip = resp.pipe(zlib.createGunzip());
            }

            gzip.on("data", function(data) {
              if (buffer) {
                buffer = Buffer.concat([buffer, data]);
              }
              else {
                buffer = data;
              }
            });

            gzip.on("end", function() {
              if (!snapshots) {
                return;
              }

              snapshots.match.body = buffer;

              // Attach the correct status code.
              snapshots.match.statusCode = resp.statusCode;
              snapshots.match.headers = resp.headers;

              // Ensure that the date doesn't get added many times.
              delete snapshots.match.headers.date;

              Object.keys(resp.headers).forEach(function(header) {
                // Always assume normal utf-8 encoding.
                if (header !== "content-encoding") {
                  res.header(header, resp.headers[header]);
                }
              });

              if (buffer) {
                res.header("Content-Length", buffer.length);
              }

              // Send the response.
              res.send(resp.statusCode, buffer);

              var output = snapshots.all.map(function(snapshot) {
                var body = snapshot.body;
                delete snapshot.body;

                var out = snapshot !== "undefined" ? yaml.dump(snapshot) : "";
                var contentType = resp.headers["content-type"];
                var isHTML = contentType && contentType.indexOf("text/html") > -1;

                if (body && !isHTML) {
                  out += "\nbody: !!binary > \n" + indent(body.toString("base64"), 2);
                } else if (body && isHTML) {
                  out += "\nbody: !!str > \n" + indent(body.toString(), 2);
                }

                return out;
              }).join("---\n");

              fs.writeFileSync(fixturePath, output);
            });
          });
        }
        else {
          snapshots = snapshots || { match: {} };
          var resp = snapshots.match;
          var buffer = new Buffer(snapshots.match.body || "", "utf8");

          Object.keys(resp.headers || {}).forEach(function(header) {
            // Always assume normal utf-8 encoding.
            if (header !== "content-encoding") {
              res.header(header, resp.headers[header]);
            }
          });

          if (buffer) {
            res.header("Content-Length", buffer.length);
          }

          if (snapshots.match) {
            res.send(snapshots.match.statusCode, buffer);
          }
        }
      })
      .catch(function(err) {
        res.send(500, "Internal server error\n\n<pre>" + err.stack) + "</pre>";
        console.warn(err.stack);
      });
  });

  // Ensure SSL is supported.
  if (options.ssl) {
    https.createServer(options.ssl, server).listen(options.port + 1, options.host);
  }

  // Listen on the specified host and port.
  process.nextTick(function() {
    server.listen(options.port, options.host);
  });

  return server;
};
