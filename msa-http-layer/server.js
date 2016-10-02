/** @name __inline_debug__ */
global.__defineSetter__('__inline_debug__', function (value) {
    var e = new Error;
    console.log(value);
    console.log(e.stack ? e.stack.split("\n").slice(3).join("\n") : 'no stack provided');
});

if (require.main === module) {
    console.log('called directly');
} else {
    console.log('required as a module');
}

require('./../config.js');
require('core-os');

/** @name MSAServer_Init */
/** @name MSAServer_Init_Success */
/** @name MSAServer_Init_Fail */
Core.registerRequestPoint('MSAServer_Init', {type: 'multi'});

var express = require('express');
var busboy = require('connect-busboy');
var cookieParser = require('cookie-parser');
var app = express();

var port = process.env.PORT || 8079;

var url = require('url');

app.use(busboy());
app.use(cookieParser());

if (!process.env.PRODUCTION) {
    app.set('json spaces', 2);
}

var mongodb = require('mongodb');

var crypto = require('crypto');

var mongoClient = mongodb.MongoClient;
var db;
var io;

fs = require('fs');

var mongoApiFile;
var sitesCollection;

classes = {};
require('./Auth.js');
require('./Plugin.js');

var mongoHost = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/mongo-sites';
mongoClient.connect(mongoHost, function (err, dblink) {
    if (err) {
        console.log('Unable to connect to the mongoDB server from environment variable MONGO_URL=' + mongoHost + '. Error:', err);
        setTimeout(function() {
            process.exit();
        }, 5000);
    } else {
        console.log('Connected to mongodb');
        db = dblink;
        app.db = dblink;
        app.db.DBObject = db.db("mongo-sites");
        sitesCollection = db.collection('_sites');

        var server;

        FireRequest(new MSAServer_Init({app: app}), function() {
            console.log('Running on port ' + port);
            server = app.listen(port);

            io = require('socket.io')(server);

            io.on('connection', function (socket) {
                socket.on('MgoClient_Subscribe', function(data) {
                    var data = data || {};
                    socket.join('subscribed:' + data.to || 'all');
                });

                socket.on('MgoClient_Unsubscribe', function(data) {
                    var data = data || {};
                    socket.leave('subscribed:' + data.to || 'all');
                });
            });
        });
    }
});


app.get('/health/', function (req, res) {
    res.json({health: "ok"});
});


app.get('/+mongoSitesApi.js$', function (req, res) {

    res.contentType('text/javascript');

    var origin = url.parse(req.headers.referer || 'http://localhost').host.replace(/^\d+\./,'');

    function send(site) {
        fs.readFile('mongoSitesApi.js', function (err, data) {
            res.send(data.toString().replace(/\{site\}/g, site).replace(/\{api_url\}/g, '//' + req.headers.host));
        });
    }

    if (origin.match(/^(localhost|127.\d+.\d+.\d+)(:\d+)?$/)) {
        sitesCollection.find({_id: req.query.site}).toArray(function (err, sites) {
            if (sites.length) {
                send(req.query.site)
            } else {
                res.send('alert("MongoApi: site ' + req.query.site + ' not found");');
            }
        })
    } else {
        sitesCollection.find({names: origin}).toArray(function (err, sites) {
            if (sites.length) {
                send(sites[0]._id);
            } else {
                res.send('alert("MongoApi error: site not found for domain ' + origin + '")');
            }
        })
    }
});

app.use(express.static(__dirname + '/'));

app.options('/api/:method/:submethod?', function (req, res) {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-MongoApi-Site ');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.send();
});

app.parser = parser;

function parser(data_handle, custom_handle) {

    return function (req, res) {

        var data = '';

        if (data_handle) {
            req.setEncoding('utf8');

            req.on('data', function (chunk) {
                data += chunk;
            });

            req.on('end', function () {
                try {
                    handle(JSON.parse(data));
                } catch (e) {
                    res.send([e]);
                }
            });
        } else {
            handle();
        }

        function handle(data) {

            var origin = url.parse(req.headers.referer || 'http://localhost').host.replace(/^\d+\./,'');
            var isLocalhost = origin.match(/^(localhost|127.\d+.\d+.\d+)(:\d+)?$/);

            sitesCollection.find(isLocalhost ? {_id: req.headers['x-mongoapi-site']} : {names: origin}).toArray(function (err, sites) {
                if (!sites.length) {
                    res.status(404);
                    res.send('');
                } else {

                    res.header('Access-Control-Allow-Origin', req.headers.origin);
                    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
                    res.header('Access-Control-Allow-Headers', 'Content-Type, X-MongoApi-Site');
                    res.header('Access-Control-Allow-Credentials', 'true');

                    try {
                        var site = sites[0];

                        var auth_data, user;

                        try {
                            var token = req.query.token || req.cookies[site._id + ':_auth'];
                            auth_data = JSON.parse(decrypt(token));

                            db.collection('site-' + site._id + '-users').find({
                                _id: auth_data.user,
                                active_sessions: token
                            }).toArray(function (err, users) {
                                if(err) {
                                    res.send(['unknown, database error. contact administrator.']);
                                    console.error(err);
                                    return
                                }
                                if (!users.length) {
                                    auth_data = null
                                } else {
                                    user = users[0]
                                }
                                if (data_handle) {
                                    handleRequest();
                                } else {
                                    custom_handle(req, res, site, users[0]);
                                }
                            })

                        } catch (e) {
                            if (data_handle) {
                                handleRequest();
                            } else {
                                custom_handle(req, res, site);
                            }
                        }

                        function handleRequest() {

                            data_handle(
                                site,
                                (function substituteSpecialValues(field, cursor) {
                                    switch (true) {
                                        case typeof cursor == 'string' && /* field.match(/_id$/) && */ !!String.prototype.match.call(cursor, /^[0-9a-f]{24}$/):
                                            return mongodb.ObjectId(cursor);

                                        case typeof cursor != 'object' || cursor === null:
                                            return cursor;

                                        case !!cursor.__function__ :
                                            return (new Function('return ' + cursor.__function__))();

                                        case !!cursor._geo_point :
                                            return {_geo_point: { lng: parseFloat(cursor._geo_point.lng), lat: parseFloat(cursor._geo_point.lat)} };

                                        default:
                                            for (var i in cursor) {
                                                if (cursor.hasOwnProperty(i)) {
                                                    cursor[i] = substituteSpecialValues(i, cursor[i]);
                                                }
                                            }
                                            return cursor
                                    }
                                })('', data),
                                function (err, result) {
                                    if (isLocalhost || !process.env.PRODUCTION) {
                                        res.setHeader('Content-Type', 'application/json');
                                        res.send(JSON.stringify([err, result], null, 4) + "\n");
                                    } else {
                                        res.send([err, result]);
                                    }
                                },
                                user,
                                res,
                                req
                            )
                        }

                    } catch (err) {
                        console.error(err.message ? err.message + "\n" + err.stack : err);
                        res.send([err.message ? 'Server error: ' + err.message : err]);
                    }
                }
            });
        }
    }
}

app.post('/api/_find', parser(function (site, data, cb) {
    mongodb.Collection.prototype
        .find
        .apply(db.collection('site-' + site._id), data).toArray(cb);
}));

app.post('/api/_findOne', parser(function (site, data, cb) {
    mongodb.Collection.prototype
        .findOne
        .apply(db.collection('site-' + site._id), data).then(function (data) {
            cb(null, data)
        });
}));

app.post('/api/_aggregate', parser(function (site, data, cb) {
    mongodb.Collection.prototype
        .aggregate
        .call(db.collection('site-' + site._id), data[0], cb);
}));

app.post('/api/_insert', parser(function (site, data, cb, user) {

    if (!user) {
        cb(['Authorization required']);
        return;
    }

    mongodb.Collection.prototype
        [data[0] instanceof Array ? 'insertMany' : 'insertOne']
        .call(db.collection('site-' + site._id), data[0], function(err, res) {
            io.sockets.in('subscribed:all').emit('Collection_Changed', { collection: 'site-' + site._id });
            cb && cb(err, res);
        });
}));

app.post('/api/_update', parser(function (site, data, cb, user) {

    if (!user) {
        cb(['Authorization required']);
        return;
    }

    mongodb.Collection.prototype
        .update
        .call(db.collection('site-' + site._id), data[0], data[1], function(err, res) {
            io.sockets.in('subscribed:all').emit('Collection_Changed', { collection: 'site-' + site._id });
            cb && cb(err, res);
        });
}));

app.post('/api/_remove', parser(function (site, data, cb, user) {

    if (!user) {
        cb(['Authorization required']);
        return;
    }

    mongodb.Collection.prototype
        .deleteOne
        .call(db.collection('site-' + site._id), data[0], function(err, res) {
            io.sockets.in('subscribed:all').emit('Collection_Changed', { collection: 'site-' + site._id });
            cb && cb(err, res);
        });
}));

app.post('/api/_mapReduce', parser(function (site, data, cb, user) {
    data[2] = data[2] || {};
    if (data[2].out && !data[2].out.inline) {
        if (!user) {
            cb(['Authorization required for write operations']);
            return;
        }
    }
    data[2].out = {inline: 1};
    db.collection('site-' + site._id)
        .mapReduce(data[0], data[1], data[2], cb);
}));

var
    algorithm = 'aes192',
    password = 'd6F3Ef9efwh3n90s03eq';

function decrypt(buffer) {
    var decipher = crypto.createDecipher(algorithm, password);
    return decipher.update(new Buffer(buffer, 'base64')) + decipher.final();
}

app.post('/api/save', parser(function (site, data, cb, user) {

    if (!user) {
        cb(['Authorization required']);
        return;
    }

    if (!data._type) {
        cb('Cannot save without _type');
        return;
    }

    var collection = db.collection('site-' + site._id);
    var snapshots = db.collection('site-' + site._id + '-snapshots');

    var _id = data._id;
    delete data._id;
    delete data._snapshot_id;

    if (_id) {
        collection.findOne({_id: _id}, function (err, result) {

            var i, changed = false, changed_persist = false;

            // if has found element with the _id in the collection
            for (i in result) {
                if (result.hasOwnProperty(i) && ['_id', '_modified'].indexOf(i) == -1) {
                    if (JSON.stringify(result[i]) != JSON.stringify(data[i])) {
                        if(i == '_persist') {
                            changed_persist = true;
                        } else {
                            changed = true;
                        }
                    }
                }
            }

            for (i in data) {
                if (data.hasOwnProperty(i) && ['_id', '_modified'].indexOf(i) == -1) {
                    if (JSON.stringify(result[i]) != JSON.stringify(data[i])) {
                        if(i == '_persist') {
                            changed_persist = true;
                        } else {
                            changed = true;
                        }
                    }
                }
            }

            if (!changed && !changed_persist) {
                cb(null, result);
                return;
            }

            if(changed) {
                data._modified = parseInt(new Date() / 1000);
            }

            collection.updateOne({_id: _id}, data, {upsert: true}, function (err1, result1) {
                data._oid = _id;
                data._user = user._id;

                io.sockets.in('subscribed:all').emit('Collection_Changed', { collection: 'site-' + site._id });

                delete data._persist;

                if(changed) {
                    snapshots.insertOne(data, function (err2, result2) {
                        collection.findOne({_id: _id}, function (err3, result3) {
                            cb(err1 || err2 || err3, result3);
                        })
                    })
                } else {
                    collection.findOne({_id: _id}, function (err3, result4) {
                        cb(null, result4);
                    })
                }
            });
        });
    } else {

        data._originated = data._modified = parseInt(new Date() / 1000);

        collection.insertOne(data, function (err1, result) {
            _id = data._id;
            delete data._id;

            data._oid = _id;
            data._user = user._id;
            delete data._id;

            snapshots.insertOne(data, function (err2, result) {
                collection.findOne({_id: _id}, function (err3, result) {
                    cb(err1 || err2 || err3, result);
                })
            })
        });
    }

}));

app.post('/api/snapshots', parser(function (site, data, cb, user) {

    if (!user) {
        cb(['Authorization required']);
        return;
    }

    var limit = data[2] && data[2].limit || 5;

    var snapshots = db.collection('site-' + site._id + '-snapshots');

    (function (data) {
        if (data._id) {
            data._oid = data._id;
            delete data._id;
        }

        if (data._snapshot_id) {
            data._id = data._snapshot_id;
            delete data._snapshot_id;
        }
    })(data[0]);

    mongodb.Collection.prototype.find.apply(snapshots, data).sort({_modified: -1}).limit(limit).toArray(function (err, result) {
        cb(err, result.map(function (it) {
            it._snapshot_id = it._id;
            it._id = it._oid;
            delete it._oid;
            return it
        }));
    });
}));

app.post('/api/snapshots/revert', parser(function (site, data, cb, user) {

    if (!user) {
        cb(['Authorization required']);
        return;
    }

    var collection = db.collection('site-' + site._id);
    var snapshots  = db.collection('site-' + site._id + '-snapshots');

    snapshots.findOne({_id: mongodb.ObjectId(data[0])}, function(err, result) {
        if(err || !result) {
            cb(err || 'no snapshot found with _snapshot_id=' + data[0]);
            return;
        }
        delete result._id;
        result._id = result._oid;
        delete result._oid;
        collection.findOne({_id: mongodb.ObjectId(result._id)}, function(err, old_data) {
            if(old_data._persist) {
                result._persist = old_data._persist;
            }
            collection.updateOne({_id: result._id}, result, function(err, result) {
                if(err) {
                    cb(err);
                    return;
                }
                cb(null, result);
            })
        })
    })

}));

app.post('/api/graph_search', parser(function (site, data, cb) {

    var collection = db.collection('site-' + site._id);

    var query = data[0];

    var source_query = data[0].source || {};
    var destination_query = data[0].destination || {};
    delete data[0].source;
    delete data[0].destination;

    query._type = 'link';

    collection.find(query).toArray(function (err, links) {

        source_query._id = {
            $in: links.map(function (it) {
                return it.source_id
            })
        };

        collection.find(source_query).toArray(function (err, sources) {
            var _id2source = {};
            sources.map(function (it) {
                _id2source[it._id] = it
            });
            links = links.filter(function (it) {
                return _id2source[it.source_id]
            });

            destination_query._id = {
                $in: links.map(function (it) {
                    return it.destination_id
                })
            };

            collection.find(destination_query).toArray(function (err, destinations) {
                var _id2destination = {};
                destinations.map(function (it) {
                    _id2destination[it._id] = it
                });
                links = links.filter(function (it) {
                    return _id2destination[it.destination_id]
                });

                var _id2object = {};

                links.map(function (it) {
                    _id2object[it.source_id] = _id2source     [it.source_id];
                    _id2object[it.destination_id] = _id2destination[it.destination_id];
                });

                cb(null, [links, _id2object])
            });
        });
    });
}));


app.get('/', function(req, res) {
    fs.readFile('./mgosites-admin/index.html', function (err, data) {
        res.send( data.toString() );
    });
});

Core.processNamespace(classes);